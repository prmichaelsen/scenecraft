# Spec: WebAudio Mixer, Mix-Graph, and Offline Rendering

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Retroactive — describes the system as currently implemented on `main` (commit-range ending 392960b). Discrepancies between spec and code are listed as Open Questions, not implicit approvals.

---

## Purpose

Define the exact observable behavior of scenecraft's live WebAudio mixer (`AudioMixer`), the shared mix-graph scheduling helpers, and the module-level `audio-mixer-ref` singleton, such that a reviewer can proof every scenario that matters before implementation drift accumulates.

**On `mix-render.ts` (clarification, 2026-04-27)**: this module is NOT a general
"offline audio mixdown" path and does NOT participate in playback. It is the
purpose-built offline renderer used by the bounce/analyze chat round-trip
(`chat-client.ts::handleMixRenderRequest` / `handleBounceAudioRequest`) which
builds a one-shot `OfflineAudioContext`, encodes a WAV, and POSTs it to
`/mix-render-upload` or `/bounce-upload`. Verification: ripgrep shows it is
imported only by `chat-client.ts` (production) and by its own tests. It is NOT
vestigial; it IS narrowly-scoped to bounce+analyze. Any "bit-identical live
vs. offline parity (R20)" invariant previously asserted in this spec has been
removed — there is no general-purpose offline mixdown path in scenecraft, and
the bounce/analyze renderer's contract lives in `local.bounce-and-analysis.md`.

## Source

**Mode**: retroactive black-box (no clarification / design file — drawn directly from the four source files and audit-2).

**Primary sources**:
- `/home/prmichaelsen/.acp/projects/scenecraft/src/lib/audio-mixer.ts`
- `/home/prmichaelsen/.acp/projects/scenecraft/src/lib/mix-graph.ts`
- `/home/prmichaelsen/.acp/projects/scenecraft/src/lib/audio-mixer-ref.ts`
- `mix-render.ts` is referenced only as a collaborator (bounce/analyze round-trip); its contract is in `local.bounce-and-analysis.md`.

**Context**: `agent/reports/audit-2-architectural-deep-dive.md` §1E units 1–3, 10–11; §2 invariant "Audio = Frontend"; §3 leaks #6 (decode cache module-global) and #15 (no LRU).

## Scope

**In scope**:
- `AudioMixer` public surface: `play`, `pause`, `seek`, `rebuild`, `updateClip`, `updateTrack`, `getTrackAnalysers`, `getMasterAnalysers`, `getTrackChannelCount`, `reevaluateMasterChain`, `dispose`, `trackCount`.
- Graph construction from DB state: tracks → trackGain → masterGain → master fx chain → analyser tap → destination; clips → source → clipGain → crossfadeGain → trackGain.
- Seek semantics: tear down prior `AudioBufferSourceNode` instances and rebuild fresh ones (single-use node contract).
- Playhead ↔ AudioContext clock alignment: `when = ctx.currentTime + max(0, clip.start_time - playhead)`.
- Crossfade scheduling: equal-power cos/sin (length 128) on overlapping clips on the **same track**.
- Mute / solo rules: `trackGain = 0` when the track is muted; when **any** track is solo, non-solo tracks are forced to 0.
- Module-global decode cache keyed by `source_path`; `pendingDecodes` dedup map; LRU eviction policy (resolved per OQ-7).
- `audio-mixer-ref` singleton for cross-panel access to the live graph's master analysers.
- Multi-window ownership of the live audio playback graph (INV-5).

**Out of scope** (covered elsewhere or deferred):
- Effect registry + per-effect param curves (`audio-effect-types.ts`, `audio-graph.ts`) — see the separate `audio-effects-and-curve-scheduling` spec target. This spec only asserts that the master-bus fx chain is wired correctly in live and that `reevaluateMasterChain` swaps it atomically.
- Send-bus topology (reverb/delay/echo buses) — referenced as collaborators; exact topology is covered in the effects spec.
- Bounce / analyze offline render (`renderMixToBuffer`, `encodePCMToWav`, upload round-trip) — fully covered in `local.bounce-and-analysis.md`. This spec no longer asserts any live/offline parity.
- Waveform cache (separate UI path).
- Timeline ↔ mixer wiring (Timeline seeks via `seekRef`; out of scope here — covered in `timeline-composition-and-playback-loop`).

---

## Requirements

### R1 — Public API shape
`createAudioMixer(projectName, tracks, options?) → AudioMixer` returns an object exposing exactly the members in the `AudioMixer` type (play, pause, seek, updateClip, updateTrack, rebuild, getTrackAnalysers, getMasterAnalysers, getTrackChannelCount, reevaluateMasterChain, dispose, trackCount).

### R2 — Lazy graph construction
The `AudioContext` is created on first `ensureCtx()` call (triggered by `play`, `seek` after ctx exists, or any call requiring the graph). `createAudioMixer` MUST NOT construct an `AudioContext` eagerly; tests with no factory MUST NOT crash under Node.

### R3 — Master bus topology
When the master graph is built, the node topology is exactly:
`(all trackGains) → masterGain → masterFxChain.input → …effects in order_index order… → masterFxChain.output → (a) ChannelSplitter(2) → analyserL/R (post-chain tap) and (b) ctx.destination`.
When `masterEffects` is empty, `masterFxChain` MUST still exist as a passthrough pair of `GainNode`s so downstream wiring is identical.

### R4 — Track / clip chain topology
For every clip in every track:
`AudioBufferSourceNode → clipGain → crossfadeGain → trackGain → masterGain`.
`clipGain` and `crossfadeGain` persist across activation cycles; only the `AudioBufferSourceNode` is single-use.

### R5 — Decode cache
A module-level `Map<source_path, AudioBuffer>` named `decodeCache` caches decoded buffers across **all** mixer instances in the page. An in-flight `pendingDecodes` map dedup-coalesces concurrent fetches of the same `source_path` within a single mixer instance.

### R6 — Decode cache LRU + project-switch clear
The cache is LRU-bounded at **512 MB total decoded audio** (sum of
`numberOfChannels × length × 4` across cached `AudioBuffer`s). On overflow, the
least-recently-used entries are evicted until the total is under cap. On project
switch the entire cache is cleared (and with it any `pendingDecodes`). HMR reload
of the page is covered by project-switch semantics. `__clearDecodeCacheForTest`
is a test-only helper. (Resolves OQ-7 + OQ-10.)

