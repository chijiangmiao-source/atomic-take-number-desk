"""Acceptance tests for the append-only operation event feed.

Covered guarantees:

* a successful issuance and each genuinely new notes revision append exactly
  one event, committed in the same transaction as the business change; the
  event carries the business snapshot of that moment
* the global ``seq`` strictly follows commit order
* idempotent replays, no-change saves, conflicts and rejected requests emit
  NO event
* cursor pagination pins a snapshot on the first page; later pages read only
  inside that snapshot — concurrent writes during paging never leak in, and a
  full walk has no duplicates and no omissions
* old databases are backfilled at startup in a deterministic order
  (occurrence time, issuance-before-revision, client_op_id, revision); the
  backfill is idempotent across restarts and leaves shot numbers / notes
  untouched
"""

from __future__ import annotations

import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from conftest import ApiServer


def post_issue(base_url: str, **payload) -> httpx.Response:
    return httpx.post(f"{base_url}/api/shot-numbers", json=payload, timeout=10.0)


def issue_ok(base_url: str, scene: str, notes: str = "", op_id: str | None = None) -> dict:
    resp = post_issue(
        base_url,
        scene_id=scene,
        client_op_id=op_id or uuid.uuid4().hex,
        notes=notes,
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


def update_notes(
    base_url: str, op_id: str, base_revision: int, notes: str
) -> httpx.Response:
    return httpx.post(
        f"{base_url}/api/operations/{op_id}/notes",
        json={"base_revision": base_revision, "notes": notes},
        timeout=10.0,
    )


def get_operation(base_url: str, op_id: str) -> dict:
    resp = httpx.get(f"{base_url}/api/operations/{op_id}", timeout=10.0)
    assert resp.status_code == 200, resp.text
    return resp.json()


def get_history(base_url: str, op_id: str) -> list[dict]:
    resp = httpx.get(f"{base_url}/api/operations/{op_id}/notes/history", timeout=10.0)
    assert resp.status_code == 200, resp.text
    return resp.json()


def scene_numbers(base_url: str, scene: str) -> list[int]:
    resp = httpx.get(f"{base_url}/api/scenes/{scene}/operations", timeout=10.0)
    assert resp.status_code == 200, resp.text
    return [op["shot_number"] for op in resp.json()]


def get_events(
    base_url: str, cursor: str | None = None, limit: int | None = None
) -> dict:
    params: dict = {}
    if cursor is not None:
        params["cursor"] = cursor
    if limit is not None:
        params["limit"] = limit
    resp = httpx.get(f"{base_url}/api/events", params=params, timeout=10.0)
    assert resp.status_code == 200, resp.text
    return resp.json()


def drain_events(
    base_url: str, limit: int = 50, cursor: str | None = None
) -> list[dict]:
    """Walk every remaining page and return all events (newest first)."""
    events: list[dict] = []
    next_cursor = cursor
    while True:
        page = get_events(base_url, cursor=next_cursor, limit=limit)
        events.extend(page["events"])
        next_cursor = page["next_cursor"]
        if next_cursor is None:
            return events


def event_count(base_url: str) -> int:
    return len(get_events(base_url, limit=200)["events"])


# ---------------------------------------------------------------------------
# Event emission: which outcomes write an event, and with what snapshot
# ---------------------------------------------------------------------------


def test_issue_and_revision_emit_snapshot_events_in_commit_order(api_server):
    base = api_server.base_url
    op1 = issue_ok(base, "EV-1", notes="开场")
    op2 = issue_ok(base, "EV-1", notes="追车")
    resp = update_notes(base, op1["client_op_id"], 1, "开场·改")
    assert resp.status_code == 200

    events = get_events(base, limit=100)["events"]
    # 三次提交 → 三条事件；seq 严格等于提交先后（最新在前）
    assert [e["seq"] for e in events] == [3, 2, 1]

    issued1, issued2, revised = events[2], events[1], events[0]
    assert issued1["event_type"] == "issued"
    assert issued1["client_op_id"] == op1["client_op_id"]
    assert issued1["scene_id"] == "EV-1"
    assert issued1["shot_number"] == op1["shot_number"] == 1
    assert issued1["revision"] == 1
    assert issued1["notes"] == "开场"  # 当时的备注快照

    assert issued2["event_type"] == "issued"
    assert issued2["shot_number"] == op2["shot_number"] == 2
    assert issued2["notes"] == "追车"

    assert revised["event_type"] == "note_revised"
    assert revised["client_op_id"] == op1["client_op_id"]
    assert revised["shot_number"] == 1  # 镜号不变
    assert revised["revision"] == 2
    assert revised["notes"] == "开场·改"  # 修订生效时的文本快照

    # 事件时间与对应业务行（发放 / 修订历史）的时间一致
    history = get_history(base, op1["client_op_id"])
    assert issued1["created_at"] == history[0]["created_at"]
    assert revised["created_at"] == history[1]["created_at"]


def test_replay_conflict_noop_and_rejected_requests_emit_no_events(api_server):
    base = api_server.base_url
    op_id = uuid.uuid4().hex
    issue_ok(base, "EV-2", notes="原始", op_id=op_id)
    assert event_count(base) == 1

    # 幂等重放：同标识同内容 → 200，无新事件
    replay = post_issue(base, scene_id="EV-2", client_op_id=op_id, notes="原始")
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True
    assert event_count(base) == 1

    # 同标识不同内容 → 409，无新事件
    conflict = post_issue(base, scene_id="EV-2", client_op_id=op_id, notes="换内容")
    assert conflict.status_code == 409
    assert event_count(base) == 1

    # 无变化保存（文本与当前一致）→ 200，无新修订、无新事件
    unchanged = update_notes(base, op_id, 1, "原始")
    assert unchanged.status_code == 200
    assert unchanged.json()["notes_revision"] == 1
    assert event_count(base) == 1

    # 非法基础修订号 → 409，无新事件
    invalid_base = update_notes(base, op_id, 7, "来自未来")
    assert invalid_base.status_code == 409
    assert event_count(base) == 1

    # 操作不存在 → 404，无新事件
    missing = update_notes(base, "no-such-op", 1, "x")
    assert missing.status_code == 404
    assert event_count(base) == 1

    # 一次真实修订 → 恰好一条新事件
    moved = update_notes(base, op_id, 1, "服务端改动")
    assert moved.status_code == 200
    assert event_count(base) == 2

    # 重叠编辑三方冲突 → 409，数据库未动，无新事件
    overlap = update_notes(base, op_id, 1, "本地改动")
    assert overlap.status_code == 409
    assert overlap.json()["detail"]["error"] == "notes_merge_conflict"
    assert event_count(base) == 2

    # 请求本身不合法（备注超长）→ 422，无新事件
    too_long = post_issue(
        base, scene_id="EV-2", client_op_id=uuid.uuid4().hex, notes="长" * 4001
    )
    assert too_long.status_code == 422
    assert event_count(base) == 2

    # 以上拒绝/重放都没有消耗镜号
    assert scene_numbers(base, "EV-2") == [1]


# ---------------------------------------------------------------------------
# Cursor pagination: pinned snapshot, no duplicates, no omissions
# ---------------------------------------------------------------------------


def test_first_page_pins_snapshot_and_new_events_wait_for_refresh(api_server):
    base = api_server.base_url
    ops = [issue_ok(base, "EV-3", notes=f"镜头{i}") for i in range(5)]

    page1 = get_events(base, limit=2)
    assert [e["seq"] for e in page1["events"]] == [5, 4]
    cursor = page1["next_cursor"]
    assert cursor is not None

    # 浏览期间发生的新写入：3 次领取 + 1 次修订
    for i in range(3):
        issue_ok(base, "EV-3", notes=f"补拍{i}")
    update_notes(base, ops[0]["client_op_id"], 1, "镜头0·改")

    # 后续页只读快照范围：新事件不出现，序号连续无重无漏
    page2 = get_events(base, cursor=cursor, limit=2)
    assert [e["seq"] for e in page2["events"]] == [3, 2]
    page3 = get_events(base, cursor=page2["next_cursor"], limit=2)
    assert [e["seq"] for e in page3["events"]] == [1]
    assert page3["next_cursor"] is None

    # 刷新流水（不带游标）→ 新事件出现
    fresh = get_events(base, limit=100)["events"]
    assert len(fresh) == 9
    assert [e["seq"] for e in fresh] == list(range(9, 0, -1))
    assert fresh[0]["event_type"] == "note_revised"


def test_full_pagination_walk_is_duplicate_and_gap_free(api_server):
    base = api_server.base_url
    ops = [issue_ok(base, "EV-4", notes=f"n{i}") for i in range(15)]
    for i in range(8):
        resp = update_notes(base, ops[i]["client_op_id"], 1, f"n{i}·改")
        assert resp.status_code == 200

    walked = drain_events(base, limit=4)  # 23 条事件，每页 4 条 → 6 页
    assert len(walked) == 23
    seqs = [e["seq"] for e in walked]
    assert seqs == sorted(seqs, reverse=True), "跨页序号必须严格递减"
    assert len(set(seqs)) == 23, "分页不得重复"

    pairs = {(e["client_op_id"], e["revision"]) for e in walked}
    expected = {(op["client_op_id"], 1) for op in ops} | {
        (ops[i]["client_op_id"], 2) for i in range(8)
    }
    assert pairs == expected, "分页不得遗漏任何事件"

    # 大页一次取回的是同一集合
    assert {e["seq"] for e in get_events(base, limit=100)["events"]} == set(seqs)


def test_concurrent_writes_interleaved_with_pagination(api_server):
    """并发写入穿插分页：进行中的浏览会话只看到快照内的世界。"""
    base = api_server.base_url
    ops = [issue_ok(base, "EV-5", notes=f"基线{i}") for i in range(30)]

    page1 = get_events(base, limit=10)
    assert len(page1["events"]) == 10
    cursor = page1["next_cursor"]

    new_op_ids = [uuid.uuid4().hex for _ in range(12)]

    def issue_concurrent(op_id: str) -> None:
        resp = post_issue(
            base, scene_id="EV-5", client_op_id=op_id, notes=f"并发{op_id[:6]}"
        )
        assert resp.status_code == 201, resp.text

    def revise_concurrent(index: int) -> None:
        resp = update_notes(base, ops[index]["client_op_id"], 1, f"基线{index}·并发改")
        assert resp.status_code == 200, resp.text

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(issue_concurrent, op_id) for op_id in new_op_ids]
        futures += [pool.submit(revise_concurrent, i) for i in range(8)]
        # 写入进行中的同时继续翻页
        page2 = get_events(base, cursor=cursor, limit=10)
        for future in futures:
            future.result()

    rest = drain_events(base, limit=7, cursor=page2["next_cursor"])
    walked = page1["events"] + page2["events"] + rest

    # 整个会话恰好看到基线的 30 条事件：无重、无漏、严格递减
    assert len(walked) == 30
    seqs = [e["seq"] for e in walked]
    assert seqs == sorted(seqs, reverse=True)
    assert len(set(seqs)) == 30
    assert {e["client_op_id"] for e in walked}.isdisjoint(new_op_ids)
    assert all(e["event_type"] == "issued" for e in walked), "快照外的修订不得混入"

    # 刷新后：30 领取 + 12 并发领取 + 8 并发修订全部可见
    assert event_count(base) == 50


