# Task 125: Optimistic Extraction Ghost During Video Drop / Auto-Link

**Milestone**: [M15](../../milestones/milestone-15-audio-clip-editing.md)
**Estimated Time**: 1.5-2 hours
**Dependencies**: None (polish deferred from M9 Task 89)
**Status**: Not Started

---

## Objective

Instead of waiting ~1-2 s for the audio extraction + link to complete and be picked up by `refreshTimeline`, show an optimistic "generating audio…" ghost block on the paired audio track immediately when a user drops a video onto a transition (or duplicates one). The ghost resolves to the real clip when the refresh lands.

---

## Steps

### 1. Local ghost state

In `Timeline.tsx`, add `pendingAudioGhosts: Map<transitionId, { trackId, startTime, endTime }>`.

On `handleDropVideoOnTransition` (and the duplicate path), immediately compute the expected audio slot and insert a ghost entry before awaiting the backend call.

### 2. Ghost rendering

A new `AudioClipGhost` component — same dimensions as `AudioClipBlock` but with a striped background and "generating audio…" label. Rendered inside `AudioLane` keyed off the pending map.

### 3. Resolve on refresh

After the POST returns and `refreshTimeline()` runs, the resulting `audioTracks` either contains a new clip on the expected track (resolve ghost — remove from pending map) OR doesn't (the video had no audio stream; remove ghost silently).

### 4. Timeout safeguard

If the ghost is still pending after 10 s, drop it — something went wrong, avoid stuck phantoms. Log to console.

### 5. Paired-slot computation

Audio lanes are paired to video tracks by display order (see design doc). Compute the expected audio track from the transition's video track's `z_order`. For the ghost's `start_time`/`end_time`, use the transition's from-kf/to-kf timestamps.

### 6. Tests

- Drop video with audio → ghost appears immediately, resolves to real clip after refresh.
- Drop video without audio → ghost appears, disappears on refresh.
- Server error → ghost disappears after 10 s timeout.

---

## Verification

- [ ] Dropping a video shows a ghost audio block within one frame
- [ ] Ghost resolves to a waveform block after ~1-2 s
- [ ] No stuck ghosts when the source has no audio
- [ ] Timeout safeguard at 10 s

---

**Milestone Complete** once this task ships. M15 success criteria in [milestone-15](../../milestones/milestone-15-audio-clip-editing.md) all green.
