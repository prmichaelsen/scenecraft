# Spec: Offline Audio Bounce + Mix Analysis (Frontend-as-Source-of-Truth)

> **Agent Directive**: This spec is the retroactive black-box contract for the
> frontend-rendered audio bounce + mix analysis round-trip. The **Behavior
> Table** is the reviewer's proofing surface; the **Tests** section is the
> executable contract. Every `undefined` row is linked to an Open Question —
> do not silently guess, update the spec.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Retroactive (codifies existing behavior)

---

## Purpose

Codify the end-to-end contract of the offline bounce + mix-analysis pipeline:
the frontend renders PCM via `OfflineAudioContext` cloning the live mix graph,
encodes WAV (16 / 24 / 32-float bit depth), POSTs to the engine; the engine
stores the WAV content-addressed under `pool/mixes/` (analysis) or
`pool/bounces/` (bounce), then for analysis runs librosa + pyloudnorm and
caches the result. The **bit-identical offline = live** invariant is load-
bearing: the backend never reimplements the mixer.

## Source

- Retroactive black-box spec (`--from-draft`, interactive) derived from:
  - `scenecraft/src/lib/mix-render.ts` (frontend render + WAV encoder)
  - `scenecraft/src/lib/chat-client.ts` (`handleMixRenderRequest`, `handleBounceAudioRequest`, `filterTracksForBounce`)
  - `scenecraft-engine/src/scenecraft/chat.py` — `_exec_analyze_master_bus` (line ~3036), `_exec_bounce_audio` (line ~3422), `_MIX_RENDER_EVENTS`, `_BOUNCE_RENDER_EVENTS`. **Note**: there are NO separate `bounce_audio.py` / `analyze_master_bus.py` modules; the logic is inlined in `chat.py`.
  - `scenecraft-engine/src/scenecraft/api_server.py` (`/mix-render-upload`, `/bounce-upload`)
- Audit report: `agent/reports/audit-2-architectural-deep-dive.md` §1E unit 3; §2 invariant `Audio = Frontend`.

## Scope

**In-scope**:
- `renderMixToBuffer(tracks, opts)` — bit-identical offline render via `OfflineAudioContext` reusing `mix-graph.ts`.
- `encodePCMToWav(pcm, sr, channels, bitDepth)` at 16 / 24 / 32-bit.
- WS round-trip: `mix_render_request` / `bounce_audio_request` → PCM → WAV → HTTP multipart POST.
- `/mix-render-upload` + `/bounce-upload` upload validation (hash, sample_rate, channels, duration drift ≤ 100ms).
- Content-addressed WAV persistence at `pool/mixes/<mix_graph_hash>.wav` and `pool/bounces/<composite_hash>.wav`.
- `_exec_analyze_master_bus` cache lookup + librosa/pyloudnorm analyses (peak, true_peak, RMS, LUFS, clipping_detect, spectral_centroid, dynamic_range).
- `_exec_bounce_audio` selection filter (`full` / `tracks` / `clips`), bit-depth + sample-rate validation, cache by `composite_hash`.
- Live-playback pause/resume around offline render.
- The **"backend MUST NOT reimplement the mixer"** invariant.

**Out-of-scope** (covered elsewhere):
- Construction of the live mix graph (crossfade math, effect chain topology, clip scheduling) — see `local.webaudio-mixer-and-mix-graph`.
- Per-effect DSP math — see `local.audio-effects-and-curve-scheduling`.
- `mix_graph_hash` / `composite_hash` field composition — see hash-specific specs.
- Chat-tool destructive-op elicitation (analyze / bounce are both non-destructive).

---

## Requirements

