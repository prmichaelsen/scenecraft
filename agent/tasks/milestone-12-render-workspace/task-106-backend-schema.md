# Task 106: Backend `render_jobs` Schema + Migration

**Milestone**: [M12 — Render Workspace](../../milestones/milestone-12-render-workspace.md)
**Design**: [local.render-workspace.md](../../design/local.render-workspace.md)
**Estimated Hours**: 2
**Status**: Not Started
**Dependencies**: None (schema-only)

---

## Objective

Add the `render_jobs` table to `project.db` with idempotent `CREATE TABLE IF NOT EXISTS`, basic CRUD helpers in `db.py`, and a `status/queue_position` index. No API surface in this task — that lands in Task 107.

---

## Steps

1. **Schema** in `scenecraft-engine/src/scenecraft/db.py` (alongside existing `CREATE TABLE` blocks):

   ```sql
   CREATE TABLE IF NOT EXISTS render_jobs (
       id                   TEXT PRIMARY KEY,
       name                 TEXT NOT NULL,
       snapshot_commit_sha  TEXT NOT NULL,
       in_seconds           REAL NOT NULL,
       out_seconds          REAL NOT NULL,
       settings_json        TEXT NOT NULL,
       status               TEXT NOT NULL DEFAULT 'queued',
       queue_position       INTEGER NOT NULL,
       output_path          TEXT,
       progress             REAL DEFAULT 0.0,
       error_message        TEXT,
       submitted_at         TEXT NOT NULL,
       started_at           TEXT,
       completed_at         TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_render_jobs_status_position
       ON render_jobs(status, queue_position);
   ```

   Add alongside the `checkpoints` table block (lines 319–323 region).

2. **CRUD helpers** in `db.py` (mirror the checkpoint helpers at lines 1591–1626):

   - `insert_render_job(project_dir, row: dict) -> dict` — generates id if missing, assigns `queue_position = max(queue_position) + 1` for `queued` status, returns the inserted row as a dict
   - `get_render_job(project_dir, job_id) -> dict | None`
   - `list_render_jobs(project_dir, *, statuses: list[str] | None = None) -> list[dict]` — filter by status list; default to all; ordered by `queue_position ASC` then `submitted_at ASC`
   - `update_render_job(project_dir, job_id, patch: dict) -> dict | None` — partial update; returns updated row or None if missing
   - `delete_render_job(project_dir, job_id) -> bool`
   - `reorder_render_jobs(project_dir, ordered_ids: list[str]) -> None` — rewrite `queue_position` in the given order (only queued rows; ignore non-queued)
   - `next_queued_job(project_dir) -> dict | None` — used by the worker (Task 108)

3. **Row shape helper**:
   - Parse `settings_json` as JSON when reading rows (return as a dict in the `settings` key, keep raw `settings_json` internal).
   - Serialize on write.

4. **Tests** in `scenecraft-engine/tests/test_render_jobs_db.py`:
   - Insert sets `queue_position` monotonically
   - Insert with missing id auto-generates uuid4
   - List filters by status, orders by queue_position
   - Update returns None for missing id
   - Reorder only touches queued rows; running/completed rows are left alone
   - `next_queued_job` returns the row with the lowest `queue_position` among `queued`

---

## Verification

- [ ] `render_jobs` table created on server start (idempotent)
- [ ] Index `idx_render_jobs_status_position` present
- [ ] All CRUD helpers exist and pass tests
- [ ] `settings_json` roundtrips cleanly through JSON

---

**Next Task**: [Task 107: Backend render-job API endpoints](task-107-backend-api.md)
