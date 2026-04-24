# Task 136: Core Tracks Schema Unification and Migration

**Milestone**: [M17 - Track Contribution Point and Light Show Plugin](../../milestones/milestone-17-track-contribution-point-and-light-show-plugin.md)
**Design Reference**: [local.track-contribution-point-and-light-show-plugin.md § Part 2](../../design/local.track-contribution-point-and-light-show-plugin.md)
**Estimated Time**: 8 hours
**Dependencies**: None (task-135 runs in parallel)
**Status**: Not Started

---

## Objective

Replace the parallel `tracks` (video) + `audio_tracks` (audio) hierarchies with a unified `tracks` table plus per-type sidecar tables (`tracks_video`, `tracks_audio`). Add a `type` discriminant column. Write a one-shot migration script that preserves the existing project DB.

---

## Context

The current split (`tracks` for video, `audio_tracks` for audio) makes adding a third track type structurally awkward. Every new type currently requires a new parallel table with duplicated common-field columns. The unified schema lets core own common fields and sidecars own type-specific fields. R9a (plugins can't touch core schema) naturally extends to plugins owning their own sidecar tables (e.g., `light_show__tracks`).

One project DB currently exists and must survive this migration. Every child table that FKs to `tracks.id` (opacity_keyframes, transitions, transition_effects) or `audio_tracks.id` (audio_clips, audio_clip_links) must keep resolving after the migration.

---

## Steps

### 1. Design target schema

New unified schema (in `db.py` `_ensure_schema`):

```sql
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,       -- may be implicit in single-project DBs; keep for future
  type TEXT NOT NULL,              -- 'video' | 'audio' | 'light_show'
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  muted INTEGER DEFAULT 0,
  solo INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS tracks_video (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  blend_mode TEXT DEFAULT 'normal',
  base_opacity REAL DEFAULT 1.0,
  z_order INTEGER NOT NULL,        -- compositing depth, semantically distinct from display_order
  chroma_key_color TEXT,
  chroma_key_threshold REAL
);

CREATE TABLE IF NOT EXISTS tracks_audio (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  volume_curve TEXT                -- JSON, matches existing shape
);
```

Audit `src/scenecraft/db.py` for every column currently on `tracks` and `audio_tracks`; everything type-specific goes to the sidecar.

### 2. Identify child-table FK surface

Grep for `REFERENCES tracks(id)` and `REFERENCES audio_tracks(id)` in `db.py`. Document every child table (known: `opacity_keyframes`, `transitions`, `transition_effects`, `audio_clips`, `audio_clip_links`). All of these keep pointing at `tracks.id` after migration — audio clips now reference the unified `tracks.id` instead of `audio_tracks.id`.

### 3. Write migration script

New file: `scenecraft-engine/src/scenecraft/migrations/core_tracks_unify.py`

Idempotency check: if `tracks` already has a `type` column → no-op.

```python
def migrate_project_db(cursor: sqlite3.Cursor):
    # Idempotence
    cols = {r[1] for r in cursor.execute("PRAGMA table_info(tracks)")}
    if "type" in cols:
        return

    cursor.executescript("BEGIN TRANSACTION;")
    try:
        # 1. Rename old tables
        cursor.execute("ALTER TABLE tracks RENAME TO _tracks_old_video")
        cursor.execute("ALTER TABLE audio_tracks RENAME TO _tracks_old_audio")

        # 2. Create new unified tables (from new schema)
        # ... (CREATE TABLE tracks, tracks_video, tracks_audio)

        # 3. Migrate video rows
        cursor.execute("""
          INSERT INTO tracks (id, project_id, type, name, display_order, muted, solo, hidden)
          SELECT id, ?, 'video', name, z_order, muted, solo, hidden
          FROM _tracks_old_video
        """, (project_id,))
        cursor.execute("""
          INSERT INTO tracks_video (track_id, blend_mode, base_opacity, z_order, chroma_key_color, chroma_key_threshold)
          SELECT id, blend_mode, base_opacity, z_order, chroma_key_color, chroma_key_threshold
          FROM _tracks_old_video
        """)

        # 4. Migrate audio rows — IDs may collide with video; namespace or rekey
        # Strategy: audio rows keep their IDs if unique across both tables; otherwise prefix 'a_' and rewire audio_clips.track_id
        # Simpler: audio_tracks IDs are already independent UUIDs; verify uniqueness then INSERT
        # Assert: SELECT COUNT(*) FROM _tracks_old_video WHERE id IN (SELECT id FROM _tracks_old_audio) must be 0
        cursor.execute("""
          INSERT INTO tracks (id, project_id, type, name, display_order, muted, solo, hidden)
          SELECT id, ?, 'audio', name, display_order, muted, solo, hidden
          FROM _tracks_old_audio
        """, (project_id,))
        cursor.execute("""
          INSERT INTO tracks_audio (track_id, volume_curve)
          SELECT id, volume_curve FROM _tracks_old_audio
        """)

        # 5. Drop old tables
        cursor.execute("DROP TABLE _tracks_old_video")
        cursor.execute("DROP TABLE _tracks_old_audio")

        cursor.executescript("COMMIT;")
    except Exception:
        cursor.executescript("ROLLBACK;")
        raise
```

Child-table FKs (`opacity_keyframes.track_id`, `audio_clips.track_id`, `transitions.from_track_id` / `to_track_id`, `transition_effects.track_id`) continue pointing at the right rows because IDs are preserved. Verify no ID collisions between video and audio tracks via the pre-migration assertion.

### 4. Wire migration into startup

In `db.py` `_ensure_schema` (or `get_connection`), run `migrate_project_db` before returning the connection. Idempotent — reruns are no-ops.

### 5. Update core track CRUD in `db.py`

- `get_tracks(project_id)` returns unified rows joined with the appropriate sidecar based on `type`
- `add_track(project_id, type, fields)` — INSERT into core `tracks` + INSERT into the matching sidecar
- `update_track(track_id, fields)` — routes common fields to `tracks`, type-specific fields to the right sidecar
- `delete_track(track_id)` — DELETE from `tracks` (CASCADE handles sidecars)

### 6. Expose `add_track` to plugin_api

Add `add_track(type, **fields)` to the `plugin_api.py` allowlist so plugins can create core track rows for their own types (light_show will call this). Common fields only; plugins then INSERT into their own sidecar.

### 7. Tests

- Roundtrip migration test: seed a DB with old `tracks` + `audio_tracks` + child tables, run migration, assert:
  - All old video track IDs addressable as type='video' rows
  - All old audio track IDs addressable as type='audio' rows
  - All child-table FKs resolve
  - `audio_tracks` table gone
  - Idempotent re-run is a no-op
- Core CRUD test: add_track / update_track / get_tracks / delete_track for each type
- Rollback test: inject failure mid-migration, assert DB state unchanged (tables restored to old names)

---

## Verification

- [ ] New unified schema declared in `db.py`
- [ ] Migration script runs on the existing project DB without data loss
- [ ] All child-table FKs (`opacity_keyframes`, `audio_clips`, `transitions`, `transition_effects`, `audio_clip_links`) resolve after migration
- [ ] `audio_tracks` table dropped after migration
- [ ] Idempotent: re-running migration on a migrated DB is a no-op
- [ ] Transactional: rollback test passes
- [ ] Core CRUD helpers (`add_track`, `update_track`, `get_tracks`, `delete_track`) work for video + audio types
- [ ] `add_track` exposed in `plugin_api.py` allowlist
- [ ] Frontend `scenecraft-client.ts` `Track` type updated to include `type` discriminant (backward compat: default `type='video'` in REST response if frontend not yet migrated — OR plan to land frontend changes before BE deploy)

---

## Key Design Decisions

### Schema unification

| Decision | Choice | Rationale |
|---|---|---|
| Full unification | `tracks` + per-type sidecars; `audio_tracks` dropped | Cleaner long-term schema; no feature-flag drift; greenfield enough to pay cost now |
| `z_order` | Kept on `tracks_video` sidecar | Semantically distinct from `display_order` (compositing depth vs. UI row position) despite being in sync today |
| `display_order` | Common column on core `tracks` | Primary timeline row ordering for all types |
| Migration mode | One-shot script at bootstrap | One existing project DB to preserve; declarative schema migrations (via `register_migration`) not yet adopted for core |

---

## Notes

- This core migration does NOT go through `register_migration` — that primitive is for plugins. Core schema evolution stays in `db.py` at M17. Retrofitting core onto `register_migration` is a larger architectural change and out of scope.
- Frontend `Track` type updates: land in the same PR as the backend migration, or coordinate so stale clients return `type=null` gracefully during the rollout window (greenfield — no users — so swap directly).
- Test with a real project DB copy. Backup before apply.

---

**Next Task**: [task-137-tracktype-contribution-point.md](./task-137-tracktype-contribution-point.md)
**Related Design Docs**: [local.track-contribution-point-and-light-show-plugin.md](../../design/local.track-contribution-point-and-light-show-plugin.md)
