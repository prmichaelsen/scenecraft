# Animated Transform Curves (X, Y, Z)

**Concept**: Replace static transform sliders with animated remap curves for layer position (X/Y) and scale (Z) on transitions  
**Created**: 2026-04-09  
**Status**: Design Specification  

---

## Overview

Transitions currently have static `transformX`/`transformY` values set via sliders, with no scale control. This design replaces those sliders with animated remap curves — the same curve system used for opacity, color, and other per-transition properties. A new Z axis (uniform scale) is added. All three curves are displayed on a single canvas with pill tabs for axis selection.

---

## Problem Statement

- Static transform values cannot animate over time — a layer is shifted by a fixed offset for the entire transition duration
- No scale/zoom control exists — users cannot animate zoom in/out effects per layer
- The slider UI is disconnected from the curve-based workflow used for every other animated property

---

## Solution

### Data Model

Add three new curve columns to the `transitions` table:
- `transform_x_curve TEXT` — JSON array of `[progress, value, easing?]` points, range ±1.0
- `transform_y_curve TEXT` — same format, range ±1.0
- `transform_z_curve TEXT` — same format, range 0–10, default 1.0

### Migration

Hard cutover: existing static `transform_x`/`transform_y` values are migrated to flat curves. Example: `transform_x = 0.3` becomes `transform_x_curve = [[0, 0.3], [1, 0.3]]`. Static columns are left in place but no longer read by the frontend or render pipeline.

### Frontend: TransformCurveEditor

A new composite curve editor component replaces the X/Y slider section in TransitionPanel:

- **Single canvas** displays all 3 curves overlaid with distinct colors:
  - X = cyan, Y = magenta, Z = yellow
- **Pill tab bar** (`X | Y | Z`) above the canvas selects the active editing axis
- **Non-active curves** render as faded lines (view-only, no hit targets)
- **Auto-switch**: clicking or starting a drag on a point belonging to a non-active curve automatically switches the active axis to match, then begins the drag
- **Y-axis label** changes per active tab: "X Offset" / "Y Offset" / "Scale"
- **Ranges**:
  - X: -1.0 to +1.0 (canvas center = 0)
  - Y: -1.0 to +1.0 (canvas center = 0)
  - Z: 0 to 10.0 (canvas bottom = 0, reference line at 1.0)
- **Default curves**: X/Y flat at 0, Z flat at 1.0
- **Interaction**: same as `AnimCurveEditor` — click to add, drag to move, double-click to remove, right-click to cycle easing

### Render Pipeline

`_apply_transform()` in `narrative.py` is extended:
- If `transform_x_curve` exists: `tx = _evaluate_curve(transform_x_curve, progress)`
- If `transform_y_curve` exists: `ty = _evaluate_curve(transform_y_curve, progress)`
- If `transform_z_curve` exists: `scale = _evaluate_curve(transform_z_curve, progress)`, then apply `cv2.resize` centered on frame center + center-crop/pad

---

## Implementation

### Files Modified

**Backend (`davinci-beat-lab`)**:

| File | Changes |
|---|---|
| `src/beatlab/db.py` | Add 3 columns via migration, update `_row_to_transition`, `add_transition`, `update_transition` serialization, migration of static values to curves |
| `src/beatlab/api_server.py` | Response serialization (`transformXCurve`, etc.), `update-transition-style` handler, `copy-transition-style` field list, paste style fields |
| `src/beatlab/render/narrative.py` | Extend `_apply_transform()` to evaluate curves + Z scale |

**Frontend (`beatlab-synthesizer`)**:

| File | Changes |
|---|---|
| `src/routes/project/$name/editor.tsx` | `Transition` type: add `transformXCurve`, `transformYCurve`, `transformZCurve` fields; loader mapping |
| `src/components/editor/TransitionPanel.tsx` | Remove static X/Y sliders, add `TransformCurveEditor` component |

### TransformCurveEditor Component

Key differences from `AnimCurveEditor`:
1. **Signed Y-axis** for X/Y: canvas midpoint = 0, supports negative values (-1.0 to +1.0)
2. **Multi-curve rendering**: draws 3 curves, only one is interactive
3. **Auto-switch on grab**: mousedown hit-tests all curves, switches active axis if needed
4. **Per-axis config**: different `maxY`, `minY`, `defaultY`, `color`, and `yLabel` per axis
5. **Saves 3 separate keys**: `transformXCurve`, `transformYCurve`, `transformZCurve` via `postUpdateTransitionStyle`

### DB Migration (in `db.py` `get_db()`)

