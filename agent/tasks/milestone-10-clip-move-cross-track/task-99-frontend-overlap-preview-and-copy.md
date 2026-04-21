# Task 99: Frontend Overlap Preview + Auto-Create-Track Rows + Copy-Mode Visuals

**Milestone**: [M10 — Clip Move Cross-Track](../../milestones/milestone-10-clip-move-cross-track.md)  
**Design**: [local.clip-move-cross-track.md](../../design/local.clip-move-cross-track.md)  
**Estimated Hours**: 6-8  
**Status**: Not Started  
**Dependencies**: Task 95 (backend overlap resolution), Task 96 (backend copy mode), Task 98 (cross-track + multi-clip frontend)  

---

## Objective

Final UX layer for body-drag: during drag, render a live preview of what the drop would do — red tint on would-be-consumed target trs, split lines where dragged boundaries would cut existing trs, dashed ghost rows above/below the track stack when `trackDelta` would require auto-creating tracks. Capture Cmd/Ctrl at mousedown for copy mode; show a `+` badge (or green tint) on the ghost to distinguish copy from move.

---

## Steps

1. **Copy-mode capture at mousedown**:
   - At mousedown, read `e.metaKey || e.ctrlKey` and store as `dragState.mode = 'copy' | 'move'`
   - Mode is FIXED for the duration of the gesture (user can't switch mid-drag by releasing/pressing the modifier — matches NLE behavior)

2. **Copy-mode ghost affordance**:
   - If `mode === 'copy'`: render a small `+` icon in the top-left corner of the primary ghost
   - Alternative: apply a green tint (`bg-green-500/30 border-green-500`) to all ghost rects instead of the orange move tint
   - Update tooltip: replace "move" context with "copy" — e.g., prefix the delta with "+" icon

3. **Remove trackDelta clamp from Task 98** and replace with auto-create behavior:
   - If the computed `target_track_index` for any clip is out of range (< 0 or >= existing_tracks.length):
     - Do NOT clamp
     - Instead, render a **dashed ghost row** above or below the existing track stack indicating "New track"
     - Compute how many rows needed on each side; render that many
     - Dashed style: `border-dashed border-blue-500/40 bg-blue-500/5`
     - Label: "New track" text in muted blue

4. **Overlap preview compute** (on mousemove, memoized by `{timeDelta, trackDelta, mode}`):
   - Function signature:
     ```typescript
     function computeOverlapPreview(
       dragState: { primaryTrId, draggedIds, timeDelta, trackDelta, mode },
       allTransitions: Transition[],
       allKeyframes: KeyframeWithTime[],
     ): {
       consumedIds: string[]                            // target trs fully inside drop span
       splitLines: Array<{ trId: string, x: number }>   // existing trs split at x (timeline position)
       trimmed: Array<{ trId: string, side: 'left' | 'right', newBoundaryX: number }>
     }
     ```
   - For each dragged clip at its computed target `(track, new_from, new_to)`, find overlaps on the target track (excluding dragged clips themselves)
   - Classify by the same four cases as Task 95 (A: fully-inside → consumed, B: straddle new_from → trimmed left side, C: straddle new_to → trimmed right side, D: drop inside → two split lines)

5. **Render overlap preview**:
   - Consumed trs: overlay a red tint on the existing transition bar (`bg-red-500/25 ring-1 ring-red-500/60`)
   - Trimmed trs (cases B/C): overlay a partial-width red tint on the portion that would disappear
   - Split lines (case D): render a thin vertical blue line at each `x` position on the target tr
   - Don't mutate any DB state — preview only

6. **Throttle**:
   - Wrap `computeOverlapPreview` in a `requestAnimationFrame` loop so it runs at most once per frame
   - Skip computation if `timeDelta`/`trackDelta` haven't changed since last frame

7. **Tooltip enrichment**:
   - If overlap preview has `consumedIds.length > 0`: append `(${consumedIds.length} consumed)` to tooltip
   - If `splitLines.length > 0`: append `(${splitLines.length} split)` to tooltip
   - If new tracks would be created: append `(+${count} new track${count>1?'s':''})`

8. **Commit with overlap semantics**:
   - Existing `postMoveTransitions` call unchanged — backend handles overlap resolution automatically
   - On success response, populate any toast: `Moved N clips (M consumed, K split)` if counts > 0

9. **Tests** (manual):
   - Drag clip over a smaller existing target → red tint on target while hovering, target soft-deleted on drop
   - Drag clip whose right edge lands mid-target → partial red tint on target's left portion, split line at new_from
   - Drag clip entirely inside a larger target → two split lines on the target, remainders formed on drop
   - Cmd+drag → green tint / + badge on ghost, source unchanged on drop
   - Drag past last track → dashed ghost rows appear for new tracks, backend auto-creates on drop
   - Release Cmd mid-drag → mode stays `"copy"` (mode is captured at mousedown)
   - Tooltip updates with counts when overlap changes

---

## Verification

- [ ] Cmd/Ctrl captured at mousedown; `mode` stays constant for the gesture
- [ ] Copy-mode ghost has `+` badge or green tint
- [ ] `trackDelta` clamp removed; overflow shows dashed ghost rows for new tracks
- [ ] Dashed ghost rows have "New track" label
- [ ] Consumed targets show red tint during drag; clear on mouseup/cancel
- [ ] Straddle cases (B/C) show partial red tint + split line
- [ ] Three-way split case (D) shows two split lines
- [ ] Overlap preview throttled (no dropped frames during rapid drag)
- [ ] Tooltip shows counts (consumed / split / new tracks)
- [ ] Backend handles overlap resolution and auto-create-tracks on the commit
- [ ] All tests pass

---

**Next Task**: None (M10 complete). **Follow-up**: wire body-drag into the global snap system once M7 Tasks 50/51 ship.  