### R7 — Seek semantics (single-use source nodes)
Every `seek(seconds)` call:
1. Updates `lastPlayhead = seconds`.
2. Classifies the seek as "hard" iff `|seconds − prevPlayhead| > 0.05` seconds.
3. If hard, re-schedules all track volume curves anchored at the new playhead.
4. Calls `reevaluateClips(seconds, hardSeek)`:
   - Clips whose `[start_time, end_time)` contains `seconds` and are inactive → activated.
   - Clips whose window does NOT contain `seconds` and are active → deactivated.
   - Clips whose window contains `seconds` AND are already active AND this is a **hard** seek → deactivated then re-activated (so the single-use source node is rebuilt at the new source offset).

### R8 — `play()` semantics
`play()`:
- Sets `isPlaying = true`.
- Calls `ensureGraph()` (builds master + track + clip chains if not already built; kicks off decodes).
- Re-schedules all track volume curves at `lastPlayhead`.
- Invokes `reevaluateClips(lastPlayhead, hardSeek=true)`.
- Emits a `[audio-mixer] play() @<t>s` debug log.

### R9 — `pause()` semantics
`pause()`:
- Sets `isPlaying = false`.
- Stops and disconnects every active `AudioBufferSourceNode`.
- Clears each affected clip's `active` flag to `false`.
- Does NOT tear down `clipGain`, `crossfadeGain`, `trackGain`, or master nodes.
- Does NOT close the `AudioContext`.

### R10 — Playhead → AudioContext clock alignment
For a clip being activated at playhead `p`:
- `sourcePosition = max(0, effective_source_offset + (p − clip.start_time) × rate)` where `rate = playback_rate ?? 1`.
- `whenDelta = max(0, clip.start_time − p)`.
- `when = ctx.currentTime + whenDelta`.
- `effectiveDuration = min(timelineRemaining × rate, max(0, buffer.duration − sourcePosition))`.
- If `isPlaying` and `effectiveDuration > 0`, `source.start(when, sourcePosition, effectiveDuration)` is called exactly once; the node self-stops at its natural end.

### R11 — Crossfade scheduling
When two clips on the **same track** have overlapping `[start_time, end_time)` intervals and both are (or become) active:
- The earlier-starting clip is treated as **incumbent** (fades out with `COS_CURVE`).
- The later-starting clip is **newcomer** (fades in with `SIN_CURVE`).
- Both curves are applied via `setValueCurveAtTime(curve, fadeStart, duration)` where:
  - `fadeStart = paramAnchorTime + max(0, overlapStart − playhead)` on the appropriate `crossfadeGain.gain`.
  - `duration = overlapEnd − overlapStart`.
- `COS_CURVE` and `SIN_CURVE` are precomputed Float32Arrays of length 128 sampling `cos(t·π/2)` and `sin(t·π/2)` on `t ∈ [0,1]` respectively — identical arrays shared by live and offline.

### R12 — Mute / solo rules
`isTrackEffectivelyMuted(track, allTracks)`:
- Returns `true` if `track.muted`.
- Else returns `true` if **any** track in `allTracks` has `solo === true` and this track does not.
- Else returns `false`.
When effectively muted, the track's gain param is set to `0` at the anchor time and no curve points are scheduled. This function is **shared verbatim** by the live mixer and `renderMixToBuffer`.

### R13 — `getTrackAnalysers(trackId)` / `getMasterAnalysers()`
- Return `{ left: AnalyserNode, right: AnalyserNode }` when the corresponding graph has been built.
- Return `null` when the track / master graph has not yet been built (e.g. no `ensureGraph()` call has occurred, or the trackId is unknown).
- Analyser `fftSize = 1024`, `smoothingTimeConstant = 0`. Taps are post-gain / post-fx-chain.

### R14 — `getTrackChannelCount(trackId)`
- Returns `1` iff every decoded buffer on the track has `numberOfChannels === 1`.
- Returns `2` otherwise (including when no buffers have decoded yet, so the UI meter does not flash mono during load).
- Returns `2` for an unknown `trackId`.

### R15 — `rebuild(nextTracks)`
- Tears down every existing `trackNode`'s clips (including source nodes, clipGains, crossfadeGains) and the track's gain + analysers.
- Repopulates `trackMap` from `nextTracks`; clips are created inactive with `buffer = null`, `source = null`.
- If an `AudioContext` already exists: calls `ensureGraph()`, reschedules all track curves, and re-runs `reevaluateClips(lastPlayhead, hardSeek=true)`.
- Does NOT clear the module-level decode cache — re-adding a clip with a previously-seen `source_path` hits the cache.
- Does NOT dispose the `AudioContext` or master graph nodes.

### R16 — `reevaluateMasterChain(effects)`
- Replaces the active master fx chain with a fresh chain built from `effects`.
- Disposes the old `EffectChainHandle` and the old analyser splitter / analyser pair.
- Re-connects `masterGain → newChain.input`, taps a new analyser pair off `newChain.output`, and connects `newChain.output → ctx.destination`.
- Stores `effects` so a later `ensureMasterGraph()` (e.g. post-rebuild) uses the new list.
- If the master graph has not yet been built, stores `effects` and returns without constructing anything.

### R17 — `dispose()`
- Sets `disposed = true`; every public method that mutates state becomes a no-op thereafter.
- Stops and disconnects every source node, clipGain, crossfadeGain, trackGain, analyser, splitter, master fx chain, and master gain.
- Calls `AudioContext.close()` and nulls the reference.
- Subsequent `dispose()` calls are no-ops.

### R18–R22 — REMOVED

Previously R18–R22 specified the offline renderer (`renderMixToBuffer`) and its
"bit-identical live/offline parity" invariant. There is no general-purpose
offline audio mixdown path in scenecraft. `renderMixToBuffer` is exclusively
used by the bounce/analyze chat round-trip and is fully specified in
`local.bounce-and-analysis.md`. These requirements are intentionally removed
from this spec; the R-numbers are preserved as placeholders to avoid renumbering.

### R23 — `audio-mixer-ref` singleton contract
- `setActiveAudioMixer(m)` sets the module-level `activeMixer` to `m`.
- `getActiveAudioMixer()` returns the current value (or `null`).
- Multiple concurrent mixers may be created, but only the **last** one passed to `setActiveAudioMixer` is accessible via `getActiveAudioMixer`. (Not a multiplexer — a plain ref.)
- Consumers read per-frame and MUST tolerate `null`.

### R24 — Decode dedup across concurrent activations
When two activations for the same `source_path` are in flight simultaneously within one mixer instance, exactly one `fetchBytes` + `decode` pair fires; both callers receive the same resolved `AudioBuffer`. Cache hit on the module-global `decodeCache` short-circuits both.

