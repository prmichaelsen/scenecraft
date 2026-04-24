# Task 129: Musicful Client + Backend Plugin

**Milestone**: [M16](../../milestones/milestone-16-music-generation-plugin.md)
**Spec**: `agent/specs/local.music-generation-plugin.md` — R5, R6, R13-R21, R52-R53
**Estimated Time**: 6 hours
**Dependencies**: task-127 (schema + helpers), task-128 (call_service shim)
**Status**: Not Started

---

## Objective

Wrap the Musicful REST API in a thin client, implement the `generate_music.run` handler + polling worker, wire up JobManager progress events. Happy path, partial success, full failure, and 429 retry all covered.

---

## Files

Create:
- `scenecraft-engine/src/scenecraft/plugins/generate_music/__init__.py` — exports `activate(api)` + `run`
- `scenecraft-engine/src/scenecraft/plugins/generate_music/client.py` — Musicful REST wrapper
- `scenecraft-engine/src/scenecraft/plugins/generate_music/generate_music.py` — kickoff + polling worker + helpers
- `scenecraft-engine/src/scenecraft/plugins/generate_music/plugin.yaml` — manifest (docs-only in M16)
- `scenecraft-engine/src/scenecraft/plugins/generate_music/README.md` — short operator doc
- `scenecraft-engine/src/scenecraft/plugins/generate_music/tests/test_generate_music.py`

---

## Steps

### 1. `client.py` — Musicful wrapper

Thin functions over `plugin_api.call_service(service='musicful', ...)`:

- `musicful_generate(payload: dict) -> list[str]` — POST `/v1/music/generate`, returns task_ids list
- `musicful_get_tasks(task_ids: list[str]) -> list[Song]` — GET `/v1/music/tasks?ids=...`, returns parsed rows
- `musicful_get_key_info() -> dict` — GET `/v1/get_api_key_info`, returns `{key_music_counts, email, ...}`

`Song` dataclass mirrors the spec's Song shape: `{id, title, style, duration, audio_url, cover_url, status, song_id, lyric, fail_code, fail_reason}`.

### 2. `generate_music.py` — `run` handler

```python
def run(project_dir, project_name, *, action, style, lyrics=None, title=None,
        instrumental=0, gender=None, model='MFV2.0',
        entity_type=None, entity_id=None) -> dict:
    """Kick off a music generation. Returns {generation_id, task_ids, job_id} or {error}."""
```

Flow (R13-R15):
1. Validate `action in ('auto', 'custom')` (R5). Other actions → return `{error: 'action not supported in MVP'}`.
2. Validate `style` non-empty; if `action='custom'` and `instrumental=0` and `lyrics` empty → reject.
3. Create `generate_music__generations` row with `status='pending'`, `entity_type`, `entity_id`, `created_by='plugin:generate-music'`.
4. Build payload (R13 filter-by-action):
   - `auto`: `{action, style, instrumental, gender, model, mv: model}`
   - `custom`: `{action, style, lyrics, title, instrumental, gender, model, mv: model}`
   - Drop `lyrics` if `instrumental=1` even in custom mode.
5. Call `musicful_generate(payload)`. On exception → update row to `status='failed'` with error; return `{error}`.
6. Update row: `task_ids_json`, `status='running'`.
7. Create JobManager job with `meta={'generationId': id, 'entityType': entity_type, 'entityId': entity_id}`.
8. Start polling worker in a daemon thread (see step 3).
9. Return `{generation_id, task_ids, job_id}`.

### 3. Polling worker

Box drives 5s cadence (spec "Option 1 — box drives cadence"):

```python
def _poll_worker(project_dir, generation_id, task_ids, job_id, auth_context):
    poll_interval = 5.0
    pending = set(task_ids)
    completed_songs = {}
    failed_tasks = {}
    retry_budget = 3      # per R17
    backoff = [1.0, 2.0, 4.0]

    while pending:
        time.sleep(poll_interval)
        try:
            songs = musicful_get_tasks(list(pending))
        except ServiceError as e:
            if e.status == 429:
                # Exponential backoff up to retry_budget
                if not backoff:
                    _finalize_failed(generation_id, job_id, 'rate_limit_exceeded')
                    return
                time.sleep(backoff.pop(0))
                continue
            _finalize_failed(generation_id, job_id, f'musicful_http_{e.status}')
            return

        for song in songs:
            if song.is_terminal_completed:
                completed_songs[song.id] = song
                pending.discard(song.id)
            elif song.is_terminal_failed:
                failed_tasks[song.id] = song
                pending.discard(song.id)
        job_manager.update_progress(job_id, completed=len(completed_songs) + len(failed_tasks),
                                    detail=f'{len(completed_songs)}/{len(task_ids)} completed')

    _finalize(project_dir, generation_id, job_id, completed_songs, failed_tasks, auth_context)
```

