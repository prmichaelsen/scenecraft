# Task 58: Transition Lipsyncs Schema

**Objective**: Create the `transition_lipsyncs` table and add `active_lipsync_id` column to `transitions`
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 2
**Status**: Not Started

---

## Context

Lipsync outputs are stored as append-only rows — each generation attempt creates a new row with a new UUID. Transitions gain a nullable `active_lipsync_id` pointing at which lipsync variant is currently active; null means "use the raw Veo clip." This preserves originals and lets users toggle between lipsync candidates.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — Data Model section

## Steps

1. Add schema migration creating `transition_lipsyncs`:
   ```sql
   CREATE TABLE transition_lipsyncs (
     id TEXT PRIMARY KEY,                  -- lipsync_{hex8}
     transition_id TEXT NOT NULL,
     source_video_hash TEXT NOT NULL,      -- sha256 of source Veo clip
     output_filename TEXT NOT NULL,        -- under assets/lipsync_outputs/{tr_id}/, named {id}.mp4
     speaker_map TEXT NOT NULL,            -- JSON: speaker_id -> char_id
     segments TEXT NOT NULL,               -- JSON: [{speaker, start, end, text}]
     created_at TEXT NOT NULL,
     last_modified_by TEXT,
     deleted_at TEXT,
     FOREIGN KEY (transition_id) REFERENCES transitions(id)
   );
   CREATE INDEX idx_lipsyncs_tr ON transition_lipsyncs(transition_id) WHERE deleted_at IS NULL;
   ```

2. Add column to existing transitions table:
   ```sql
   ALTER TABLE transitions ADD COLUMN active_lipsync_id TEXT;
   ```
   Use idempotent `_ensure_schema` logic — check for column existence before adding.

3. Implement `_new_lipsync_id()` helper: `return f"lipsync_{uuid4().hex[:8]}"` with collision retry.

4. DB helpers in `db.py`:
   - `create_transition_lipsync(project_dir, transition_id, source_video_hash, output_filename, speaker_map, segments, user) -> dict`
   - `list_transition_lipsyncs(project_dir, transition_id) -> list[dict]` (non-deleted only)
   - `get_transition_lipsync(project_dir, lipsync_id) -> dict | None`
   - `set_active_lipsync(project_dir, transition_id, lipsync_id_or_none, user)` — updates transition's `active_lipsync_id`
   - `soft_delete_lipsync(project_dir, lipsync_id, user)`

5. Unit tests (`tests/test_lipsyncs_schema.py`):
   - Create + retrieve round-trip
   - List filters deleted
   - Set active lipsync updates the transition row
   - Multiple lipsyncs per transition coexist

## Verification

- [ ] Fresh project has `transition_lipsyncs` table
- [ ] Existing project gets `transitions.active_lipsync_id` column on startup
- [ ] Inserting a lipsync returns `lipsync_{hex8}` ID
- [ ] `set_active_lipsync(null)` clears the pointer
- [ ] Unit tests pass

---

**Dependencies**: None
