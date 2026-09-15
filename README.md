# 镜号发放系统（Shot Number Issuer）

多台场记终端同时为同一场次领取下一条镜号。系统保证：

- **严格连续**：每个场次的镜号从 1 开始逐个递增，无重复、无缺口；
- **提交顺序**：号码分配顺序等于数据库事务提交顺序；
- **幂等**：相同 `client_op_id` + 相同内容，无论并发、超时重试还是进程重启，永远返回最初发放的号码；
- **冲突拒绝**：相同 `client_op_id` 携带不同内容，返回 `409`；
- **崩溃安全**：服务在“落库后、回包前”崩溃，重试仍能取回已提交的号码；
- **备注可修订**：发放后场记可在场次看板行内修订备注，镜号不变；发放时的备注作为不可变请求指纹，修订不影响幂等重放；
- **操作流水**：每次成功领取与每个真正生成的新备注修订，都与对应变更在同一事务追加一条含当时业务快照的事件；多部门交接时可按全局提交顺序回看全片场流水，游标分页保证长列表无重无漏。

## 架构

```
浏览器 ──► web (nginx, 静态页面 + /api 反向代理)
              │
              ▼
           api (FastAPI, 单进程)
              │  单个事务内：查映射 → 递增场次计数 → 写操作映射
              │  → 写备注修订 → 追加操作流水事件
              ▼
           SQLite (WAL, synchronous=FULL, 命名卷 api-data 持久化)
```

- 镜号分配在 API 请求事务内同步完成，**不依赖任何后台 worker / 队列**；
- 数据库（SQLite 文件，挂载在 `api-data` 卷）是操作映射与场次计数的唯一持久化载体；
- 前端把每次“领取”操作连同 `client_op_id` 持久化在浏览器本地存储中，失败后保留待重试操作，刷新页面不丢失。

## 快速开始（Docker Compose）

```bash
docker compose up --build -d
```

- 页面：<http://localhost:8080>（`WEB_PORT` 可覆盖）
- API：<http://localhost:8000/api/health>（`API_PORT` 可覆盖），交互文档见 `/docs`

覆盖宿主端口：

```bash
WEB_PORT=9000 API_PORT=9001 docker compose up --build -d
```

数据保存在命名卷 `api-data` 中，容器重建、宿主机重启后号码与映射不丢失。

## 一次性验收

```bash
docker compose --profile acceptance up --build --exit-code-from verify verify
```

`verify` 服务依次执行（任一步失败即整体失败，退出码非 0）：

1. 检查 `web → api` 反向代理链路与健康检查；
2. **pytest**：20 并发无重号无缺号、重复提交幂等、409 冲突、**进程重启后映射与计数恢复**、故障注入后重试取回原号码、**旧库自动迁移与迁移重放、两终端不相交编辑合并、重叠编辑 409 及解决、备注修订不影响镜号序列**、**操作流水的事件生成与快照游标分页、并发写入穿插分页无重无漏、旧库幂等补建历史流水且序号跨重启稳定**（其中 `test_live_service.py` 直接打向 compose 中运行的 `api` 服务）；
3. **Vitest**：前端待重试保留、本地持久化、重试幂等键不变、409 反馈、**备注草稿状态机（编辑/保存中/冲突）与过期轮询合并**、**流水分页控制器的续页/失败保留游标/就地重试**等逻辑。

## 幂等协议与事务边界

### 客户端协议

1. 每一次“领取下一条镜号”的**新操作**生成一个不再复用的 `client_op_id`（前端默认 `crypto.randomUUID()`；成功领取后页面自动更换新标识，也可手动重新生成）；
2. 提交 `{scene_id, client_op_id, notes}`；
3. 网络异常、5xx、超时等**任何不确定结果**，都必须用**完全相同的三个字段**重试——服务器据此识别这是同一次操作；
4. 只有 `409` 表示该标识已被不同内容占用，重试无意义，需换用新标识。

前端的两道保护：