def test_invalid_cursor_and_limit_rejected(api_server):
    base = api_server.base_url
    issue_ok(base, "EV-6", notes="x")

    for bad_cursor in ["abc", "1:2:3", "1.5:2", "-1:2", "2:0", ":", ""]:
        resp = httpx.get(
            f"{base}/api/events", params={"cursor": bad_cursor}, timeout=10.0
        )
        assert resp.status_code == 400, bad_cursor
        assert resp.json()["detail"]["error"] == "invalid_cursor"

    # 超出 SQLite 64 位整数范围的游标分量：同样判为无效游标（400），而非 500
    int64_max = 2**63 - 1
    for huge_cursor in [
        f"{int64_max + 1}:1",          # snapshot 溢出
        f"1:{int64_max + 1}",          # before 溢出
        "99999999999999999999999999:1",
        "1:99999999999999999999999999",
    ]:
        resp = httpx.get(
            f"{base}/api/events", params={"cursor": huge_cursor}, timeout=10.0
        )
        assert resp.status_code == 400, huge_cursor
        assert resp.json()["detail"]["error"] == "invalid_cursor"

    # 边界值（int64 上限）是合法游标：正常返回快照范围内的全部事件而非报错
    boundary = httpx.get(
        f"{base}/api/events",
        params={"cursor": f"{int64_max}:{int64_max}"},
        timeout=10.0,
    )
    assert boundary.status_code == 200
    boundary_page = boundary.json()
    assert [e["seq"] for e in boundary_page["events"]] == [1]
    assert boundary_page["next_cursor"] is None

    assert httpx.get(f"{base}/api/events", params={"limit": 0}, timeout=10.0).status_code == 422
    assert httpx.get(f"{base}/api/events", params={"limit": 201}, timeout=10.0).status_code == 422


