# Task 108: Backend Render Worker + Snapshot Isolation + WS Events

**Milestone**: [M12 — Render Workspace](../../milestones/milestone-12-render-workspace.md)
**Design**: [local.render-workspace.md](../../design/local.render-workspace.md)
**Estimated Hours**: 8
**Status**: Not Started
**Dependencies**: Task 106 (schema), Task 107 (API — specifically `/start` and `/cancel`)

---

## Objective

Implement the async render worker that: polls for top-queued jobs, extracts each pinned VCS commit into a temp directory, invokes the existing composition renderer against that isolated db, streams progress via WebSocket events matching the `job_*` protocol used by chat generation, writes outputs to `renders/{uuid}.{ext}`, and handles cancel/failure cleanly.

---

## Steps

1. **Module layout** — create `scenecraft-engine/src/scenecraft/render_worker.py`.

2. **Single-flight worker**:
   - Module-level `_running_job_id: str | None = None` + `_cancel_event: asyncio.Event | None = None`.
   - Public entry point: `async def start_next_job(project_dir: Path, ws_broadcaster) -> dict | None`.
     - If a job is already running → return its row.
     - Else: fetch `db.next_queued_job(project_dir)`, set it to `running` via `db.update_render_job`, spawn `asyncio.create_task(_run_job(...))`, return the row.
   - Public: `async def cancel_running_job() -> bool` — sets `_cancel_event` if applicable.

3. **`_run_job(project_dir, job, ws_broadcaster)`** body:

   ```python
   import tempfile, shutil, time
   from scenecraft.vcs.objects import copy_snapshot_to, get_commit
   from scenecraft import db

   commit = get_commit(project_dir, job["snapshot_commit_sha"])
   if not commit:
       _fail(project_dir, job, "snapshot commit not found")
       return

   tmp_dir = Path(tempfile.mkdtemp(prefix=f"render_{job['id']}_"))
   temp_db_path = tmp_dir / "project.db"
   output_path = Path("renders") / f"{job['id']}.{job['settings']['format']}"
   abs_output_path = project_dir / output_path
   abs_output_path.parent.mkdir(parents=True, exist_ok=True)

   try:
       copy_snapshot_to(project_dir, commit["db_hash"], temp_db_path)
       await ws_broadcaster.send({
           "type": "job_started",
           "job_id": job["id"],
           "kind": "render",
           "entity_key": job["id"],
       })

       # Invoke existing render module (see Step 4)
       await _invoke_renderer(
           temp_db_path=temp_db_path,
           temp_project_root=tmp_dir,
           in_seconds=job["in_seconds"],
           out_seconds=job["out_seconds"],
           settings=job["settings"],
           output_abs_path=abs_output_path,
           progress_cb=lambda p, stage: asyncio.create_task(
               _emit_progress(ws_broadcaster, job["id"], p, stage)
           ),
           cancel_event=_cancel_event,
       )

       db.update_render_job(project_dir, job["id"], {
           "status": "completed",
           "output_path": str(output_path),
           "progress": 1.0,
           "completed_at": iso_now(),
       })
       await ws_broadcaster.send({
           "type": "job_completed",
           "job_id": job["id"],
           "output_path": str(output_path),
       })
   except CancelledError:
       db.update_render_job(project_dir, job["id"], {
           "status": "canceled",
           "completed_at": iso_now(),
       })
       # Clean up partial output file if created
       if abs_output_path.exists():
           abs_output_path.unlink()
   except Exception as e:
       db.update_render_job(project_dir, job["id"], {
           "status": "failed",
           "error_message": str(e),
           "completed_at": iso_now(),
       })
       await ws_broadcaster.send({
           "type": "job_failed",
           "job_id": job["id"],
           "error": str(e),
       })
   finally:
       shutil.rmtree(tmp_dir, ignore_errors=True)
       globals()["_running_job_id"] = None
       # Auto-advance to next queued job (Resolve-style continuous processing)
       await start_next_job(project_dir, ws_broadcaster)
   ```

4. **`_invoke_renderer(...)`** — bridge to the existing composition render module.
   - Locate the current render entry point in `scenecraft-engine/` (likely in a `render/` subpackage — if not present, the renderer may currently only exist as a script invoked by api_server's extend-video flow).
   - If a clean function signature doesn't exist, add one: `def render_composition(db_path: Path, in_seconds: float, out_seconds: float, settings: dict, output_path: Path, progress_cb, cancel_event) -> None`.
   - **If no such render module exists yet**: stub `_invoke_renderer` with a ffmpeg pipeline that reads the `transitions` table's `final_video_path` entries within `[in, out]` and concatenates them into an MP4. Mark this as MVP and file a follow-up task.

5. **Progress throttling** — `_emit_progress` should throttle to ≤ 2 Hz per job to avoid WS flooding:
   ```python
   _last_emit: dict[str, float] = {}
   async def _emit_progress(ws, job_id, progress, stage):
       now = time.monotonic()
       if now - _last_emit.get(job_id, 0) < 0.5:
           return
       _last_emit[job_id] = now
       db.update_render_job(project_dir, job_id, {"progress": progress})
       await ws.send({
           "type": "job_progress",
           "job_id": job_id,
           "progress": progress,
           "stage": stage,
       })
   ```

6. **Integration with api_server.py**:
   - `POST /render-jobs/start` calls `render_worker.start_next_job(project_dir, ws)` (passing the existing broadcaster).
   - `POST /render-jobs/:id/cancel` calls `render_worker.cancel_running_job()` if the target id matches `_running_job_id`.

7. **Tests** in `scenecraft-engine/tests/test_render_worker.py`:
   - Worker takes top queued and advances to `running` then `completed` (with a mocked `_invoke_renderer`)
   - Snapshot isolation: mutate live `project.db` during a mocked render → output reflects pre-mutation state (verified by hashing a column value from temp_db read inside the mocked renderer)
   - Cancel mid-render transitions to `canceled`, cleans up partial output
   - Failure → status=failed, error_message set
   - Auto-advance: after one job finishes, the next queued is picked up
   - Progress throttled to ≤ 2 Hz

---

## Verification

- [ ] `start_next_job` single-flights correctly (concurrent calls don't double-run)
- [ ] Temp dir created + cleaned up on success, failure, and cancel
- [ ] Output written to `renders/{uuid}.{ext}` under the project dir
- [ ] WS `job_started` / `job_progress` / `job_completed` / `job_failed` events emitted with correct shape
- [ ] Live-db edits during render don't affect output
- [ ] Auto-advance picks up next queued job on completion
- [ ] All tests pass

---

**Notes**:
- If the existing composition renderer can't be called cleanly, Step 4 becomes a minimal ffmpeg stub; file a follow-up task to wire the real renderer. This is the most schedule-risky step in M12 — flag early during estimation.

---

**Next Task**: [Task 109: Frontend timeline render in/out handles](task-109-frontend-timeline-handles.md)
