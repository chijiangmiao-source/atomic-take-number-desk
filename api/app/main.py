"""FastAPI application for the shot-number issuance service."""

from __future__ import annotations

import os
import re
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Response
from pydantic import BaseModel, Field, field_validator

from .storage import (
    CONFLICT,
    ISSUED,
    NOTE_CONFLICT,
    NOTE_INVALID_BASE,
    NOTE_NOT_FOUND,
    REPLAYED,
    NoteRevision,
    Operation,
    OperationEvent,
    Storage,
)


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class IssueRequest(BaseModel):
    scene_id: str = Field(min_length=1, max_length=120)
    client_op_id: str = Field(min_length=1, max_length=120)
    notes: str = Field(default="", max_length=4000)
    inject_failure_after_commit: bool = False

    @field_validator("scene_id", "client_op_id")
    @classmethod
    def _strip_and_require(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped


class UpdateNotesRequest(BaseModel):
    """Revision of the notes the edit is based on plus the new text."""

    base_revision: int = Field(ge=1)
    notes: str = Field(default="", max_length=4000)


class OperationModel(BaseModel):
    scene_id: str
    client_op_id: str
    issue_notes: str  # immutable issuance-time notes (idempotency fingerprint)
    notes: str  # current revisable notes
    notes_revision: int
    shot_number: int
    created_at: str

    @classmethod
    def from_operation(cls, op: Operation) -> "OperationModel":
        return cls(**op.as_dict())


class IssueResponseModel(OperationModel):
    # True when the request was an idempotent replay of an already-committed
    # operation (no new number was allocated).
    replayed: bool


class NoteRevisionModel(BaseModel):
    revision: int
    notes: str
    base_revision: int
    created_at: str

    @classmethod
    def from_revision(cls, rev: NoteRevision) -> "NoteRevisionModel":
        return cls(**rev.as_dict())


class OperationEventModel(BaseModel):
    seq: int
    event_type: str  # "issued" | "note_revised"
    scene_id: str
    client_op_id: str
    shot_number: int
    revision: int
    notes: str  # 事件发生时的备注快照
    created_at: str

    @classmethod
    def from_event(cls, event: OperationEvent) -> "OperationEventModel":
        return cls(**event.as_dict())


class EventsPageModel(BaseModel):
    events: list[OperationEventModel]
    # 下一页游标（"<快照序号>:<本页末条序号>"）；为 null 表示本次快照已翻完。
    next_cursor: Optional[str]


# 游标格式："<snapshot_seq>:<before_seq>"，由服务端在上一页的 next_cursor 中签发。
_CURSOR_RE = re.compile(r"^(\d+):(\d+)$")

# SQLite INTEGER 为 64 位有符号整数；超出范围的游标分量无法绑定为查询参数，
# 必须在进入存储层之前判为无效游标（400），而不是放大成服务器错误（500）。
_SQLITE_INT64_MAX = 2**63 - 1


def _parse_events_cursor(cursor: str) -> tuple[int, int]:
    """Parse and validate a feed cursor into ``(snapshot, before)``.

    Rejects anything that is not two non-negative decimal integers, a
    ``before`` below 1 (sequence numbers start at 1) and components outside
    the SQLite 64-bit integer range.
    """
    match = _CURSOR_RE.match(cursor)
    if match is not None:
        snapshot = int(match.group(1))
        before = int(match.group(2))
        if 1 <= before <= _SQLITE_INT64_MAX and snapshot <= _SQLITE_INT64_MAX:
            return snapshot, before
    raise HTTPException(
        status_code=400,
        detail={
            "error": "invalid_cursor",
            "message": "游标无效或超出范围：请使用上一页返回的 next_cursor",
        },
    )


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------


def create_app(
    db_path: Optional[str] = None,
    allow_failure_injection: Optional[bool] = None,
) -> FastAPI:
    db_path = db_path or os.environ.get("SHOT_DB_PATH", "./data/shotnumbers.db")
    if allow_failure_injection is None:
        allow_failure_injection = _env_flag("ALLOW_FAILURE_INJECTION")

    storage = Storage(db_path)
    app = FastAPI(title="Shot Number Issuer", version="1.2.0")
    app.state.storage = storage
    app.state.allow_failure_injection = allow_failure_injection

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.post("/api/shot-numbers", response_model=IssueResponseModel)
    def issue_shot_number(request: IssueRequest, response: Response) -> IssueResponseModel:
        # The whole allocation happens inside one database transaction
        # (see storage.Storage.issue).  When this call returns ISSUED, the
        # number is already durably committed.
        outcome = storage.issue(
            scene_id=request.scene_id,
            client_op_id=request.client_op_id,
            notes=request.notes,
        )

        if outcome.status == CONFLICT:
            assert outcome.operation is not None
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "client_op_id_conflict",
                    "message": (
                        "client_op_id 已被占用：同一操作标识不允许携带不同内容重复提交"
                    ),
                    "existing": outcome.operation.as_dict(),
                },
            )

        assert outcome.operation is not None
        body = IssueResponseModel(
            **outcome.operation.as_dict(),
            replayed=outcome.status == REPLAYED,
        )

        if outcome.status == ISSUED:
            response.status_code = 201
            # Development-only chaos knob: the operation has ALREADY been
            # durably committed above; we now simulate the server crashing
            # before the response reaches the client.  A retry with the same
            # client_op_id takes the replay branch and therefore can never
            # trigger this failure twice.
            if request.inject_failure_after_commit and app.state.allow_failure_injection:
                raise HTTPException(
                    status_code=503,
                    detail={
                        "error": "injected_failure_after_commit",
                        "message": (
                            "注入故障：镜号已持久提交，但响应前模拟服务崩溃；"
                            "请使用相同 client_op_id 重试以取回该号码"
                        ),
                    },
                )
        else:
            response.status_code = 200

        return body

    @app.get("/api/scenes/{scene_id}/operations", response_model=list[OperationModel])
    def list_scene_operations(scene_id: str) -> list[OperationModel]:
        return [
            OperationModel.from_operation(op)
            for op in storage.list_operations(scene_id)
        ]

    @app.get("/api/operations/{client_op_id}", response_model=OperationModel)
    def get_operation(client_op_id: str) -> OperationModel:
        operation = storage.get_operation(client_op_id)
        if operation is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "not_found", "message": "操作标识不存在"},
            )
        return OperationModel.from_operation(operation)

    @app.post("/api/operations/{client_op_id}/notes", response_model=OperationModel)
    def update_operation_notes(
        client_op_id: str, request: UpdateNotesRequest
    ) -> OperationModel:
        """Revise the notes of an issued operation (shot number stays put).

        The whole update — current text plus its history row — commits in one
        transaction.  A lagging ``base_revision`` triggers a deterministic
        line-based three-way merge; overlapping edits return 409 with the
        three fragments and leave the database untouched.
        """
        outcome = storage.update_notes(
            client_op_id=client_op_id,
            base_revision=request.base_revision,
            notes=request.notes,
        )

        if outcome.status == NOTE_NOT_FOUND:
            raise HTTPException(
                status_code=404,
                detail={"error": "not_found", "message": "操作标识不存在"},
            )

        if outcome.status == NOTE_INVALID_BASE:
            assert outcome.operation is not None
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "invalid_base_revision",
                    "message": "基础修订号无效：请刷新看板后重试",
                    "current_revision": outcome.operation.notes_revision,
                },
            )

        if outcome.status == NOTE_CONFLICT:
            assert outcome.operation is not None
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "notes_merge_conflict",
                    "message": (
                        "备注与他人同期的修改重叠：数据库未改动，"
                        "请对照三方片段整理后重新保存"
                    ),
                    "current_revision": outcome.operation.notes_revision,
                    "base_revision": request.base_revision,
                    "base_notes": outcome.base_notes,
                    "server_notes": outcome.server_notes,
                    "local_notes": outcome.local_notes,
                    "conflicts": [c.as_dict() for c in outcome.conflicts],
                },
            )

        # NOTE_UPDATED or NOTE_UNCHANGED (retry of an already-applied update)
        assert outcome.operation is not None
        return OperationModel.from_operation(outcome.operation)

    @app.get(
        "/api/operations/{client_op_id}/notes/history",
        response_model=list[NoteRevisionModel],
    )
    def list_note_history(client_op_id: str) -> list[NoteRevisionModel]:
        if storage.get_operation(client_op_id) is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "not_found", "message": "操作标识不存在"},
            )
        return [
            NoteRevisionModel.from_revision(rev)
            for rev in storage.list_note_revisions(client_op_id)
        ]

    @app.get("/api/events", response_model=EventsPageModel)
    def list_events(
        cursor: Optional[str] = Query(default=None),
        limit: int = Query(default=50, ge=1, le=200),
    ) -> EventsPageModel:
        """Cursor-paginated operation feed, newest first.

        The first request of a browsing session carries no cursor: the server
        pins the current maximum ``seq`` as the session snapshot and returns
        the newest page.  Each response carries ``next_cursor``; passing it
        back keeps reading strictly inside the pinned snapshot, so events
        committed while the user is paging appear only after a fresh
        (cursor-less) request.
        """
        snapshot: Optional[int] = None
        before: Optional[int] = None
        if cursor is not None:
            snapshot, before = _parse_events_cursor(cursor)

        events, resolved_snapshot, has_more = storage.list_events(
            snapshot=snapshot, before=before, limit=limit
        )
        next_cursor = (
            f"{resolved_snapshot}:{events[-1].seq}" if has_more and events else None
        )
        return EventsPageModel(
            events=[OperationEventModel.from_event(event) for event in events],
            next_cursor=next_cursor,
        )

    return app


app = create_app()
