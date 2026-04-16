# Task 48: Trim Drag UI — Right Edge Only

**Milestone**: [M7 — Clip Trim and Snap](../../milestones/milestone-7-clip-trim-and-snap.md)  
**Design**: [local.clip-trim-and-snap.md](../../design/local.clip-trim-and-snap.md)  
**Estimated Hours**: 8-10  
**Status**: Not Started  
**Dependencies**: Task 47 (Bin/duplicate/split)  

---

## Objective

Implement the right-edge trim drag handle on transition clips in `TransitionTrack.tsx`. No modifiers yet — plain drag only. Includes empty tr auto-insertion, collision rules for downstream empty/content trs, and per-gesture reversibility.

---

## Steps

1. **Add drag handle element** at the right edge of every transition clip in `TransitionTrack.tsx`:
   - 4px-wide zone positioned at `to_kf.timestamp * pxPerSec - 2px`
   - `cursor: col-resize`
   - `onMouseDown` initiates drag

2. **Hover zone detection** (prep for Task 49 — implement just the `<]` zone now):
   - Within 6px of the boundary, cursor shows `<]` trim icon
   - Other zones (`<|>`, `[>`) treated as plain boundary for now — same behavior

3. **Drag handler state** (during drag):
   - Track original `trim_out`, `to_kf.timestamp`, and all downstream kf positions
   - Track list of transitions inserted/deleted this gesture for per-gesture reversibility
   - Track which downstream tr (if any) is currently being collided with

4. **Drag math** (on each mousemove):
   - Delta in seconds: `(currentX - startX) / pxPerSec`
   - `new_trim_out = original_trim_out + delta * time_remap_factor`
   - Clamp: `new_trim_out ≤ source_video_duration`
   - Clamp: `new_trim_out > trim_in + 0.1` (minimum clip duration)
   - Compute new `to_kf.timestamp = from_kf.timestamp + (new_trim_out - trim_in) / time_remap_factor` (preserve speed)

5. **Collision with downstream empty tr**:
   - Partial overlap (new_to_kf < empty_tr.to_kf): shrink empty — `empty.from_kf.timestamp = new_to_kf`; compute empty's new timeline_duration
   - Full coverage (new_to_kf ≥ empty_tr.to_kf): delete the empty tr and its start kf; the dragged tr's `to_kf` becomes what was the empty's `to_kf`
   - Reversible: track which empties were deleted so drag-back can restore them

6. **Collision with downstream content tr**:
   - Partial (new_to_kf < content_tr.to_kf): advance content's `trim_in` by `(new_to_kf - content.from_kf.timestamp) * content.time_remap_factor`
   - Full (new_to_kf ≥ content_tr.to_kf): soft-delete the content tr (mark `deleted_at`, move to bin)
   - Reversible: track soft-deletes and restore on drag-back

7. **Space creation** (shrinking below current span):
   - If `new_to_kf < from_kf.timestamp + timeline_duration` (i.e., we're shrinking the visual clip):
     - Insert a new kf at `new_to_kf`
     - Insert a new empty tr from the new kf to the original `to_kf`
   - The new kf and empty tr persist after mouseup (per-gesture reversibility only during drag)

8. **Per-gesture reversibility** (`onMouseMove` logic):
   - On each move, check if drag direction reverses past a recorded insertion/deletion point
   - If drag passed back over an inserted empty: undo the insertion
   - If drag passed back over a soft-delete: restore the tr
   - This is gesture-local state; committed on mouseup

9. **Commit on mouseup**:
   - Persist `trim_out`, `to_kf.timestamp` updates to backend via `postUpdateTransitionTrim`
   - Persist any new kfs, trs, or soft-deletes
   - Invalidate timeline router query to refresh

10. **Render empty trs as black frame**:
    - In the render/preview pipeline (or `BeatEffectPreview` frame fetching), if `selected == '[]'`, emit black for the duration — no video decode

11. **Visual drag preview**:
    - During drag, show the new boundary position with a thin blue line or dashed indicator
    - Show tooltip: `trim_out: 5.2s / 8.0s (1.0x)` with current values

12. **Tests** (manual + automated):
    - Shrink a clip → empty tr appears to its right
    - Extend clip into empty → empty shrinks
    - Extend clip past empty → empty consumed
    - Extend into content tr → content's trim_in advances
    - Drag back before committing → insertions/deletions reverse
    - Commit persists to DB

---

## Verification

- [ ] Drag handle appears at right edge of every tr
- [ ] Cursor changes on hover (col-resize or `<]` trim icon)
- [ ] Dragging leftward creates empty tr between clip and next kf
- [ ] Dragging rightward consumes/shrinks adjacent empty tr correctly
- [ ] Dragging into content tr advances its trim_in
- [ ] Dragging over entire content tr soft-deletes it
- [ ] Drag-back within gesture undoes insertions/deletions
- [ ] Mouseup commits; refreshing page shows persisted state
- [ ] Empty trs render as black frame during playback

---

**Next Task**: [Task 49: Left-edge drag + modifier modes](task-49-left-edge-and-modifiers.md)  