- **待重试期间改内容再提交**：若表单标识与某个待重试操作相同但内容不同，控制器会为这次新提交另发新标识，原待重试操作原样保留，仍可从待重试入口取回它的号码；
- **不可重试的失败**：`409` 与其它 4xx（如备注超过 4000 字）直接进入“失败操作”列表，不会伪装成可重试；备注超长时表单也会就地阻止提交。

### 服务端事务边界（`api/app/storage.py` 的 `Storage.issue`）

```
BEGIN IMMEDIATE                        -- 立即取得写锁，串行化所有发放事务
  SELECT operations                    -- ① 按 client_op_id 查已提交映射
    ├─ 命中且指纹一致 → COMMIT，返回原号码（幂等重放，不动计数器，不写流水）
    └─ 命中但指纹不同 → ROLLBACK，返回 409（不动计数器，不写流水）
  INSERT INTO scene_counters …         -- ② 场次计数器原子 +1（不存在则从 1 开始）
    ON CONFLICT DO UPDATE … RETURNING
  INSERT INTO operations …             -- ③ 写入 client_op_id → 镜号 的持久映射
  INSERT INTO note_revisions …         -- ④ 备注的第 1 个修订（发放文本）
  INSERT INTO operation_events …       -- ⑤ 流水事件：领取时的业务快照
COMMIT                                 -- 提交后号码才对其他连接可见
```

关键性质：

- **无重号**：`BEGIN IMMEDIATE` 使写事务互斥，计数器递增与映射插入串行执行；
- **无缺口**：计数器递增与映射插入在**同一事务**中，任何失败整体回滚，不会“烧了号码却没落映射”；
- **提交顺序即号码顺序**：号码在事务内分配、提交后立即可见，并发请求的号码次序等于事务提交次序；
- **崩溃安全**：`synchronous=FULL` + WAL，COMMIT 返回即落盘；响应阶段的崩溃不影响已提交数据，客户端重试走路径 ① 取回号码；
- **指纹不可变**：幂等判定的“内容一致”指 `scene_id` + **发放时备注**（`issue_notes`，落库后不再改变）。之后对备注的任何修订都不会把合法重试误判成冲突。

### 备注修订（`Storage.update_notes`）

发放后备注仍可修订：场记在看板行内编辑并保存，镜号、场次、计数器、`client_op_id` 均不变。每条操作的备注带一个从 1 开始单调递增的修订号，全部历史版本落在 `note_revisions` 表中。

```
BEGIN IMMEDIATE                        -- 同样串行化所有修订事务
  SELECT operations                    -- 当前文本 + 当前修订号
  -- base_revision == 当前修订号：新文本直接生效（快路径）
  -- base_revision <  当前修订号：确定性的按行三方合并
  --   （基础修订文本 vs 服务端当前文本 vs 本次提交文本）
  --   · 不相交改动 → 自动合并，且只产生一个新修订
  --   · 重叠改动   → ROLLBACK，数据库保持原样，409 返回三方片段
  UPDATE operations SET notes, notes_revision   -- 当前文本 + 修订号 +1
  INSERT INTO note_revisions …                  -- 新修订的历史行（同事务提交）
  INSERT INTO operation_events …                -- 流水事件：修订后的业务快照（同事务提交）
COMMIT
```

- 备注更新、修订记录与流水事件在**同一事务**提交，不会出现“改了当前文本却丢了历史”或“有修订却查不到事件”；
- 合并是**确定性**的：同样的三方输入永远得到同样结果（按行 diff3，无随机、无时间依赖）；
- **重试安全**：保存响应在网络中丢失后，客户端用相同 `(base_revision, notes)` 重试，合并会重现当前文本，服务端视为无变化返回现状，不产生重复修订；
- 409 响应携带 `base_notes` / `server_notes` / `local_notes` 全文与按行的重叠片段，场记对照整理后以 `current_revision` 为基础再次保存即可。

### 操作流水（`operation_events` 与 `GET /api/events`）

