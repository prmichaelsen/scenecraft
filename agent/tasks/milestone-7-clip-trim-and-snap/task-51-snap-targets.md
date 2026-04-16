# Task 51: Snap Targets + Feedback

**Milestone**: [M7 — Clip Trim and Snap](../../milestones/milestone-7-clip-trim-and-snap.md)  
**Design**: [local.clip-trim-and-snap.md](../../design/local.clip-trim-and-snap.md)  
**Estimated Hours**: 4-5  
**Status**: Not Started  
**Dependencies**: Task 50 (Snap toggle infrastructure)  

---

## Objective

Implement snap target computation, hit-testing, and visual feedback during drag. Gated by the snap toggle from Task 50. Snap applies to all drag modes (trim / rolling / ripple / remap / keyframe drag).

---

## Steps

1. **Snap target computation** — at drag-start:
   - Build a sorted array of candidate times:
     - All `kf.timestamp` values across all tracks
     - `0` (timeline origin)
     - Current `playhead` position
   - EXCLUDE the dragged node's own current position (can't snap to self)
   - EXCLUDE beats, sections, ruler marks (not in the target set)
   - Store in `snapTargetsRef.current: number[]` for duration of gesture

2. **Snap hit-testing** — on each `mousemove` during drag:
   - If `snap.enabled === false`: skip snap logic, use raw mouse position
   - Else:
     - Compute current drag position in seconds: `currentTimeSeconds`
     - Compute mouse x in pixels: `currentX`
     - Binary-search sorted targets for nearest time value to `currentTimeSeconds`
     - For each of the 2 nearest candidates, compute pixel distance: `|candidate * pxPerSec - currentX|`
     - If min distance ≤ 8px: `snappedTime = nearest_candidate`; record for visual feedback
     - Else: `snappedTime = currentTimeSeconds` (no snap)
   - Use `snappedTime` as the drag's effective position for all trim/kf math

3. **Visual feedback — blue line indicator**:
   - When a snap is active, render a vertical blue line at the snap target's x-coordinate
   - Component: thin 1px `<div>` positioned absolutely across the timeline tracks
   - Only visible during drag AND when currently snapping
   - Color: matches existing blue accent (e.g. `bg-blue-500`)
   - Height: spans the full timeline track area
   - Pointer-events: none (visual only)

4. **Sticky cursor feel**:
   - When snap applies, the drag commits to the snap target — delta accumulates visually but position stays put until cursor moves more than 8px beyond snap point
   - Implementation: in the drag state, track `cursorOffsetAtSnap` — the pixel offset between snap target and actual cursor
   - Unsnap occurs when `|currentX - snapTargetX| > 8` (threshold exceeded in the direction away from snap)
   - Smooth handoff: once unsnapped, position resumes tracking the cursor from that moment

5. **Integration with all drag handlers** (right-edge, left-edge, rolling, ripple, remap, kf-drag):
   - Each handler's `mousemove` checks `snap.enabled` and applies snap logic to the input delta before running the trim/kf math
   - Pass `snappedTime` in place of raw mouse time

6. **Performance**:
   - Precompute target array once at drag-start (not on every mousemove)
   - Use binary search (`findInsertionIndex` + check neighbors) for O(log n) per frame
   - Cache `pxPerSec` at drag-start (won't change mid-gesture unless user zooms during drag)

7. **Edge cases**:
   - If zoom changes mid-drag: recompute pxPerSec but keep target array
   - If playhead moves mid-drag (autoplay): the target array is stale; acceptable for P0 (rebuild on next gesture)
   - If dragged node's target-candidate ordering changes (e.g., ripple shifts kfs): skip — keep initial snapshot for duration of drag

8. **Tests**:
   - Drag near a kf → snaps at ~8px visual distance
   - Disable snap via `s` key → drag no longer snaps
   - Re-enable → snap resumes
   - Drag past snap target → cursor "unsticks" correctly, resumes tracking
   - Snap line appears at correct x-coordinate
   - Performance OK with 100+ targets (test with a large project)

---

## Verification

- [ ] Snap targets include keyframes, tr boundaries (same as kfs), 0:00, playhead — nothing else
- [ ] Snap threshold is 8 pixels at any zoom level
- [ ] Blue line indicator renders at snap target during active snap
- [ ] Sticky cursor feel confirmed — cursor moves but position holds until unsnapped
- [ ] `s` key toggles snap on/off during drag (or at least between gestures)
- [ ] Snap applies to all drag modes (trim / rolling / ripple / remap / kf-drag)
- [ ] No performance regression with 100+ kfs on timeline
- [ ] Snap gated by `useSnap().enabled` — disabled path bypasses all snap code

---

**Next Steps After M7**: Design a scene/character/setting system (Clarification 3) for richer prompt composition. Consider multi-track clip trimming for overlaid transitions.  