### R25 — Clip curve scheduling semantics (shared helper)
`scheduleClipCurveOnParam(param, clip, playhead, paramAnchorTime)`:
- Cancels scheduled values at `paramAnchorTime`.
- If `clip.muted`: sets value `0` at `paramAnchorTime` and returns.
- Otherwise anchors at `dbToLinear(sampleClipDbAtPlayhead(clip, playhead))` at `paramAnchorTime`.
- Emits `linearRampToValueAtTime(dbToLinear(db), paramAnchorTime + (xSec − playhead))` for each curve point `[xNorm, db]` in sorted order where `xSec = start_time + xNorm × (end_time − start_time)` satisfies `playhead < xSec ≤ end_time`.

### R27 — Multi-window exclusive playback ownership (INV-5)
The live `AudioMixer` + active `HTMLAudioElement` master clock are exclusive
browser resources. Only one browser window/tab may own the live audio playback
graph at a time. Secondary windows MUST receive read-only playhead updates over
the unified WS (INV-4) rather than building their own `AudioMixer` instance.
Ownership transfer uses a "Take playback control" modal that gracefully releases
the previous owner's `AudioMixer` (via `dispose()`) and installs a new one in
the requesting window. Closing the owning window transparently releases the
resource; the next interaction in any remaining window claims it.

Multi-window DB-backed state (tracks, clips, curves, master effects) stays
synchronized across windows via unified WS events; all windows that render
Timeline/waveforms reflect the same underlying DB state.

Implementation details deferred per INV-5 to the multi-window workspaces design
doc; this spec states the black-box ownership contract only.

### R28 — Solo/mute change requires updateTrack or rebuild
`isTrackEffectivelyMuted(track, allTracks)` reads the caller-supplied array at
call time; the mixer does NOT subscribe to mutations on the track objects.
Callers (React/Timeline) MUST invoke `updateTrack(trackId)` or `rebuild()` to
propagate a mute/solo change to audible output. Negative-assertion test
codifies this: "solo flag change in DB without updateTrack does NOT silently
re-schedule." (Resolves OQ-6.)

### R26 — Track curve scheduling semantics (shared helper)
`scheduleTrackCurveOnParam(param, track, playhead, paramAnchorTime, effectiveMuted)`:
- Cancels scheduled values at `paramAnchorTime`.
- If `effectiveMuted`: sets `0` at `paramAnchorTime` and returns.
- Otherwise anchors and then emits `linearRampToValueAtTime` for each sorted curve point `[xSec, db]` where `xSec > playhead`. Track curve points are in **absolute timeline seconds** (not normalized like clip curves).

---

## Interfaces / Data Shapes

### `AudioMixer`
See R1 — the full TypeScript interface is reproduced in `src/lib/audio-mixer.ts:44-77`.

### `AudioMixerOptions`
```
{
  audioCtxFactory?: () => AudioContext
  sourceUrlFactory?: (projectName, sourcePath) => string
  fetchBytes?: (url) => Promise<ArrayBuffer>
  decode?: (ctx, bytes) => Promise<AudioBuffer>
  masterEffects?: readonly TrackEffect[]
}
```

### `MixRenderOptions`
```
{
  startTimeS: number            // required
  endTimeS: number              // required
  sampleRate?: number           // default 48000
  channels?: 1 | 2              // default 2
  projectName: string           // required
  offlineCtxFactory?, sourceUrlFactory?, fetchBytes?, decode?,
  bufferCache?: Map<string, AudioBuffer>,
  masterEffects?: readonly TrackEffect[]
}
```

### `MixRenderResult`
```
{
  pcm: Float32Array             // interleaved; stereo => [L0,R0,L1,R1,...], mono => [S0,S1,...]
  channels: 1 | 2
  sampleRate: number
  durationSeconds: number       // = frames / sampleRate, where frames = ceil((endTimeS-startTimeS)*sampleRate)
}
```

### `EffectChainHandle`
```
{
  input: AudioNode              // always present (passthrough GainNode when empty)
  output: AudioNode             // always present
  effects: readonly EffectNode[]
  dispose(): void               // idempotent
}
```

