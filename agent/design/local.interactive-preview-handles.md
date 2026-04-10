# Interactive Preview Handles

**Concept**: Direct manipulation of transform (position, scale) and mask properties via draggable handles on the video preview canvas, with auto-keyframing to curve editors  
**Created**: 2026-04-10  
**Status**: Design Specification  

---

## Overview

Users currently edit transform X/Y, scale, and mask properties via numeric sliders and curve editors in the TransitionPanel. This design adds a visual handle overlay on the video preview canvas — bounding box corners, a center crosshair/anchor, and mask handles — so users can directly drag to manipulate layer transforms. Dragging a handle auto-creates or updates curve pins at the current playhead position, enabling intuitive spatial animation.

---

## Problem Statement

- Editing transform X/Y and scale via sliders or raw curve points is tedious and non-visual
- Users cannot see the spatial effect of a change until they scrub the timeline
- No way to interactively position a layer by dragging it in the preview
- Anchor point (scale pivot) is hardcoded to center — no way to change it

---

## Solution

Add a **transform mode** toggle that overlays draggable handles on the preview canvas. Handles read from and write to the existing transform curve data model. Auto-keyframing inserts curve pins at the playhead position when handles are dragged.

### Handle Types (P0 — MVP)

| Handle | Visual | Action | Modifier |
|--------|--------|--------|----------|
| **Position** | White crosshair + ring at anchor point | Drag → update transformX/Y curves | Shift: constrain to H or V. Alt: reposition anchor point |
| **Scale** | White corner squares (bounding box corners) | Drag → update scale curve (uniform) | Shift: uniform scale (no-op for MVP since Z is already uniform) |
| **Bounding box** | White dashed outline | Visual only — shows layer edges after transform/scale | — |
| **Mask center** | Blue/cyan dot at mask center | Drag → update maskCenterX/Y | — |

### Handle Types (P2 — Deferred)

- Mask radius handle (drag edge of mask circle)
- Free scale (independent scaleX/scaleY)

### Activation

- **Transform mode toggle** — button in toolbar or keyboard shortcut (`T`)
- When off: no handles rendered, clicks pass through to normal preview behavior
- When on: handles visible even during playback (follow animated curve values in real-time)
- Handles appear on whichever transition is selected, regardless of track z-order

---

## Implementation

### Data Model Changes

Add static anchor point fields to the Transition model:

```
-- DB migration (db.py)
ALTER TABLE transitions ADD COLUMN anchor_x REAL;  -- default 0.5
ALTER TABLE transitions ADD COLUMN anchor_y REAL;  -- default 0.5
```

```typescript
// Frontend Transition type (editor.tsx)
anchorX: number | null   // default 0.5
anchorY: number | null   // default 0.5
```

Anchor is static per-transition (not curve-animatable).

### Shader Changes

Update COMPOSITE_SHADER in `BeatEffectPreview.tsx`:

```glsl
uniform vec2 u_anchor;  // anchor point (default 0.5, 0.5)
uniform float u_scale;  // uniform scale

// In main():
vec2 baseCoord = u_isAdjustment > 0.5 ? v_texCoord : vec2(v_texCoord.x, 1.0 - v_texCoord.y);
// Scale around anchor
vec2 scaled = (baseCoord - u_anchor) / u_scale + u_anchor;
// Position offset
vec2 layerCoord = scaled - vec2(u_transform.x, u_isAdjustment > 0.5 ? u_transform.y : -u_transform.y);
```

### Handle Overlay Component

New component: `TransformHandles.tsx`

```typescript
type TransformHandlesProps = {
  canvasRef: RefObject<HTMLCanvasElement>     // the WebGL preview canvas
  transition: Transition | null
  currentTime: number
  pxPerSec: number
  transformMode: boolean
  onCurveUpdate: (axis: 'X' | 'Y' | 'Z', time: number, value: number) => void
  onAnchorUpdate: (x: number, y: number) => void
  onMaskCenterUpdate: (x: number, y: number) => void
}
```

