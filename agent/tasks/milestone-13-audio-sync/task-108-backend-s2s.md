# Task 108: Backend `/lipsync` Endpoint — S2S Mode

**Milestone**: [M13 - Audio Sync Tab](../../milestones/milestone-13-audio-sync.md)
**Design Reference**: [local.audio-sync.md](../../design/local.audio-sync.md)
**Estimated Time**: 4 hours
**Dependencies**: Task 107 (TTS endpoint + sync_client)
**Status**: Not Started

---

## Objective

Add the Audio (S2S) input mode: user provides source audio (upload or an existing pool_segment audio), server runs ElevenLabs Speech-to-Speech with the chosen `voice_id`, passes the result to sync.so.

Implements in `scenecraft-engine/src/scenecraft/lipsync/elevenlabs_s2s.py` and extends the existing `/lipsync` endpoint.

---

## Steps

### 1. Preflight: check for native sync.so S2S

Before building the two-hop path, verify whether sync.so's ElevenLabs provider supports native S2S via an audio input field (e.g. `{"type":"audio","provider":{"name":"elevenlabs","voiceId":..., "source_audio_url":...}}` or similar). If yes, the whole task collapses to a provider-payload difference in `sync_client.submit_lipsync_s2s()` — do that and skip Step 2/3 below.

Cite the sync.so docs or API response probe in the PR description.

### 2. ElevenLabs S2S client (if native not available)

Create `lipsync/elevenlabs_s2s.py`:

```python
async def s2s(
    source_audio_path: Path,
    voice_id: str,
    *,
    output_format: str = "mp3_44100_128",
) -> Path:
    """Call ElevenLabs /v1/speech-to-speech/{voice_id} with the audio file. Returns path to the resulting audio."""
```

- Reads `ELEVENLABS_API_KEY` from env; raises with a clear error if missing
- Writes output to a temp file; caller is responsible for cleanup (or returns bytes — match the sync_client's expected input)
- Timeout + size caps consistent with ElevenLabs' API limits (10MB source audio per their docs as of 2026-04)

### 3. Resolve `source_audio_ref`

The endpoint accepts `source_audio_ref` as either:
- A pool_segment_id (for audio pool segments — `pool_segments.kind = 'audio'` with a valid `pool_path`)
- A multipart upload handle (new audio supplied inline; store transiently in `tmp/`)

Helper:

```python
def _resolve_source_audio(project_dir: Path, ref: str, upload: UploadFile | None) -> Path:
    ...
```

### 4. Orchestrator

Extend `run_lipsync_tts` → add `run_lipsync_s2s(..., source_audio_ref, ...)`:

1. Resolve source audio path
2. Emit `job_progress` with `phase='s2s'`
3. Call `elevenlabs_s2s.s2s(source_audio_path, voice_id)` → produces target-voice audio
4. Call `sync_client.submit_lipsync_with_audio(video_path, audio_path)` (new method — passes audio as `input=[{"type":"audio","url":...}]` or multipart file, whichever sync.so accepts)
5. From here, same as TTS mode (poll → download → insert rows → complete)

The `generation_params` records:

```python
{
    "provider": "sync.so",
    "model": "lipsync-2",
    "mode": "s2s",
    "voiceId": voice_id,
    "sourceAudioRef": ref,  # pool_segment_id if applicable; 'upload' otherwise
    "options": options or {},
}
```

(Never store the audio bytes in `generation_params`.)

### 5. Endpoint

In the existing `/lipsync` handler, branch on `mode`:

```python
if body.get("mode") == "tts":
    ... # existing path from Task 107
elif body.get("mode") == "s2s":
    if not body.get("source_audio_ref") and not (upload := <multipart audio file>):
        raise HTTPException(400, "S2S mode requires source_audio_ref or an audio upload")
    job_id = run_lipsync_s2s(...)
    return {"jobId": job_id}
else:
    raise HTTPException(400, f"Unknown mode: {body.get('mode')}")
```

Accept multipart uploads on this endpoint; if sync.so native S2S is available, the endpoint may skip the ElevenLabs hop entirely — the frontend contract is the same either way.

### 6. Tests

Extend `tests/test_lipsync.py`:
- Mocked ElevenLabs S2S (via `respx`): builds correct POST, handles 200 audio response, returns a playable audio file
- End-to-end (mocked both APIs): S2S mode produces the same pool_segments/tr_candidates shape as TTS
- `source_audio_ref` resolution: pool_segment_id path, upload path, invalid path (400)
- Missing `ELEVENLABS_API_KEY` → surfaces clear error via `job_failed` WS event (not a 500)

---

## Verification

- [ ] Pre-check documented in PR: whether sync.so native S2S is used or the two-hop path
- [ ] `POST /lipsync` with `mode='s2s'` + `source_audio_ref` succeeds and emits `job_progress` with `phase='s2s'` when the two-hop path is used
- [ ] Multipart upload on the endpoint is handled for the inline-audio case
- [ ] Both pool_segment audio refs and inline uploads resolve correctly
- [ ] `generation_params` records `mode='s2s'` + the ref; audio bytes are never stored in the DB
- [ ] Real-API smoke (manual): staging run with a real source audio + real keys → lipsynced video with the target voice