1. **R1 — Bit-identical offline render.** `renderMixToBuffer` wires the exact same topology as the live mixer (`source → clipGain → crossfadeGain → trackGain → masterGain → masterFxChain → destination`) via the shared `mix-graph.ts` helpers. For a given `(tracks, startTimeS, endTimeS, sampleRate, channels, masterEffects)`, the returned PCM is byte-identical to the rendered output of the live mixer for the same window.
2. **R2 — Window semantics.** `renderMixToBuffer({startTimeS, endTimeS})` includes every clip whose `[start_time, end_time)` intersects the window; clips entirely outside are omitted. Requires `endTimeS > startTimeS` or throws. The offline clock `t = 0` corresponds to timeline `t = startTimeS`.
3. **R3 — Channel + sample-rate contract.** `channels ∈ {1, 2}` (default 2); `sampleRate` defaults to 48000 and must be > 0. Any other channel count throws. Output `pcm` is interleaved L/R for stereo, mono verbatim for mono.
4. **R4 — WAV bit depth.** `encodePCMToWav` supports `bitDepth ∈ {16, 24, 32}`. 16/24 are signed PCM `wFormatTag=0x0001`; 32 is IEEE-754 float `wFormatTag=0x0003`. Default 16. Values outside this set throw. Output conforms to the canonical 44-byte RIFF/WAVE header documented in `mix-render.ts`.
5. **R5 — Clip decode resilience.** `resolveClipBuffer` consults the shared buffer cache (keyed by `clip.source_path`); on fetch / decode failure it logs and returns `null`, and the caller drops that clip from the schedule rather than failing the whole render.
6. **R6 — Live-playback pause/resume.** Both `handleMixRenderRequest` and `handleBounceAudioRequest` pause the live mixer before rendering iff `isPlaying` is true and a `mixer` is supplied; they resume (only if previously playing) in a `finally` block that runs on success and on failure. If no mixer / not playing, neither pause nor resume is attempted.
7. **R7 — Upload contract (mix-render).** Client POSTs multipart to `/api/projects/:name/mix-render-upload` with fields `audio` (WAV blob), `mix_graph_hash` (64-char hex), `start_time_s`, `end_time_s`, `sample_rate`, `channels`, `request_id`. Server validates: hex length; numeric parsability; `channels ∈ {1,2}`; `sample_rate > 0`; `end_time_s > start_time_s`; WAV header `channels` and `sampleRate` match form fields; WAV `duration = frames/sr` is within 100ms of `end - start`. On any failure after bytes hit disk, the file is unlinked. Response 200 echoes `rendered_path`.
8. **R8 — Upload contract (bounce).** Same shape, posted to `/api/projects/:name/bounce-upload`, substituting `composite_hash` for `mix_graph_hash` and adding `bit_depth ∈ {16,24,32}`.
9. **R9 — Content-addressed persistence.** WAV lands at `pool/mixes/<mix_graph_hash>.wav` (analysis) or `pool/bounces/<composite_hash>.wav` (bounce). Re-upload with the same hash overwrites the same bytes (safe: same graph ⇒ same bytes).
10. **R10 — WS round-trip + event signalling.** Chat tool creates an `asyncio.Event`, registers it in `_MIX_RENDER_EVENTS` / `_BOUNCE_RENDER_EVENTS` keyed by `request_id` (uuid4 hex), emits the WS request, then `await event.wait()` with a timeout (default 60s; monkeypatchable via `MIX_RENDER_TIMEOUT_S` / `BOUNCE_RENDER_TIMEOUT_S`). The upload handler calls `set_mix_render_event(request_id)` / `set_bounce_render_event(request_id)` on success. On timeout the tool returns `{"error": "... timeout ...", ...}`.
11. **R11 — Cache (analysis).** `_exec_analyze_master_bus` keys its cache by `(mix_graph_hash, start_time_s, end_time_s, sample_rate, analyzer_version)`. A cache hit returns `cached: true` and the persisted scalars / clipping-event count **without** re-decoding the WAV or re-running librosa. `force_rerun: true` deletes the prior row and re-analyzes.
12. **R12 — Cache (bounce).** `_exec_bounce_audio` keys by `composite_hash` (which already encodes mode/selection/window/format). A hit with `rendered_path != null` returns `cached: true` + download URL. A row with `rendered_path = null` (prior timeout) is deleted before retry.
13. **R13 — Analyses & scalars.** Known analyses are `peak`, `true_peak`, `rms`, `lufs`, `clipping_detect`, `spectral_centroid`, `dynamic_range`. Unknown names are silently skipped. Silence / too-short buffers map to `-inf` (peak/lufs) and `dynamic_range` is skipped (not persisted) when either input is `-inf`. Clipping threshold is `|y| ≥ 0.99`; runs separated by < 10ms are merged.
14. **R14 — Bounce validation.** `sample_rate ∈ {44100, 48000, 88200, 96000}`; `bit_depth ∈ {16, 24, 32}`; `channels ∈ {1, 2}`; `start_time_s ≥ 0`; `end_time_s > start_time_s` (if `end_time_s` null → resolved as `MAX(audio_clips.end_time)` with `deleted_at IS NULL`); `track_ids` and `clip_ids` are mutually exclusive; existence of referenced `track_ids` / `clip_ids` is verified before rendering. Any violation → `{"error": ...}`.
15. **R15 — Selection filter.** `filterTracksForBounce`:
    - `full` → unchanged tracks;
    - `tracks` → tracks whose id is in `track_ids`;
    - `clips` → clips whose id is in `clip_ids`; tracks with zero matching clips are dropped.
    Mixer mute/solo semantics still apply inside each track.
16. **R16 — Sample-rate agreement.** On analyze, if the WAV's header sample_rate ≠ the requested `sample_rate` (cache key), return `{"error": ...}` — the cache row is never written.
17. **R17 — Frontend-as-source-of-truth invariant.** The backend MUST NOT contain any code that synthesizes or mixes PCM. Its only audio-production role is (a) storing bytes uploaded by the frontend at a content-addressed path, and (b) reading those bytes back for analysis. Any future feature that needs rendered PCM goes through the same WS round-trip.
18. **R18 — Fire-and-forget handler.** The frontend WS handlers swallow all render/encode/upload errors (logged to `console.warn`); the backend times out on its own. The frontend never retries.
19. **R19 — Pending-row cleanup on failure.** On WS send failure, upload timeout, WAV-still-missing race, or stat/wave-open failure, `_exec_bounce_audio` deletes the pending `audio_bounces` row before returning the error.
20. **R20 — Single-writer per (user, project) (INV-1).** Concurrent `analyze_master_bus` or `bounce_audio` calls from the **same user on the same project** are explicitly out of scope and undefined. Concurrent calls from different users, or from the same user across different projects, MUST work. No per-project mutex is held across these tool calls; enforcement is by the session/working-copy model.
21. **R21 — Hash-compute / cache-lookup atomicity.** `compute_mix_graph_hash` and the cache lookup execute back-to-back within a single request against the current DB snapshot. A concurrent write between the two steps naturally invalidates the hash on the next request (hash changes ⇒ new cache key). No transaction wraps compute+lookup.
22. **R22 — WS handler vs ChatPanel unmount.** The backend's `asyncio.Event` for a request is popped in a `finally` block regardless of client lifecycle. If the ChatPanel unmounts while a handler is in flight, the frontend WS handler reference is lost, but the backend `set_mix_render_event` / `set_bounce_render_event` call on upload completes without side effects (no callback fires on the stale handler).
23. **R23 — Interrupted upload.** The `/mix-render-upload` and `/bounce-upload` handlers require `content-length` and validate that the full body was read. A client disconnect mid-body raises `BounceUploadInterrupted` (bounce) or the equivalent mix-render error. No partial WAV is persisted; any bytes already staged are unlinked.
24. **R24 — Live-playback pause/resume pair.** The frontend `handleMixRenderRequest` / `handleBounceAudioRequest` pause the live mixer **before** triggering the render and resume it in a `finally` block **after** upload completes (or fails). The pause/resume pair is symmetric and already present in shipped code — spec codifies it as a stable contract.
25. **R25 — Late upload is a no-op.** When an upload arrives with a `request_id` whose event has already been popped from `_MIX_RENDER_EVENTS` / `_BOUNCE_RENDER_EVENTS` (e.g., because the tool already timed out), `set_*_event` returns `False`, the server persists the WAV (content-addressed, harmless), but no waiter is notified. Orphan WAV is acceptable under the content-addressed model; no GC is specified.

---

## Interfaces

### Frontend — `renderMixToBuffer`

```ts
renderMixToBuffer(
  tracks: readonly AudioTrack[],
  options: {
    startTimeS: number          // required, ≥ 0
    endTimeS:   number          // required, > startTimeS
    sampleRate?: number         // default 48000
    channels?:  1 | 2           // default 2
    projectName: string
    masterEffects?: readonly TrackEffect[]
    // injection hooks: offlineCtxFactory, sourceUrlFactory, fetchBytes, decode, bufferCache
  },
): Promise<{
  pcm: Float32Array             // interleaved when stereo, mono verbatim
  channels: 1 | 2
  sampleRate: number
  durationSeconds: number       // frames / sampleRate
}>
```

