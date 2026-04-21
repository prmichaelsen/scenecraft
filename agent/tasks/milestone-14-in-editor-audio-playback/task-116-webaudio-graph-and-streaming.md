# Task 116: WebAudio Graph + Streaming Sources + Scheduling Loop

**Milestone**: [M14](../../milestones/milestone-14-in-editor-audio-playback.md)
**Design Reference**: [local.audio-streaming-and-mixing.md](../../design/local.audio-streaming-and-mixing.md)
**Estimated Time**: 3-5 hours
**Dependencies**: Task 115
**Status**: Not Started

---

## Objective

Build the live WebAudio graph inside the mixer: `AudioContext`, per-track `GainNode`, per-clip `GainNode`, `HTMLAudioElement` + `MediaElementAudioSourceNode` per clip. Implement the scheduling loop that activates/deactivates clips as the playhead crosses their boundaries.

---

## Context

Streaming (not full decode) is the critical architectural choice — see design doc for memory math. Each `<audio>` element is wrapped once by a `MediaElementAudioSourceNode` (the browser enforces this); reusing an element requires disposing the source node first.

---

## Steps

### 1. Lazy `AudioContext` creation

Create the context on first `play()` (user-gesture requirement). Before first play, the mixer holds only data, no nodes.

```typescript
let audioCtx: AudioContext | null = null
function ensureCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext({ latencyHint: 'playback' })
  return audioCtx
}
```

### 2. Build track + clip nodes

On `rebuild(tracks)` (and first `play()`):

- For each track, create one `GainNode` connected to `destination`.
- For each clip on the track, create `<audio>` with `.src = scenecraftFileUrl(project, clip.source_path)` and `.preload = 'auto'`, wrap with `MediaElementAudioSourceNode`, pipe through a per-clip `GainNode`, connect to the track `GainNode`.
- Store in `TrackNode` / `ClipNode` maps keyed by id.

### 3. Scheduling loop

On `play()`:

- `ensureCtx()`, resume if suspended.
- Set `playingSince = performance.now() / 1000 - seekedTo` (or reference the Timeline's `currentTime` via an injected getter).
- Start a rAF loop that, each frame, computes `playhead = currentTime`, iterates all clips, and:
  - If `playhead ∈ [start, end)` and `!clip.active` → set `audio.currentTime = (playhead - start) + source_offset`, `audio.play()`, `scheduleCurves(clip)`, `clip.active = true`.
  - If `playhead ∉ [start, end)` and `clip.active` → `audio.pause()`, cancel pending automation, `clip.active = false`.

Curve scheduling is a stub in this task (filled in Task 117); here just make sure a clip plays at its correct source offset.

### 4. `pause()` and `seek()`

- `pause()`: pause every active element, cancel scheduled automation, stop the rAF loop.
- `seek(sec)`: immediately re-evaluate active set against `sec`. No restart required if already paused.

### 5. `dispose()`

Pause every element, disconnect every node, release the `AudioContext`, clear maps.

### 6. Tests (jsdom + WebAudio mock)

Install `standardized-audio-context-mock` (or hand-roll a minimal mock). Tests:

- Two non-overlapping clips: at playhead 0.5 and 2.5, only the enclosing clip has `active=true`.
- Seek from inside clip A to inside clip B: A gets paused, B gets played.
- Dispose: after `dispose()`, all elements are paused and further calls no-op.

### 7. Range-request check (manual)

With the scenecraft API running locally, load a project, open DevTools Network, verify that when the mixer activates a clip mid-file, the request includes a `Range:` header and the response is `206 Partial Content`. If not, a regression in the file server's streaming path; fix or document.

---

## Verification

- [ ] Pressing play on a simple project produces audible output (no curves applied yet, just unity gain).
- [ ] Seek moves playback position cleanly.
- [ ] Jsdom integration tests pass.
- [ ] Range-request spot-check passes on WAV + M4A + MP3.

---

**Next Task**: [Task 117 — Curve automation + crossfade](task-117-curve-automation-and-crossfade.md)