多部门交接时需要回看全片场的镜号领取与备注变更。系统在 `operations` / `scene_counters` / `note_revisions` 之上维护一张**只追加**的操作流水表：

- **什么会写事件**：每次成功领取（`issued`，修订号恒为 1）与每个真正生成的新备注修订（`note_revised`）各写一条，事件携带**当时的业务快照**（场次、镜号、修订号、当时备注、发生时间），并与对应业务变更在**同一事务**提交——事件存在当且仅当变更已提交；
- **什么不写事件**：幂等重放、无变化保存、409 冲突、404、参数校验失败等被拒绝的请求，一律不产生事件；
- **全局序号**：`seq` 为 `AUTOINCREMENT`，在串行化的写事务内分配，严格等于事务提交先后；回滚不烧号。

**快照游标分页**：`GET /api/events?limit=N`（首屏）固定当次浏览的最高 `seq` 为快照，返回最新一页与 `next_cursor`（形如 `"<快照序号>:<本页末条序号>"`）；后续请求携带该游标，只读取快照范围内的数据。浏览期间提交的新事件**不会**混入进行中的分页会话，用户点击“刷新流水”（不带游标的新请求）后才出现。任意 `limit` 下翻完整个快照都**无重复、无遗漏**。

**看板流水视图**：页面底部“操作流水”卡片按提交先后（最新在前）展示场次、镜号、事件类型、修订号、当时备注与发生时间；滚动到底自动续页；加载失败时**已显示内容与原游标原样保留**，就地“重试”即可续页，不会整页清空。

### 旧库迁移

老版本数据库（无 `issue_notes` / `notes_revision` / `note_revisions`）在服务启动时**自动迁移，无需人工处理**：现有备注被复制为不可变的发放指纹，修订号从 1 开始，并向历史表播种第 1 个修订。迁移是幂等的，重复启动不会改动已迁移数据；迁移后同一 `client_op_id` 携发放时备注重试仍取回原号码。

没有流水表的历史数据库同样在启动时**幂等补建**：按 `note_revisions` 重建每个操作的领取事件（修订 1）与修订事件，次序为**发生时间 → 领取先于修订 → 操作标识 → 修订号**；补建受 `UNIQUE(client_op_id, revision)` 与 NOT EXISTS 双重保护，反复重启不会重复插入，已分配的流水序号跨重启保持稳定，且补建不触碰任何既有镜号与备注。

### 故障注入（仅开发模式）

为可重复验收“落库后、回包前崩溃”这一现场故障，请求可携带
`inject_failure_after_commit=true`：

- 仅当服务以 `ALLOW_FAILURE_INJECTION=true` 启动（compose 默认开启，生产应关闭）且该请求**确实新提交了号码**时，接口在 **COMMIT 之后**返回 `503`；
- 此后用相同 `client_op_id` 重试进入幂等重放分支，返回原号码且**不会再次触发故障**（故障只挂在“新插入”路径上）。

