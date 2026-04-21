# Task 97: Frontend Body-Drag Gesture + Ghost Preview (Same-Track, Single-Clip)

**Milestone**: [M10 — Clip Move Cross-Track](../../milestones/milestone-10-clip-move-cross-track.md)  
**Design**: [local.clip-move-cross-track.md](../../design/local.clip-move-cross-track.md)  
**Estimated Hours**: 5-7  
**Status**: Not Started  
**Dependencies**: Task 93 (backend endpoint)  

---

## Objective

Wire the body-drag gesture in `TransitionTrack.tsx`: mousedown on a transition bar's interior (not on the `<]`/`<|>`/`[>` zones) initiates a move after a 3-4 px movement threshold. Cursor transitions from `grab` to `grabbing`. Ghost preview renders at bottom-right of cursor. On mouseup, call `postMoveTransitions({ timeDeltaSeconds, trackDelta: 0, transitionIds: [dragged_id] })`. Escape cancels.

Scope: single-clip same-track moves only. Cross-track and multi-clip come in Task 98.

---

## Steps

1. **Hover cursor**:
   - Add `cursor: grab` to the transition bar interior div (excluding boundary zones which already have their own cursors)
   - On hover, no visual change beyond cursor — the bar's existing hover style stays

2. **Mousedown on body**:
   - Add `onMouseDown` to the transition bar interior (NOT on the boundary zone divs, which stopPropagation)
   - Capture starting state: `{ trId, startX: e.clientX, startY: e.clientY, startTrackId: tr.trackId, mode: (e.metaKey || e.ctrlKey) ? 'copy' : 'move' }`
   - Don't call `e.preventDefault` or set `didDrag.current` yet; plain click should still work

3. **Movement threshold + gesture lock**:
   - On mousemove: compute `dx = e.clientX - startX`, `dy = e.clientY - startY`
   - If `Math.hypot(dx, dy) < 4`, gesture still pending (no visual change, click can still fire on mouseup)
   - Once threshold crossed: set `dragState` to "active", apply `cursor: grabbing` to document body, begin ghost preview render
   - Set `didDrag.current = true` to prevent the click handler from firing on release

4. **Ghost preview**:
   - Render a fixed-positioned div via portal (or an absolute-positioned div at the Timeline root) at `(cursor.x + 4px, cursor.y + 4px)` (bottom-right of cursor hotspot)
   - Ghost opacity: 0.5
   - Ghost width: same as dragged clip (`(tr.toTimeSeconds - tr.fromTimeSeconds) * pxPerSec`)
   - Ghost height: current transition bar height
   - Ghost style: mirror the transition bar's orange-500/30 bg + border + label, just semi-transparent

5. **timeDelta computation on mousemove**:
   - `timeDelta = (e.clientX - startX) / pxPerSec`
   - Clamp: `new_from_time = tr.fromTimeSeconds + timeDelta >= 0` (if violated, clamp `timeDelta` to `-tr.fromTimeSeconds`)
   - Ghost position along X axis reflects clamped `timeDelta`

6. **Escape-to-cancel**:
   - `document.addEventListener('keydown', handler)` during drag
   - On Escape: clear `dragState`, remove ghost, remove `grabbing` cursor, no backend call

7. **Mouseup commit**:
   - If `didDrag.current` is false (movement < threshold): normal click handler fires as before
   - If `didDrag.current` is true:
     - Compute final `timeDelta` from last mouse position
     - If `timeDelta == 0` (no net movement): skip backend call, clear state
     - Else: `await postMoveTransitions(project, { mode: dragState.mode, trackDelta: 0, timeDeltaSeconds: timeDelta, transitionIds: [dragState.trId], autoCreateTracks: true })`
     - On success: clear state, trigger `onTrimChange()` (or equivalent timeline refresh)
     - On error: toast + clear state

8. **Global mouse listeners cleanup**:
   - Add `document.addEventListener('mousemove'|'mouseup'|'keydown', ...)` on mousedown
   - Remove all three on mouseup or Escape

9. **State diagnostics**:
   - Use `React.useRef` for drag state (not state) to avoid re-renders on every mousemove
   - Only trigger a setState when ghost position changes enough to visually matter (throttle to ~60 fps)

10. **Tests** (manual, since Playwright isn't set up for drag):
    - Click a clip without moving → normal selection fires, no drag
    - Click + move 2 px → still a click (no drag)
    - Click + move 10 px → drag initiated, ghost rendered
    - Drag right 3 seconds → on release, tr's from/to timestamps shift by +3s
    - Drag left past timeline origin → drag clamps at 0, no backend call if `timeDelta == 0`
    - Escape during drag → drag cancelled, no backend call, cursor restored
    - Copy mode (Cmd+drag) deferred to Task 99 — for now `mode` just passes through

---

## Verification

- [ ] Hover cursor `grab` on transition bar interior
- [ ] Mousedown on interior + 4+ px movement initiates drag
- [ ] Click without significant movement still triggers selection (no regression)
- [ ] Active-drag cursor is `grabbing` (applied to document body)
- [ ] Ghost preview renders at bottom-right of cursor with 0.5 opacity
- [ ] Ghost position tracks mouse X accurately
- [ ] `new_from_time >= 0` clamp enforced
- [ ] Escape cancels the drag without side effects
- [ ] Mouseup with `timeDelta != 0` triggers `postMoveTransitions` and refreshes timeline
- [ ] Mouseup with `timeDelta == 0` skips backend call (no-op drag)
- [ ] All global listeners cleaned up after gesture

---

**Next Task**: [Task 98: Cross-track + multi-clip + multi-track source](task-98-frontend-cross-track-multi-clip.md)  
