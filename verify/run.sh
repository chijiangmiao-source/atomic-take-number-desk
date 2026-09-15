#!/bin/sh
# 一次性验收流程：任何一步失败即整体失败（退出码非 0）。
set -e

echo "== 1/3 检查 web 反向代理到 api 的链路 =="
python - <<'PY'
import json
import os
import urllib.request

web_base = os.environ.get("WEB_BASE_URL", "http://web")
api_base = os.environ.get("API_BASE_URL", "http://api:8000")

with urllib.request.urlopen(f"{api_base}/api/health", timeout=10) as resp:
    assert json.load(resp)["status"] == "ok", "api 健康检查失败"
print(f"api 直连正常: {api_base}")

with urllib.request.urlopen(f"{web_base}/api/health", timeout=10) as resp:
    assert json.load(resp)["status"] == "ok", "web 代理健康检查失败"
with urllib.request.urlopen(f"{web_base}/", timeout=10) as resp:
    assert "text/html" in resp.headers.get("Content-Type", ""), "页面未返回 HTML"
print(f"web 页面与 /api 代理正常: {web_base}")
PY

echo "== 2/3 pytest：并发无重号 / 幂等重放 / 409 / 重启恢复 / 故障注入 / 备注修订·三方合并·旧库迁移 =="
python -m pytest tests -v

echo "== 3/3 Vitest：前端重试保留、备注草稿状态机与过期轮询合并逻辑 =="
npm --prefix web test

echo "验收通过：全部检查成功"
