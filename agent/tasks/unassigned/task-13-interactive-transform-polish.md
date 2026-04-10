# Task 13: Polish Interactive Transform Handles

**Milestone**: Unassigned  
**Design Reference**: [Interactive Preview Handles](../design/local.interactive-preview-handles.md)  
**Estimated Time**: 4-6 hours  
**Status**: Not Started  

---

## Objective

Polish the interactive transform handles feature to production quality. The core infrastructure is in place (TransformHandles component, auto-keyframing, anchor point, shader uniforms, hotkey registry) but several pieces need refinement.

---

## Context

Implemented so far:
- TransformHandles overlay component with position crosshair, scale corners, bounding box, mask center
- Transform mode toggle (T key + toolbar button with serif font, dotted border)
- Auto-keyframing: handle drags insert/update curve pins at playhead progress
- Anchor point system (u_anchor shader uniform, static per-transition, Alt+drag to reposition)
- Curve pin navigation ([ / ] keys)
- Hotkey registry at src/lib/hotkeys.ts

---

## Steps

### 1. Arrow Key Nudging
- When transform mode is active and a transition is selected, arrow keys should nudge the position by ~0.005 in normalized coords per press
- Add hotkeys to registry: `nudgeUp`, `nudgeDown`, `nudgeLeft`, `nudgeRight`
- Should also auto-keyframe (insert/update curve pin at current progress)

### 2. Delete Key Removes Curve Pin
- When transform mode is active, Delete key should remove the curve pin at the current playhead progress (±0.005 tolerance)
- Should scan transformXCurve, transformYCurve, transformZCurve and remove matching pins
- Don't remove endpoint pins (progress 0 or 1)

### 3. Curve Editor Active Pin Highlighting
- In TransformCurveEditor, the pin at the current playhead progress should be highlighted with white fill + blue border
- Distinct from existing hover/drag states
- Updates in real-time as playhead moves

### 4. Handle Cursor Feedback
- Position handle: `cursor-move` on hover
- Scale corners: appropriate resize cursors (`nwse-resize`, `nesw-resize`) based on corner
- Mask center: `cursor-move` on hover
- Background (no handle hit): `cursor-default` (not crosshair)

### 5. Copy/Paste Keyframe Includes Transition Properties
- When Ctrl+C copies keyframes and Ctrl+V pastes them, the paste-group backend already copies transition properties
- Verify this works end-to-end: copy a kf with transform curves on its transitions, paste, confirm curves are on the new transitions
- If not working, debug the paste-group flow

### 6. Handle Rendering During Playback
- Handles should follow animated curve values in real-time during playback (when transform mode is on)
- Currently the canvas redraws on [transformMode, tr, size, getTransformValues] — verify getTransformValues updates as currentTime/linearProgress changes during playback
- May need to add linearProgress to the draw effect dependencies

---

## Verification

- [ ] Arrow keys nudge position handles by small increments
- [ ] Arrow key nudges auto-keyframe at playhead progress
- [ ] Delete removes curve pin at playhead (not endpoints)
- [ ] Active pin highlighted in TransformCurveEditor (white fill, blue border)
- [ ] Appropriate cursors on handle hover (move, resize)
- [ ] Background cursor is default, not crosshair
- [ ] Handles animate during playback when transform mode is on
- [ ] Copy/paste keyframes carries transition curves to new transitions