The overlay is a transparent `<div>` positioned over the preview canvas with `pointer-events: auto` only when transform mode is active.

#### Coordinate Mapping

Canvas pixel → normalized UV: `(mouseX / canvasWidth, mouseY / canvasHeight)` directly, since aspect ratios are matched (no letterboxing for MVP).

#### Handle Rendering

Handles are drawn via a 2D canvas overlay (not WebGL) for simplicity:
- **Position crosshair**: two 20px lines + 10px ring at `(anchorX * w, anchorY * h)`
- **Scale corners**: four 8×8 squares at transformed bounding box corners
- **Bounding box**: dashed rectangle computed from transform + scale
- **Mask center**: 8px blue circle at `(maskCenterX * w, maskCenterY * h)`
- Colors: white/light gray for transform, blue/cyan for mask

#### Drag Logic

```
mousedown on handle → identify handle type
  → if Alt held + position handle: switch to anchor-drag mode
  → begin undo group
  
mousemove → compute delta in normalized coords
  → if Shift held: constrain to H or V (lock the axis with smaller delta)
  → update local preview state (immediate visual feedback)
  → update curve pin at current playhead time:
    - if pin exists at this time: update its value
    - if no pin: insert new pin at [progress, value]
  → live-update curve editor panel

mouseup → end undo group
  → persist curve changes via postUpdateTransitionStyle
```

### Auto-Keyframing

When a handle is dragged:
1. Compute `linearProgress` within the transition (same as Timeline.tsx layer construction)
2. Find the relevant curve (e.g., `transformXCurve`)
3. Search for an existing pin within ±0.005 of `linearProgress`
4. If found: update that pin's Y value
5. If not found: insert `[linearProgress, value]` into the curve, sort by X
6. Write both X and Y curves simultaneously for position drags

### Curve Pin Navigation (Global)

Keyboard shortcuts `[` / `]` seek to the nearest curve pin on the selected transition's curves:
- Scans all curve types: opacity, red, green, blue, black, saturation, hueShift, invert, transformX, transformY, transformZ
- Finds the closest pin time before/after the current playhead
- Seeks playhead to that time
- Works in any context, not just transform mode

### Curve Editor Sync

- Active pin at current playhead time highlighted with **white fill + blue border** in the TransformCurveEditor
- Handle drags live-update the curve editor canvas (both components read from the same transition object)
- No conflict prevention — both handle drags and curve editor drags write to the same data

### Keyboard Controls

| Key | Action |
|-----|--------|
| `T` | Toggle transform mode |
| Arrow keys | Nudge selected handle by ~0.005 in normalized coords |
| `Delete` | Remove curve pin at current playhead time |
| `[` / `]` | Seek to prev/next curve pin |
| `Shift` + drag | Constrain to H/V (position) or uniform (scale) |
| `Alt` + drag position | Reposition anchor point |

---

## Files to Modify

### Frontend (New)
- `src/components/editor/TransformHandles.tsx` — handle overlay component

### Frontend (Modify)
- `src/components/editor/BeatEffectPreview.tsx` — add `u_anchor` uniform, update shader
- `src/components/editor/Timeline.tsx` — pass anchor to TrackLayer, transform mode state, keyboard shortcuts
- `src/components/editor/TransitionPanel.tsx` — active pin highlighting in curve editor
- `src/routes/project/$name/editor.tsx` — Transition type + data loading for anchorX/Y
- `src/lib/beatlab-client.ts` — postUpdateTransitionStyle type for anchorX/Y

### Backend (Modify)
- `src/beatlab/db.py` — migration for anchor_x/anchor_y columns, _row_to_transition
- `src/beatlab/api_server.py` — serialization, update-transition-style, copy-transition-style
- `src/beatlab/render/narrative.py` — apply anchor in backend renderer