### Frontend — `encodePCMToWav`

```ts
encodePCMToWav(
  pcm: Float32Array,
  sampleRate: number,
  channels: 1 | 2,
  bitDepth: 16 | 24 | 32 = 16,
): ArrayBuffer                  // canonical 44-byte header + LE samples
```

### WS messages (server → client)

```ts
type MixRenderRequest = {
  type: 'mix_render_request'
  request_id: string            // uuid4 hex
  mix_graph_hash: string        // 64-char hex SHA-256
  start_time_s: number
  end_time_s: number
  sample_rate: number
}

type BounceAudioRequest = {
  type: 'bounce_audio_request'
  request_id: string
  bounce_id: string
  composite_hash: string        // 64-char hex
  start_time_s: number
  end_time_s: number
  mode: 'full' | 'tracks' | 'clips'
  track_ids?: string[] | null
  clip_ids?: string[] | null
  sample_rate: number
  bit_depth: 16 | 24 | 32
  channels: 1 | 2
}
```

### HTTP — `POST /api/projects/:name/mix-render-upload`

Multipart form: `audio`, `mix_graph_hash`, `start_time_s`, `end_time_s`, `sample_rate`, `channels`, `request_id`.
Response 200: `{ "rendered_path": "pool/mixes/<hash>.wav", ... }`
Response 400: `{ "error": { "code": "BAD_REQUEST", "message": "..." } }` (missing field / hash malformed / channel mismatch / sample-rate mismatch / duration drift > 100ms / invalid WAV)

### HTTP — `POST /api/projects/:name/bounce-upload`

Same shape, `composite_hash` + `bit_depth`; writes to `pool/bounces/<composite_hash>.wav`.

### Chat tool result (analyze, cache miss)

```json
{
  "run_id": "...",
  "cached": false,
  "mix_graph_hash": "...",
  "start_time_s": 0.0,
  "end_time_s": 120.5,
  "rendered_path": "pool/mixes/<hash>.wav",
  "scalars": {
    "peak_db": -3.1,
    "true_peak_db": -2.9,
    "lufs_integrated": -14.2,
    "clip_count": 0,
    "dynamic_range_db": 11.1
  },
  "clipping_events": 0,
  "analyses_written": ["peak","true_peak","rms","lufs","clipping_detect","spectral_centroid","dynamic_range"]
}
```

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | Render a window with 2 overlapping clips across 2 tracks | PCM is bit-identical to live mixer for same window | `render-matches-live-bit-identical` |
| 2 | Request exceeds project length (endTimeS > last clip end) | Clips scheduled normally; silence fills trailing frames | `render-past-project-end-fills-silence` |
| 3 | `endTimeS <= startTimeS` | `renderMixToBuffer` throws before creating an OfflineAudioContext | `rejects-inverted-window` |
| 4 | `channels = 3` | Throws; no context created | `rejects-unsupported-channel-count` |
| 5 | `bitDepth = 8` | `encodePCMToWav` throws | `rejects-unsupported-bit-depth` |
| 6 | Encode 16-bit | int16 LE PCM, `wFormatTag=0x0001`, round-trips via Python `wave` | `encodes-16bit-pcm` |
| 7 | Encode 24-bit | 3-byte LE packed PCM, `wFormatTag=0x0001`, round-trips via `soundfile` | `encodes-24bit-pcm` |
| 8 | Encode 32-bit float | IEEE-754 LE, `wFormatTag=0x0003`, no clipping / no quantization | `encodes-32bit-float-lossless` |
| 9 | Clip `source_path` 404s | Clip dropped from schedule; render completes; other clips present | `drops-unreachable-clip` |
| 10 | Live mixer playing when WS request arrives | Mixer paused before render; resumed after upload | `pauses-and-resumes-live-playback` |
| 11 | Live mixer not playing | No pause / no resume is called | `no-pause-when-not-playing` |
| 12 | Render succeeds, upload 500s | Handler logs warning; live playback still resumed | `resumes-playback-on-upload-failure` |
| 13 | Upload with mismatched WAV header channels | Server returns 400; file deleted from disk | `server-rejects-channel-mismatch` |
| 14 | Upload with >100ms duration drift | Server returns 400; file deleted | `server-rejects-duration-drift` |
| 15 | Upload with malformed `mix_graph_hash` | Server returns 400 before writing bytes | `server-rejects-bad-hash` |
| 16 | Analyze: cache hit | Returns `cached: true`; librosa never invoked | `analyze-cache-hit-skips-librosa` |
| 17 | Analyze: cache miss, WAV already on disk, no ws | Proceeds to analyze; no WS emission | `analyze-uses-existing-wav` |
| 18 | Analyze: cache miss, WAV absent, no ws | Returns error with `expected_rendered_path` | `analyze-no-ws-no-wav-errors` |
| 19 | Analyze: cache miss, WAV absent, ws present | Emits `mix_render_request`, awaits event, analyzes on arrival | `analyze-full-ws-roundtrip` |
| 20 | Analyze: ws round-trip times out (60s default) | Returns `{"error": "mix render timeout ..."}`; cache row NOT created | `analyze-timeout-no-cache-row` |
| 21 | Analyze: requested `sample_rate` differs from WAV header | Returns error; cache row NOT created | `analyze-sr-mismatch-errors` |
| 22 | Analyze silence (all-zero WAV) | `peak_db = -inf`, `lufs = -inf`, `dynamic_range` skipped, `clip_count = 0` | `analyze-silence-infinities` |
| 23 | Analyze: LUFS buffer too short (<400ms) | `lufs_integrated = -inf`; other analyses still written | `analyze-short-buffer-lufs-neg-inf` |
| 24 | Analyze unknown analysis name | Silently skipped; not listed in `analyses_written` | `analyze-unknown-skipped` |
| 25 | Analyze: librosa raises mid-run | Pending run row deleted; returns `{"error": ...}` | `analyze-cleans-up-on-failure` |
| 26 | Analyze with `force_rerun: true` over existing row | Old row deleted; new row persisted; returns `cached: false` | `analyze-force-rerun-replaces` |
| 27 | Bounce: `full` mode end-to-end | WAV written to `pool/bounces/<hash>.wav`; download URL returned | `bounce-full-mode-happy` |
| 28 | Bounce: `tracks` mode filters to given track ids | Only listed tracks are in the rendered PCM | `bounce-tracks-mode-filters` |
| 29 | Bounce: `clips` mode drops tracks with no matching clips | Tracks emptied by filter are omitted entirely | `bounce-clips-mode-drops-empty-tracks` |
| 30 | Bounce: both `track_ids` and `clip_ids` non-empty | Error: "pass either track_ids or clip_ids, not both" | `bounce-mutex-selection` |
| 31 | Bounce: `track_ids` contains non-existent id | Error with `"track_ids not found: [...]"` | `bounce-missing-track-id` |
| 32 | Bounce: `sample_rate = 22050` (not in allow-list) | Error listing valid sample rates | `bounce-invalid-sample-rate` |
| 33 | Bounce: `bit_depth = 20` | Error listing valid bit depths | `bounce-invalid-bit-depth` |
| 34 | Bounce: cache hit (row + file present) | Returns `cached: true` with download URL; no WS emission | `bounce-cache-hit` |
| 35 | Bounce: prior pending row (rendered_path=null) | Old row deleted; fresh request proceeds | `bounce-retry-deletes-pending` |
| 36 | Bounce: WS send fails | Pending row deleted; error returned | `bounce-ws-send-fail-cleanup` |
| 37 | Bounce: upload times out | Pending row deleted; timeout error returned | `bounce-upload-timeout-cleanup` |
| 38 | Backend synthesizes PCM anywhere | MUST NOT happen — structural invariant | `backend-never-synthesizes-pcm` |
| 39 | Two concurrent `analyze_master_bus` calls with same mix_graph_hash from the SAME user + project | Out of scope per INV-1 (single-writer); undefined by design | `analyze-same-user-same-project-undefined-per-inv1` |
| 40 | Two concurrent bounces with same composite_hash from the SAME user + project | Out of scope per INV-1 (single-writer); undefined by design | `bounce-same-user-same-project-undefined-per-inv1` |
| 41 | Project DB mutates between cache-key compute and cache lookup | Hash + lookup execute back-to-back; mutation invalidates next request naturally (hash changes ⇒ new cache key). No transaction wraps compute+lookup. | `analyze-hash-lookup-no-internal-lock` |
| 42 | WS message arrives while ChatPanel is unmounting | `asyncio.Event` popped in `finally`; stale frontend handler reference is lost without side effects on the backend | `unmount-mid-handler-no-side-effects` |
| 43 | PCM upload interrupted mid-stream (connection reset) | Upload validator enforces `content-length`; mid-stream disconnect raises `BounceUploadInterrupted`; no partial WAV persisted | `upload-interrupted-raises-no-partial-wav` |
| 44 | User starts playback while offline render is in-flight | Frontend handlers pause live playback before triggering the render and resume after in `finally`. Pair is symmetric. | `pause-resume-pair-around-render` |
| 45 | Upload arrives after timeout (WAV written post-hoc) | Event already popped; `set_*_event` returns False; WAV persists (content-addressed, harmless); no GC specified | `late-upload-after-timeout-is-noop` |
| 46 | Analyze called on empty project (no audio_clips, `end_time_s=null`) | Error: "end_time_s (0.0) must be greater than start_time_s" | `analyze-empty-project-errors` |
| 47 | Bounce called on empty project | Same end-time validation error as analyze | `bounce-empty-project-errors` |
| 48 | `request_id` absent from upload form | Upload still succeeds; no event signalled; WAV is a no-op orphan for any waiter | `upload-without-request-id-noop` |
| 49 | `request_id` present but unknown (no waiter) | `set_*_event` returns False; upload still 200s | `upload-unknown-request-id-ok` |

