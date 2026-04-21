# Task 107: Backend Render-Job API Endpoints

**Milestone**: [M12 — Render Workspace](../../milestones/milestone-12-render-workspace.md)
**Design**: [local.render-workspace.md](../../design/local.render-workspace.md)
**Estimated Hours**: 6
**Status**: Not Started
**Dependencies**: Task 106 (schema + CRUD helpers)

---

## Objective

Wire the full REST surface for render-job management in `api_server.py`: create/list/update/delete + rerun/duplicate/cancel + reorder + start + clear + output-streaming. Each create call captures a VCS snapshot via `commit_working_copy` so the row is pinned to a reproducible state.

---

## Steps

1. **Imports** in `scenecraft-engine/src/scenecraft/api_server.py`:
   ```python
   from scenecraft.vcs.objects import commit_working_copy
   from scenecraft import db
   import uuid, json
   ```

2. **Endpoints** (all under `/api/projects/:name/render-jobs`, using the existing project-resolution helpers):

   - **`GET /render-jobs`** — list all jobs. Optional query `?status=queued,running,completed,failed,canceled` filters.
   - **`POST /render-jobs`** — body: `{name, in_seconds, out_seconds, settings}`.
     - Resolve project_dir.
     - Call `commit_working_copy(project_dir, source_db=project.db_path, branch="main", author="render-worker", message=f"Render snapshot for {name}")`.
     - Insert row with: `id = uuid4()`, `snapshot_commit_sha = commit["hash"]`, `status = "queued"`, `submitted_at = now()`, `settings_json = json.dumps(settings)`.
     - Return the created row.
   - **`PATCH /render-jobs/:id`** — partial update. Allowed fields: `name`, `in_seconds`, `out_seconds`, `settings`. Reject (409) if `status != "queued"` (can only edit queued).
   - **`DELETE /render-jobs/:id`** — delete row. Does NOT delete the output file on disk (GC later). Reject (409) if `status == "running"` — user must cancel first.
   - **`POST /render-jobs/:id/rerun`** — insert a new row cloning `{name, snapshot_commit_sha, in_seconds, out_seconds, settings_json}`, fresh id, status=queued, new `queue_position`. Returns the new row.
   - **`POST /render-jobs/:id/duplicate`** — same as rerun but **captures a fresh snapshot** (`commit_working_copy`) against current live state. Returns the new row.
   - **`POST /render-jobs/:id/cancel`** — if queued → status=canceled. If running → set status=canceled and signal the worker (Task 108) to abort.
   - **`POST /render-jobs/reorder`** — body: `{ids: [...]}`. Calls `db.reorder_render_jobs`.
   - **`POST /render-jobs/start`** — body: `{}`. If no running job: pick top queued via `db.next_queued_job`, mark it `running`, kick the worker (Task 108 will expose an `enqueue_render_start()`). If already running: return current running job.
   - **`POST /render-jobs/clear-rendered`** — delete all rows with status in `(completed, failed, canceled)`.
   - **`POST /render-jobs/clear-all`** — delete all rows except `running`.
   - **`GET /render-jobs/:id/output`** — streams the MP4 from `project_dir / job.output_path`.
     - 404 if job missing, 409 if `output_path` not set (not yet completed).
     - Supports HTTP range requests (reuse any existing range helper; otherwise use FastAPI's `FileResponse` which handles ranges).
     - Query `?attachment=1` → set `Content-Disposition: attachment; filename="{sanitize(name)}.{ext}"`. Default: no disposition (inline for `<video>`).
     - `sanitize(name)`: replace anything not `[A-Za-z0-9._-]` with `_`, truncate to 128 chars, fallback to `render` if empty.

3. **Frontend client helpers** in `scenecraft/src/lib/scenecraft-client.ts`:

   ```typescript
   export type RenderJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

   export interface RenderJob {
     id: string
     name: string
     snapshotCommitSha: string
     inSeconds: number
     outSeconds: number
     settings: RenderSettings
     status: RenderJobStatus
     queuePosition: number
     outputPath: string | null
     progress: number
     errorMessage: string | null
     submittedAt: string
     startedAt: string | null
     completedAt: string | null
   }

   export interface RenderSettings {
     format: 'mp4' | 'mov'
     codec: 'h264' | 'h265' | 'prores'
     width: number
     height: number
     fps: number
     audioCodec: 'aac' | 'pcm'
     presetId?: string
   }

   export async function listRenderJobs(project: string, statuses?: RenderJobStatus[]): Promise<RenderJob[]>
   export async function createRenderJob(project: string, opts: { name: string; inSeconds: number; outSeconds: number; settings: RenderSettings }): Promise<RenderJob>
   export async function updateRenderJob(project: string, id: string, patch: Partial<Pick<RenderJob, 'name' | 'inSeconds' | 'outSeconds' | 'settings'>>): Promise<RenderJob>
   export async function deleteRenderJob(project: string, id: string): Promise<void>
   export async function rerunRenderJob(project: string, id: string): Promise<RenderJob>
   export async function duplicateRenderJob(project: string, id: string): Promise<RenderJob>
   export async function cancelRenderJob(project: string, id: string): Promise<RenderJob>
   export async function reorderRenderJobs(project: string, ids: string[]): Promise<void>
   export async function startRenderQueue(project: string): Promise<RenderJob | null>
   export async function clearRenderedJobs(project: string): Promise<void>
   export async function clearAllRenderJobs(project: string): Promise<void>

   export function renderJobOutputUrl(project: string, id: string, opts?: { attachment?: boolean }): string
   ```

4. **Snake-case ↔ camelCase** conversion at the client boundary — reuse existing client conventions for this project.

5. **Tests** in `scenecraft-engine/tests/test_render_jobs_api.py`:
   - Create → row has `snapshot_commit_sha` matching a real commit
   - Two creates without edits → same `snapshot_commit_sha` (content-addressed dedup verified)
   - Patch a queued row → succeeds
   - Patch a running row → 409
   - Delete a running row → 409
   - Rerun → new id, same commit sha, status=queued
   - Duplicate → new id, **different** commit sha if live db has changed since original; same commit sha if unchanged
   - Reorder rewrites positions
   - Start picks top queued, marks running
   - Clear-rendered leaves queued + running intact
   - GET /output 404 for missing; 409 for queued (no output_path); 200 with range support for completed

---

## Verification

- [ ] All 11 endpoints registered and return correct status codes
- [ ] Create call captures commit via `commit_working_copy`
- [ ] Content-addressed dedup verified (two creates without edits share a sha)
- [ ] 409 returned for edit/delete on non-queued rows where stated
- [ ] Frontend client helpers compile, types match
- [ ] `renderJobOutputUrl` helper produces correct URL with/without attachment flag
- [ ] All tests pass

---

**Next Task**: [Task 108: Backend worker + snapshot isolation + WS events](task-108-backend-worker.md)
