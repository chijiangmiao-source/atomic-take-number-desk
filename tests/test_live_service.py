"""Tests that run against a live, already-deployed service.

Used by the Docker Compose ``verify`` acceptance service, which sets
``API_BASE_URL=http://api:8000``.  All scenes and operation ids are unique per
run so the suite is safe to repeat against a persistent database.
"""

from __future__ import annotations

import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

BASE_URL = os.environ.get("API_BASE_URL", "").rstrip("/")

pytestmark = pytest.mark.skipif(
    not BASE_URL, reason="API_BASE_URL not set; skipping live-service tests"
)


def _scene() -> str:
    return f"live-{uuid.uuid4().hex[:12]}"


def test_live_health():
    resp = httpx.get(f"{BASE_URL}/api/health", timeout=10.0)
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_live_twenty_concurrent_operations_are_gapless():
    scene = _scene()
    op_ids = [uuid.uuid4().hex for _ in range(20)]

    with ThreadPoolExecutor(max_workers=20) as pool:
        responses = list(
            pool.map(
                lambda op_id: httpx.post(
                    f"{BASE_URL}/api/shot-numbers",
                    json={"scene_id": scene, "client_op_id": op_id, "notes": "并发"},
                    timeout=15.0,
                ),
                op_ids,
            )
        )

    assert all(r.status_code == 201 for r in responses)
    numbers = sorted(r.json()["shot_number"] for r in responses)
    assert numbers == list(range(1, 21))


