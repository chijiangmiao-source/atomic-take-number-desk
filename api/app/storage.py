"""Persistent storage for shot-number issuance and revisable shot notes.

The database is the single source of truth for:

* ``operations``      — the client_op_id -> shot_number mapping (idempotency log).
                        ``issue_notes`` is the IMMUTABLE issuance-time notes text and
                        acts as the request fingerprint for idempotency checks;
                        ``notes`` is the current, revisable text together with its
                        monotonically increasing ``notes_revision``.
* ``scene_counters``  — the last issued shot number per scene
* ``note_revisions``  — full notes history: exactly one row per revision
* ``operation_events``— append-only operation feed: exactly one row per committed
                        business change (a successful issuance or a genuinely new
                        notes revision), carrying the business snapshot of that
                        moment (scene, shot number, revision, notes text, time).
                        ``seq`` is a global AUTOINCREMENT assigned inside the
                        serialized write transaction, so it strictly follows the
                        commit order.  Idempotent replays, no-change saves and
                        rejected requests write NO event row.

Issuance transaction boundary
-----------------------------
``Storage.issue`` performs exactly one database transaction::

    BEGIN IMMEDIATE
      SELECT operations WHERE client_op_id = ?      -- idempotent replay / conflict check
                                                    -- (fingerprint = scene_id + issue_notes)
      INSERT INTO scene_counters ... ON CONFLICT    -- atomic counter increment
        DO UPDATE ... RETURNING last_value
      INSERT INTO operations ...                    -- durable operation mapping
      INSERT INTO note_revisions ... (revision 1)   -- first notes revision
      INSERT INTO operation_events ... ('issued')   -- feed event: snapshot at issuance
    COMMIT

Notes revision transaction boundary
-----------------------------------
``Storage.update_notes`` also performs exactly one transaction; the current-text
UPDATE, the history INSERT and the feed event commit or roll back together, and
it never touches scene_id, shot_number, the counters or client_op_id::

    BEGIN IMMEDIATE
      SELECT operations WHERE client_op_id = ?      -- current text + revision
      -- base_revision == current: fast path, the new text wins directly
      -- base_revision <  current: deterministic line-based three-way merge
      --   (base revision text vs. current server text vs. submitted text);
      --   overlapping edits -> ROLLBACK, nothing changes, 409 with fragments
      UPDATE operations SET notes, notes_revision   -- current text + revision bump
      INSERT INTO note_revisions ...                -- history row for the new revision
      INSERT INTO operation_events ... ('note_revised')  -- feed event: new snapshot
    COMMIT

* ``BEGIN IMMEDIATE`` acquires the database write lock up front, so at most one
  issuance/revision transaction runs at any moment.  Concurrent requests are
  serialized and the assigned numbers follow the transaction commit order.
* The counter increment and the operation insert commit or roll back together,
  therefore a failed/aborted request can never leave a gap in the sequence.
* A committed row in ``operations`` is what makes retries safe: after a crash
  (or an injected post-commit failure) the same ``client_op_id`` simply replays
  the committed number — even after the notes were revised, because the
  idempotency fingerprint is the immutable ``issue_notes``.
* The feed event is the LAST insert of each transaction, so an event exists iff
  its business change committed; a rolled-back transaction leaves no event.

Event feed pagination
---------------------
``Storage.list_events`` serves keyset pages over the feed, newest first.  The
first request of a browsing session pins ``snapshot = MAX(seq)``; every
subsequent page of that session carries the cursor ``"<snapshot>:<before>"``
and reads only rows with ``seq <= snapshot AND seq < before``.  Events
committed while the user is paging therefore never leak into the ongoing
session — they appear after the next refresh (a fresh snapshot).  Pages can
neither repeat nor skip events, regardless of concurrent writers.

Schema migration
----------------
Databases created before notes became revisable are migrated automatically at
startup (no manual step): the missing columns are added, the existing notes are
copied into ``issue_notes`` as the request fingerprint, ``notes_revision``
starts at 1 and revision 1 is seeded into ``note_revisions``.

Databases created before the operation feed existed are backfilled in the same
startup transaction: one event per ``note_revisions`` row (revision 1 = the
issuance, higher revisions = note edits), ordered by occurrence time, then
issuance-before-revision, then client_op_id, then revision number.  The
backfill is guarded by ``UNIQUE (client_op_id, revision)`` plus a NOT EXISTS
filter, so re-running it (every restart) changes nothing — backfilled ``seq``
values stay stable forever.

SQLite is opened in WAL mode with ``synchronous=FULL`` so a committed
transaction survives an OS/process crash before any response is sent.
"""