### `audio-mixer-ref` singleton
```
setActiveAudioMixer(mixer: AudioMixer | null): void
getActiveAudioMixer(): AudioMixer | null
```

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | `createAudioMixer` with zero tracks | Returns mixer with `trackCount === 0`; no AudioContext built yet | `factory-no-ctx-until-needed`, `track-count-zero` |
| 2 | `play()` on fresh mixer with one track, one clip covering playhead 0..10 | Builds graph; decodes clip; schedules `source.start(ctx.currentTime, 0, duration)`; clip becomes active | `play-activates-covered-clip` |
| 3 | `pause()` during playback | `isPlaying → false`; all active source nodes stopped + disconnected; clipGain/trackGain/master intact | `pause-stops-sources-keeps-graph` |
| 4 | `seek(t)` with `|t − prev| > 0.05` while active clip covers `t` | Hard seek: existing source node torn down; fresh one built at new `sourcePosition`; track curves re-scheduled | `hard-seek-rebuilds-source` |
| 5 | `seek(t)` with `|t − prev| ≤ 0.05` (frame tick) | Soft seek: active sources untouched; playhead updated | `soft-seek-preserves-source` |
| 6 | `seek(t)` into a clip that was previously inactive | Activates the clip at new offset | `seek-activates-newly-covered-clip` |
| 7 | `seek(t)` out of the current clip's window | Deactivates the clip; source stopped + disconnected | `seek-deactivates-exited-clip` |
| 8 | Two overlapping clips on one track during activation | Crossfade: incumbent param gets COS_CURVE, newcomer gets SIN_CURVE over `[overlapStart, overlapEnd]` | `crossfade-equal-power` |
| 9 | Two overlapping clips on **different** tracks | No crossfade; both play at their clip-curve-scheduled gain | `no-cross-track-crossfade` |
| 10 | Track with `muted = true` | `trackGain` scheduled to `0`; audible output is silence from that track | `muted-track-silent` |
| 11 | Any track has `solo = true`, others do not | Non-solo tracks' `trackGain` forced to `0`; solo track plays normally | `solo-mutes-others` |
| 12 | `rebuild(newTracks)` mid-playback | Existing clips torn down; fresh track/clip nodes created; `ensureGraph` rebuilds; track curves rescheduled; hard-seek reevaluation runs | `rebuild-mid-playback` |
| 13 | `rebuild` followed by re-adding same clip | Decode cache hit — no second `fetchBytes` call | `rebuild-hits-decode-cache` |
| 14 | Two concurrent activations of same `source_path` | Single fetch + single decode; both activations see the same buffer | `concurrent-decode-dedup` |
| 15 | `getTrackAnalysers(trackId)` before `ensureGraph` | Returns `null` | `track-analysers-null-before-build` |
| 16 | `getTrackAnalysers(trackId)` after graph built | Returns `{left, right}` with `fftSize=1024`, `smoothingTimeConstant=0` | `track-analysers-populated` |
| 17 | `getMasterAnalysers()` after graph built | Returns post-chain tap pair | `master-analysers-post-chain` |
| 18 | `getTrackChannelCount` with only mono buffers decoded | Returns `1` | `channel-count-mono` |
| 19 | `getTrackChannelCount` with any stereo buffer decoded | Returns `2` | `channel-count-stereo` |
| 20 | `getTrackChannelCount` before any decode | Returns `2` (avoids mono flash) | `channel-count-default-stereo` |
| 21 | `reevaluateMasterChain(newEffects)` after graph built | Old chain disposed; new chain built; analyser re-tapped off new output; destination re-wired | `master-chain-swap` |
| 22 | `reevaluateMasterChain(newEffects)` before graph built | Stores `masterEffects`; no graph construction | `master-chain-lazy` |
| 23 | `dispose()` then any public method call | All methods are no-ops; no throws | `dispose-freezes-mixer` |
| 24 | `dispose()` called twice | Second call is a no-op | `dispose-idempotent` |
| 25 | `renderMixToBuffer` window with one track, one clip entirely inside window | Offline PCM contains the clip's decoded samples with clip+track curves applied | `offline-single-clip-renders` |
| 26 | `renderMixToBuffer` window with `endTimeS <= startTimeS` | Promise rejects with descriptive error; no context is constructed | `offline-rejects-zero-window` |
| 27 | `renderMixToBuffer` with `channels` not in {1,2} | Promise rejects | `offline-rejects-bad-channels` |
| 28 | `renderMixToBuffer` where a clip's asset fetch 404s | That clip is skipped (console.warn); render completes; other clips render | `offline-skips-missing-asset` |
| 29 | `renderMixToBuffer` with overlapping clips on same track | Same equal-power crossfade as live path | `offline-same-crossfade` |
| 30 | `renderMixToBuffer` with solo'd track | Non-solo tracks silenced; solo track rendered | `offline-solo-honored` |
| 31 | Live vs. offline rendering same window, same state | PCM samples match within float determinism of the browser's OfflineAudioContext | `live-offline-parity` |
| 32 | Offline render with a `hidden` track | Track is skipped (no graph nodes allocated) | `offline-skips-hidden-track` |
| 33 | Clip entirely outside the offline render window | Skipped; no source node created | `offline-skips-outside-window` |
| 34 | Clip partially inside the offline window (starts before `startTimeS`) | `sourceOffset` advanced by `(startTimeS − clip.start_time) × rate`; `whenInOffline = 0` | `offline-mid-clip-start` |
| 35 | Clip partially inside the offline window (ends after `endTimeS`) | `effectiveDuration` clamped to `endTimeS − clip.start_time` (scaled by rate) | `offline-mid-clip-end` |
| 36 | `setActiveAudioMixer(m)` then `getActiveAudioMixer()` | Returns `m` | `ref-set-get` |
| 37 | `setActiveAudioMixer(null)` | `getActiveAudioMixer()` returns `null` | `ref-clear` |
| 38 | Two mixers: `setActiveAudioMixer(m1)` then `setActiveAudioMixer(m2)` | `getActiveAudioMixer()` returns `m2` (last-write-wins) | `ref-last-write-wins` |
| 39 | `seek` with no `AudioContext` yet | Updates `lastPlayhead`; returns without graph work | `seek-before-play-updates-playhead-only` |
| 40 | Decode failure during graph build (background fetch throws) | Logged via `console.debug`/`console.warn`; no exception propagates; clip is not activated; other clips unaffected | `decode-error-contained` |
| 41 | `AudioContext.state === 'suspended'` when `ensureCtx` runs | `ctx.resume()` is invoked; rejection is swallowed | `resume-suspended-ctx` |
| 42 | `seek` during an active live crossfade | In-flight crossfade curves cancelled on seek; no crossfade carries across seek boundary; rescheduled fresh from the new position | `seek-cancels-in-flight-crossfade` |
| 43 | `play()` with zero tracks | Master graph still built; master analysers report silence; no exception | `play-with-zero-tracks-builds-silence` |
| 44 | `rebuild` called while sources are actively playing | Brief audible click at teardown boundary is accepted; not further constrained | `rebuild-midplay-click-accepted` |
| 45 | Asset fetch 404 in live path | No retry within mixer instance; clip marked inactive + `console.warn`; rebuild required to retry | `live-asset-404-no-retry-within-instance` |
| 46 | (moot) Decoded buffer's native sample rate ≠ AudioContext | Out of scope; no offline mixdown path to compare against | `removed-per-no-offline-path` |
| 47 | User toggles `solo` on a track mid-playback without `updateTrack` / `rebuild` | Contract: caller MUST invoke `updateTrack(trackId)` or `rebuild()` to propagate; bare-field mutation does NOT reschedule | `solo-without-updatetrack-no-reschedule` |
| 48 | Decode cache grows over a long session | LRU evicts when total decoded audio exceeds 512 MB; project switch clears | `decode-cache-lru-evicts-at-512mb`, `decode-cache-cleared-on-project-switch` |
| 49 | (moot) Offline sample rate mismatch | Removed per no-offline-path | `removed-per-no-offline-path` |
| 50 | (moot) Offline master-effect tails | Removed per no-offline-path | `removed-per-no-offline-path` |
| 51 | HMR reload while mixer is playing | Same as project switch: cache cleared; mixer instance disposed by React cleanup; new graph builds fresh | `hmr-reload-clears-cache-like-project-switch` |
| 52 | Second browser window attempts to build an AudioMixer while window A owns playback | Take-over modal in window B; on confirm, window A's `AudioMixer.dispose()` runs and window B installs a fresh one; read-only playhead streams to window A via unified WS | `take-playback-control-modal-transfers` |
| 53 | Owning window closes while playback is active | Exclusive resource released; next interaction in any remaining window claims playback | `owning-window-close-releases-playback` |

---

## Behavior (step-by-step)

