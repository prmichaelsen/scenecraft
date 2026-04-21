# Task 70: Schema Foundation (pool_segments + source_locations)

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 4 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Land the schema additions that every downstream M9 task depends on: three new columns on `pool_segments` (`source_hash`, `source_size`, `media_kind`), a new `source_locations` many-to-one table, and removal of the legacy `original_filepath` column. Greenfield — no backfill required.

---

## Context

The Explorer + media-import feature needs two things the current schema can't express:
1. **Content-addressable dedup**: same bytes from two sources → one pool row. Requires `source_hash` (SHA-256 hex, indexed).
2. **Multi-source tracking**: "imported from both `/mnt/media/clip.mp4` and a 2026-04-21 upload" → requires a `source_locations` many-to-one table.

The existing `pool_segments.original_filepath` column records only the first-seen path. Drop it outright — this is greenfield so there's no data to preserve.

`media_kind` (`'video' | 'image' | 'audio'`) drives the Import panel's icon choice and enables per-kind filter chips later.

---

## Steps

1. **Add columns to `pool_segments`** in `scenecraft-engine/src/scenecraft/db.py::_ensure_schema()`:
   ```sql
   ALTER TABLE pool_segments ADD COLUMN source_hash TEXT;
   ALTER TABLE pool_segments ADD COLUMN source_size INTEGER;
   ALTER TABLE pool_segments ADD COLUMN media_kind TEXT;
   ```
   Follow the existing idempotent pattern (check `PRAGMA table_info(pool_segments)` before each ADD).

2. **Drop `original_filepath`** — greenfield, no data migration:
   ```sql
   ALTER TABLE pool_segments DROP COLUMN original_filepath;
   ```
   Gate on SQLite ≥ 3.35; if older, leave as NULL and mark deprecated. Verify project's SQLite version first (`sqlite3.sqlite_version`).

3. **Create `source_locations` table**:
   ```sql
   CREATE TABLE IF NOT EXISTS source_locations (
     id TEXT PRIMARY KEY,
     pool_segment_id TEXT NOT NULL REFERENCES pool_segments(id),
     source_kind TEXT NOT NULL,          -- 'upload' | 'server_path'
     source_ref TEXT NOT NULL,           -- user-side string for uploads; absolute server path for watched
     watched_folder_id TEXT,             -- nullable; links to a watched-folders row if applicable
     first_seen_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL
   );
   ```

4. **Indexes**:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_pool_segments_source_hash ON pool_segments(source_hash);
   CREATE INDEX IF NOT EXISTS idx_pool_segments_media_kind ON pool_segments(media_kind);
   CREATE INDEX IF NOT EXISTS idx_source_locations_pool ON source_locations(pool_segment_id);
   CREATE INDEX IF NOT EXISTS idx_source_locations_hash_lookup ON source_locations(source_ref);
   ```

5. **Undo triggers**: the existing dynamic enumeration via `PRAGMA table_info` picks up new columns automatically; add `source_locations` to the `_undo_tracked_tables` list in `db.py` so it participates in undo/redo.

6. **Helper functions** (`db.py`):
   - `add_source_location(project_dir, pool_segment_id, source_kind, source_ref, watched_folder_id=None) -> str` — inserts and returns new id; sets both timestamps to current.
   - `get_source_locations(project_dir, pool_segment_id) -> list[dict]` — returns all locations for a pool row.
   - `find_pool_by_hash(project_dir, source_hash) -> dict | None` — indexed lookup used by dedup.
   - `touch_source_location(project_dir, location_id)` — updates `last_seen_at`.

7. **Tests** (`scenecraft-engine/tests/test_migrations.py`):
   - Fresh DB has all three new columns + `source_locations` table.
   - Migration is idempotent (re-run is a no-op).
   - `find_pool_by_hash` returns existing row or None.
   - `add_source_location` inserts and both timestamps are set.
   - Undo a source_location insert restores removal (uses the trigger).

---

## Verification

- [ ] `source_hash`, `source_size`, `media_kind` columns present on `pool_segments`.
- [ ] `source_locations` table created with all columns + indexes.
- [ ] `original_filepath` dropped from `pool_segments` (or confirmed deprecated if SQLite too old).
- [ ] Dynamic undo triggers cover `source_locations`.
- [ ] Helper functions (`add_source_location`, `find_pool_by_hash`, etc.) work end-to-end.
- [ ] Tests pass: fresh DB, idempotency, helpers, undo.
- [ ] `pool_segments.media_kind` index confirmed via `EXPLAIN QUERY PLAN`.

---

**Next Task**: [Task 71: ACL system](task-71-acl-system.md)
