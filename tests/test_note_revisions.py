"""Acceptance tests for revisable shot notes (notes revisions).

Covered guarantees:

* notes can be revised after issuance; the shot number never changes
* the issuance-time notes stay the immutable idempotency fingerprint:
  retrying the original issue request still returns the original number
* updates carry (client_op_id, base_revision, new text); the text update and
  its history row commit in one transaction
* lagging base revision -> deterministic line-based three-way merge;
  disjoint edits auto-merge into exactly one new revision
* overlapping edits -> 409 with the three fragments, database untouched
* retrying an already-applied update is a safe no-op (no extra revision)
* old databases migrate automatically on startup (no manual step)
* the shot-number sequence is unaffected by note revisions
"""

from __future__ import annotations

import sqlite3
import uuid
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


def test_update_notes_fast_path_bumps_revision_and_keeps_number(api_server):
    op = issue_ok(api_server.base_url, "N-1", notes="原始备注")
    assert op["notes_revision"] == 1
    assert op["issue_notes"] == "原始备注"

    resp = update_notes(api_server.base_url, op["client_op_id"], 1, "修订后的备注")
    assert resp.status_code == 200, resp.text
    updated = resp.json()
    assert updated["notes"] == "修订后的备注"
    assert updated["notes_revision"] == 2
    # 镜号、场次、操作标识、发放指纹均不变
    assert updated["shot_number"] == op["shot_number"]
    assert updated["scene_id"] == op["scene_id"]
    assert updated["client_op_id"] == op["client_op_id"]
    assert updated["issue_notes"] == "原始备注"

    # 历史：两个修订，revision 1 是发放文本
    history = get_history(api_server.base_url, op["client_op_id"])
    assert [r["revision"] for r in history] == [1, 2]
    assert history[0]["notes"] == "原始备注"
    assert history[0]["base_revision"] == 0
    assert history[1]["notes"] == "修订后的备注"
    assert history[1]["base_revision"] == 1

    # 看板与单查接口同步反映新修订
    assert get_operation(api_server.base_url, op["client_op_id"])["notes_revision"] == 2
    board = httpx.get(
        f"{api_server.base_url}/api/scenes/N-1/operations", timeout=10.0
    ).json()
    assert board[0]["notes"] == "修订后的备注"
    assert board[0]["notes_revision"] == 2