### Lifecycle
1. `createAudioMixer(projectName, tracks, options)` constructs internal data structures (`trackMap`, `pendingDecodes`) but does NOT create an `AudioContext`.
2. The first operation that requires an `AudioContext` (typically `play()`) invokes `ensureCtx()` → `audioCtxFactory()`. If `state === 'suspended'`, `resume()` is called (fire-and-forget).
3. `ensureGraph()` is idempotent: it calls `ensureMasterGraph`, then for each track calls `buildTrackGraph` (idempotent), then for each clip calls `buildClipGraph` (idempotent). `buildClipGraph` also kicks off a background `decodeClipBuffer`.

### Seek logic (R7)
- `crossedLargeGap = |seconds − lastPlayhead| > 0.05`.
- `lastPlayhead = seconds`.
- If no `AudioContext` exists, return immediately (playhead tracked, no graph work).
- If hard seek: reschedule all track curves.
- `reevaluateClips(seconds, hardSeek)` iterates every clip:
  - `inside = seconds ∈ [start_time, end_time)`.
  - inactive + inside → `activateClip`.
  - active + !inside → `deactivateClip`.
  - active + inside + hardSeek → `deactivateClip` then `activateClip` (source is single-use).

### Activation (R10)
- If `buffer === null`: await decode; on resolve, if `!disposed` and playhead still inside clip window, re-enter `activateClip`.
- Tear down any existing source on the clip.
- Compute `sourcePosition`, `whenDelta`, `effectiveDuration`.
- Create fresh `AudioBufferSourceNode`; set `buffer` and `playbackRate.value = rate`.
- Connect `source → clipGain`.
- Reset `crossfadeGain.gain` to 1 at `ctx.currentTime`.
- Schedule the clip curve on `clipGain.gain`.
- For each overlapping active clip on the same track, schedule crossfade (COS/SIN).
- If `isPlaying` and `effectiveDuration > 0`, call `source.start(when, sourcePosition, effectiveDuration)`.
- Mark `clipNode.source = src`, `clipNode.active = true`.

### Mute / solo (R12)
- Solo rule evaluated at every `scheduleTrackCurve` call by sampling the live `trackMap` for any track with `solo === true`.
- There is **no** internal listener that re-evaluates solo when `track.solo` mutates. The caller (React / Timeline) must call `updateTrack` or `rebuild` to reflect the change (see OQ-6).

### Offline render
1. Validate inputs (R22); compute `frames = ceil((endTimeS−startTimeS) × sampleRate)`.
2. Construct `OfflineAudioContext({numberOfChannels, length: frames, sampleRate})`.
3. Build master fx chain; wire `masterGain → chain.input → chain.output → destination`.
4. For each non-hidden track with at least one clip in the window:
   - Create `trackGain`, wire to `masterGain`.
   - Schedule track curve at `playhead=startTimeS`, `paramAnchorTime=0`, `effectiveMuted = isTrackEffectivelyMuted(track, tracks)`.
   - For each intersecting clip: resolve buffer (cache or fetch); compute window math; build source + gains; connect; schedule clip curve; call `source.start(whenInOffline, sourceOffset, effectiveDuration)`.
5. Schedule same-track crossfades over intersecting clip pairs.
6. `await ctx.startRendering()`.
7. Extract PCM: mono copies channel 0; stereo interleaves L/R (duplicating channel 0 if only one channel rendered).
8. Return `{pcm, channels, sampleRate, durationSeconds}`.

---

## Acceptance Criteria

- [ ] Every live-mixer requirement R1–R17, R23–R28 has at least one named test in §Tests.
- [ ] `COS_CURVE` and `SIN_CURVE` are imported by the live mixer and used verbatim; no recomputation anywhere.
- [ ] Decode cache obeys LRU cap (512 MB) + project-switch clear.
- [ ] `dispose()` is idempotent and no public method throws post-dispose.
- [ ] All previously-undefined scenarios on rows 42–51 are resolved; rows 46/49/50 are removed per the no-offline-path correction.
- [ ] Multi-window ownership (R27) honors take-over + close-releases behavior.

---

## Tests

### Base Cases

#### Test: factory-no-ctx-until-needed (covers R1, R2)

**Given**: `createAudioMixer('p', [])` called with no `audioCtxFactory` override.
**When**: The mixer is constructed and no method is called.
**Then**:
- **no-ctx-constructed**: no `AudioContext` instance exists.
- **track-count-zero**: `mixer.trackCount === 0`.
- **no-throw**: construction does not throw.

#### Test: track-count-zero (covers R1)

**Given**: Mixer built with `tracks = []`.
**When**: `mixer.trackCount` is read.
**Then**:
- **returns-zero**: value is `0`.

#### Test: play-activates-covered-clip (covers R3, R4, R8, R10)

**Given**: One track with one clip `start_time=0, end_time=10, source_offset=0, playback_rate=1`; playhead at `0`.
**When**: `mixer.play()`.
**Then**:
- **is-playing**: internal `isPlaying` flag is true (observed via subsequent `seek` behaviors).
- **source-created**: an `AudioBufferSourceNode` is created and connected to `clipGain`.
- **start-invoked**: `source.start(ctx.currentTime + 0, 0, ≤10)` is invoked exactly once.
- **clip-active**: `clipNode.active === true`.
- **master-graph-built**: master analyser pair is non-null after play.
- **debug-log**: `[audio-mixer] play() @0.000s` emitted via `console.debug`.

#### Test: pause-stops-sources-keeps-graph (covers R9)

**Given**: A playing mixer with one active clip.
**When**: `mixer.pause()`.
**Then**:
- **source-stopped**: the active source has `.stop()` + `.disconnect()` called.
- **active-cleared**: `clipNode.active === false`.
- **trackgain-intact**: `trackGain` still connected to `masterGain` (master analysers still report).
- **ctx-open**: `AudioContext.close()` is NOT called.

#### Test: hard-seek-rebuilds-source (covers R7)

**Given**: Playing mixer; active clip covers `[0, 10]`; playhead at `1`.
**When**: `mixer.seek(5)` (delta > 0.05).
**Then**:
- **old-source-stopped**: prior source node is stopped + disconnected.
- **new-source-created**: a new `AudioBufferSourceNode` replaces it.
- **source-offset-5**: new `source.start(_, 5, _)` — `sourceOffset` reflects the 4s advance at rate 1.
- **track-curves-rescheduled**: `trackGain.gain.cancelScheduledValues` observed at the new anchor.

#### Test: soft-seek-preserves-source (covers R7)

**Given**: Playing mixer; active clip; playhead at `1.0`.
**When**: `mixer.seek(1.01)` (delta ≤ 0.05).
**Then**:
- **source-unchanged**: the original `AudioBufferSourceNode` instance is still attached.
- **playhead-updated**: subsequent behavior uses `1.01`.

