# Task 2: Animated Transform Curves (X, Y, Z)

**Milestone**: M1 - Audio Intelligence Integration  
**Design Reference**: [Animated Transform Curves](../../design/local.animated-transform-curves.md)  
**Estimated Time**: 8-12 hours  
**Dependencies**: None  
**Status**: Not Started  

---

## Objective

Replace static transform X/Y sliders with animated remap curves and add a Z (scale) axis. All three curves display on a single canvas with pill tabs for axis selection, matching the curve-based workflow used for opacity, color, and other per-transition properties.

---

## Context

Transitions currently have static `transformX`/`transformY` values set via sliders, with no scale control. Every other animated property (opacity, RGB, saturation, hue shift, invert) already uses the `AnimCurveEditor` pattern. This task brings transforms into the same system, enabling keyframed motion and zoom effects per layer.

---

## Steps

### 1. Backend DB: Add curve columns and migration

**File**: `../davinci-beat-lab/src/beatlab/db.py`

- Add migration in `get_db()`: `ALTER TABLE transitions ADD COLUMN transform_x_curve TEXT` (+ y, z)
- Migrate existing static values to flat curves:
  - `transform_x = 0.3` becomes `transform_x_curve = [[0, 0.3], [1, 0.3]]`
  - `transform_y` same treatment
  - Leave static columns in place (dead columns, no data loss)
- Update `_row_to_transition()`: parse the 3 new columns as JSON (same pattern as `opacity_curve`)
- Update `update_transition()`: add the 3 new keys to the JSON serialization list (line ~521)
- Update `add_transition()`: add 3 new columns + values to the INSERT statement

### 2. Backend API: Serialization and style endpoints

**File**: `../davinci-beat-lab/src/beatlab/api_server.py`

- Response serialization (~line 1542): add `"transformXCurve"`, `"transformYCurve"`, `"transformZCurve"` fields
- `update-transition-style` handler (~line 1007): add 3 camelCase-to-snake_case mappings
- `copy-transition-style` key tuple (~line 974): add `"transform_x_curve"`, `"transform_y_curve"`, `"transform_z_curve"`
- `paste-group` transition dict (~line 2391): add the 3 curve fields

### 3. Backend Render: Evaluate curves in transform

**File**: `../davinci-beat-lab/src/beatlab/render/narrative.py`

- Extend `_apply_transform()` (~line 1949) to accept `progress` parameter
- If `transform_x_curve` exists: `tx = _evaluate_curve(transform_x_curve, progress)`
- If `transform_y_curve` exists: `ty = _evaluate_curve(transform_y_curve, progress)`
- If `transform_z_curve` exists: apply `cv2.resize` centered on frame center + center-crop/pad
- Fall back to static `transform_x`/`transform_y` if no curves (backward compat during transition)

### 4. Frontend Type and Loader

**File**: `src/routes/project/$name/editor.tsx`

- Add to `Transition` type (~line 86): `transformXCurve`, `transformYCurve`, `transformZCurve` as `[number, number, number?][] | null`
- Add to loader mapping (~line 260): map the 3 new fields from API response

### 5. Frontend: TransformCurveEditor component

**File**: `src/components/editor/TransitionPanel.tsx`

- Remove the static Transform X/Y slider section (lines ~234-261)
- Create `TransformCurveEditor` component with:
  - **Single canvas** showing all 3 curves: X=cyan, Y=magenta, Z=yellow
  - **Pill tab bar** (`X | Y | Z`) — selects active editing axis
  - **Non-active curves** rendered as faded lines (no hit targets)
  - **Auto-switch on grab**: mousedown hit-tests all 3 curves; if closest point belongs to non-active axis, switch before drag
  - **Signed Y-axis for X/Y**: canvas midpoint = 0, range -1.0 to +1.0
  - **Unsigned Y-axis for Z**: range 0 to 10.0, reference line at 1.0
  - **Y-axis label** changes per tab: "X Offset" / "Y Offset" / "Scale"
  - **Default curves**: X/Y flat at 0, Z flat at 1.0
  - **Same interactions as AnimCurveEditor**: click add, drag move, dbl-click remove, right-click cycle easing
  - **Saves** via `postUpdateTransitionStyle` with `transformXCurve`, `transformYCurve`, `transformZCurve` keys

### 6. Wire into TransitionPanel

- Replace the `{/* Transform */}` section with `<TransformCurveEditor>`
- Pass `transition`, `projectName`, `keyframes`, `currentTime`, `onDataChange`

---

## Verification

- [ ] DB migration runs without error on existing projects
- [ ] Existing static transform values migrated to flat curves
- [ ] API response includes `transformXCurve`, `transformYCurve`, `transformZCurve`
- [ ] `update-transition-style` accepts and persists the 3 curve fields
- [ ] `copy-transition-style` copies the 3 curve fields
- [ ] TransformCurveEditor renders with 3 overlaid curves
- [ ] Pill tabs switch active axis; Y-axis label updates
- [ ] Clicking a non-active curve's point auto-switches the active axis
- [ ] Curves save and persist across reload
- [ ] Render pipeline evaluates curves per-frame (verify with a simple X-pan animation)
- [ ] Z scale applies correctly (zoom in crops, zoom out pads black)
- [ ] Static sliders removed from UI

---

## Key Design Decisions

### Z Axis

| Decision | Choice | Rationale |
|---|---|---|
| Z behavior | Uniform scale (zoom) | Intuitive — Z = depth = closer/farther |
| Z center | Frame center (always) | Simpler than mask-center |
| Z range | 0-10 | 0 = invisible, 1 = normal, 10 = extreme zoom |

### UI

| Decision | Choice | Rationale |
|---|---|---|
| Static sliders | Removed entirely | Curves replace sliders — hard cutover |
| Multi-curve display | All 3 on one canvas | See relationships between axes |
| Active axis switching | Auto-switch on pin grab | Direct manipulation, pill tabs as fallback |
| X/Y range | +/-1.0 | Full frame pan |

### Data

| Decision | Choice | Rationale |
|---|---|---|
| Migration | Hard cutover | Clean — no dual code paths |
| Static columns | Left in DB, no longer read | No data loss |

---

## Notes

- The `TransformCurveEditor` cannot reuse `AnimCurveEditor` directly because it needs signed Y-axis (negative values) and multi-curve overlay. It will share the interaction patterns but is a new component.
- The render pipeline already has `_evaluate_curve()` and per-frame progress — extending `_apply_transform()` is straightforward.
- Implementation order matters: backend first (DB + API), then frontend type/loader, then component.

---

**Next Task**: TBD  
**Related Design Docs**: [local.animated-transform-curves](../../design/local.animated-transform-curves.md)  
**Estimated Completion Date**: TBD  
