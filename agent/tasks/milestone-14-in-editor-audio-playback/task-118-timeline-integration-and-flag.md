# Task 118: Timeline Integration (Direct Swap)

**Milestone**: [M14](../../milestones/milestone-14-in-editor-audio-playback.md)
**Design Reference**: [local.audio-streaming-and-mixing.md](../../design/local.audio-streaming-and-mixing.md)
**Estimated Time**: 2-3 hours
**Dependencies**: Tasks 115, 116, 117
**Status**: Not Started

---

## Objective

Wire `createAudioMixer` into the Timeline directly — replace the legacy `<AudioTrack>` element that plays `data.audioFile`. No feature flag; scenecraft is greenfield with no users to protect from regressions.

After this task, pressing play in the editor produces audible multi-track output via the WebAudio streaming mixer, curve edits are live, mute toggles are instant, and same-track overlaps equal-power crossfade.

---

## Steps

### 1. `useAudioMixer` hook

```typescript
// src/hooks/useAudioMixer.ts
export function useAudioMixer(
  projectName: string,
  tracks: AudioTrack[],
  isPlaying: boolean,
  currentTime: number,
): AudioMixer | null {
  const mixerRef = useRef<AudioMixer | null>(null)
  if (mixerRef.current === null && typeof window !== 'undefined') {
    mixerRef.current = createAudioMixer(projectName, tracks)
  }
  // rebuild when tracks identity changes (SSR + refreshTimeline updates)
  useEffect(() => { mixerRef.current?.rebuild(tracks) }, [tracks])
  // play/pause
  useEffect(() => { isPlaying ? mixerRef.current?.play() : mixerRef.current?.pause() }, [isPlaying])
  // seek on every playhead change
  useEffect(() => { mixerRef.current?.seek(currentTime) }, [currentTime])
  // cleanup
  useEffect(() => () => mixerRef.current?.dispose(), [])
  return mixerRef.current
}
```

### 2. Timeline swap

In `Timeline.tsx`:

- Remove the `<AudioTrack>` render for `data.audioFile` in the audio section (keep beats markers + audio lanes).
- Call `useAudioMixer(data.projectName, localAudioTracks, isPlaying, currentTime)`.
- `AudioTrack` component itself can stay in the tree for now; just unreferenced. (Could be deleted in a later cleanup — it's ~150 LOC — but tangential to M14.)
- Playhead-driven audio controls (space bar, left/right arrow step, scrub) already update `currentTime`, which is now what drives the mixer's `seek()`. No additional wiring.

### 3. Live edit feedback

In `AudioPropertiesPanel` (M9 Task 90), the `onChanged` callback currently triggers `router.invalidate()` to re-fetch everything. Replace with a targeted mixer update:

- After `postUpdateAudioClip` success → call `mixer.updateClip(clipId)`.
- After `postUpdateAudioTrack` success → call `mixer.updateTrack(trackId)`.
- Also call `refreshTimeline()` so the curve editor's locked-state re-syncs with the server (cheap partial fetch, not full invalidate).

The mixer needs to be accessible from the panel. Options:
- (a) Pass the mixer down through `EditorPanelLayout` → `AudioPropertiesPanel` props
- (b) Expose through a new `useAudioMixerContext` at the Timeline level

Pick (a) — single prop threaded through the three hops is cheaper than adding context.

### 4. Error resilience

- If `createAudioMixer` throws (e.g. `AudioContext` unavailable in some edge case), catch and log; editor keeps working without audio preview.
- Swallow `NotAllowedError` from first play — the browser blocks autoplay until a user gesture; the click that triggered play() already satisfies the gesture.

### 5. Verify end-to-end in browser

- Start dev server.
- Open a project with audio clips.
- Press play — hear the clips.
- Drag a curve point in the properties panel — amplitude change audible within one frame.
- Toggle mute on a clip or track — silences instantly.
- Create two overlapping clips on the same track — hear the equal-power crossfade (no click, no level bump).
- Seek backwards during playback — audio resumes from new position cleanly.

### 6. Tests

Component/integration tests for `useAudioMixer`:
- Hook creates a mixer on mount.
- Play/pause props drive `mixer.play()` / `mixer.pause()`.
- `currentTime` changes drive `mixer.seek()`.
- Unmount calls `mixer.dispose()`.

(Writing these in vitest with a mock `createAudioMixer` — no real WebAudio involved.)

---

## Verification

- [ ] Pressing play produces audible multi-track output from audio clips
- [ ] Curve edits in the properties panel change the amplitude live
- [ ] Mute toggles silence instantly
- [ ] Overlapping clips crossfade smoothly
- [ ] Seek backwards/forwards works cleanly
- [ ] Legacy `<AudioTrack>` is no longer referenced in Timeline
- [ ] Unit tests for `useAudioMixer` pass

---

## Follow-ups (not in M14)

- Delete unused `AudioTrack.tsx` component + `data.audioFile` plumbing if genuinely unused after the swap.
- Peak meters on per-track gain nodes (design doc future consideration).
- LUFS loudness display.

---

**Milestone Complete** once this task ships. Success criteria in [milestone-14](../../milestones/milestone-14-in-editor-audio-playback.md) all green.