---

## Behavior (step-by-step)

### Analyze round-trip (cache miss, ws present)

1. Chat tool `_exec_analyze_master_bus` validates inputs, resolves `end_time_s` (null → `MAX(audio_clips.end_time) WHERE deleted_at IS NULL`).
2. Computes `mix_graph_hash` via `compute_mix_graph_hash(project_dir)`.
3. Queries mix-cache by `(hash, start, end, sr, analyzer_version)`; returns `cached: true` on hit (skip 4–11).
4. Checks `pool/mixes/<hash>.wav`. If present, jump to 10.
5. Creates `asyncio.Event`, registers under fresh `request_id` in `_MIX_RENDER_EVENTS`.
6. Sends `mix_render_request` over WS. On send-exception → pop event, return error.
7. `await asyncio.wait_for(event.wait(), MIX_RENDER_TIMEOUT_S)`. Timeout → pop event, return timeout error.
8. Frontend handler pauses mixer (if playing), runs `renderMixToBuffer`, encodes 16-bit WAV, POSTs to `/mix-render-upload` with the `request_id` echoed.
9. Server validates form + WAV header + duration (≤100ms drift), writes `pool/mixes/<hash>.wav`, calls `set_mix_render_event(request_id)` which sets the Event. Pops from map in `finally`.
10. Re-stat disk; if still missing → error. Otherwise load WAV via `soundfile`, check `sr == sample_rate`.
11. Insert pending `mix_runs` row, run each requested analysis; wrap in try/except — on exception delete the row and return error.
12. Persist datapoints (rms, spectral_centroid), sections (clipping_event), scalars (peak_db, true_peak_db, lufs_integrated, dynamic_range_db, clip_count), update `rendered_path`.
13. Return `{run_id, cached:false, mix_graph_hash, start/end, rendered_path, scalars, clipping_events, analyses_written}`.

### Bounce round-trip

Mirrors the analyze flow with three differences:
- Cache key is `composite_hash` (encodes mode + selection + window + format).
- Frontend filters tracks via `filterTracksForBounce` before rendering; WAV encoded at requested `bit_depth`.
- On any early failure (WS send, timeout, stat/wave-open error, still-missing after event) the pending `audio_bounces` row is deleted before returning the error; post-success, row is updated with duration + size.

### Frontend handler error discipline

- All errors inside `handleMixRenderRequest` / `handleBounceAudioRequest` are caught + logged; handler returns normally.
- `finally` block always resumes live playback iff `wasPlaying && mixer`.
- No retry. Backend timeout is the single failure boundary.

