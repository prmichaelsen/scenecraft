# Task 117: Curve Automation + Equal-Power Crossfade

**Milestone**: [M14](../../milestones/milestone-14-in-editor-audio-playback.md)
**Design Reference**: [local.audio-streaming-and-mixing.md](../../design/local.audio-streaming-and-mixing.md)
**Estimated Time**: 2-4 hours
**Dependencies**: Task 116
**Status**: Not Started

---

## Objective

Fill in the `scheduleClipCurve` / `scheduleTrackCurve` stubs so dB curves actually drive the `GainNode` automation during playback, and implement same-track equal-power crossfade so overlapping clips blend cleanly without a level bump.

---

## Context

`GainNode.gain` is an `AudioParam` with automation methods: `setValueAtTime`, `linearRampToValueAtTime`, `cancelScheduledValues`, `setValueCurveAtTime`. We sample the curve at its breakpoints and emit a ramp sequence, so the audio thread interpolates in native code — no JS in the hot path.

---

## Steps

### 1. Clip curve automation

```typescript
function scheduleClipCurve(clip: ClipNode, playhead: number): void {
  const g = clip.gain.gain
  const now = audioCtx.currentTime
  g.cancelScheduledValues(now)

  if (clip.data.muted) {
    g.setValueAtTime(0, now)
    return
  }

  const { start_time, end_time, volume_curve } = clip.data
  const pts = (volume_curve ?? []).slice().sort((a, b) => a[0] - b[0])
  // Anchor at playhead
  g.setValueAtTime(sampleClipLinear(clip.data, playhead), now)
  // Emit future breakpoints
  for (const [xNorm, db] of pts) {
    const xSec = start_time + xNorm * (end_time - start_time)
    if (xSec <= playhead) continue
    if (xSec >= end_time) break
    g.linearRampToValueAtTime(dbToLinear(db), now + (xSec - playhead))
  }
}
```

Call `scheduleClipCurve` on activation and on every `updateClip(id)`.

### 2. Track curve automation

Analogous but with absolute-seconds x. Called on `updateTrack(id)` and when a track becomes active (i.e. first time a clip on it is activated after play or seek).

### 3. Equal-power crossfade on same-track overlap

When two clips on the same track have overlap `[a, b]`:

- Precompute `cosCurve` and `sinCurve` as `Float32Array(128)` samples of `cos(t * π/2)` and `sin(t * π/2)`.
- During clip activation, detect overlap against currently-active clips on the same track.
- For the incumbent (fading out): `incumbent.gain.gain.setValueCurveAtTime(cosCurve, now + (a - playhead), b - a)`.
- For the newcomer (fading in): `newcomer.gain.gain.setValueCurveAtTime(sinCurve, now + (a - playhead), b - a)`.
- These MULTIPLY on top of the volume curve; implement via a small chain: clip source → `curveGainNode` (volume curve) → `crossfadeGainNode` (overlap gains) → track gain. Or use a single node and fold the crossfade multiplication into the volume curve sampling — simpler but requires recomputing on overlap change.

Pick the two-node chain for clarity.

### 4. Update paths

- `updateClip(id)`: re-evaluate overlap, re-schedule volume + crossfade nodes.
- `updateTrack(id)`: re-schedule track curve only.
- `rebuild(tracks)`: tear down clip/track nodes, recreate. Keep `AudioContext`.

### 5. Tests

Using the mocked `GainNode` from Task 115/116's test harness:

- Curve `[[0, 0], [1, -6]]` on a 10 s clip: scheduled ramps arrive at `gain` with the right values at the right times.
- Mute → `setValueAtTime(0, now)` is the last call; no further ramps.
- Two clips overlap by 1.0 s: each gets a `setValueCurveAtTime` call with matching duration; the curve arrays sum-of-squares to ~1.

### 6. Manual perceptual check

- Drag a curve point during playback → amplitude change audible within a frame, no restart.
- Two clips with 1 s overlap → no click, no level bump; sounds like a continuous blend.

---

## Verification

- [ ] Curves drive gain in real time; drag feels live.
- [ ] Mute kills signal within a frame and un-mute restores it.
- [ ] Same-track overlap sounds smooth; no audible click or spike.
- [ ] Mocked-gain tests pass.

---

**Next Task**: [Task 118 — Timeline integration + feature flag](task-118-timeline-integration-and-flag.md)
