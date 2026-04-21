# Task 107: Backend `/lipsync` Endpoint — TTS Mode

**Milestone**: [M13 - Audio Sync Tab](../../milestones/milestone-13-audio-sync.md)
**Design Reference**: [local.audio-sync.md](../../design/local.audio-sync.md)
**Estimated Time**: 5 hours
**Dependencies**: Task 106 (schema)
**Status**: Not Started

---

## Objective

Productionize the prototype in `scenecraft-engine/scripts/sync_lipsync_test.py` into a real backend module and endpoint. This task ships the TTS (Script → ElevenLabs voice) mode only; Task 108 adds S2S.

Implements in `scenecraft-engine/src/scenecraft/lipsync/` and `api_server.py`.

---

## Steps

### 1. Module layout

Create `src/scenecraft/lipsync/`:
- `__init__.py` — public surface (`run_lipsync_tts`, `SyncJobStatus`)
- `sync_client.py` — sync.so HTTP client (multipart upload + polling)

### 2. Sync client

Lift the logic from `scripts/sync_lipsync_test.py` into `sync_client.py`:
- `submit_lipsync_tts(video_path, voice_id, script, *, sync_mode='cut_off') -> job_id`
- `poll_status(job_id) -> SyncJobStatus` (enum or dataclass wrapping `status`, `output_url`, `error`)
- Uses `httpx.AsyncClient` (match the rest of the codebase's async style; or `requests` if that's the convention — check existing generation clients in `render/`)
- Reads `SYNC_API_KEY` from env; raises with a clear error if missing
- 20MB video size cap enforced with a descriptive error

### 3. Orchestrator

`lipsync/__init__.py`:

```python
def run_lipsync_tts(
    project_dir: Path,
    *,
    tr_id: str,
    slot: int,
    source_pool_segment_id: str,
    voice_id: str,
    script: str,
    options: dict | None = None,
) -> str:
    """Kicks off a background job. Returns job_id."""
```

Inside the background task:
1. Resolve source video path: `pool/segments/cand_<source>.mp4` via `get_pool_segment(source_pool_segment_id)`
2. Call `sync_client.submit_lipsync_tts(...)` → sync.so job_id
3. Poll every 5s; emit `job_progress` events (`phase='processing'`, percent from sync.so response when available)
4. On `COMPLETED`: download outputUrl, write to `pool/segments/cand_<new_uuid>.mp4`
5. Insert pool_segments row:
   ```python
   insert_pool_segment(
       id=new_uuid,
       pool_path=f"pool/segments/cand_{new_uuid}.mp4",
       kind="generated",
       variant_kind="lipsync",
       derived_from=source_pool_segment_id,
       generation_params={
           "provider": "sync.so",
           "model": "lipsync-2",
           "mode": "tts",
           "voiceId": voice_id,
           "script": script,
           "options": options or {},
       },
       duration_seconds=_probe(new_path),
       byte_size=new_path.stat().st_size,
       created_by=<session user>,
       created_at=_now_iso(),
   )
   ```
6. Insert `tr_candidates` row: `(tr_id, slot, pool_segment_id=new_uuid, source='generated')`
7. Emit `job_completed` with `{ transitionId, poolSegmentId, derivedFrom, slot }`

Use the existing JobManager — don't invent a new one. Mirror the shape of `generate_transition_candidates` kickoff.

### 4. Endpoint

In `api_server.py`:

```python
@app.post("/api/projects/{name}/transitions/{tr_id}/lipsync")
async def post_lipsync(name: str, tr_id: str, body: dict):
    if body.get("mode") != "tts":
        raise HTTPException(400, "Task 107 only supports mode='tts' — S2S lands in Task 108")
    required = ["source_pool_segment_id", "voice_id", "script"]
    missing = [k for k in required if not body.get(k)]
    if missing:
        raise HTTPException(400, f"Missing required fields: {missing}")
    job_id = run_lipsync_tts(
        project_dir=...,
        tr_id=tr_id,
        slot=body.get("options", {}).get("slot", 0),
        source_pool_segment_id=body["source_pool_segment_id"],
        voice_id=body["voice_id"],
        script=body["script"],
        options=body.get("options"),
    )
    return {"jobId": job_id}
```

Match the patterns in existing generation endpoints (look at `/generate-transitions`).

### 5. Tests

`tests/test_lipsync.py`:
- `sync_client.submit_lipsync_tts` builds the correct multipart request (assert the `input` JSON block with the ElevenLabs provider, assert model=lipsync-2)
- `sync_client.poll_status` parses `COMPLETED` / `FAILED` / `REJECTED` response shapes
- Integration (mocked sync.so via `respx` or local HTTP fixture): full flow from endpoint → pool_segments row + tr_candidates row + file on disk
- `run_lipsync_tts` rejects missing env var with a clear error
- `run_lipsync_tts` rejects >20MB video with a clear error

---

## Verification

- [ ] `POST /transitions/:tr_id/lipsync` with `mode='tts'` returns `{jobId}`
- [ ] WS subscribers to `/ws/jobs` receive `job_progress` and `job_completed` for the job
- [ ] Mocked integration test: on `COMPLETED`, a new `pool/segments/cand_<uuid>.mp4` exists, a `pool_segments` row with `variant_kind='lipsync'` + `derived_from=<source>` exists, and a `tr_candidates` row on the target transition exists
- [ ] Missing required fields → 400 with a helpful message
- [ ] `mode='s2s'` → 400 (reserved for Task 108)
- [ ] Real-API smoke (manual): run against staging with a real `SYNC_API_KEY` and a small fixture video → end-to-end lipsync video in the pool
