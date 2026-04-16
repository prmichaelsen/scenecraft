# Task 49: Left-Edge Drag + Modifier Modes

**Milestone**: [M7 — Clip Trim and Snap](../../milestones/milestone-7-clip-trim-and-snap.md)  
**Design**: [local.clip-trim-and-snap.md](../../design/local.clip-trim-and-snap.md)  
**Estimated Hours**: 8-10  
**Status**: Not Started  
**Dependencies**: Task 48 (Trim drag right edge)  

---

## Objective

Complete the drag model: left-edge handles (mirror of right), three hover zones (`<]` / `<|>` / `[>`), and modifier modes (shift = ripple, cmd = time remap). Rolling edit on `<|>` zone by default.

---

## Steps

1. **Three hover zones** at each kf boundary:
   - `<]` zone (LEFT of boundary, 4px): cursor = left-trim handle — single-side trim of LEFT clip
   - `<|>` zone (CENTER, 4px): cursor = double-arrow — rolling edit
   - `[>` zone (RIGHT of boundary, 4px): cursor = right-trim handle — single-side trim of RIGHT clip
   - Implement `getHoverZone(mouseX, kfX): '<]' | '<|>' | '[>' | null`

2. **Left-edge drag** (`[>` zone, plain):
   - Mirror of Task 48's `<]` logic, but targets `trim_in_RIGHT`
   - Dragging rightward (shrinking from start): `trim_in_RIGHT` advances by `delta × time_remap_factor`; insert empty kf+tr before the clip to fill the gap
   - Dragging leftward (extending start earlier): `trim_in_RIGHT` decreases; collision with previous tr — split (advance `trim_out_prev`) or soft-delete

3. **Rolling edit on `<|>`** (plain drag, center zone):
   - Move the shared kf by `delta`
   - `trim_out_LEFT += delta × time_remap_factor_LEFT`
   - `trim_in_RIGHT += delta × time_remap_factor_RIGHT`
   - Total timeline unchanged
   - No kfs shift beyond the shared one
   - Clamped by both sides' source availability: drag halts when either side's trim hits 0 or source_video_duration

4. **Shift+drag (ripple edit)** — works on any zone:
   - Apply the single-side or rolling trim math for the dragged boundary
   - ALSO shift all downstream kfs by `delta` (preserves all non-dragged trs' time_remap_factors)
   - Total timeline duration changes

5. **Cmd+drag (time remap)** — works on any zone:
   - Only the dragged kf moves (no trim changes)
   - `trim_in`, `trim_out` unchanged for both adjacent trs
   - Both adjacent trs see `time_remap_factor` change (shared-boundary physics)
   - No other kfs move
   - Scope: only applies to boundary handles, not elsewhere on timeline

6. **Keyframe marker drag** (dragging the kf icon itself, not an edge):
   - Equivalent to `<|>` zone — rolling edit
   - Shift+kf = ripple
   - Cmd+kf = time remap

7. **Cursor feedback**:
   - On mouse enter boundary zone, set cursor per zone
   - When modifier key held: update cursor to modifier mode (ripple `⇔` / remap `↔⚡`)
   - Listen for keydown/keyup while hovering to update cursor live

8. **Invariants/clamps**:
   - Hard: `trim_in < trim_out` (positive duration)
   - Hard: `trim_in ≥ 0`, `trim_out ≤ source_video_duration`
   - No soft clamp on `time_remap_factor`
   - Rolling clamped by both sides' source

9. **Commit + reversibility** (same as Task 48):
   - All changes reversible within a gesture
   - Mouseup commits to backend

10. **Tests**:
    - All 9 combinations of (zone × modifier) produce correct mutations
    - Rolling preserves total timeline
    - Ripple changes total timeline and shifts downstream correctly
    - Remap keeps trim fixed and changes adjacent remap factors
    - Clamps fire correctly at source boundaries

---

## Verification

- [ ] Hover zones detected with correct cursor for each
- [ ] Modifier-held cursor updates while hovering
- [ ] Left-edge plain drag shrinks/extends with collision rules
- [ ] `<|>` drag performs rolling edit
- [ ] Shift+drag ripples all downstream kfs
- [ ] Cmd+drag moves only the boundary kf
- [ ] Keyframe marker drag = rolling (default)
- [ ] All clamps enforced; no invalid state can be committed

---

**Next Task**: [Task 50: Snap toggle infrastructure](task-50-snap-toggle.md)  