def test_replay_with_issuance_notes_after_notes_revised(api_server):
    op_id = uuid.uuid4().hex
    first = issue_ok(api_server.base_url, "N-2", notes="发放时的备注", op_id=op_id)

    # 场记随后修订了备注
    resp = update_notes(api_server.base_url, op_id, 1, "完全改写的新备注")
    assert resp.status_code == 200

    # 同一 client_op_id 携发放时备注重试：仍取回原号码（幂等不受修订影响）
    replay = post_issue(
        api_server.base_url,
        scene_id="N-2",
        client_op_id=op_id,
        notes="发放时的备注",
    )
    assert replay.status_code == 200
    assert replay.json()["shot_number"] == first["shot_number"]
    assert replay.json()["replayed"] is True

    # 但同一标识携带另一份发放内容仍是 409（当前备注不等于发放指纹）
    conflict = post_issue(
        api_server.base_url,
        scene_id="N-2",
        client_op_id=op_id,
        notes="完全改写的新备注",
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["error"] == "client_op_id_conflict"

    # 冲突与重放都不消耗号码
    assert scene_numbers(api_server.base_url, "N-2") == [first["shot_number"]]


def test_two_terminal_disjoint_edits_merge_into_one_revision(api_server):
    op = issue_ok(api_server.base_url, "N-3", notes="第一行\n第二行\n第三行")
    op_id = op["client_op_id"]

    # 终端 A 基于 r1 改第一行 → r2
    resp_a = update_notes(api_server.base_url, op_id, 1, "一改\n第二行\n第三行")
    assert resp_a.status_code == 200
    assert resp_a.json()["notes_revision"] == 2

    # 终端 B 仍基于 r1 改第三行（不相交）→ 自动合并，且只产生一个新修订 r3
    resp_b = update_notes(api_server.base_url, op_id, 1, "第一行\n第二行\n三改")
    assert resp_b.status_code == 200, resp_b.text
    merged = resp_b.json()
    assert merged["notes"] == "一改\n第二行\n三改"
    assert merged["notes_revision"] == 3

    # 历史恰好三个修订：r1 发放、r2 终端A、r3 合并结果
    history = get_history(api_server.base_url, op_id)
    assert [r["revision"] for r in history] == [1, 2, 3]
    assert history[1]["notes"] == "一改\n第二行\n第三行"
    assert history[2]["notes"] == "一改\n第二行\n三改"
    assert history[2]["base_revision"] == 1  # 合并修订记录的是终端 B 的基础版本


def test_overlapping_edits_return_409_with_fragments_and_db_untouched(api_server):
    op = issue_ok(api_server.base_url, "N-4", notes="第一行\n第二行\n第三行")
    op_id = op["client_op_id"]

    resp_a = update_notes(api_server.base_url, op_id, 1, "第一行\n服务端改动\n第三行")
    assert resp_a.status_code == 200

    # 另一终端基于 r1 改同一行 → 重叠 → 409，含三方片段
    resp_b = update_notes(api_server.base_url, op_id, 1, "第一行\n本地改动\n第三行")
    assert resp_b.status_code == 409, resp_b.text
    detail = resp_b.json()["detail"]
    assert detail["error"] == "notes_merge_conflict"
    assert detail["current_revision"] == 2
    assert detail["base_revision"] == 1
    assert detail["base_notes"] == "第一行\n第二行\n第三行"
    assert detail["server_notes"] == "第一行\n服务端改动\n第三行"
    assert detail["local_notes"] == "第一行\n本地改动\n第三行"
    assert detail["conflicts"] == [
        {"base": ["第二行"], "server": ["服务端改动"], "local": ["本地改动"]}
    ]

    # 数据库保持原样：仍是 r2 / 服务端文本，历史没有增长
    current = get_operation(api_server.base_url, op_id)
    assert current["notes"] == "第一行\n服务端改动\n第三行"
    assert current["notes_revision"] == 2
    assert len(get_history(api_server.base_url, op_id)) == 2

    # 场记整理三方文本后，以当前修订号为基础再次保存 → 成功
    resolved = update_notes(
        api_server.base_url, op_id, 2, "第一行\n服务端+本地整理稿\n第三行"
    )
    assert resolved.status_code == 200
    assert resolved.json()["notes"] == "第一行\n服务端+本地整理稿\n第三行"
    assert resolved.json()["notes_revision"] == 3


def test_retry_of_applied_update_is_noop_no_extra_revision(api_server):
    op = issue_ok(api_server.base_url, "N-5", notes="原始")
    op_id = op["client_op_id"]

    # 第一次保存成功（假设响应在网络中丢失，客户端不知情）
    first = update_notes(api_server.base_url, op_id, 1, "保存成功的文本")
    assert first.status_code == 200
    assert first.json()["notes_revision"] == 2

    # 客户端用完全相同的 (base_revision, notes) 重试 → 安全：不产生新修订
    retry = update_notes(api_server.base_url, op_id, 1, "保存成功的文本")
    assert retry.status_code == 200
    assert retry.json()["notes"] == "保存成功的文本"
    assert retry.json()["notes_revision"] == 2
    assert len(get_history(api_server.base_url, op_id)) == 2


def test_update_notes_unknown_operation_404(api_server):
    resp = update_notes(api_server.base_url, "no-such-op", 1, "x")
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "not_found"


def test_update_notes_invalid_base_revision_409(api_server):
    op = issue_ok(api_server.base_url, "N-6", notes="原始")
    resp = update_notes(api_server.base_url, op["client_op_id"], 5, "来自未来的修订")
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["error"] == "invalid_base_revision"
    assert detail["current_revision"] == 1
    # 数据库未动
    assert get_operation(api_server.base_url, op["client_op_id"])["notes_revision"] == 1


def test_note_revisions_do_not_affect_shot_sequence(api_server):
    first = issue_ok(api_server.base_url, "N-7", notes="第一条")
    second = issue_ok(api_server.base_url, "N-7", notes="第二条")

    # 多轮修订不消耗、不改变任何号码
    assert update_notes(api_server.base_url, first["client_op_id"], 1, "一·改").status_code == 200
    assert update_notes(api_server.base_url, second["client_op_id"], 1, "二·改").status_code == 200
    assert update_notes(api_server.base_url, first["client_op_id"], 2, "一·再改").status_code == 200

    third = issue_ok(api_server.base_url, "N-7", notes="第三条")
    assert third["shot_number"] == 3
    assert scene_numbers(api_server.base_url, "N-7") == [1, 2, 3]


def test_concurrent_note_updates_serialize_and_merge(api_server):
    """两个终端同时基于同一修订保存：写事务串行化，后到者走三方合并。"""
    from concurrent.futures import ThreadPoolExecutor

    op = issue_ok(api_server.base_url, "N-8", notes="第一行\n第二行\n第三行")
    op_id = op["client_op_id"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        resp_a, resp_b = list(
            pool.map(
                lambda notes: update_notes(api_server.base_url, op_id, 1, notes),
                ["一改\n第二行\n第三行", "第一行\n第二行\n三改"],
            )
        )

    assert resp_a.status_code == 200 and resp_b.status_code == 200
    revisions = sorted(r.json()["notes_revision"] for r in (resp_a, resp_b))
    assert revisions == [2, 3], "串行化后一个先到 r2，另一个合并为 r3"
    final = get_operation(api_server.base_url, op_id)
    assert final["notes"] == "一改\n第二行\n三改"
    assert len(get_history(api_server.base_url, op_id)) == 3


def _create_legacy_db(path: Path) -> None:
    """手工构造一份“备注可修订”之前的老库：无 issue_notes / notes_revision /
    note_revisions。"""
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


def test_legacy_database_migrates_on_startup(tmp_path):
    """旧库启动后无需人工处理：自动迁移，重放、查询、修订全部可用。"""
    db_path = tmp_path / "legacy.db"
    _create_legacy_db(db_path)

    with ApiServer(db_path) as server:
        # 迁移后：老操作获得修订号 1，发放备注成为不可变指纹
        op = get_operation(server.base_url, "legacy-op-1")
        assert op["notes_revision"] == 1
        assert op["issue_notes"] == "老备注一"
        assert op["notes"] == "老备注一"
        assert op["shot_number"] == 1

        # 迁移重放：同一 client_op_id 携发放时备注重试仍取回原号码
        replay = post_issue(
            server.base_url,
            scene_id="OLD-1",
            client_op_id="legacy-op-1",
            notes="老备注一",
        )
        assert replay.status_code == 200
        assert replay.json()["shot_number"] == 1
        assert replay.json()["replayed"] is True

        # 同一标识换内容仍是 409
        conflict = post_issue(
            server.base_url,
            scene_id="OLD-1",
            client_op_id="legacy-op-1",
            notes="别的内容",
        )
        assert conflict.status_code == 409

        # 历史已播种：revision 1 即发放文本
        history = get_history(server.base_url, "legacy-op-1")
        assert [r["revision"] for r in history] == [1]
        assert history[0]["notes"] == "老备注一"

        # 老数据可以直接进入可修订流程
        updated = update_notes(server.base_url, "legacy-op-1", 1, "迁移后的修订")
        assert updated.status_code == 200
        assert updated.json()["notes_revision"] == 2
        assert updated.json()["shot_number"] == 1

        # 计数器原样保留：新操作继续发 3 号
        fresh = issue_ok(server.base_url, "OLD-1", notes="迁移后的新镜头")
        assert fresh["shot_number"] == 3
        assert scene_numbers(server.base_url, "OLD-1") == [1, 2, 3]

    # 再次启动（迁移幂等）：数据完好，重放依旧
    with ApiServer(db_path) as restarted:
        replay = post_issue(
            restarted.base_url,
            scene_id="OLD-1",
            client_op_id="legacy-op-1",
            notes="老备注一",
        )
        assert replay.status_code == 200
        assert replay.json()["shot_number"] == 1
        op = get_operation(restarted.base_url, "legacy-op-1")
        assert op["notes"] == "迁移后的修订"
        assert op["notes_revision"] == 2
        assert len(get_history(restarted.base_url, "legacy-op-1")) == 2