```python
# Add transform curve columns
if "transform_x_curve" not in cols:
    conn.execute("ALTER TABLE transitions ADD COLUMN transform_x_curve TEXT")
if "transform_y_curve" not in cols:
    conn.execute("ALTER TABLE transitions ADD COLUMN transform_y_curve TEXT")
if "transform_z_curve" not in cols:
    conn.execute("ALTER TABLE transitions ADD COLUMN transform_z_curve TEXT")

# Migrate static values to curves
rows = conn.execute("SELECT id, transform_x, transform_y FROM transitions WHERE transform_x IS NOT NULL OR transform_y IS NOT NULL").fetchall()
for row in rows:
    tx = row["transform_x"] or 0
    ty = row["transform_y"] or 0
    if tx != 0:
        conn.execute("UPDATE transitions SET transform_x_curve = ? WHERE id = ?", (json.dumps([[0, tx], [1, tx]]), row["id"]))
    if ty != 0:
        conn.execute("UPDATE transitions SET transform_y_curve = ? WHERE id = ?", (json.dumps([[0, ty], [1, ty]]), row["id"]))
```

### Z Scale in Render Pipeline

```python
def _apply_transform(img, clip_data, progress=0):
    # Evaluate curves (fall back to static for backward compat)
    tx_curve = clip_data.get("transform_x_curve")
    ty_curve = clip_data.get("transform_y_curve")
    tz_curve = clip_data.get("transform_z_curve")
    
    tx = _evaluate_curve(tx_curve, progress) if tx_curve else (clip_data.get("transform_x") or 0)
    ty = _evaluate_curve(ty_curve, progress) if ty_curve else (clip_data.get("transform_y") or 0)
    scale = _evaluate_curve(tz_curve, progress) if tz_curve else 1.0
    
    h, w = img.shape[:2]
    
    # Apply scale (centered on frame center)
    if abs(scale - 1.0) > 0.001:
        new_w, new_h = int(w * scale), int(h * scale)
        scaled = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        # Center-crop or center-pad
        if scale > 1.0:
            x0 = (new_w - w) // 2
            y0 = (new_h - h) // 2
            img = scaled[y0:y0+h, x0:x0+w]
        else:
            result = np.zeros_like(img)
            x0 = (w - new_w) // 2
            y0 = (h - new_h) // 2
            result[y0:y0+new_h, x0:x0+new_w] = scaled
            img = result
    
    # Apply X/Y shift
    if tx or ty:
        dx = int(tx * w)
        dy = int(ty * h)
        M = np.float32([[1, 0, dx], [0, 1, dy]])
        img = cv2.warpAffine(img, M, (w, h), borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    
    return img
```

---

## Trade-offs

- **Migration complexity**: One-time DB migration converts static values to curves — straightforward but irreversible
- **Canvas complexity**: Multi-curve canvas with auto-switch is more complex than single-curve `AnimCurveEditor` — justified by the UX requirement of seeing all axes together
- **Signed Y-axis**: X/Y curves need negative value support, which `AnimCurveEditor` doesn't have — requires a custom component rather than reusing existing

---

## Key Design Decisions

### Z Axis

| Decision | Choice | Rationale |
|---|---|---|
| Z behavior | Uniform scale (zoom) | Intuitive mental model — Z = depth = closer/farther |
| Z center point | Frame center (always) | Simpler than mask-center, consistent behavior |
| Z range | 0–10 | 0 = invisible, 1 = normal, 10 = extreme zoom |
| Z default | 1.0 | No zoom by default |

### UI

| Decision | Choice | Rationale |
|---|---|---|
| Static sliders | Removed entirely | Curves replace sliders — hard cutover |
| Multi-curve display | All 3 on one canvas | See relationships between axes at a glance |
| Active axis switching | Auto-switch on pin grab | Direct manipulation feels natural, pill tabs as fallback |
| X/Y range | ±1.0 | Full frame pan in either direction |
| Y-axis label | Changes per tab | Clarity — "X Offset" vs "Scale" have different semantics |

### Data

| Decision | Choice | Rationale |
|---|---|---|
| Migration strategy | Hard cutover | Clean — no dual code paths for static vs curve |
| Static columns | Left in DB, no longer read | Safe — no data loss, avoids destructive ALTER TABLE |
| Curve storage | JSON TEXT columns | Matches all other curve columns in the transitions table |

---

## Future Considerations

- Per-keyframe transform curves (not just per-transition)
- Rotation axis (R) as a fourth curve
- Bezier easing support for smoother motion paths
- Visual preview of transform animation in the curve editor (mini viewport)

---

**Status**: Design Specification  
**Recommendation**: Implement — start with backend DB migration + API changes, then frontend component  
**Related Documents**: [clarification-1-animated-transform-curves.md](../clarifications/clarification-1-animated-transform-curves.md)  