---

## Acceptance Criteria

- [ ] `renderMixToBuffer` output is byte-for-byte equal to live mixer output over the same window for the same graph + seed (parity test already exists in `mix-live-vs-offline-fidelity.test.ts`).
- [ ] `encodePCMToWav` round-trips through `wave` (16/24) and `soundfile` (all three).
- [ ] `/mix-render-upload` rejects malformed hash / duration drift / channel mismatch / sample-rate mismatch and deletes any partially-written file.
- [ ] `/bounce-upload` has the same rejection semantics plus `bit_depth` passthrough.
- [ ] Cache hits short-circuit before opening the WAV.
- [ ] Timeouts do not create / leave cache rows in either table.
- [ ] No Python code paths synthesize or mix PCM.

---

## Tests

### Base Cases

The core behavior contract: the happy paths through each of the two tools, the primary validation failures, and the frontend-as-source-of-truth invariant.

#### Test: render-matches-live-bit-identical (covers R1, R2, R3)

**Given**:
- A mix graph with 2 tracks, 3 clips, one crossfade, master effects present
- Live mixer rendered the window [10.0, 20.0) at 48k/stereo into a reference buffer

**When**: `renderMixToBuffer(tracks, {startTimeS: 10, endTimeS: 20, sampleRate: 48000, channels: 2, masterEffects})`

**Then**:
- **pcm-length**: `pcm.length === ceil(10 * 48000) * 2`
- **bit-identical**: interleaved samples match live reference within 0 ulp (or documented tolerance `≤ 2^-23`)
- **channels-reported**: `result.channels === 2`
- **sr-reported**: `result.sampleRate === 48000`

#### Test: rejects-inverted-window (covers R2)

**Given**: any track list
**When**: `renderMixToBuffer([], {startTimeS: 5, endTimeS: 5, ...})`
**Then**:
- **throws**: synchronous throw before any OfflineAudioContext is constructed
- **factory-not-called**: `offlineCtxFactory` mock is not invoked

#### Test: rejects-unsupported-channel-count (covers R3)

**Given**: valid window
**When**: `renderMixToBuffer(tracks, {channels: 3, ...})`
**Then**:
- **throws**: `Error` mentioning `"channels must be 1 or 2"`

#### Test: rejects-unsupported-bit-depth (covers R4)

**Given**: arbitrary PCM
**When**: `encodePCMToWav(pcm, 48000, 2, 8 as WavBitDepth)`
**Then**:
- **throws**: `Error` mentioning `"bitDepth must be 16, 24, or 32"`

#### Test: encodes-16bit-pcm (covers R4)

**Given**: `pcm = [0, 0.5, -0.5, 1.0, -1.0]` interleaved mono
**When**: `encodePCMToWav(pcm, 48000, 1, 16)`
**Then**:
- **format-tag**: byte offset 20–21 = `0x0001` LE
- **bits-per-sample**: offset 34–35 = `16`
- **symmetric-full-scale**: peak sample encodes to `32767` / `-32767`
- **round-trips**: Python `wave.open(...)` reads back the same frame count

#### Test: encodes-24bit-pcm (covers R4)

**Given**: same PCM
**When**: `encodePCMToWav(pcm, 48000, 1, 24)`
**Then**:
- **format-tag**: `0x0001`
- **bits-per-sample**: `24`
- **bytes-per-sample**: block align byte offset 32–33 = `3`
- **le-packed**: sample bytes ordered low → high
- **round-trips**: `soundfile.read(...)` returns equal frame count

#### Test: encodes-32bit-float-lossless (covers R4)

**Given**: `pcm = [1.5, -1.5, 0.25]` (deliberately out of ±1 range)
**When**: `encodePCMToWav(pcm, 48000, 1, 32)`
**Then**:
- **format-tag**: `0x0003`
- **no-clipping**: decoded float samples equal `1.5, -1.5, 0.25` exactly (no clamp, no quantize)

#### Test: pauses-and-resumes-live-playback (covers R6)

**Given**: `mixer = { pause: spy, play: spy }`, `isPlaying = true`
**When**: `handleMixRenderRequest(msg, {mixer, isPlaying: true, ...mocked render+encode+fetch})`
**Then**:
- **pause-called-once**: `pause` invoked exactly once, before any render call
- **play-called-once**: `play` invoked exactly once, after upload resolves
- **pause-before-play**: pause call index < play call index

#### Test: no-pause-when-not-playing (covers R6)

**Given**: `mixer` present, `isPlaying = false`
**When**: `handleMixRenderRequest(...)`
**Then**:
- **pause-not-called**: `pause` never called
- **play-not-called**: `play` never called

#### Test: resumes-playback-on-upload-failure (covers R6, R18)

**Given**: upload POST resolves to `{ ok: false, status: 500 }`
**When**: `handleMixRenderRequest(...)`
**Then**:
- **handler-does-not-throw**: promise resolves normally
- **play-still-called**: mixer.play invoked in `finally`
- **logs-warn**: `console.warn` called with upload failure message

#### Test: server-rejects-channel-mismatch (covers R7, R8)

**Given**: form says `channels=2`, WAV header says `channels=1`
**When**: POST `/mix-render-upload`
**Then**:
- **status-400**: HTTP 400 BAD_REQUEST
- **file-deleted**: `pool/mixes/<hash>.wav` does not exist afterward
- **error-message**: body mentions "channels mismatch"

#### Test: server-rejects-duration-drift (covers R7)

**Given**: form says window = 10.0s, WAV contains 9.85s
**When**: POST `/mix-render-upload`
**Then**:
- **status-400**: HTTP 400
- **file-deleted**: dest WAV removed
- **error-message**: mentions ">100ms drift"

#### Test: server-rejects-bad-hash (covers R7)

**Given**: `mix_graph_hash = "not-hex"` (length ≠ 64)
**When**: POST
**Then**:
- **status-400**: HTTP 400 before bytes are persisted
- **no-file-written**: `pool/mixes/` contains no new file

#### Test: analyze-cache-hit-skips-librosa (covers R11)

**Given**: mix_runs row exists for `(hash, start, end, sr, analyzer_version)`
**When**: `_exec_analyze_master_bus(...)`
**Then**:
- **cached-true**: result has `cached: true`
- **librosa-not-called**: `librosa.feature.rms` / `librosa.feature.spectral_centroid` mocks never invoked
- **soundfile-not-called**: `soundfile.read` mock never invoked

