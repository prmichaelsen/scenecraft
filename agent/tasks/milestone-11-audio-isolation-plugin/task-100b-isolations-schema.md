# Task 100b: audio_isolations + isolation_stems Schema & Helpers

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md) — "Schema Additions (new)" + "Run & Stem Model"
**Estimated Time**: 2 hours
**Dependencies**: [Task 100: audio_candidates schema](task-100-schema-and-helpers.md) (independent — separate tables)
**Status**: Not Started

---

## Objective

Add the two new tables the v2 design requires for grouping multi-stem isolation runs: `audio_isolations` (one row per invocation) and `isolation_stems` (junction from run → pool_segment). Ship `db.py` helpers and idempotent migrations in `_ensure_schema`. No writes to `audio_clips.selected` or `audio_candidates` — those tables exist from task-100 but M11 isolation output does NOT use them.

Note: `pool_segments` is the pool-entry table despite the legacy name. Stems land there alongside imports and other generated media.

---

## Steps

### 1. Schema in `db.py::_ensure_schema`

Add, idempotent:

```sql
CREATE TABLE IF NOT EXISTS audio_isolations (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,          -- 'audio_clip' | 'transition'
    entity_id TEXT NOT NULL,
    model TEXT NOT NULL,                -- e.g. 'deepfilternet3'
    range_mode TEXT NOT NULL,           -- 'full' | 'subset'
    trim_in REAL,
    trim_out REAL,
    status TEXT NOT NULL,               -- 'pending' | 'running' | 'completed' | 'failed'
    error TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_isolations_entity
    ON audio_isolations(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_isolations_created
    ON audio_isolations(created_at);

CREATE TABLE IF NOT EXISTS isolation_stems (
    isolation_id TEXT NOT NULL REFERENCES audio_isolations(id),
    pool_segment_id TEXT NOT NULL REFERENCES pool_segments(id),
    stem_type TEXT NOT NULL,            -- 'vocal' | 'background' (extensible)
    PRIMARY KEY (isolation_id, pool_segment_id)
);
CREATE INDEX IF NOT EXISTS idx_isolation_stems_run
    ON isolation_stems(isolation_id);
CREATE INDEX IF NOT EXISTS idx_isolation_stems_segment
    ON isolation_stems(pool_segment_id);
```

### 2. Undo triggers

Follow the same pattern other tables use (`keyframes`, `transitions`, `audio_clips`). `audio_isolations` + `isolation_stems` both need insert/update/delete → undo_log triggers gated on `undo_state.active=1`. Use the existing `_install_undo_triggers` helper if one exists; otherwise inline the CREATE TRIGGER statements in `_ensure_schema`.

### 3. Helpers in `db.py`

```python
def add_audio_isolation(
    project_dir: Path, *,
    entity_type: str,
    entity_id: str,
    model: str,
    range_mode: str,
    trim_in: float | None,
    trim_out: float | None,
) -> str:
    """Insert a new audio_isolations row in status='pending'. Returns isolation_id."""

def update_audio_isolation_status(
    project_dir: Path, isolation_id: str,
    status: str, error: str | None = None,
) -> None:
    """Transition status: pending → running → completed | failed."""

def add_isolation_stem(
    project_dir: Path,
    isolation_id: str,
    pool_segment_id: str,
    stem_type: str,
) -> None:
    """Junction row. Idempotent: if row exists, no-op."""

def get_isolations_for_entity(
    project_dir: Path, entity_type: str, entity_id: str,
) -> list[dict]:
    """Returns [{id, status, model, range_mode, trim_in, trim_out, created_at,
                 stems: [{pool_segment_id, stem_type, duration_seconds, pool_path}]}, ...]
       ordered by created_at DESC. JOIN with pool_segments for stem file metadata."""

def get_isolation_stems(project_dir: Path, isolation_id: str) -> list[dict]:
    """[{pool_segment_id, stem_type, duration_seconds, pool_path}, ...]"""
```

All helpers use `_retry_on_locked`. `add_*` helpers wrap inside `undo_begin` / trigger-based logging so runs can be undone; the Redo layer works for free via the existing redo_log.

### 4. Plugin-api re-exports

Re-export the new helpers from `scenecraft-engine/src/scenecraft/plugin_api.py` so plugins can call them without reaching into `scenecraft.db`:

```python
from scenecraft.db import (
    ...existing...
    add_audio_isolation,
    update_audio_isolation_status,
    add_isolation_stem,
    get_isolations_for_entity,
    get_isolation_stems,
)
```

### 5. Tests

`tests/test_audio_isolations_schema.py`:
- `_ensure_schema` runs twice without error (idempotent)
- `add_audio_isolation` returns a non-empty id; row fields round-trip
- `update_audio_isolation_status` transitions the status; `error` stored when provided
- `add_isolation_stem` creates the junction row; duplicate (isolation_id, pool_segment_id) is a no-op (idempotent)
- `get_isolations_for_entity('audio_clip', clip_id)` returns runs in created_at DESC order, each with its stems array populated
- `get_isolation_stems(isolation_id)` returns stems joined with pool_segments (pool_path, duration_seconds present)
- Undo: insert a new isolation + 2 stems inside an undo_group; undo → rows gone; redo → rows back

---

## Verification

- [ ] `_ensure_schema` creates both tables + all indexes; idempotent
- [ ] Undo triggers installed for both new tables; undo/redo round-trip works
- [ ] All 5 helpers present in `db.py` with the shapes above
- [ ] `plugin_api.py` re-exports all 5 helpers
- [ ] Tests green including the undo round-trip case
- [ ] No changes to `audio_candidates` / `audio_clips.selected` — those stay untouched
- [ ] Migration runs cleanly on an existing project.db (tested against `oktoberfest_show_01`)
