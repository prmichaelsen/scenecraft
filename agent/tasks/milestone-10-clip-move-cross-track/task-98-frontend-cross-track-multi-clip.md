# Task 98: Frontend Cross-Track + Multi-Clip + Multi-Track Source Selections

**Milestone**: [M10 — Clip Move Cross-Track](../../milestones/milestone-10-clip-move-cross-track.md)  
**Design**: [local.clip-move-cross-track.md](../../design/local.clip-move-cross-track.md)  
**Estimated Hours**: 5-7  
**Status**: Not Started  
**Dependencies**: Task 94 (backend cross-track), Task 97 (frontend body-drag baseline)  

---

## Objective

Extend the body-drag gesture from Task 97 to support (a) cross-track drops via Y-delta → `trackDelta` mapping, (b) multi-clip drags when the clicked clip is in the current multi-select, and (c) multi-track source selections applying a uniform `trackDelta` derived from the primary-dragged clip.

Also: target-track highlight during drag, tooltip with timestamps + Δ + N-clips.

---

## Steps

1. **Y-delta → trackDelta**:
   - During drag, compute `cursor_track_index` by hit-testing `cursor.clientY` against the on-screen track row boundaries
   - `trackDelta = cursor_track_index - primary_source_track_index`
   - For now (Task 98), clamp `trackDelta` so no clip overflows the existing track range — auto-create-track preview lands in Task 99
   - Update ghost vertical position: `ghost.top = ghost.top_base + trackDelta * TRACK_ROW_HEIGHT`

2. **Multi-clip drag**:
   - At mousedown: check if `primaryTrId in selectedTransitionIds` (multi-select set from Timeline.tsx)
   - If in set: `draggedIds = [...selectedTransitionIds]`
   - If not: `draggedIds = [primaryTrId]` and leave `selectedTransitionIds` untouched
   - Ghost preview becomes a composite — one semi-transparent rect per dragged clip, positioned relative to the primary clip's ghost:
     - `offsetX = (clip.fromTimeSeconds - primary.fromTimeSeconds) * pxPerSec`
     - `offsetY = (clip_track_index - primary_track_index) * TRACK_ROW_HEIGHT`

3. **Multi-track source selections**:
   - Already works if step 1 & 2 are correct: each clip's new track = `clip_track_index + trackDelta`
   - Example: clips on T2 + T3, drag started on T3, drop on T2 → `trackDelta = -1` → T2 clips land on T1, T3 clips land on T2
   - Verify by constructing a test selection with clips on two different tracks

4. **Target-track highlight**:
   - During drag, determine the set of track IDs that would receive a dropped clip (each clip's `source_track + trackDelta`)
   - Apply a subtle tint (e.g., `bg-blue-500/10`) to those track rows' headers (or the full row background)
   - Remove tint on mouseup/cancel

5. **Tooltip**:
   - Render a fixed-positioned tooltip near the primary ghost (top-left corner of ghost, offset `(8px, -20px)` so it sits above)
   - Contents:
     - `start = primary.fromTimeSeconds + timeDelta` → format as `M:SS.ss`
     - `end = primary.toTimeSeconds + timeDelta` → format as `M:SS.ss`
     - `track = track_name(primary_source + trackDelta)` (or `"Track N"` if not in existing range)
     - `delta = Δ${timeDelta >= 0 ? '+' : ''}${timeDelta.toFixed(2)}s`
     - If `draggedIds.length > 1`: append `${draggedIds.length} clips`

6. **Mouseup call**:
   - Compute `trackDelta` and `timeDelta` from final state
   - Call `postMoveTransitions(project, { mode, trackDelta, timeDeltaSeconds: timeDelta, transitionIds: draggedIds, autoCreateTracks: true })`
   - On success: clear state, refresh timeline

7. **Tests** (manual):
   - Single clip cross-track (drag up one row) → clip moves to track above, ghost tracks mouse
   - Single clip cross-track (drag down one row) → clip moves to track below
   - Multi-clip drag (3 clips selected) → all 3 ghosts visible, all shift by same delta on release
   - Multi-track source selection (clips on T2 + T3) drag from T3 to T2 → T2 clips land on T1, T3 on T2
   - Tooltip shows accurate start/end timestamps, target track name, and Δ value
   - "N clips" appears in tooltip when > 1 clip being dragged
   - Target track row highlighted during drag; cleared on mouseup
   - Clamp still works (this task): drop past last track → no clip overflows, ghost clamped to valid range

---

## Verification

- [ ] Y-delta correctly maps to `trackDelta` via track-row hit-testing
- [ ] Ghost preview shifts vertically by `trackDelta * TRACK_ROW_HEIGHT`
- [ ] Multi-clip drag initiates when primary is in multi-select set; ghost composite renders all clips
- [ ] Single-clip drag unchanged when primary is NOT in multi-select set
- [ ] Multi-track source selections apply uniform `trackDelta` (preserves relative offsets)
- [ ] Target-track row highlighted subtly during drag; cleared on mouseup/cancel
- [ ] Tooltip shows start/end/track/Δ, plus "N clips" for multi-clip
- [ ] Mouseup commits batch via `postMoveTransitions` with correct `transitionIds`
- [ ] `trackDelta` clamp (this task) prevents out-of-range drops (auto-create comes in Task 99)
- [ ] All listeners cleaned up after gesture

---

**Next Task**: [Task 99: Overlap preview + auto-create-track rows + copy-mode visuals](task-99-frontend-overlap-preview-and-copy.md)  
