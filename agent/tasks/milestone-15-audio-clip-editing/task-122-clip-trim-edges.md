# Task 122: Clip Trim Edges

**Milestone**: [M15](../../milestones/milestone-15-audio-clip-editing.md)
**Estimated Time**: 2-4 hours
**Dependencies**: None (inherits patterns from M7 video clip trim)
**Status**: Not Started

---

## Objective

Drag left or right edge of an audio clip to trim. Left-edge drag adjusts `source_offset` and `start_time` together (trims from the start of the source); right-edge drag adjusts `end_time` only (trims from the end).

---

## Steps

### 1. Edge hit zones

Add 6-px-wide cursor zones on the left and right of each `AudioClipBlock`. `cursor: ew-resize` on hover.

### 2. `useAudioClipTrim` hook

```typescript
function useAudioClipTrim({ clip, edge: 'left' | 'right', pxPerSec, onCommit }) {
  // On drag, compute new edge position in seconds.
  // Left: clip.source_offset += delta; clip.start_time += delta
  // Right: clip.end_time += delta
  // Clamps below; on mouseup, call onCommit(updates)
}
```

### 3. Clamps

- Min clip length: 100 ms (prevents degenerate zero-duration clips).
- Left: `source_offset >= 0` (can't trim before the source's start).
- Right: no hard upper clamp in UI (backend allows extending past source; mixdown pads silence). But if we know the source duration from a prior probe, clamp to it and show a visual cue.

### 4. Commit

- Left: `postUpdateAudioClip(project, id, { sourceOffset, startTime })`.
- Right: `postUpdateAudioClip(project, id, { endTime })`.

### 5. Linked-clip consideration

If the clip is linked to a transition, trimming it directly is fine — the link stays, the clip just plays a different sub-window of its source. The transition's own trim is independent. Document this in the task notes.

If we ever want "trim transition trims the audio too", that's handled via the existing `_propagate_linked_audio_on_from_kf_shift` chokepoint in db.py (Task 85).

### 6. Tests

- Left-edge drag right by 0.5 s → `source_offset` += 0.5, `start_time` += 0.5, `end_time` unchanged.
- Right-edge drag left by 0.5 s → `end_time` -= 0.5.
- Min-length clamp: can't trim below 100 ms.
- Undo restores.

---

## Verification

- [ ] Left-edge trim works; `source_offset` and `start_time` move together
- [ ] Right-edge trim works; `end_time` changes alone
- [ ] Min clip length enforced
- [ ] Source start clamp enforced
- [ ] Undo restores pre-trim state

---

**Next Task**: [Task 123 — Unlinked audio drop](task-123-unlinked-audio-drop.md)