from __future__ import annotations

import difflib
import os
import sqlite3
import threading
from dataclasses import dataclass
from typing import Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS scene_counters (
    scene_id   TEXT PRIMARY KEY,
    last_value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
    client_op_id   TEXT PRIMARY KEY,
    scene_id       TEXT NOT NULL,
    issue_notes    TEXT NOT NULL,  -- 发放时备注：不可变的请求指纹，参与幂等判定
    notes          TEXT NOT NULL,  -- 当前备注：可修订内容
    notes_revision INTEGER NOT NULL,  -- 当前备注修订号（从 1 开始单调递增）
    shot_number    INTEGER NOT NULL,
    created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operations_scene
    ON operations (scene_id, shot_number);

CREATE TABLE IF NOT EXISTS note_revisions (
    client_op_id  TEXT NOT NULL,
    revision      INTEGER NOT NULL,
    notes         TEXT NOT NULL,
    base_revision INTEGER NOT NULL,  -- 本次编辑所基于的修订号（发放版本记为 0）
    created_at    TEXT NOT NULL,
    PRIMARY KEY (client_op_id, revision)
);

-- 只追加的操作流水：每次成功领取 / 每个真正生成的新备注修订各一行，
-- 与对应业务变更在同一事务提交；seq 全局递增，严格等于提交先后。
CREATE TABLE IF NOT EXISTS operation_events (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type   TEXT NOT NULL,  -- 'issued' | 'note_revised'
    client_op_id TEXT NOT NULL,
    scene_id     TEXT NOT NULL,
    shot_number  INTEGER NOT NULL,
    revision     INTEGER NOT NULL,  -- 事件对应的备注修订号（领取恒为 1）
    notes        TEXT NOT NULL,     -- 事件发生时的备注快照
    created_at   TEXT NOT NULL,
    UNIQUE (client_op_id, revision)  -- 幂等补建与并发写入的去重约束
);
"""

# Outcome statuses returned by Storage.issue
ISSUED = "issued"        # a brand-new number was allocated and committed
REPLAYED = "replayed"    # same client_op_id + same content: original number returned
CONFLICT = "conflict"    # same client_op_id but different content

# Outcome statuses returned by Storage.update_notes
NOTE_UPDATED = "note_updated"          # a new revision was committed
NOTE_UNCHANGED = "note_unchanged"      # merged text identical to current: no new revision
NOTE_NOT_FOUND = "note_not_found"      # unknown client_op_id
NOTE_CONFLICT = "note_conflict"        # overlapping edits: rolled back, 409 with fragments
NOTE_INVALID_BASE = "note_invalid_base"  # base_revision outside [1, current_revision]

# Event types stored in operation_events
EVENT_ISSUED = "issued"              # a shot number was issued (always revision 1)
EVENT_NOTE_REVISED = "note_revised"  # a genuinely new notes revision was committed

_OPERATION_COLUMNS = (
    "client_op_id, scene_id, issue_notes, notes, notes_revision, shot_number, created_at"
)


@dataclass(frozen=True)
class Operation:
    client_op_id: str
    scene_id: str
    issue_notes: str     # immutable issuance-time notes (idempotency fingerprint)
    notes: str           # current (revisable) notes
    notes_revision: int  # revision of the current notes, starts at 1
    shot_number: int
    created_at: str

    def as_dict(self) -> dict:
        return {
            "client_op_id": self.client_op_id,
            "scene_id": self.scene_id,
            "issue_notes": self.issue_notes,
            "notes": self.notes,
            "notes_revision": self.notes_revision,
            "shot_number": self.shot_number,
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class NoteRevision:
    client_op_id: str
    revision: int
    notes: str
    base_revision: int
    created_at: str

    def as_dict(self) -> dict:
        return {
            "client_op_id": self.client_op_id,
            "revision": self.revision,
            "notes": self.notes,
            "base_revision": self.base_revision,
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class OperationEvent:
    """One committed entry of the append-only operation feed.

    Carries the business snapshot at the moment of the change: which scene and
    shot number it concerns, the notes revision it produced and the notes text
    that became current right then.
    """

    seq: int
    event_type: str  # EVENT_ISSUED | EVENT_NOTE_REVISED
    client_op_id: str
    scene_id: str
    shot_number: int
    revision: int
    notes: str
    created_at: str

    def as_dict(self) -> dict:
        return {
            "seq": self.seq,
            "event_type": self.event_type,
            "client_op_id": self.client_op_id,
            "scene_id": self.scene_id,
            "shot_number": self.shot_number,
            "revision": self.revision,
            "notes": self.notes,
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class MergeConflict:
    """One overlapping region of a failed three-way merge (line fragments)."""

    base: tuple   # lines of the base revision
    server: tuple # lines of the current server text
    local: tuple  # lines of the submitted (local) text

    def as_dict(self) -> dict:
        return {
            "base": list(self.base),
            "server": list(self.server),
            "local": list(self.local),
        }


@dataclass(frozen=True)
class IssueOutcome:
    status: str  # ISSUED | REPLAYED | CONFLICT
    operation: Optional[Operation] = None  # the stored operation (new or existing)


@dataclass(frozen=True)
class NoteUpdateOutcome:
    status: str  # NOTE_UPDATED | NOTE_UNCHANGED | NOTE_NOT_FOUND | NOTE_CONFLICT | NOTE_INVALID_BASE
    operation: Optional[Operation] = None  # current stored operation (when it exists)
    base_notes: Optional[str] = None       # text of the base revision (conflict fragment)
    server_notes: Optional[str] = None     # current server text (conflict fragment)
    local_notes: Optional[str] = None      # submitted text (conflict fragment)
    conflicts: tuple = ()                  # tuple[MergeConflict, ...] overlapping regions


# ---------------------------------------------------------------------------
# Deterministic line-based three-way merge
# ---------------------------------------------------------------------------


def _matching_map(base_lines: list, other_lines: list) -> dict:
    """Map matched base-line index -> other-line index (deterministic)."""
    matcher = difflib.SequenceMatcher(None, base_lines, other_lines, autojunk=False)
    mapping = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            mapping[block.a + offset] = block.b + offset
    return mapping


def _sync_regions(base_lines: list, server_lines: list, local_lines: list) -> list:
    """Regions where all three texts agree: (base_start, server_start, local_start, len)."""
    server_map = _matching_map(base_lines, server_lines)
    local_map = _matching_map(base_lines, local_lines)
    regions = []
    i = 0
    n = len(base_lines)
    while i < n:
        if i in server_map and i in local_map:
            j = i
            while (
                j + 1 < n
                and server_map.get(j + 1) == server_map[j] + 1
                and local_map.get(j + 1) == local_map[j] + 1
            ):
                j += 1
            regions.append((i, server_map[i], local_map[i], j - i + 1))
            i = j + 1
        else:
            i += 1
    return regions


def merge_lines(base: str, server: str, local: str) -> tuple:
    """Three-way merge of line-oriented text.

    ``base`` is the revision the local edit started from, ``server`` the current
    stored text, ``local`` the submitted text.  Returns ``(merged_text, [])``
    when the changes are disjoint (or identical), or ``(None, conflicts)`` when
    both sides rewrote the same region differently.  Purely deterministic: the
    same three inputs always produce the same result.
    """
    base_lines = base.split("\n")
    server_lines = server.split("\n")
    local_lines = local.split("\n")

    merged: list = []
    conflicts: list = []
    i_base = i_server = i_local = 0

    def flush_changed(base_end: int, server_end: int, local_end: int) -> None:
        base_reg = base_lines[i_base:base_end]
        server_reg = server_lines[i_server:server_end]
        local_reg = local_lines[i_local:local_end]
        if server_reg == base_reg:
            merged.extend(local_reg)        # only the local side changed
        elif local_reg == base_reg:
            merged.extend(server_reg)       # only the server side changed
        elif server_reg == local_reg:
            merged.extend(server_reg)       # both sides made the same change
        else:
            conflicts.append(
                MergeConflict(tuple(base_reg), tuple(server_reg), tuple(local_reg))
            )

    for base_start, server_start, local_start, length in _sync_regions(
        base_lines, server_lines, local_lines
    ):
        flush_changed(base_start, server_start, local_start)
        if conflicts:
            return None, conflicts
        merged.extend(base_lines[base_start : base_start + length])
        i_base = base_start + length
        i_server = server_start + length
        i_local = local_start + length
    flush_changed(len(base_lines), len(server_lines), len(local_lines))
    if conflicts:
        return None, conflicts
    return "\n".join(merged), []


class Storage:
    """Thread-safe SQLite-backed issuer.

    A single connection guarded by a lock gives us strict serialization of
    writers inside the process; ``BEGIN IMMEDIATE`` + ``busy_timeout`` keep the
    same guarantee even if several processes share the database file.
    """

    def __init__(self, path: str):
        if path != ":memory:":
            directory = os.path.dirname(os.path.abspath(path))
            os.makedirs(directory, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=FULL")
            self._conn.execute("PRAGMA busy_timeout=10000")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(SCHEMA)
            self._migrate()

    def _migrate(self) -> None:
        """Upgrade an older database in place (idempotent, no manual step).

        * Pre-revision databases: existing notes become the immutable
          ``issue_notes`` fingerprint AND the current text at revision 1;
          revision 1 is seeded into the history so every operation has a
          contiguous revision chain starting at 1.
        * Pre-feed databases: the append-only ``operation_events`` log is
          backfilled from ``note_revisions`` (revision 1 = the issuance, higher
          revisions = note edits), ordered by occurrence time, then
          issuance-before-revision, then client_op_id, then revision number.
          The NOT EXISTS guard (backed by UNIQUE(client_op_id, revision))
          makes the backfill a no-op on every later restart, so the assigned
          ``seq`` values remain stable.
        """
        columns = {
            row[1] for row in self._conn.execute("PRAGMA table_info(operations)")
        }
        cur = self._conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        try:
            if "issue_notes" not in columns:
                cur.execute(
                    "ALTER TABLE operations ADD COLUMN issue_notes TEXT NOT NULL DEFAULT ''"
                )
                cur.execute("UPDATE operations SET issue_notes = notes")
            if "notes_revision" not in columns:
                cur.execute(
                    "ALTER TABLE operations"
                    " ADD COLUMN notes_revision INTEGER NOT NULL DEFAULT 1"
                )
            cur.execute(
                "INSERT INTO note_revisions"
                " (client_op_id, revision, notes, base_revision, created_at)"
                " SELECT o.client_op_id, 1, o.issue_notes, 0, o.created_at"
                " FROM operations o"
                " WHERE NOT EXISTS ("
                "   SELECT 1 FROM note_revisions r"
                "   WHERE r.client_op_id = o.client_op_id AND r.revision = 1"
                " )"
            )
            cur.execute(
                "INSERT INTO operation_events"
                " (event_type, client_op_id, scene_id, shot_number, revision,"
                "  notes, created_at)"
                " SELECT CASE WHEN r.revision = 1 THEN ? ELSE ? END,"
                "        r.client_op_id, o.scene_id, o.shot_number, r.revision,"
                "        r.notes, r.created_at"
                " FROM note_revisions r"
                " JOIN operations o ON o.client_op_id = r.client_op_id"
                " WHERE NOT EXISTS ("
                "   SELECT 1 FROM operation_events e"
                "   WHERE e.client_op_id = r.client_op_id AND e.revision = r.revision"
                " )"
                " ORDER BY r.created_at,"
                "          CASE WHEN r.revision = 1 THEN 0 ELSE 1 END,"
                "          r.client_op_id, r.revision",
                (EVENT_ISSUED, EVENT_NOTE_REVISED),
            )
            cur.execute("COMMIT")
        except Exception:
            cur.execute("ROLLBACK")
            raise

    @staticmethod
    def _row_to_operation(row: sqlite3.Row) -> Operation:
        return Operation(
            client_op_id=row["client_op_id"],
            scene_id=row["scene_id"],
            issue_notes=row["issue_notes"],
            notes=row["notes"],
            notes_revision=row["notes_revision"],
            shot_number=row["shot_number"],
            created_at=row["created_at"],
        )

    def issue(self, *, scene_id: str, client_op_id: str, notes: str) -> IssueOutcome:
        """Allocate the next shot number for ``scene_id`` or replay an existing one.

        Everything below happens inside ONE transaction; the shot number becomes
        visible to any other connection only after COMMIT.  ``notes`` here is the
        issuance-time text: it is stored as the immutable ``issue_notes``
        fingerprint, so later revisions of the notes never affect idempotency.
        """
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                row = cur.execute(
                    f"SELECT {_OPERATION_COLUMNS}"
                    " FROM operations WHERE client_op_id = ?",
                    (client_op_id,),
                ).fetchone()

                if row is not None:
                    existing = self._row_to_operation(row)
                    if existing.scene_id == scene_id and existing.issue_notes == notes:
                        # Idempotent replay: no counter movement, return the
                        # originally committed number.  The fingerprint is the
                        # immutable issuance notes, so revising the notes later
                        # can never turn a legit retry into a conflict.
                        cur.execute("COMMIT")
                        return IssueOutcome(REPLAYED, existing)
                    # Same identifier, different payload: reject without
                    # touching the counter.
                    cur.execute("ROLLBACK")
                    return IssueOutcome(CONFLICT, existing)

                last_value = cur.execute(
                    "INSERT INTO scene_counters (scene_id, last_value) VALUES (?, 1)"
                    " ON CONFLICT(scene_id) DO UPDATE SET last_value = last_value + 1"
                    " RETURNING last_value",
                    (scene_id,),
                ).fetchone()[0]

                created_at = cur.execute(
                    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')"
                ).fetchone()[0]
                cur.execute(
                    "INSERT INTO operations"
                    " (client_op_id, scene_id, issue_notes, notes, notes_revision,"
                    "  shot_number, created_at)"
                    " VALUES (?, ?, ?, ?, 1, ?, ?)",
                    (client_op_id, scene_id, notes, notes, last_value, created_at),
                )
                cur.execute(
                    "INSERT INTO note_revisions"
                    " (client_op_id, revision, notes, base_revision, created_at)"
                    " VALUES (?, 1, ?, 0, ?)",
                    (client_op_id, notes, created_at),
                )
                cur.execute(
                    "INSERT INTO operation_events"
                    " (event_type, client_op_id, scene_id, shot_number, revision,"
                    "  notes, created_at)"
                    " VALUES (?, ?, ?, ?, 1, ?, ?)",
                    (EVENT_ISSUED, client_op_id, scene_id, last_value, notes, created_at),
                )
                cur.execute("COMMIT")
                return IssueOutcome(
                    ISSUED,
                    Operation(
                        client_op_id=client_op_id,
                        scene_id=scene_id,
                        issue_notes=notes,
                        notes=notes,
                        notes_revision=1,
                        shot_number=last_value,
                        created_at=created_at,
                    ),
                )
            except sqlite3.IntegrityError:
                # Defensive path for multi-process deployments: another writer
                # committed the same client_op_id between our check and insert.
                cur.execute("ROLLBACK")
                row = self._conn.execute(
                    f"SELECT {_OPERATION_COLUMNS}"
                    " FROM operations WHERE client_op_id = ?",
                    (client_op_id,),
                ).fetchone()
                existing = self._row_to_operation(row)
                if existing.scene_id == scene_id and existing.issue_notes == notes:
                    return IssueOutcome(REPLAYED, existing)
                return IssueOutcome(CONFLICT, existing)
            except Exception:
                cur.execute("ROLLBACK")
                raise

    def update_notes(
        self, *, client_op_id: str, base_revision: int, notes: str
    ) -> NoteUpdateOutcome:
        """Revise the notes of an issued operation.

        Exactly one transaction: the current-text UPDATE and the history INSERT
        commit or roll back together.  scene_id, shot_number, the scene counter
        and client_op_id are never modified.  When ``base_revision`` lags behind
        the current revision a deterministic line-based three-way merge runs;
        overlapping edits roll everything back and report the three fragments.
        """
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                row = cur.execute(
                    f"SELECT {_OPERATION_COLUMNS}"
                    " FROM operations WHERE client_op_id = ?",
                    (client_op_id,),
                ).fetchone()
                if row is None:
                    cur.execute("ROLLBACK")
                    return NoteUpdateOutcome(NOTE_NOT_FOUND)

                current = self._row_to_operation(row)
                if not 1 <= base_revision <= current.notes_revision:
                    # The client is based on a revision the server does not have.
                    cur.execute("ROLLBACK")
                    return NoteUpdateOutcome(
                        NOTE_INVALID_BASE,
                        operation=current,
                        server_notes=current.notes,
                        local_notes=notes,
                    )

                if base_revision == current.notes_revision:
                    # Fast path: the edit builds on the latest revision.
                    base_notes = current.notes
                    merged = notes
                    conflicts: list = []
                else:
                    base_row = cur.execute(
                        "SELECT notes FROM note_revisions"
                        " WHERE client_op_id = ? AND revision = ?",
                        (client_op_id, base_revision),
                    ).fetchone()
                    if base_row is None:
                        # Revisions are contiguous from 1, so this cannot happen;
                        # treat it defensively as an invalid base.
                        cur.execute("ROLLBACK")
                        return NoteUpdateOutcome(
                            NOTE_INVALID_BASE,
                            operation=current,
                            server_notes=current.notes,
                            local_notes=notes,
                        )
                    base_notes = base_row[0]
                    merged, conflicts = merge_lines(base_notes, current.notes, notes)

                if conflicts:
                    # Overlapping edits: roll back, the database stays exactly
                    # as it was; the caller reports the three fragments.
                    cur.execute("ROLLBACK")
                    return NoteUpdateOutcome(
                        NOTE_CONFLICT,
                        operation=current,
                        base_notes=base_notes,
                        server_notes=current.notes,
                        local_notes=notes,
                        conflicts=tuple(conflicts),
                    )

                if merged == current.notes:
                    # Nothing new (typical case: retry of an update that was
                    # already applied — the merge reproduces the current text).
                    cur.execute("COMMIT")
                    return NoteUpdateOutcome(NOTE_UNCHANGED, operation=current)

                new_revision = current.notes_revision + 1
                created_at = cur.execute(
                    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')"
                ).fetchone()[0]
                cur.execute(
                    "UPDATE operations SET notes = ?, notes_revision = ?"
                    " WHERE client_op_id = ?",
                    (merged, new_revision, client_op_id),
                )
                cur.execute(
                    "INSERT INTO note_revisions"
                    " (client_op_id, revision, notes, base_revision, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (client_op_id, new_revision, merged, base_revision, created_at),
                )
                cur.execute(
                    "INSERT INTO operation_events"
                    " (event_type, client_op_id, scene_id, shot_number, revision,"
                    "  notes, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        EVENT_NOTE_REVISED,
                        client_op_id,
                        current.scene_id,
                        current.shot_number,
                        new_revision,
                        merged,
                        created_at,
                    ),
                )
                cur.execute("COMMIT")
                return NoteUpdateOutcome(
                    NOTE_UPDATED,
                    operation=Operation(
                        client_op_id=current.client_op_id,
                        scene_id=current.scene_id,
                        issue_notes=current.issue_notes,
                        notes=merged,
                        notes_revision=new_revision,
                        shot_number=current.shot_number,
                        created_at=current.created_at,
                    ),
                )
            except Exception:
                cur.execute("ROLLBACK")
                raise

    def list_operations(self, scene_id: str) -> list:
        """All issued operations of a scene, ordered by shot number."""
        with self._lock:
            rows = self._conn.execute(
                f"SELECT {_OPERATION_COLUMNS}"
                " FROM operations WHERE scene_id = ? ORDER BY shot_number",
                (scene_id,),
            ).fetchall()
        return [self._row_to_operation(row) for row in rows]

    def get_operation(self, client_op_id: str) -> Optional[Operation]:
        with self._lock:
            row = self._conn.execute(
                f"SELECT {_OPERATION_COLUMNS}"
                " FROM operations WHERE client_op_id = ?",
                (client_op_id,),
            ).fetchone()
        return self._row_to_operation(row) if row is not None else None

    def list_note_revisions(self, client_op_id: str) -> list:
        """Full notes history of an operation, ordered by revision."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT client_op_id, revision, notes, base_revision, created_at"
                " FROM note_revisions WHERE client_op_id = ? ORDER BY revision",
                (client_op_id,),
            ).fetchall()
        return [
            NoteRevision(
                client_op_id=row["client_op_id"],
                revision=row["revision"],
                notes=row["notes"],
                base_revision=row["base_revision"],
                created_at=row["created_at"],
            )
            for row in rows
        ]

    @staticmethod
    def _row_to_event(row: sqlite3.Row) -> OperationEvent:
        return OperationEvent(
            seq=row["seq"],
            event_type=row["event_type"],
            client_op_id=row["client_op_id"],
            scene_id=row["scene_id"],
            shot_number=row["shot_number"],
            revision=row["revision"],
            notes=row["notes"],
            created_at=row["created_at"],
        )

    def list_events(
        self, *, snapshot: Optional[int], before: Optional[int], limit: int
    ) -> tuple:
        """One keyset page of the operation feed, newest first.

        ``snapshot`` is the inclusive upper ``seq`` bound pinned for the whole
        browsing session (``None`` pins it to the current maximum, i.e. a
        refresh).  ``before`` is the exclusive cursor position carried over
        from the previous page.  Events committed after the snapshot was pinned
        are invisible to the session, so paging can neither repeat nor skip.
        Returns ``(events, snapshot, has_more)``.
        """
        with self._lock:
            if snapshot is None:
                snapshot = self._conn.execute(
                    "SELECT COALESCE(MAX(seq), 0) FROM operation_events"
                ).fetchone()[0]
            sql = (
                "SELECT seq, event_type, client_op_id, scene_id, shot_number,"
                " revision, notes, created_at"
                " FROM operation_events WHERE seq <= ?"
            )
            params: list = [snapshot]
            if before is not None:
                sql += " AND seq < ?"
                params.append(before)
            sql += " ORDER BY seq DESC LIMIT ?"
            params.append(limit + 1)  # one extra row tells us whether more pages exist
            rows = self._conn.execute(sql, params).fetchall()
        has_more = len(rows) > limit
        events = [self._row_to_event(row) for row in rows[:limit]]
        return events, snapshot, has_more

    def close(self) -> None:
        with self._lock:
            self._conn.close()
