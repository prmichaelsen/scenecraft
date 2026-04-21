# Milestone 14: In-Editor Audio Playback

**Goal**: Real-time multi-track audio playback inside the Timeline via a WebAudio streaming mixer, so users hear their audio clips, volume curves, mute toggles, and equal-power crossfades during editing — not only at export time.
**Duration**: ~1.5 weeks (14 hours dev)
**Dependencies**: M9 (Audio Tracks & Clips) ✅ complete. M9 Task 91 (server mixdown) defines the output the client mixer mirrors.
**Status**: Not Started

---

## Overview

Today the Timeline plays only the legacy single `audioFile` (beats track). Audio clips added in M9 — their curves, mutes, crossfades — are inaudible until export. This milestone delivers a client-side WebAudio mixer that streams each clip via `HTMLAudioElement` + `MediaElementAudioSourceNode`, runs per-clip and per-track `GainNode` automation from the same dB curves the server uses, and sums to `AudioContext.destination`.

The server-side `render_project_audio` (Task 91) remains the source of truth for export. The in-editor mixer is a perceptually-equivalent preview — not bit-identical — and is shaped for the primary use case: **3-hour videos with up to four full-length audio tracks**.

**Design**: [`local.audio-streaming-and-mixing.md`](../design/local.audio-streaming-and-mixing.md)

---

## Deliverables

### 1. `src/lib/audio-mixer.ts`
- `createAudioMixer(projectName, tracks): AudioMixer` factory.
- Internal `TrackNode` / `ClipNode` structures holding `HTMLAudioElement`, `MediaElementAudioSourceNode`, `GainNode`.
- Public API: `play()`, `pause()`, `seek(sec)`, `updateClip(id)`, `updateTrack(id)`, `rebuild(tracks)`, `dispose()`.
- Curve sampling helpers in TS that match `scenecraft.audio.curves` semantics (np.interp-equivalent, dB→linear).

### 2. Streaming source management
- One `<audio>` per clip, `src = scenecraftFileUrl(project, clip.source_path)`.
- `MediaElementAudioSourceNode` per element (note: each node can only exist once per element).
- Active-window tracking: `.play()` + `audio.currentTime = source_offset + (now - start)` on entry; `.pause()` on exit.
- Seek semantics: re-evaluate active clips without tearing down nodes.

### 3. Curve automation
- `scheduleClipCurve` emits `setValueAtTime` + `linearRampToValueAtTime` sequences at the curve breakpoints for the remaining span of the playing clip.
- Track curves scheduled in absolute seconds from current playhead.
- `clipGain` is `Math.pow(10, db/20)` with mute taking precedence (setValueAtTime 0).
- Equal-power crossfade on same-track overlap: precomputed cos/sin `Float32Array` applied via `setValueCurveAtTime`.

### 4. Timeline integration
- `useAudioMixer(projectName, audioTracks)` hook in Timeline.
- Feature-flag rollout via `localStorage.scenecraft_use_audio_mixer`, default off.
- When on, the legacy `<AudioTrack>` element is replaced; when off, legacy path runs unchanged.
- Subscribe to `isPlaying`, `currentTime`, `localAudioTracks` — react to each via the mixer API.

### 5. Tests
- Unit: curve sampling matches Python reference at keypoints; `dbToLinear` parity; schedule math emits expected `AudioParam` calls (mocked `GainNode`).
- Integration (jsdom + WebAudio mock): two non-overlapping clips activate/deactivate at the right playhead; muted clip → 0 gain regardless of curve; seek pauses previously-active elements.

---

## Success Criteria

- [ ] With the feature flag on, pressing play in the Timeline produces audible multi-track output — every enabled/non-muted clip plays during its timeline window.
- [ ] Dragging a volume-curve point during playback changes the perceived level within one frame; no restart required.
- [ ] Toggling track or clip mute silences/unsilences within one frame.
- [ ] Seeking backwards or forwards resumes playback cleanly from the new position with no clips stuck from the prior position.
- [ ] Same-track overlap plays an equal-power crossfade — no pop, no level spike.
- [ ] Editor memory stays bounded (<200 MB added) on a 3hr × 4 track project.
- [ ] Perceptual A/B between in-editor playback and exported mixdown is indistinguishable for a 30 s passage.
- [ ] Feature flag off path continues to work (legacy beats-track only).

---

## Key Files to Create

**Frontend**:
- `src/lib/audio-mixer.ts` — mixer module
- `src/hooks/useAudioMixer.ts` — React integration
- `src/lib/audio-curves.ts` — TS port of curve sampling + dB→linear (mirrors engine)
- `src/lib/__tests__/audio-mixer.test.ts` — unit tests
- `src/lib/__tests__/audio-curves.test.ts` — curve parity tests

**Modified**:
- `src/components/editor/Timeline.tsx` — flag-gated swap from `<AudioTrack>` to `useAudioMixer`
- `CHANGELOG.md` per-task entries

---

## Risks

- **Browser policy gotchas**: `AudioContext` needs a user gesture; `MediaElementAudioSourceNode` can only wrap an element once. Mitigated by lazy context creation on first play + per-element source dedup.
- **`<audio>` concurrency limits**: Chrome ~75, Safari lower. Primary use case (≤4 long tracks, modest clip count) is well under; document the limit and add a pool-and-recycle layer later if needed.
- **Range-request support**: streaming across long clips assumes the scenecraft file server honours `Range` headers for all audio formats. Verify for WAV/M4A/MP3/OGG early.
- **Curve math drift between TS and Python**: mitigated by the unit test that samples both and compares at fixed breakpoints.

---

## Out of Scope (Future Milestones)

- Hybrid decode path (short clips as `AudioBuffer`) for sample-accurate stacking — deferred until a workflow demands it.
- Effect inserts (EQ, compression, reverb) — separate milestone.
- Peak meters / LUFS metering — natural follow-up once the mixer lands.
- Audio time remapping (linked inherits tr.remap, unlinked owns its own) — see design doc Future Considerations.

---

## Tasks

- [Task 115](../tasks/milestone-14-in-editor-audio-playback/task-115-mixer-module-skeleton.md) — Mixer module skeleton + curve math TS port + unit tests (3h)
- [Task 116](../tasks/milestone-14-in-editor-audio-playback/task-116-webaudio-graph-and-streaming.md) — WebAudio graph + streaming source management + scheduling loop (4h)
- [Task 117](../tasks/milestone-14-in-editor-audio-playback/task-117-curve-automation-and-crossfade.md) — Curve automation + equal-power crossfade on same-track overlaps (3h)
- [Task 118](../tasks/milestone-14-in-editor-audio-playback/task-118-timeline-integration-and-flag.md) — Timeline integration behind feature flag + perceptual A/B + migration plan (4h)

---

**Status**: Not Started
**Next Task**: Task 115 — Mixer module skeleton
