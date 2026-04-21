# Task 121: Clip Body-Drag Move (Same-Track)

**Milestone**: [M15](../../milestones/milestone-15-audio-clip-editing.md)
**Estimated Time**: 3-5 hours
**Dependencies**: None (inherits patterns from M10)
**Status**: Not Started

---

## Objective

Drag an audio clip by its body to a new position on the same track. Ghost follows the cursor with snap-to-second, commits new `start_time`/`end_time` on drop. Single-clip MVP; cross-track and multi-select are out of scope for this task.

---

## Steps

### 1. `useAudioClipDrag` hook

```typescript
function useAudioClipDrag({ clip, pxPerSec, onCommit }) {
  // mouse-down on clip body → track clientX; on move, compute delta; snap
  // emit ghost position as a CSS translate; on mouseup, call onCommit(newStart)
}
```

Snap thresholds:
- Snap to 1 s grid when unmodified.
- Shift: snap to 0.1 s.
- Alt: no snap.

### 2. Ghost rendering

While dragging, render a semi-transparent duplicate of the clip block at the ghost position. Existing clip stays at its committed position until drop.

### 3. Commit

On mouseup:

```typescript
const duration = clip.end_time - clip.start_time
await postUpdateAudioClip(project, clip.id, {
  startTime: newStart,
  endTime: newStart + duration,
})
refreshTimeline() // or mixer.updateClip(id) if M14 is in
```

### 4. Boundary clamp

- `newStart >= 0`.
- No upper clamp; clips can extend past project duration (matches server mixdown behaviour).

### 5. Overlap handling

Dropping on an existing clip is allowed — render pipeline and mixer both handle overlap via equal-power crossfade. No preview of the overlap crossfade region needed in this task (stretch: show a diagonal-stripe pattern over the overlap).

### 6. Tests

- Simulated drag of 2 s → clip's `start_time` increases by 2 s after commit.
- Snap: drag of 1.3 s snaps to 1 s by default; with shift held, commits 1.3 s.
- Prevent-propagation: drag doesn't trigger playhead seek (inherit M8's synthetic-click swallowing pattern).

---

## Verification

- [ ] Body-drag moves clip with live ghost preview
- [ ] Snap-to-second default with shift/alt modifiers
- [ ] Commit updates `start_time`/`end_time` atomically
- [ ] Undo restores original position

---

**Next Task**: [Task 122 — Clip trim edges](task-122-clip-trim-edges.md)