#### Test: seek-activates-newly-covered-clip (covers R7)

**Given**: Playing mixer; clip `[5, 10]` currently inactive; playhead at `0`.
**When**: `mixer.seek(6)`.
**Then**:
- **activated**: clip becomes active.
- **start-called**: `source.start(_, 1, _)` (6 − 5 = 1 source offset).

#### Test: seek-deactivates-exited-clip (covers R7)

**Given**: Active clip covering `[0, 5]`; playhead at `2`.
**When**: `mixer.seek(7)`.
**Then**:
- **source-stopped**: `.stop()` + `.disconnect()` called.
- **active-false**: `clipNode.active === false`.

#### Test: crossfade-equal-power (covers R11)

**Given**: Same track, two clips: A `[0, 10]` and B `[8, 18]`; playhead at `0`; both active.
**When**: The mixer activates B (or scheduling runs).
**Then**:
- **cos-curve-on-incumbent**: A.crossfadeGain.gain receives `setValueCurveAtTime(COS_CURVE, fadeStart, 2)`.
- **sin-curve-on-newcomer**: B.crossfadeGain.gain receives `setValueCurveAtTime(SIN_CURVE, fadeStart, 2)`.
- **fadeStart-aligned**: `fadeStart = ctx.currentTime + max(0, 8 − 0) = ctx.currentTime + 8`.
- **equal-power**: `COS_CURVE[i]² + SIN_CURVE[i]² ≈ 1` for all `i` (shared-curve sanity).

#### Test: no-cross-track-crossfade (covers R11)

**Given**: Two tracks, each with one clip; clips have overlapping time windows.
**When**: Both clips are active.
**Then**:
- **no-crossfade**: neither clip's `crossfadeGain` receives `setValueCurveAtTime`.
- **both-audible**: both clips play at their scheduled clip-curve gains.

#### Test: muted-track-silent (covers R12, R26)

**Given**: Track with `muted=true`, one clip inside playhead.
**When**: `mixer.play()`.
**Then**:
- **gain-zero**: `trackGain.gain` is set to `0` at the anchor time.
- **no-ramps**: no ramp points are scheduled on `trackGain.gain`.

#### Test: solo-mutes-others (covers R12)

**Given**: Tracks A (`solo=true`), B (`solo=false`), both with clips covering playhead.
**When**: `mixer.play()`.
**Then**:
- **a-audible**: A's `trackGain.gain` anchored at `dbToLinear(sampleTrackDbAtPlayhead(A, _))`.
- **b-silenced**: B's `trackGain.gain` set to `0`.

#### Test: rebuild-mid-playback (covers R15)

**Given**: Playing mixer with track T1.
**When**: `mixer.rebuild([T2])` where T2 is a different track.
**Then**:
- **t1-torn-down**: T1's clips, clipGains, trackGain, analysers are all disconnected.
- **t2-graph-built**: T2 has fresh nodes; `ensureGraph` ran.
- **hard-seek-run**: T2's clips covering `lastPlayhead` activate with fresh source nodes.
- **ctx-not-closed**: `AudioContext.close()` NOT called.

#### Test: rebuild-hits-decode-cache (covers R5, R6, R15)

**Given**: Track T1 with clip using `source_path='a.wav'` has already been decoded; `rebuild([T1'])` where T1' references the same `source_path`.
**When**: The new clip activates.
**Then**:
- **fetch-not-called**: `fetchBytes` is NOT called for `a.wav`.
- **decode-not-called**: `decode` is NOT called.
- **cache-hit-stat**: `decodeStats.hits` increments.

#### Test: concurrent-decode-dedup (covers R5, R24)

**Given**: Mixer with two clips sharing `source_path='x.wav'`; both activated within the same tick.
**When**: Graph build fires.
**Then**:
- **single-fetch**: `fetchBytes('…x.wav')` is called exactly once.
- **single-decode**: `decode(…)` is called exactly once.
- **both-buffers-set**: both clip nodes end up with the same `AudioBuffer` instance.

#### Test: track-analysers-null-before-build (covers R13)

**Given**: Fresh mixer, no `ensureGraph` call.
**When**: `getTrackAnalysers('t1')` and `getMasterAnalysers()` are called.
**Then**:
- **track-null**: `getTrackAnalysers('t1') === null`.
- **master-null**: `getMasterAnalysers() === null`.

#### Test: track-analysers-populated (covers R13)

**Given**: Mixer after `play()` with one track.
**When**: `getTrackAnalysers('t1')`.
**Then**:
- **returns-pair**: non-null object with `left`, `right` analysers.
- **fft-size-1024**: `left.fftSize === 1024` and `right.fftSize === 1024`.
- **smoothing-zero**: both have `smoothingTimeConstant === 0`.

#### Test: master-analysers-post-chain (covers R3, R13)

**Given**: Mixer built with `masterEffects = [someEffect]`; graph built.
**When**: `getMasterAnalysers()`.
**Then**:
- **returns-pair**: non-null.
- **post-chain**: the analyser splitter's upstream node is `masterFxChain.output`, not `masterGain`.

#### Test: channel-count-mono (covers R14)

**Given**: Track with one clip whose decoded buffer has `numberOfChannels = 1`.
**When**: `getTrackChannelCount('t1')`.
**Then**:
- **returns-1**: value is `1`.

#### Test: channel-count-stereo (covers R14)

**Given**: Track with one stereo clip and one mono clip.
**When**: `getTrackChannelCount('t1')`.
**Then**:
- **returns-2**: value is `2`.

#### Test: channel-count-default-stereo (covers R14)

**Given**: Track whose clip has not yet decoded (buffer is null).
**When**: `getTrackChannelCount('t1')`.
**Then**:
- **returns-2**: value is `2`.

#### Test: master-chain-swap (covers R16)

**Given**: Playing mixer with master fx `[A]`.
**When**: `reevaluateMasterChain([B])`.
**Then**:
- **old-chain-disposed**: old `EffectChainHandle.dispose()` called.
- **new-chain-wired**: `masterGain → newChain.input`; `newChain.output → destination`.
- **analyser-retapped**: new analyser splitter sourced from `newChain.output`.
- **no-audio-loss**: master gain is re-connected before the method returns.

#### Test: master-chain-lazy (covers R16)

**Given**: Fresh mixer; no `ensureGraph` yet.
**When**: `reevaluateMasterChain([X])`.
**Then**:
- **no-graph-built**: no `AudioContext` created, no nodes instantiated.
- **next-play-uses-x**: subsequent `play()` produces a master chain containing effect X.