---

## Benefits

- **Intuitive**: Direct manipulation instead of slider/number entry
- **Fast iteration**: See spatial changes immediately while dragging
- **Auto-keyframing**: No manual curve editing needed for basic animations
- **Non-destructive**: All changes write to existing curve system, fully undoable

---

## Trade-offs

- **Overlay complexity**: 2D canvas overlay on top of WebGL canvas adds rendering cost (mitigated: only drawn when transform mode active)
- **Coordinate coupling**: Handle positions must stay in sync with shader transform math — any shader changes require matching handle updates
- **Anchor point adds fields**: Two new DB columns per transition (mitigated: nullable, default center)

---

## Dependencies

- Existing transform curve system (transformXCurve, transformYCurve, transformZCurve)
- Existing undo system (undo_begin/undo_execute for grouping)
- BeatEffectPreview WebGL compositor
- TransformCurveEditor component

---

## Testing Strategy

- Drag position handle → verify transformX/Y curves updated at correct progress
- Drag scale corner → verify scale curve updated
- Alt+drag → verify anchorX/Y updated (not curves)
- Shift+drag → verify constrained to single axis
- Verify handles follow animated values during playback
- Verify undo reverses entire drag (single undo group)
- Verify curve editor highlights active pin at playhead
- `[` / `]` navigation seeks to correct pin times

---

## Key Design Decisions

### Handle Behavior

| Decision | Choice | Rationale |
|---|---|---|
| Handle activation | Transform mode toggle (not always visible) | Prevents accidental handle grabs during normal editing |
| Position handle = anchor | Crosshair + ring, Alt to reposition | Matches AE/Premiere mental model |
| Anchor persistence | Static per-transition (not curve-animatable) | Simplifies MVP; curve-animatable anchor is rare |
| Scale type | Uniform only (single Z curve) for MVP | Free scale (scaleX/scaleY) deferred to avoid data model expansion |
| Corner scale → X/Y shift | Scale only writes Z, never X/Y | Anchor-based shader math keeps anchor stationary naturally |
| Snapping | Designed for but not implemented | Toggle placeholder, logic added later |

### Auto-Keyframing

| Decision | Choice | Rationale |
|---|---|---|
| Pin creation on drag | Auto-create/update at playhead progress | Core UX — handle drags produce animation pins |
| Multi-curve writes | Position drag writes both X and Y curves | Position is inherently 2D |
| Undo granularity | One undo group per mousedown→mouseup | Matches existing keyframe drag behavior |
| Pin navigation | Global `[`/`]` across all curve types | User requested for any curve, not just transform |

### Scope

| Decision | Choice | Rationale |
|---|---|---|
| MVP handles | Position + Scale (P0), Mask center (P0), Mask radius (P2) | User priority ranking |
| Keyframe support | Transitions only — no keyframe handles | Transforms are transition-level properties |
| Aspect ratio | Exact match only (no letterbox math) | Simplifies coordinate mapping for MVP |

---

## Future Considerations

- **Free scale (scaleX/scaleY)**: Requires splitting Z into independent axes, new DB columns, shader uniforms
- **Curve-animatable anchor**: anchorXCurve/anchorYCurve for animated pivot points
- **Rotation handle**: Circular drag outside bounding box for rotation (requires rotation curve + shader)
- **Mask radius/feather handles**: Drag edge of mask circle to resize
- **Snap-to-grid / snap-to-edge**: Implement snapping logic in the coordinate pipeline
- **Letterbox-aware coordinates**: Support mismatched canvas/source aspect ratios

---

**Status**: Design Specification  
**Recommendation**: Implement as P0 feature — create milestone with tasks for data model, shader, overlay component, auto-keyframing, and curve editor sync  
**Related Documents**: [Clarification 4](../clarifications/clarification-4-interactive-preview-handles.md), [Dynamic Panel Layout](local.dynamic-panel-layout.md)  