页面上“开发选项”中的复选框对应此参数；重试按钮永远不会再携带它。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/shot-numbers` | 领取镜号。新操作返回 `201`，幂等重放返回 `200`（`replayed: true`），内容冲突返回 `409`，注入故障返回 `503` |
| `POST` | `/api/operations/{client_op_id}/notes` | 修订备注。成功返回 `200`（含新修订号）；基础修订落后时不相交改动自动合并；重叠改动返回 `409`（含三方片段）；操作不存在返回 `404` |
| `GET` | `/api/operations/{client_op_id}/notes/history` | 备注修订历史（按修订号升序；操作不存在返回 `404`） |
| `GET` | `/api/events` | 操作流水（全片场，最新在前）。首屏不带 `cursor` 固定当次快照并返回 `next_cursor`；后续携带游标只读快照范围。`limit` 默认 50（1–200），游标非法或分量超出 64 位整数范围返回 `400` |
| `GET` | `/api/scenes/{scene_id}/operations` | 场次已发放镜号列表（按号码升序，含当前备注与修订号） |
| `GET` | `/api/operations/{client_op_id}` | 按操作标识查询（不存在返回 `404`） |
| `GET` | `/api/health` | 健康检查 |

`POST /api/shot-numbers` 请求体：

```json
{
  "scene_id": "A-12",
  "client_op_id": "7f3d…（每次新操作唯一）",
  "notes": "雨夜追车长镜头",
  "inject_failure_after_commit": false
}
```

`POST /api/operations/{client_op_id}/notes` 请求体：

```json
{
  "base_revision": 3,
  "notes": "整理后的备注文本"
}
```

其 `409` 冲突响应（`detail.error == "notes_merge_conflict"`）携带三方信息，数据库保持原样：

```json
{
  "detail": {
    "error": "notes_merge_conflict",
    "current_revision": 4,
    "base_revision": 3,
    "base_notes": "基础修订文本",
    "server_notes": "服务端当前文本",
    "local_notes": "本次提交文本",
    "conflicts": [{ "base": ["…行"], "server": ["…行"], "local": ["…行"] }]
  }
}
```

## 本地开发

```bash
# API（Python 3.11+）
pip install -r api/requirements.txt -r tests/requirements.txt
SHOT_DB_PATH=./data/dev.db ALLOW_FAILURE_INJECTION=true \
  python -m uvicorn app.main:app --reload --app-dir api

# 前端（Node 20+）
cd web && npm install && npm run dev        # http://localhost:5173，/api 已代理到 8000
```

### 测试

```bash
# 后端：并发 / 重启 / 故障注入（自动拉起真实 uvicorn 子进程 + 临时数据库）
python -m pytest tests -v

# 前端单元测试（Vitest）
cd web && npm test

# 浏览器端到端（Playwright，自动拉起真实 API 与 Vite，全程真接口）
cd web && npx playwright install chromium && npm run e2e
```

## 项目结构

```
├── compose.yaml            # api / web / verify 三个服务，WEB_PORT、API_PORT 可覆盖
├── api/                    # FastAPI 应用与 Dockerfile
│   └── app/
│       ├── main.py         # 路由、409/503 语义、流水游标分页、故障注入开关
│       └── storage.py      # 事务边界：BEGIN IMMEDIATE … COMMIT（见文件头注释）
├── tests/                  # pytest：并发、重启、故障注入、备注修订/合并/迁移、
│                           #       操作流水（快照分页、并发穿插、旧库补建）、live 验收
├── verify/                 # 一次性验收服务（Dockerfile + run.sh）
└── web/                    # React + TypeScript 前端
    ├── src/lib/issuer.ts   # 待重试操作的持久化与幂等重试
    ├── src/lib/notes.ts    # 看板行内编辑的草稿状态机与按修订号合并
    ├── src/lib/events.ts   # 流水控制器：快照分页、失败保留游标就地重试
    ├── src/lib/api.ts      # 409/5xx/网络异常分类（含备注合并冲突）
    └── e2e/                # Playwright：故障后保留待重试、409 反馈、备注行内编辑/合并/冲突、
                            #               流水分页断网续页、快照语义与看板联动
```

## 环境变量

| 变量 | 服务 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WEB_PORT` | 宿主 | `8080` | web 容器映射到宿主的端口 |
| `API_PORT` | 宿主 | `8000` | api 容器映射到宿主的端口 |
| `SHOT_DB_PATH` | api | `/data/shotnumbers.db` | SQLite 数据库文件路径 |
| `ALLOW_FAILURE_INJECTION` | api | `false`（compose 中为 `true`） | 是否允许 `inject_failure_after_commit` 故障注入 |
| `API_BASE_URL` | verify | `http://api:8000` | live 验收用例的目标 API |
| `VITE_API_PROXY_TARGET` | web(开发) | `http://localhost:8000` | Vite 开发服务器的 `/api` 代理目标 |