#### Test: analyze-full-ws-roundtrip (covers R10)

**Given**: no cached row; no WAV on disk; live ws mock captures send calls
**When**: `_exec_analyze_master_bus(project_dir, {}, ws=ws_mock)`; after emission, simulate POST to `/mix-render-upload` with echoed `request_id`
**Then**:
- **ws-send-called**: ws.send called exactly once with `type: "mix_render_request"`
- **request-id-matches**: echoed `request_id` on POST equals what was sent
- **event-set**: `set_mix_render_event(request_id)` returned True
- **analysis-ran**: returned dict has `cached: false` and non-empty `analyses_written`

#### Test: bounce-full-mode-happy (covers R8, R12, R14, R15)

**Given**: project with tracks+clips; no prior bounce row for the hash
**When**: `_exec_bounce_audio` with `mode=full`, sr=48000, bit_depth=24, channels=2; frontend uploads a well-formed 24-bit WAV
**Then**:
- **ws-emit**: exactly one `bounce_audio_request` sent with `mode: "full"`, `bit_depth: 24`
- **file-persisted**: `pool/bounces/<composite_hash>.wav` exists
- **row-finalized**: `audio_bounces` row has `rendered_path`, `size_bytes`, `duration_s` set
- **download-url**: result contains `download_url`

#### Test: backend-never-synthesizes-pcm (covers R17)

**Given**: engine source tree
**When**: grep for `numpy.sin`, `numpy.cos`, audio-synthesis signatures, `OfflineAudioContext`, mix-graph reimplementation
**Then**:
- **no-synthesis-found**: no Python file under `src/scenecraft/` produces PCM that is then stored as a rendered mix or bounce
- **only-storage-paths**: the only writes to `pool/mixes/` and `pool/bounces/` happen in the two upload handlers

### Edge Cases

#### Test: render-past-project-end-fills-silence (covers R2)

**Given**: longest clip ends at 60s
**When**: `renderMixToBuffer(tracks, {startTimeS: 0, endTimeS: 90, ...})`
**Then**:
- **frames-correct**: `pcm.length/channels === ceil(90*sr)`
- **trailing-silent**: samples after frame `60*sr` are all `0` (± effect tail if master fx present)
- **no-throw**: promise resolves

#### Test: drops-unreachable-clip (covers R5)

**Given**: `fetchBytes` mock throws for one clip's source_path
**When**: `renderMixToBuffer(tracks, ...)`
**Then**:
- **render-succeeds**: resolves with PCM
- **warn-logged**: `console.warn` mentions `"skipping clip"` and the clip id
- **other-clips-present**: remaining clips' source.start was called

#### Test: analyze-uses-existing-wav (covers R10)

**Given**: no cache row; WAV already at `pool/mixes/<hash>.wav`; `ws=None`
**When**: `_exec_analyze_master_bus(...)`
**Then**:
- **no-ws-emission**: no WS-related code path reached
- **analysis-ran**: returns `cached: false`, `analyses_written` non-empty

#### Test: analyze-no-ws-no-wav-errors (covers R10)

**Given**: no cache row; no WAV; `ws=None`
**When**: `_exec_analyze_master_bus(...)`
**Then**:
- **error-returned**: result contains `"error"` mentioning "no ws context"
- **expected-path**: `expected_rendered_path` field present

#### Test: analyze-timeout-no-cache-row (covers R10)

**Given**: `MIX_RENDER_TIMEOUT_S = 0.05`; ws send succeeds; upload never arrives
**When**: `_exec_analyze_master_bus(...)`
**Then**:
- **error-returned**: mentions "mix render timeout"
- **no-run-row**: `mix_runs` table has no new row
- **event-popped**: `_MIX_RENDER_EVENTS` has no entry for the request_id

#### Test: analyze-sr-mismatch-errors (covers R16)

**Given**: requested `sample_rate = 48000`; WAV on disk has `sr=44100`
**When**: `_exec_analyze_master_bus(sample_rate=48000, ...)`
**Then**:
- **error-returned**: mentions "sample rate .* does not match"
- **no-row-created**: no row in `mix_runs`

#### Test: analyze-silence-infinities (covers R13)

**Given**: all-zero PCM stored at `pool/mixes/<hash>.wav`, all default analyses requested
**When**: `_exec_analyze_master_bus(...)`
**Then**:
- **peak-neg-inf**: `scalars.peak_db == -inf`
- **lufs-neg-inf**: `scalars.lufs_integrated == -inf`
- **no-dynamic-range**: `"dynamic_range_db"` NOT in scalars
- **clip-count-zero**: `scalars.clip_count == 0`

#### Test: analyze-short-buffer-lufs-neg-inf (covers R13)