def test_events_empty_database(api_server):
    page = get_events(api_server.base_url)
    assert page == {"events": [], "next_cursor": None}


# ---------------------------------------------------------------------------
# Backfill of historical events on old databases
# ---------------------------------------------------------------------------


def _create_pre_events_db(path: Path) -> None:
    """手工构造一份“操作流水”之前的库：operations / note_revisions 齐全，
    但没有 operation_events 表。时间戳刻意让 op-a 的修订与 op-c 的领取同时刻，
    以验证“领取先于修订”的补建次序。"""
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE scene_counters (
            scene_id   TEXT PRIMARY KEY,
            last_value INTEGER NOT NULL
        );
        CREATE TABLE operations (
            client_op_id   TEXT PRIMARY KEY,
            scene_id       TEXT NOT NULL,
            issue_notes    TEXT NOT NULL,
            notes          TEXT NOT NULL,
            notes_revision INTEGER NOT NULL,
            shot_number    INTEGER NOT NULL,
            created_at     TEXT NOT NULL
        );
        CREATE INDEX idx_operations_scene ON operations (scene_id, shot_number);
        CREATE TABLE note_revisions (
            client_op_id  TEXT NOT NULL,
            revision      INTEGER NOT NULL,
            notes         TEXT NOT NULL,
            base_revision INTEGER NOT NULL,
            created_at    TEXT NOT NULL,
            PRIMARY KEY (client_op_id, revision)
        );
        """
    )
    conn.execute("INSERT INTO scene_counters VALUES ('LEG-A', 2), ('LEG-B', 1)")
    # op-a：T1 发放，T3 修订到 r2
    conn.execute(
        "INSERT INTO operations VALUES"
        " ('op-a', 'LEG-A', 'a-发放', 'a-改', 2, 1, '2026-09-10T08:00:00.000Z')"
    )
    conn.execute(
        "INSERT INTO note_revisions VALUES"
        " ('op-a', 1, 'a-发放', 0, '2026-09-10T08:00:00.000Z')"
    )
    conn.execute(
        "INSERT INTO note_revisions VALUES"
        " ('op-a', 2, 'a-改', 1, '2026-09-10T08:00:02.000Z')"
    )
    # op-b：T2 发放
    conn.execute(
        "INSERT INTO operations VALUES"
        " ('op-b', 'LEG-A', 'b-发放', 'b-发放', 1, 2, '2026-09-10T08:00:01.000Z')"
    )
    conn.execute(
        "INSERT INTO note_revisions VALUES"
        " ('op-b', 1, 'b-发放', 0, '2026-09-10T08:00:01.000Z')"
    )
    # op-c：T3 发放（与 op-a 的修订同一时刻）
    conn.execute(
        "INSERT INTO operations VALUES"
        " ('op-c', 'LEG-B', 'c-发放', 'c-发放', 1, 1, '2026-09-10T08:00:02.000Z')"
    )
    conn.execute(
        "INSERT INTO note_revisions VALUES"
        " ('op-c', 1, 'c-发放', 0, '2026-09-10T08:00:02.000Z')"
    )
    conn.commit()
    conn.close()


def test_legacy_database_backfills_events_idempotently(tmp_path):
    """旧库启动即补建历史流水；补建幂等、序号稳定，且不改镜号与备注。"""
    db_path = tmp_path / "pre-events.db"
    _create_pre_events_db(db_path)

    # 期望次序：发生时间 → 领取先于修订 → 操作标识 → 修订号
    expected_ascending = [
        ("op-a", "issued", 1, "a-发放", "LEG-A", 1),
        ("op-b", "issued", 1, "b-发放", "LEG-A", 2),
        ("op-c", "issued", 1, "c-发放", "LEG-B", 1),
        ("op-a", "note_revised", 2, "a-改", "LEG-A", 1),
    ]

    with ApiServer(db_path) as server:
        events = get_events(server.base_url, limit=100)["events"]
        assert [e["seq"] for e in events] == [4, 3, 2, 1]
        ascending = list(reversed(events))
        assert [
            (
                e["client_op_id"],
                e["event_type"],
                e["revision"],
                e["notes"],
                e["scene_id"],
                e["shot_number"],
            )
            for e in ascending
        ] == expected_ascending
        first_snapshot = events

        # 补建不改变既有镜号与备注结果
        assert scene_numbers(server.base_url, "LEG-A") == [1, 2]
        assert scene_numbers(server.base_url, "LEG-B") == [1]
        op_a = get_operation(server.base_url, "op-a")
        assert op_a["notes"] == "a-改"
        assert op_a["notes_revision"] == 2

    # 重启：补建幂等，序号与内容原样稳定
    with ApiServer(db_path) as restarted:
        assert get_events(restarted.base_url, limit=100)["events"] == first_snapshot

        # 新的事件接续全局序号
        fresh = issue_ok(restarted.base_url, "LEG-A", notes="重启后新镜头")
        assert fresh["shot_number"] == 3
        revised = update_notes(restarted.base_url, "op-b", 1, "b-改")
        assert revised.status_code == 200

        events = get_events(restarted.base_url, limit=100)["events"]
        assert [e["seq"] for e in events] == [6, 5, 4, 3, 2, 1]
        assert events[0]["event_type"] == "note_revised"
        assert events[0]["client_op_id"] == "op-b"
        assert events[0]["notes"] == "b-改"
        assert events[1]["event_type"] == "issued"
        assert events[1]["shot_number"] == 3

        # 原有镜号与备注结果未被改变
        assert scene_numbers(restarted.base_url, "LEG-A") == [1, 2, 3]
        assert get_operation(restarted.base_url, "op-a")["notes"] == "a-改"
        assert get_operation(restarted.base_url, "op-b")["notes"] == "b-改"

    # 第三次启动：补建依旧幂等
    with ApiServer(db_path) as third:
        assert [e["seq"] for e in get_events(third.base_url, limit=100)["events"]] == [
            6,
            5,
            4,
            3,
            2,
            1,
        ]


def _create_pre_revision_db(path: Path) -> None:
    """更老的库：连“备注可修订”都没有（无 issue_notes / notes_revision /
    note_revisions）。"""
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE scene_counters (
            scene_id   TEXT PRIMARY KEY,
            last_value INTEGER NOT NULL
        );
        CREATE TABLE operations (
            client_op_id TEXT PRIMARY KEY,
            scene_id     TEXT NOT NULL,
            notes        TEXT NOT NULL,
            shot_number  INTEGER NOT NULL,
            created_at   TEXT NOT NULL
        );
        CREATE INDEX idx_operations_scene ON operations (scene_id, shot_number);
        """
    )
    conn.execute("INSERT INTO scene_counters VALUES ('OLD-1', 2)")
    conn.execute(
        "INSERT INTO operations VALUES ('legacy-op-1', 'OLD-1', '老备注一', 1,"
        " '2026-09-01T00:00:00.000Z')"
    )
    conn.execute(
        "INSERT INTO operations VALUES ('legacy-op-2', 'OLD-1', '老备注二', 2,"
        " '2026-09-01T00:00:01.000Z')"
    )
    conn.commit()
    conn.close()