def test_live_duplicate_and_conflict():
    scene = _scene()
    op_id = uuid.uuid4().hex
    payload = {"scene_id": scene, "client_op_id": op_id, "notes": "第一条"}

    first = httpx.post(f"{BASE_URL}/api/shot-numbers", json=payload, timeout=10.0)
    assert first.status_code == 201

    replay = httpx.post(f"{BASE_URL}/api/shot-numbers", json=payload, timeout=10.0)
    assert replay.status_code == 200
    assert replay.json()["shot_number"] == first.json()["shot_number"]
    assert replay.json()["replayed"] is True

    conflict = httpx.post(
        f"{BASE_URL}/api/shot-numbers",
        json={**payload, "notes": "换内容"},
        timeout=10.0,
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["error"] == "client_op_id_conflict"


def test_live_injected_failure_replays_original_number():
    scene = _scene()
    op_id = uuid.uuid4().hex
    payload = {"scene_id": scene, "client_op_id": op_id, "notes": "故障注入"}

    failed = httpx.post(
        f"{BASE_URL}/api/shot-numbers",
        json={**payload, "inject_failure_after_commit": True},
        timeout=10.0,
    )
    assert failed.status_code == 503

    retry = httpx.post(f"{BASE_URL}/api/shot-numbers", json=payload, timeout=10.0)
    assert retry.status_code == 200
    assert retry.json()["shot_number"] == 1
    assert retry.json()["replayed"] is True


def _update_notes(op_id: str, base_revision: int, notes: str) -> httpx.Response:
    return httpx.post(
        f"{BASE_URL}/api/operations/{op_id}/notes",
        json={"base_revision": base_revision, "notes": notes},
        timeout=10.0,
    )


def test_live_notes_revision_merge_and_conflict_flow():
    """修订全流程：发放 → 两终端不相交合并 → 重叠 409 → 整理后保存 → 重放原号码。"""
    scene = _scene()
    op_id = uuid.uuid4().hex
    payload = {"scene_id": scene, "client_op_id": op_id, "notes": "第一行\n第二行\n第三行"}

    issued = httpx.post(f"{BASE_URL}/api/shot-numbers", json=payload, timeout=10.0)
    assert issued.status_code == 201
    assert issued.json()["notes_revision"] == 1
    assert issued.json()["issue_notes"] == "第一行\n第二行\n第三行"

    # 终端 A 改第一行 → r2
    resp_a = _update_notes(op_id, 1, "一改\n第二行\n第三行")
    assert resp_a.status_code == 200
    assert resp_a.json()["notes_revision"] == 2
    assert resp_a.json()["shot_number"] == 1

    # 终端 B 基于 r1 改第三行（不相交）→ 自动合并为 r3，只产生一个新修订
    resp_b = _update_notes(op_id, 1, "第一行\n第二行\n三改")
    assert resp_b.status_code == 200
    assert resp_b.json()["notes"] == "一改\n第二行\n三改"
    assert resp_b.json()["notes_revision"] == 3

    # 终端 C 基于 r1 改第一行（与 r2/r3 重叠）→ 409 含三方片段，数据库不动
    resp_c = _update_notes(op_id, 1, "本地改\n第二行\n第三行")
    assert resp_c.status_code == 409
    detail = resp_c.json()["detail"]
    assert detail["error"] == "notes_merge_conflict"
    assert detail["current_revision"] == 3
    assert detail["server_notes"] == "一改\n第二行\n三改"
    assert detail["conflicts"], "必须携带重叠片段"

    current = httpx.get(f"{BASE_URL}/api/operations/{op_id}", timeout=10.0).json()
    assert current["notes_revision"] == 3
    assert current["notes"] == "一改\n第二行\n三改"

    # 场记整理后以当前修订为基础再存 → r4
    resolved = _update_notes(op_id, 3, "整理稿\n第二行\n三改")
    assert resolved.status_code == 200
    assert resolved.json()["notes_revision"] == 4

    # 历史完整：r1 发放 + 三次修订
    history = httpx.get(
        f"{BASE_URL}/api/operations/{op_id}/notes/history", timeout=10.0
    ).json()
    assert [r["revision"] for r in history] == [1, 2, 3, 4]

    # 同一 client_op_id 携发放时备注重试仍取回原号码
    replay = httpx.post(f"{BASE_URL}/api/shot-numbers", json=payload, timeout=10.0)
    assert replay.status_code == 200
    assert replay.json()["shot_number"] == 1
    assert replay.json()["replayed"] is True

    # 镜号序列不受修订影响：下一条仍是 #2
    nxt = httpx.post(
        f"{BASE_URL}/api/shot-numbers",
        json={"scene_id": scene, "client_op_id": uuid.uuid4().hex, "notes": "下一条"},
        timeout=10.0,
    )
    assert nxt.status_code == 201
    assert nxt.json()["shot_number"] == 2


def test_live_events_feed_snapshot_and_pagination():
    """操作流水：领取与修订各产生一条事件；首屏固定快照，新事件刷新后才出现。"""
    scene = _scene()
    op_a = uuid.uuid4().hex
    op_b = uuid.uuid4().hex

    issued_a = httpx.post(
        f"{BASE_URL}/api/shot-numbers",
        json={"scene_id": scene, "client_op_id": op_a, "notes": "流水A"},
        timeout=10.0,
    )
    assert issued_a.status_code == 201
    revised_a = _update_notes(op_a, 1, "流水A·改")
    assert revised_a.status_code == 200
    issued_b = httpx.post(
        f"{BASE_URL}/api/shot-numbers",
        json={"scene_id": scene, "client_op_id": op_b, "notes": "流水B"},
        timeout=10.0,
    )
    assert issued_b.status_code == 201

    # 首屏（limit=1）：最新事件是 B 的领取；游标固定了当次快照
    page1 = httpx.get(f"{BASE_URL}/api/events", params={"limit": 1}, timeout=10.0).json()
    assert page1["events"][0]["client_op_id"] == op_b
    assert page1["events"][0]["event_type"] == "issued"
    assert page1["events"][0]["revision"] == 1
    cursor = page1["next_cursor"]
    assert cursor

    # 浏览期间的新写入
    op_c = uuid.uuid4().hex
    issued_c = httpx.post(
        f"{BASE_URL}/api/shot-numbers",
        json={"scene_id": scene, "client_op_id": op_c, "notes": "流水C"},
        timeout=10.0,
    )
    assert issued_c.status_code == 201

    # 续页只读快照范围：依次是 A 的修订与 A 的领取，C 不出现
    page2 = httpx.get(
        f"{BASE_URL}/api/events", params={"cursor": cursor, "limit": 2}, timeout=10.0
    ).json()
    assert [e["client_op_id"] for e in page2["events"]] == [op_a, op_a]
    assert [e["event_type"] for e in page2["events"]] == ["note_revised", "issued"]
    assert page2["events"][0]["revision"] == 2
    assert page2["events"][0]["notes"] == "流水A·改"
    assert op_c not in {e["client_op_id"] for e in page2["events"]}

    # 刷新流水（不带游标）：C 的领取成为最新事件
    fresh = httpx.get(f"{BASE_URL}/api/events", params={"limit": 1}, timeout=10.0).json()
    assert fresh["events"][0]["client_op_id"] == op_c
    assert fresh["events"][0]["event_type"] == "issued"