### 4. `_finalize` — writes on completion

For each completed song:
1. Download mp3 to `pool/segments/<uuid>.mp3` (use `httpx` streaming download with timeout).
2. `plugin_api.add_pool_segment(project_dir, kind='generated', created_by='plugin:generate-music', variant_kind='music', context_entity_type=row.entity_type, context_entity_id=row.entity_id, generation_params={...}, ...)` → seg_id.
3. Plugin-local `add_generation_track(generation_id, seg_id, musicful_task_id=song.id, song_title=song.title, duration_seconds=song.duration, cover_url=song.cover_url)`.
4. If row has `entity_type='audio_clip'`: `plugin_api.add_audio_candidate(...)` (R22).
5. If row has `entity_type='transition'`: `plugin_api.add_tr_candidate(..., source='generated')` (R23).

After all successful songs:
6. If `completed_songs` non-empty:
   - `plugin_api.record_spend(plugin_id='generate-music', username=auth_context.username, org=auth_context.org, amount=len(completed_songs), unit='credit', operation='generate-music.run', job_ref=generation_id, metadata={'task_ids': list(task_ids)}, api_key_id=auth_context.api_key_id, source='local')`
7. Update row status:
   - All succeeded: `status='completed'`, error=NULL
   - Partial: `status='completed'`, error=concat of fail_reasons (R20)
   - All failed: `status='failed'`, error=concat of fail_reasons; NO `record_spend`; NO pool_segments (R21)
8. `job_manager.complete_job(job_id, {'generation_id': generation_id, 'pool_segment_ids': [...]})` on success, `fail_job` otherwise.

### 5. Download failure handling

- mp3 download returns 404 → don't create pool_segment for that task; treat as failed per R21 behavior
- Partial file cleanup: use `<uuid>.mp3.tmp`, rename atomically on successful download

### 6. Resumable-on-restart

Background startup hook (plugin activation) scans `generate_music__generations` for rows with `status IN ('pending', 'running')` and re-attaches polling workers for them. Otherwise a server restart mid-generation leaves orphan rows.

### 7. Tests

Match the spec's Base Cases directly — every test below corresponds to a named test in the spec:

- `generates-music-auto-no-context` — R5, R12, R13, R14, R15, R16, R18, R19, R26, R35, R47
- `generates-music-custom-with-transition-context` — R13, R22, R23, R25
- `generates-music-with-audio-clip-context` — R22, R25
- `rejects-unsupported-action` — R5
- `partial-success-one-of-two-tasks` — R20
- `rate-limit-retry-succeeds` — R17
- `rate-limit-exhausts-retries` — R17
- `non-retriable-http-fails-immediately` — R17
- `instrumental-1-drops-lyrics` — R13
- `action-auto-ignores-lyrics-and-title` — R13
- `duplicate-task-id-idempotent-poll` — R16
- `no-pools-leaks-on-download-failure` — R18
- `very-long-style-accepted` + `style-over-limit-rejected` + `empty-style-rejected` — R13
- `concurrent-generations-independent` — R14, R16, R47
- `singleton-polling-worker-per-generation` — R16

Mock Musicful with a fake server (spec R55). The `real-musicful-smoke-test` (R56) gated on `MUSICFUL_API_KEY` being set lives in this task's test file too.

---

## Verification

- [ ] All listed tests pass against mock
- [ ] Partial-success leaves exactly the expected rows
- [ ] Polling worker's retry loop backs off at correct intervals (within 10% tolerance)
- [ ] Server restart with `status='running'` row re-attaches the worker
- [ ] Real-API smoke (when env set) produces a completed generation
- [ ] No raw API key in log output or error bodies

---

## Notes

- If a future requirement adds a "cancel generation" flow, the worker needs a cancel signal via JobManager. Not in M16 scope.
- Musicful's task response format — the `status` field is an integer per the spec's extracted docs; make sure the client maps integer codes to `'completed' | 'failed' | 'running'`.
- Keep the downloader straightforward: no partial resume, no multi-connection. Musicful mp3s are short; a single stream is fine.