def test_pre_revision_database_migrates_then_backfills(tmp_path):
    """最老的库先迁移出修订历史，再据此补建流水；重启后序号稳定。"""
    db_path = tmp_path / "legacy.db"
    _create_pre_revision_db(db_path)

    with ApiServer(db_path) as server:
        events = get_events(server.base_url, limit=100)["events"]
        assert [e["seq"] for e in events] == [2, 1]
        assert [
            (e["client_op_id"], e["event_type"], e["revision"], e["notes"])
            for e in reversed(events)
        ] == [
            ("legacy-op-1", "issued", 1, "老备注一"),
            ("legacy-op-2", "issued", 1, "老备注二"),
        ]

        # 迁移后的老数据照常修订：新事件接续序号
        resp = update_notes(server.base_url, "legacy-op-1", 1, "迁移后的修订")
        assert resp.status_code == 200
        events = get_events(server.base_url, limit=100)["events"]
        assert [e["seq"] for e in events] == [3, 2, 1]
        assert events[0]["event_type"] == "note_revised"
        assert events[0]["notes"] == "迁移后的修订"
        assert events[0]["shot_number"] == 1

        # 镜号序列未受影响
        assert scene_numbers(server.base_url, "OLD-1") == [1, 2]

    # 重启：已补建 + 已追加的事件全部稳定
    with ApiServer(db_path) as restarted:
        events = get_events(restarted.base_url, limit=100)["events"]
        assert [e["seq"] for e in events] == [3, 2, 1]
        fresh = issue_ok(restarted.base_url, "OLD-1", notes="重启后新镜头")
        assert fresh["shot_number"] == 3
        assert event_count(restarted.base_url) == 4