#### Test: dispose-freezes-mixer (covers R17)

**Given**: Playing mixer.
**When**: `mixer.dispose()`; then `play`, `pause`, `seek(5)`, `rebuild([])`, `updateClip('c')`, `updateTrack('t')`, `reevaluateMasterChain([])` each invoked.
**Then**:
- **no-throws**: no call throws.
- **no-audio**: no new source nodes are created; `AudioContext.close()` was called exactly once.

#### Test: dispose-idempotent (covers R17)

**Given**: Playing mixer.
**When**: `mixer.dispose()` called twice in a row.
**Then**:
- **second-noop**: second call performs no disconnects; no throws.
- **close-once**: `AudioContext.close()` was called exactly once total.

*(Offline-render tests removed — offline bounce/analyze renderer is specified in
`local.bounce-and-analysis.md`; this spec no longer asserts those behaviors.)*

#### Test: ref-set-get (covers R23)

**Given**: `setActiveAudioMixer(m1)` called.
**When**: `getActiveAudioMixer()`.
**Then**:
- **returns-m1**: value `=== m1`.

#### Test: ref-clear (covers R23)

**Given**: `setActiveAudioMixer(m1)` then `setActiveAudioMixer(null)`.
**When**: `getActiveAudioMixer()`.
**Then**:
- **returns-null**: value is `null`.

#### Test: ref-last-write-wins (covers R23)

**Given**: `setActiveAudioMixer(m1)` then `setActiveAudioMixer(m2)`.
**When**: `getActiveAudioMixer()`.
**Then**:
- **returns-m2**: value `=== m2`.

### Edge Cases

#### Test: seek-before-play-updates-playhead-only (covers R7)

**Given**: Fresh mixer; no `play` yet; no `AudioContext`.
**When**: `seek(10)`.
**Then**:
- **no-ctx-constructed**: `audioCtxFactory` was NOT called.
- **playhead-stored**: a subsequent `play()` activates clips relative to `10`, not `0`.

#### Test: decode-error-contained (covers R2, R8)

**Given**: A clip whose `decode` function rejects.
**When**: `play()` runs `ensureGraph` and decode fires.
**Then**:
- **no-throw**: `play()` does not throw.
- **not-activated**: the clip's `active` remains `false`.
- **other-clips-ok**: any sibling clip with a valid source still activates.
- **log-emitted**: `decode failed` appears in console output.

#### Test: resume-suspended-ctx (covers R2)

**Given**: `audioCtxFactory` returns a context with `state === 'suspended'`.
**When**: `ensureCtx` runs.
**Then**:
- **resume-called**: `ctx.resume()` invoked.
- **rejection-swallowed**: if `resume()` rejects, no exception escapes `ensureCtx`.

*(Offline-render edge cases removed — see `local.bounce-and-analysis.md`.)*

#### Test: rebuild-mid-playback-undefined-artifact (covers R15)

**Given**: Playing mixer with an actively-ringing source.
**When**: `rebuild([...])` mid-playback.
**Then**:
- **undefined-click**: spec explicitly does not constrain audible-click behavior — marked for OQ-3.

*Note*: this is a placeholder for the Open Question; implementation SHOULD NOT be changed without first resolving OQ-3.

#### Test: solo-toggle-mid-playback-not-propagated (covers R12)

**Given**: Playing mixer; track T has `solo=false`; user mutates `track.solo = true` on the underlying object without calling `updateTrack`.
**When**: Audio continues playing (no mixer method invoked).
**Then**:
- **no-reschedule**: `trackGain.gain` is not re-scheduled by the mixer; the audible balance does not change until a subsequent `updateTrack`, `rebuild`, `play`, or hard `seek` occurs.
- **undefined-semantics**: whether this is correct behavior is deferred to OQ-6.

#### Test: decode-cache-lru-evicts-at-512mb (covers R6)

**Given**: Many sequential decodes pushing total decoded audio past 512 MB.
**When**: `decodeCache` is observed after the cap is exceeded.
**Then**:
- **total-bytes-capped**: `sum(numberOfChannels × length × 4)` across cached buffers is ≤ 512 MB.
- **lru-evicted-first**: the least-recently-used entries are the ones missing.
- **still-functional**: re-decoding an evicted path incurs a fresh fetch + decode.

#### Test: decode-cache-cleared-on-project-switch (covers R6)

**Given**: A populated `decodeCache` (HMR reload is treated identically).
**When**: The project is switched (or the page HMR-reloads, which collapses to the same event).
**Then**:
- **cache-empty**: `decodeCache.size === 0`.
- **pending-decodes-empty**: `pendingDecodes` is likewise empty.

#### Test: seek-cancels-in-flight-crossfade (covers R11, OQ-1)

**Given**: A crossfade between two clips on the same track is partway through.
**When**: `seek(t)` with a hard delta is called.
**Then**:
- **cancel-on-both-crossfade-gains**: both `crossfadeGain.gain.cancelScheduledValues` observed.
- **no-cross-boundary-carry**: neither clip's crossfade curve continues past the seek.
- **reschedule-if-overlap-still-covers-t**: if the new playhead still falls inside the overlap window, a fresh COS/SIN pair is scheduled at the new anchor.

#### Test: play-with-zero-tracks-builds-silence (covers R3, OQ-2)

**Given**: Mixer constructed with `tracks = []`.
**When**: `mixer.play()`.
**Then**:
- **master-graph-built**: master analyser pair is non-null.
- **silence-from-analysers**: `getByteTimeDomainData` yields mid-rail (silent) samples.
- **no-exception**: `play()` returns normally.

#### Test: rebuild-midplay-click-accepted (covers R15, OQ-3)

**Given**: Playing mixer with an actively-ringing source.
**When**: `rebuild([...])` runs.
**Then**:
- **teardown-observed**: old source's `.stop()` / `.disconnect()` called.
- **click-is-not-constrained**: spec explicitly accepts a brief audible click at the teardown boundary — test asserts only that teardown + fresh build completed without exception.

#### Test: live-asset-404-no-retry-within-instance (covers OQ-4)

**Given**: A clip whose `fetchBytes` throws in the live path.
**When**: Activation attempts fire over several seeks within the same mixer instance.
**Then**:
- **warn-logged**: `console.warn` contains `decode failed` and the clip id.
- **active-false**: the clip's `active` flag stays `false` across subsequent seeks.
- **no-auto-retry**: `fetchBytes` is called at most once per activation attempt; no exponential-backoff retry loop fires.
- **rebuild-resets**: after `rebuild([...])`, a fresh `fetchBytes` attempt is allowed.

