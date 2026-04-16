# Task 44: Schema Migration + Undo Triggers

**Milestone**: [M7 — Clip Trim and Snap](../../milestones/milestone-7-clip-trim-and-snap.md)  
**Design**: [local.clip-trim-and-snap.md](../../design/local.clip-trim-and-snap.md)  
**Estimated Hours**: 3-4  
**Status**: Not Started  
**Dependencies**: None  

---

## Objective

Add three new columns to the `transitions` table in `project.db` for the clip-trim model, and update undo triggers to enumerate them. Write a one-time backfill migration that probes selected videos for `source_video_duration` and initializes trim values.

---

## Steps

1. **Schema migration** in `scenecraft-engine/src/scenecraft/db.py`:
   - `trim_in REAL NOT NULL DEFAULT 0` on `transitions`
   - `trim_out REAL` (nullable) on `transitions`
   - `source_video_duration REAL` (nullable) on `transitions`
   - Use `ALTER TABLE` statements in the existing migration runner
   - Add idempotency check (skip if columns already present)

2. **Update undo triggers** on `transitions` table:
   - `transitions_insert_undo` — no column enumeration needed (DELETE is just PK)
   - `transitions_update_undo` — add the three new columns to the SET clause
   - `transitions_delete_undo` — add to the INSERT column list AND values list
   - The trigger SQL is inline in the `CREATE TRIGGER` string in `db.py`

3. **Backfill migration** (run once per existing project):
   - For each transition in `transitions` where `deleted_at IS NULL`:
     - Parse `selected` JSON; for each selected variant, locate the video file in `transition_candidates/{tr_id}/slot_{n}/`
     - If any variant exists: `ffprobe` the selected video → set `source_video_duration = probe_dur`, `trim_in = 0`, `trim_out = probe_dur`
     - If no selected variant: leave all three nullable fields null
   - Log per-transition: "tr_xxx: source=6.02s, trim=[0, 6.02]"
   - Idempotent: skip rows where `source_video_duration IS NOT NULL`

4. **Feature flag** (optional): gate the migration behind `SCENECRAFT_CLIP_MODEL=1` env var for first rollout. Run on project open if flag set and columns missing.

5. **Tests** (`scenecraft-engine/tests/test_migrations.py`):
   - Schema migration applies cleanly to a fresh DB
   - Schema migration is idempotent (running twice is a no-op)
   - Backfill correctly probes existing videos
   - Undo triggers cover new columns (insert a tr, update trim, undo, verify trim restored)

---

## Verification

- [ ] All three columns exist on `transitions` after migration
- [ ] Running migration twice is a no-op
- [ ] Undo restores trim values through insert/update/delete paths
- [ ] Backfill populates `source_video_duration` for all transitions with selected variants
- [ ] `duration_seconds` column retained (no changes to it — deprecated but not dropped)

---

**Next Task**: [Task 45: Backend trim support](task-45-backend-trim-support.md)  