**Given**: WAV of 100ms duration (under BS.1770's 400ms block requirement)
**When**: analyze `lufs`
**Then**:
- **lufs-neg-inf**: `lufs_integrated == -inf`
- **peak-still-written**: `peak_db` is a finite value reflecting max |sample|

#### Test: analyze-unknown-skipped (covers R13)

**Given**: `analyses = ["peak", "phlogiston"]`
**When**: `_exec_analyze_master_bus(...)`
**Then**:
- **peak-written**: `"peak"` in `analyses_written`
- **unknown-absent**: `"phlogiston"` NOT in `analyses_written`
- **no-error**: no error returned

#### Test: analyze-cleans-up-on-failure (covers R11)

**Given**: librosa mock raises on `feature.rms`
**When**: `_exec_analyze_master_bus(["rms"], ...)`
**Then**:
- **error-returned**: result contains `"error"`
- **row-deleted**: `mix_runs` row for the insert was deleted

#### Test: analyze-force-rerun-replaces (covers R11)

**Given**: existing row for the cache key with scalar `peak_db=-6`
**When**: `_exec_analyze_master_bus(force_rerun=True, ...)` with a newly-rendered WAV whose peak is `-3`
**Then**:
- **old-row-gone**: prior `run_id` no longer resolvable
- **new-scalar**: new row has `peak_db ≈ -3`
- **cached-false**: response `cached: false`

#### Test: bounce-tracks-mode-filters (covers R15)

**Given**: 3 tracks, `track_ids=[t1, t3]`
**When**: `filterTracksForBounce(tracks, msg)`
**Then**:
- **two-tracks**: returned list has length 2
- **ids-match**: returned ids = `{t1, t3}`
- **t2-absent**: `t2` not in list

#### Test: bounce-clips-mode-drops-empty-tracks (covers R15)

**Given**: tracks A (has clips c1,c2), B (has c3), C (has c4); `clip_ids=[c1, c4]`
**When**: `filterTracksForBounce`
**Then**:
- **track-B-dropped**: B not in result
- **A-has-c1**: A kept with clips = `[c1]`
- **C-has-c4**: C kept with clips = `[c4]`

#### Test: bounce-mutex-selection (covers R14)

**Given**: `track_ids=["t1"]`, `clip_ids=["c1"]`
**When**: `_exec_bounce_audio(...)`
**Then**:
- **error**: result is `{"error": "pass either track_ids or clip_ids, not both"}`
- **no-row**: `audio_bounces` unchanged

#### Test: bounce-missing-track-id (covers R14)

**Given**: `track_ids=["t-doesnotexist"]`
**When**: `_exec_bounce_audio(...)`
**Then**:
- **error**: `"track_ids not found: ['t-doesnotexist']"`

#### Test: bounce-invalid-sample-rate (covers R14)

**Given**: `sample_rate=22050`
**When**: `_exec_bounce_audio(...)`
**Then**:
- **error**: lists `[44100, 48000, 88200, 96000]`

#### Test: bounce-invalid-bit-depth (covers R14)

**Given**: `bit_depth=20`
**When**: `_exec_bounce_audio(...)`
**Then**:
- **error**: lists `[16, 24, 32]`

#### Test: bounce-cache-hit (covers R12)

**Given**: `audio_bounces` row with `rendered_path="pool/bounces/<hash>.wav"` and file present
**When**: `_exec_bounce_audio` with inputs that hash to that composite_hash
**Then**:
- **cached-true**: `cached: true`
- **no-ws**: ws.send not called
- **download-url-present**: result has `download_url`

#### Test: bounce-retry-deletes-pending (covers R12, R19)

**Given**: pending `audio_bounces` row with `rendered_path=None` for the hash
**When**: fresh `_exec_bounce_audio` call with same inputs, ws present, upload succeeds
**Then**:
- **old-row-gone**: original `bounce_id` not resolvable
- **new-row-finalized**: new row has non-null `rendered_path`

#### Test: bounce-ws-send-fail-cleanup (covers R19)

**Given**: `ws.send` mock raises
**When**: `_exec_bounce_audio(...)`
**Then**:
- **error-returned**: result contains `"error"` mentioning "failed to send"
- **row-deleted**: no pending row remains

#### Test: bounce-upload-timeout-cleanup (covers R19)

**Given**: `BOUNCE_RENDER_TIMEOUT_S=0.05`; upload never arrives
**When**: `_exec_bounce_audio(...)`
**Then**:
- **error-timeout**: mentions "bounce render timeout"
- **row-deleted**: `audio_bounces` has no pending row
- **event-popped**: `_BOUNCE_RENDER_EVENTS` no longer contains the request_id

#### Test: analyze-empty-project-errors (covers R14 — shared end-time resolution)

**Given**: project DB has no `audio_clips`, `end_time_s=None`
**When**: `_exec_analyze_master_bus(...)`
**Then**:
- **error**: mentions "end_time_s (0.0) must be greater than start_time_s"
- **no-ws-emission**: ws.send not called

#### Test: bounce-empty-project-errors (covers R14)

Same as above for `_exec_bounce_audio`.
- **error**: same text
- **no-row**: `audio_bounces` unchanged

#### Test: upload-without-request-id-noop (covers R7)

**Given**: well-formed upload with `request_id` field omitted
**When**: POST `/mix-render-upload`
**Then**:
- **status-200**: upload succeeds
- **file-written**: WAV present at expected path
- **no-event-set**: no entry in `_MIX_RENDER_EVENTS` was touched

#### Test: analyze-same-user-same-project-undefined-per-inv1 (covers R20)

**Given**: Two analyze calls initiated by the same user against the same project concurrently
**When**: Both enter `_exec_analyze_master_bus`
**Then**:
- **no-internal-lock**: no per-project mutex is acquired across the API call (negative assertion — future refactors must update the spec if this changes).
- **undefined-outcome**: the spec does not constrain which call "wins"; the cache UNIQUE constraint may cause one to error or race; behavior is accepted-undefined per INV-1.

#### Test: bounce-same-user-same-project-undefined-per-inv1 (covers R20)

**Given**: Two bounce calls initiated by the same user against the same project concurrently with the same `composite_hash`
**When**: Both enter `_exec_bounce_audio`
**Then**:
- **no-internal-lock**: no per-project mutex is held.
- **undefined-outcome**: behavior accepted-undefined per INV-1; one call may raise on the `audio_bounces` UNIQUE constraint.

#### Test: analyze-hash-lookup-no-internal-lock (covers R21)

**Given**: `_exec_analyze_master_bus` is called
**When**: Hash compute and cache lookup run sequentially
**Then**:
- **no-transaction-wrap**: no `BEGIN ... COMMIT` wraps the two steps (inspection of code / lack of cursor transaction).
- **hash-from-current-state**: the hash is computed against the DB state at read time.
- **next-request-self-corrects**: if a write lands after hash compute but before lookup, the next request recomputes the hash against the new state and uses the new cache key.

#### Test: unmount-mid-handler-no-side-effects (covers R22)

**Given**: A `mix_render_request` is in flight; ChatPanel unmounts; upload arrives
**When**: Server calls `set_mix_render_event(request_id)`
**Then**:
- **event-popped-in-finally**: the `asyncio.Event` entry is removed from `_MIX_RENDER_EVENTS` in the tool's `finally` block regardless of client state.
- **no-exception**: no backend exception from the stale client handler.
- **no-frontend-side-effect**: the (now-unmounted) ChatPanel's handler reference is not invoked because its component tree no longer exists.

#### Test: upload-interrupted-raises-no-partial-wav (covers R23)

**Given**: Client begins multipart upload; connection drops mid-body
**When**: Server attempts to read `content-length` bytes
**Then**:
- **raises-interrupted**: handler raises `BounceUploadInterrupted` (bounce) or equivalent for mix-render.
- **no-partial-file**: `pool/bounces/<hash>.wav` (or `pool/mixes/<hash>.wav`) is NOT left on disk; any staged bytes are unlinked.
- **event-not-set**: no corresponding `set_*_event(request_id)` call succeeds.

#### Test: pause-resume-pair-around-render (covers R24)

**Given**: Live mixer is playing (`isPlaying === true`) when a render request arrives
**When**: `handleMixRenderRequest` runs to completion (or failure)
**Then**:
- **pause-before-render**: `mixer.pause()` is invoked before `renderMixToBuffer`.
- **resume-in-finally**: `mixer.play()` is invoked in a `finally` block — symmetric with pause — even when the render or upload throws.
- **pair-is-idempotent-under-user-replay**: if the user presses Play mid-render, the resume still fires at end-of-handler; there is no duplicate resume.

#### Test: late-upload-after-timeout-is-noop (covers R25)

**Given**: A `_exec_analyze_master_bus` call timed out 30 seconds ago and popped its `_MIX_RENDER_EVENTS` entry. Client finally finishes rendering and POSTs the WAV
**When**: Server processes the upload
**Then**:
- **wav-persisted**: WAV is written to `pool/mixes/<hash>.wav` (content-addressed; harmless).
- **set-event-returns-false**: `set_mix_render_event(request_id)` returns `False` (no waiter).
- **no-log-error**: the "late" arrival is not logged as an error.
- **no-gc**: the orphan WAV persists on disk (no garbage collection of orphan mix/bounce renders is specified).

#### Test: upload-unknown-request-id-ok (covers R10)

**Given**: `request_id = "unknown-uuid"` with no matching pending event
**When**: POST succeeds
**Then**:
- **status-200**: HTTP 200
- **set-returns-false**: `set_mix_render_event("unknown-uuid")` would return False
- **no-log-failure**: no `mix-render-upload: set_mix_render_event raised` warning

---

## Non-Goals

- **Dithering on 24→16 downsample.** Current code uses plain round-to-nearest; a dithered path is noted as a TODO in `mix-render.ts`. Not part of this spec.
- **Multi-channel (>2) render.** Surround is not supported by either the WAV encoder or the channels validator.
- **Resumable uploads.** Upload is one-shot; network failures restart the round-trip from the next tool call.
- **Live streaming of bounce progress.** Bounce is whole-file on completion; no streamed chunks.
- **Independent cross-project cache sharing.** Each project has its own cache tables; `pool/` is per-project.
- **Mix-graph composition** — covered in `local.webaudio-mixer-and-mix-graph` (future).

---

## Open Questions

### Resolved

- **OQ-1 — Concurrent analyze_master_bus calls for the same mix_graph_hash.**
  **Resolved**: closed per INV-1 (single-writer per user+project). Concurrent calls from the same user on the same project are out of scope; from different users or different projects they proceed independently. Test: `analyze-same-user-same-project-undefined-per-inv1`.

- **OQ-2 — Concurrent bounces with identical composite_hash.**
  **Resolved**: closed per INV-1. Test: `bounce-same-user-same-project-undefined-per-inv1`.

- **OQ-3 — Project mutation between hash compute and cache lookup.**
  **Resolved (codify)**: hash + lookup run back-to-back against the current DB state with no transaction wrapping; later mutations invalidate naturally via hash change on next request. Spec requirement R21. Test: `analyze-hash-lookup-no-internal-lock`.

- **OQ-4 — WS message during ChatPanel unmount.**
  **Resolved (codify)**: `asyncio.Event` popped in `finally`; stale frontend handler reference is silently discarded; backend proceeds without side effects. Spec requirement R22. Test: `unmount-mid-handler-no-side-effects`.

- **OQ-5 — Interrupted PCM upload.**
  **Resolved (fix)**: upload validator enforces `content-length`; mid-stream disconnect raises `BounceUploadInterrupted`; no partial WAV is persisted. Spec requirement R23. Test: `upload-interrupted-raises-no-partial-wav`.

- **OQ-6 — User plays during offline render.**
  **Resolved (codify)**: frontend pauses live playback before triggering render and resumes in `finally`. Pair is symmetric and already present in code. Spec requirement R24. Test: `pause-resume-pair-around-render`.

- **OQ-7 — Upload after timeout.**
  **Resolved (codify)**: late upload with no matching `request_id` is a no-op; `set_*_event` returns False; WAV persists content-addressed; no GC specified. Spec requirement R25. Test: `late-upload-after-timeout-is-noop`.

---

## Related Artifacts

- **Source code**:
  - Frontend: `scenecraft/src/lib/mix-render.ts`, `scenecraft/src/lib/chat-client.ts`
  - Backend: `scenecraft-engine/src/scenecraft/chat.py` — `_exec_analyze_master_bus` at ~line 3036, `_exec_bounce_audio` at ~line 3422 (no separate `bounce_audio.py` / `analyze_master_bus.py` modules exist); `scenecraft-engine/src/scenecraft/api_server.py` (`/mix-render-upload`, `/bounce-upload`), `db_mix_cache.py`, `db_bounces.py`, `mix_graph_hash.py`, `bounce_hash.py`
- **Existing tests**:
  - `scenecraft/src/lib/__tests__/mix-render.test.ts`
  - `scenecraft/src/lib/__tests__/mix-live-vs-offline-fidelity.test.ts`
  - `scenecraft/src/lib/__tests__/master-bus-chain.test.ts`
  - `scenecraft/src/lib/__tests__/bounce-audio.test.ts`
  - `scenecraft-engine/tests/test_analyze_master_bus.py`, `test_analyze_master_bus_roundtrip.py`
  - `scenecraft-engine/tests/test_bounce_audio.py`, `test_mix_render_upload.py`, `test_master_bus_integration.py`, `test_m15_e2e.py`
- **Reports**:
  - `agent/reports/audit-2-architectural-deep-dive.md` (§1E unit 3; §2 invariant "Audio = Frontend")
- **Related specs (planned / existing)**:
  - `local.webaudio-mixer-and-mix-graph` (mixer internals — out of scope here)
  - `local.audio-effects-and-curve-scheduling` (effect DSP — out of scope here)

---

**Namespace**: local
**Spec**: bounce-and-analysis
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Retroactive