#### Test: solo-without-updatetrack-no-reschedule (covers R12, R28, OQ-6)

**Given**: Playing mixer; track T with `solo=false`. User mutates `track.solo = true` on the underlying object without calling `updateTrack`.
**When**: Audio continues playing; no mixer method is invoked.
**Then**:
- **no-reschedule**: no `trackGain.gain.cancelScheduledValues` / `setValueAtTime` is observed on the mixer's internal nodes as a result of the mutation.
- **audible-balance-unchanged**: output balance does not change until a subsequent `updateTrack`, `rebuild`, `play`, or hard `seek` occurs.

#### Test: hmr-reload-clears-cache-like-project-switch (covers R6, OQ-10)

**Given**: Mixer + populated decodeCache.
**When**: Vite/webpack HMR reloads the module.
**Then**:
- **cache-cleared-by-module-reinit**: the new module-scope `decodeCache` starts empty (module-level re-initialization, same as project-switch path).
- **no-dangling-pendingdecodes**: `pendingDecodes` is empty.

#### Test: take-playback-control-modal-transfers (covers R27)

**Given**: Window A owns the live `AudioMixer` (playback active); window B is another tab of the same project.
**When**: Window B attempts to start playback.
**Then**:
- **modal-shown-in-b**: window B displays a "Take playback control" modal.
- **on-confirm-a-disposes**: window A's `AudioMixer.dispose()` is invoked and window A transitions to read-only playhead streaming.
- **b-builds-fresh-mixer**: window B constructs a new `AudioMixer`, calls `play()`, and becomes the owner.

#### Test: owning-window-close-releases-playback (covers R27)

**Given**: Window A owns playback; window B is open as a peer (read-only playhead).
**When**: Window A closes (page unload).
**Then**:
- **resource-released**: `AudioMixer.dispose()` runs in window A's unload handler.
- **next-action-claims**: window B's next Play interaction claims the playback role without a take-over modal (since no owner remained).

---

## Non-Goals

- **Effect registry internals**: param curves, effect-level bypass, built-in effect types — specified separately (`audio-effects-and-curve-scheduling`).
- **Send-bus topology** (reverb/delay/echo buses): referenced but not specified here.
- **Pitch-preservation during `playback_rate ≠ 1`**: WebAudio BufferSource has no native pitch preservation; a phase-vocoder shim is TODO (M15 task N — see comment in `audio-mixer.ts:484-486`).
- **Timeline integration**: `Timeline.tsx` seeking into the mixer via `seekRef`, HTMLAudioElement master clock, panel remount handling — covered in `timeline-composition-and-playback-loop`.
- **WAV encoder byte-level correctness** (`encodePCMToWav`) + offline `renderMixToBuffer`: fully in `bounce-and-analysis`.
- **Waveform cache and peaks fetching**: split into `waveform-cache-and-rendering`.

---

## Open Questions

### Resolved

- **OQ-1 — Seek during active crossfade**: **Resolved (fix)**. Seek cancels in-flight crossfade curves and reschedules from the new position; no curve carries across the seek boundary. Test: `seek-cancels-in-flight-crossfade`.
- **OQ-2 — `play()` with zero tracks**: **Resolved (codify)**. Master graph built; master analysers report silence; no exception. Test: `play-with-zero-tracks-builds-silence`.
- **OQ-3 — `rebuild` mid-playback**: **Resolved (codify)**. Audible click at the teardown boundary is accepted; not further constrained. Test: `rebuild-midplay-click-accepted`.
- **OQ-4 — Live-path asset 404**: **Resolved (codify)**. No retry within a mixer instance; clip marked inactive + `console.warn`; rebuild required to retry. Test: `live-asset-404-no-retry-within-instance`.
- **OQ-5 — Sample-rate mismatch (live vs offline)**: **Removed**. There is no offline audio mixdown path in scenecraft (mix-render.ts is bounce/analyze-only). The question is moot in this spec.
- **OQ-6 — Solo toggle without `updateTrack`**: **Resolved (codify)**. Contract is "mute/solo changes require `updateTrack(trackId)` or `rebuild()` to take effect." Requirement R28. Test: `solo-without-updatetrack-no-reschedule`.
- **OQ-7 — Decode cache growth**: **Resolved (fix)**. LRU cap at 512 MB total decoded audio; clear on project switch. Requirement R6. Tests: `decode-cache-lru-evicts-at-512mb`, `decode-cache-cleared-on-project-switch`.
- **OQ-8 — Offline sample rate ≠ live**: **Removed**. No offline mixdown path; bounce/analyze spec owns any sample-rate semantics in that context.
- **OQ-9 — Master-effect tails offline**: **Removed**. No offline mixdown path.
- **OQ-10 — HMR-surviving decode cache**: **Resolved via OQ-7**. Project-switch clear covers HMR reload (module re-init). Test: `hmr-reload-clears-cache-like-project-switch`.

---

## Related Artifacts

- **Audit**: `agent/reports/audit-2-architectural-deep-dive.md` §1E units 1–3, 10–11; §2 "Audio = Frontend"; §3 leaks #6, #15.
- **Source files**:
  - `src/lib/audio-mixer.ts`
  - `src/lib/mix-graph.ts`
  - `src/lib/mix-render.ts`
  - `src/lib/audio-mixer-ref.ts`
- **Adjacent / downstream specs** (planned from audit §5):
  - `local.audio-effects-and-curve-scheduling.md` — effect registry, param curves, bypass.
  - `local.bounce-and-analysis.md` — `encodePCMToWav`, bounce end-to-end, master-bus analysis.
  - `local.timeline-composition-and-playback-loop.md` — how Timeline + CurrentTimeContext drive `AudioMixer.seek`.
  - `local.audio-lane-and-clip-editing.md` — how clip CRUD triggers `rebuild` / `updateClip`.
- **Memory**:
  - `project_frontend_is_audio_source_of_truth.md` — mix analysis + final export MUST render via OfflineAudioContext cloning the playback graph.
  - `project_panel_singletons_for_long_lived_connections.md` — rationale for `audio-mixer-ref` as a module singleton.

---

**Status**: Retroactive spec. All previously-`undefined` Behavior Table rows
(42–51) have been resolved per OQ resolution 2026-04-27; offline-mixdown rows
(46/49/50) are removed as out-of-scope. Multi-window INV-5 behavior added
(rows 52–53) with implementation details deferred to
`agent/design/local.multi-window-workspaces.md`.
