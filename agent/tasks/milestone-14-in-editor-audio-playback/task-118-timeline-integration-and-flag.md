# Task 118: Timeline Integration + Feature Flag + Perceptual A/B

**Milestone**: [M14](../../milestones/milestone-14-in-editor-audio-playback.md)
**Design Reference**: [local.audio-streaming-and-mixing.md](../../design/local.audio-streaming-and-mixing.md)
**Estimated Time**: 3-5 hours
**Dependencies**: Tasks 115, 116, 117
**Status**: Not Started

---

## Objective

Wire the mixer into the Timeline behind a feature flag, subscribe it to the existing `isPlaying` / `currentTime` / `localAudioTracks` state, dogfood on the 3hr × 4-track project, and run a perceptual A/B against the server mixdown. Flip the flag default on once it holds.

---

## Steps

### 1. `useAudioMixer` hook

```typescript
// src/hooks/useAudioMixer.ts
export function useAudioMixer(projectName: string, tracks: AudioTrack[]) {
  const mixerRef = useRef<AudioMixer | null>(null)
  useEffect(() => {
    mixerRef.current = createAudioMixer(projectName, tracks)
    return () => mixerRef.current?.dispose()
  }, [projectName])
  useEffect(() => { mixerRef.current?.rebuild(tracks) }, [tracks])
  return mixerRef.current
}
```

### 2. Timeline wiring

In `Timeline.tsx`, read the feature flag once from `localStorage.scenecraft_use_audio_mixer`.

- If on: mount `useAudioMixer(data.projectName, localAudioTracks)`. Drive with effects:
  ```typescript
  useEffect(() => { isPlaying ? mixer?.play() : mixer?.pause() }, [isPlaying])
  useEffect(() => { mixer?.seek(currentTime) }, [currentTime])
  ```
  Skip rendering the legacy `<AudioTrack>` element.
- If off: render `<AudioTrack>` unchanged.

### 3. Curve/mute edit hooks

Extend the existing `AudioPropertiesPanel` save callbacks so after a successful `postUpdateAudioClip` / `postUpdateAudioTrack`, they call `mixer.updateClip(id)` / `mixer.updateTrack(id)` for immediate audible feedback without waiting for a route invalidate.

### 4. Error handling + fallback

- If `AudioContext` construction fails (rare — maybe private mode on Safari), log once and fall back to the legacy path.
- Browser autoplay policy: swallow `NotAllowedError` from `play()` — the first user click in the Timeline already unlocks the context.

### 5. Perceptual A/B

On the 3hr × 4-track dogfood project:

1. Export a 30 s window via the server render.
2. Play the same 30 s window in-editor.
3. Confirm by ear the mix is indistinguishable.
4. If not: diff the curve schedules, verify the track order is the same, check for off-by-one on time conversions.

### 6. Flip the flag

Once dogfood passes:

- Change default: `const useAudioMixer = localStorage.getItem(FLAG) !== '0'` (opt-out instead of opt-in).
- Document the flag in CHANGELOG with the opt-out string for users who hit issues.
- Keep the legacy `<AudioTrack>` path for one release; remove in a follow-up task.

### 7. Tests

- Component test: Timeline with flag-on renders no `<AudioTrack>`; with flag-off, does.
- Integration test: play → mixer.play called; pause → mixer.pause; seek → mixer.seek with correct value.

---

## Verification

- [ ] Feature flag on: Timeline plays multi-track audio with curves + mute + crossfade.
- [ ] Curve edits are audibly live without restart.
- [ ] Perceptual A/B indistinguishable on a 30 s reference passage.
- [ ] Feature flag off: legacy beats-track playback unchanged.
- [ ] Flag default flipped to on after dogfood passes.

---

## Follow-up (future task, not in M14)

- Remove the legacy `<AudioTrack>` component + `data.audioFile` preload path once the mixer has been the default for one release.

---

**Milestone Complete** once this task ships. Success criteria in [milestone-14](../../milestones/milestone-14-in-editor-audio-playback.md) all green.
