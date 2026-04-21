# Task 115: Mixer Module Skeleton + Curve Math + Unit Tests

**Milestone**: [M14 — In-Editor Audio Playback](../../milestones/milestone-14-in-editor-audio-playback.md)
**Design Reference**: [local.audio-streaming-and-mixing.md](../../design/local.audio-streaming-and-mixing.md)
**Estimated Time**: 2-3 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Create the `audio-mixer.ts` module skeleton with the public `AudioMixer` API, a TS port of the volume-curve evaluation math that matches `scenecraft.audio.curves`, and unit tests that pin behaviour before any WebAudio wiring lands. No browser integration in this task — pure logic, easy to test.

---

## Context

Before wiring WebAudio, we want the shape of the mixer locked down and the dB-curve math proven equivalent to the engine's `np.interp` / `db_to_linear`. A mismatch here would cause a silent drift between in-editor playback and the exported mixdown.

---

## Steps

### 1. `src/lib/audio-curves.ts`

```typescript
export type CurvePoint = [number, number]  // [x, dB]

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

export function sampleCurveDb(
  curve: CurvePoint[] | null | undefined,
  xQuery: number,
): number {
  // linear interp, clamp to endpoints outside range, default 0 dB
}
```

Add a helper `sampleClipGainAtPlayhead(clip, playhead)` that maps absolute playhead → normalized x → dB via the clip curve, and a `sampleTrackGainAtPlayhead(track, playhead)`.

### 2. `src/lib/audio-mixer.ts` skeleton

```typescript
import type { AudioTrack, AudioClip } from './audio-client'

export type AudioMixer = {
  trackCount: number
  play(): void
  pause(): void
  seek(seconds: number): void
  updateClip(clipId: string): void
  updateTrack(trackId: string): void
  rebuild(tracks: AudioTrack[]): void
  dispose(): void
}

export function createAudioMixer(projectName: string, tracks: AudioTrack[]): AudioMixer {
  // Stub: returns an object that logs calls but does not create audio nodes yet.
  // Task 116 adds the WebAudio graph.
}
```

Internal types (private module-scope): `TrackNode`, `ClipNode`. Their shape is specified in the design doc.

### 3. Unit tests

`src/lib/__tests__/audio-curves.test.ts`:

- `dbToLinear(-60)` ≈ 0.001; `dbToLinear(-6)` ≈ 0.501; `dbToLinear(0)` === 1; `dbToLinear(+6)` ≈ 1.995.
- `sampleCurveDb([[0, 0], [1, -6]], 0.5)` ≈ -3.
- Clamp outside range: `sampleCurveDb([[2, -12], [4, 0]], 0)` === -12.
- Empty curve: `sampleCurveDb([], 0.5)` === 0.

`src/lib/__tests__/audio-mixer.test.ts`:

- `createAudioMixer('p', [])` returns an object with all API methods present.
- `trackCount` reflects input length.
- All methods callable without throwing (even on empty state).

### 4. Curve-parity script

Optional but valuable: a small Node script (`scripts/audio-curve-parity.mjs`) that reads a fixture curve, samples it at 100 points via the TS implementation, shells out to `python3 -c "from scenecraft.audio.curves import evaluate_curve_db; ..."`, and asserts max-diff < 1e-5. Useful as a one-time smoke check, not part of CI.

---

## Verification

- [ ] `src/lib/audio-curves.ts` exports `dbToLinear`, `sampleCurveDb`, and helpers
- [ ] `src/lib/audio-mixer.ts` exports `createAudioMixer` with the full public API
- [ ] Unit tests pass
- [ ] Curve parity: hand-picked fixture matches Python reference at 100 points within 1e-5

---

**Next Task**: [Task 116 — WebAudio graph + streaming](task-116-webaudio-graph-and-streaming.md)
