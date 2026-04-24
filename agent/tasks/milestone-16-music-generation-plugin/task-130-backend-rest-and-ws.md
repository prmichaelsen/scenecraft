# Task 130: Backend REST + WS

**Milestone**: [M16](../../milestones/milestone-16-music-generation-plugin.md)
**Spec**: `agent/specs/local.music-generation-plugin.md` — "REST endpoints" + R47-R49
**Estimated Time**: 3 hours
**Dependencies**: task-126 (auth middleware), task-127 (helpers), task-129 (run handler)
**Status**: Not Started

---

## Objective

Register plugin REST endpoints via `plugin_api.register_rest_endpoint`, each gated by the double-gate auth middleware (task-126). Wire completion events onto the existing `/ws/jobs` WebSocket. No new WS channel; reuse JobManager's broadcast.

---

## Endpoints

All under `POST/GET /api/projects/:project/plugins/generate-music/...`:

### `POST /run`

Body (JSON):
```json
{
  "action": "auto" | "custom",
  "style": "string",
  "lyrics": "string (optional)",
  "title": "string (optional, max 80)",
  "instrumental": 0 | 1,
  "gender": "male" | "female" | "" (optional),
  "model": "MFV2.0" (optional, default),
  "entity_type": "audio_clip" | "transition" | null,
  "entity_id": "string | null"
}
```

Handler:
1. Auth middleware populates `request.auth = {username, org, api_key_id}` (rejects before reaching this handler otherwise).
2. Call `generate_music.run(project_dir, project_name, ...payload, auth_context=request.auth)`.
3. Return the handler's dict: `{generation_id, task_ids, job_id}` with status 200, or `{error}` with appropriate status.

### `GET /generations?entityType=&entityId=`

Query params optional. If both present, filter by them. If absent, return all for the project.

Response: `{generations: [GenerationRow...]}` where `GenerationRow` is the full `generate_music__generations` row + an embedded `tracks: [GenerationTrack...]` array joined via `generate_music__tracks`.

### `POST /generations/:id/retry`

Path param: generation id.

Handler:
1. Look up the failed row (404 if not found or not failed).
2. Read its params.
3. Create new generation row with `reused_from=<failed_id>` and identical params.
4. Kick off a new run (as if the user called `/run` with the same payload).
5. Return new run's `{generation_id, task_ids, job_id}`.

### `GET /credits`

Returns `{credits: number, last_checked_at: "ISO-8601"}`.

- First call per session: fetches `musicful_get_key_info()` and caches with a short TTL (e.g. 60s).
- Subsequent calls within TTL: return cached value.
- If `MUSICFUL_API_KEY` is unset: return `{credits: null, error: "This plugin requires a Musicful API key..."}` with status 503.

---

## WebSocket integration

No new WS channel. Piggyback on existing `/ws/jobs` (from M11 task-101 + `ws_server.JobManager`).

`generate_music.run` already calls `job_manager.create_job('generate_music', total=N, meta={...})` (per task-129). The existing `JobManager._broadcast` fires:

- `job_started` on `create_job`
- `job_progress` on `update_progress` (fired per poll cycle in the worker)
- `job_completed` on `complete_job`
- `job_failed` on `fail_job`

Plugin does NOT emit custom WS events. Everything flows through the JobManager seam already in use by M11 isolation.

Frontend subscribers filter by `jobType === 'generate_music'`.

---

## Registration via plugin_api

In the plugin's `activate(api)` function:

```python
def activate(api):
    api.register_rest_endpoint(
        method='POST',
        path='/run',
        handler=_handle_run,
        auth='required',        # triggers double-gate middleware
    )
    api.register_rest_endpoint(method='GET',  path='/generations',            handler=_handle_list,    auth='required')
    api.register_rest_endpoint(method='POST', path='/generations/:id/retry',  handler=_handle_retry,   auth='required')
    api.register_rest_endpoint(method='GET',  path='/credits',                handler=_handle_credits, auth='required')
```

Plugin paths are auto-prefixed by the host with `/api/projects/:project/plugins/<plugin-id>`. Plugin only declares the suffix.

---

## Tests

- `run-happy-path-returns-ids` — POST with valid payload + auth → 200 with `generation_id`
- `run-without-auth-401` — missing session → 401; missing key → 401; expired key → 401
- `run-with-missing-api-key-env-returns-admin-error` — `MUSICFUL_API_KEY` unset → 200 returning `{error: "This plugin requires a Musicful API key..."}` (from `generate_music.run`)
  - Or 503 if the error is transport-level; confirm with spec's admin-error test
- `list-generations-filtered-by-entity` — `?entityType=transition&entityId=tr-A` returns only tr-A's generations
- `list-generations-unfiltered` — no params returns all
- `retry-creates-new-row` — POST `/generations/:id/retry` → new row with `reused_from=:id`; original unchanged
- `retry-of-completed-row` — 400 or 409; retry is only for failed rows (clarify in handler; spec R51 says "Retry" button appears on failed cards, implying retry is failed-only)
- `credits-cached-within-ttl` — two GETs within TTL → one upstream call
- `credits-refreshed-after-run` — complete a run → next GET hits upstream

WS tests (integration against live server or WS test harness):

- `ws-job-started-fires-on-run` — after POST /run, subscriber receives `job_started` with matching `generationId` in meta
- `ws-job-completed-fires-on-all-tasks-done` — subscriber receives `job_completed` with `pool_segment_ids`

---

## Verification

- [ ] Four endpoints respond correctly for all test cases
- [ ] Double-gate middleware rejects before handlers run (no plugin code executes on 401 paths)
- [ ] `list-generations` respects entity filter
- [ ] `retry` creates new row with `reused_from` and does not mutate the original
- [ ] Credits cache TTL works as spec'd
- [ ] WS subscribers on `/ws/jobs` see the four job events

---

## Notes

- If `plugin_api.register_rest_endpoint` doesn't exist yet (I believe it was stubbed in M11 task-101), extend it in this task. Keep the API narrow: `method`, `path`, `handler`, `auth` flag.
- The `auth='required'` flag is interpreted by the host routing layer — it attaches the middleware from task-126. Don't re-implement auth inside the plugin.
- Responses should use the standard scenecraft-engine error shape (`{error: string, code?: string}`) for consistency with other plugins.
