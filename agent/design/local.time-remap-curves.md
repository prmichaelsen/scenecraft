# Time Remap Curves

**Concept**: Arbitrary time remap curves for transition video playback — dilate/contract time within a clip to land visual effects precisely on beat hits
**Created**: 2026-03-29
**Status**: Design Specification

---

## Overview

When editing music videos, visual moments in a transition need to land precisely on beat hits. Currently, transitions play at a uniform speed (linear remap). The editor needs a way to dilate (slow down) or contract (speed up) specific moments within a clip — e.g., slow-mo leading into a beat drop, then snap to fast motion after.

---

## Problem Statement

- Transitions play at a constant speed determined by `remap.target_duration`
- Beat hits from audio intelligence land at specific timestamps, but the visual peak in a generated video may not align
- The only current control is uniform speed (linear remap) — no way to stretch specific moments
- Users must regenerate videos hoping the timing lines up, rather than adjusting the existing clip

---

## Solution

### Data Model

Extend the `remap` field on each transition with an optional `curve_points` array:

```yaml
remap:
  method: curve          # "linear" (default) or "curve"
  target_duration: 5.7
  curve_points:          # array of [timelineProgress, videoProgress] pairs
    - [0, 0]             # start (fixed)
    - [0.3, 0.15]        # slow: 30% of timeline = 15% of video
    - [0.5, 0.5]         # midpoint
    - [0.7, 0.85]        # fast: 70% of timeline = 85% of video
    - [1, 1]             # end (fixed)
```

Both values are 0-1 normalized. The curve is piecewise-linear between control points. When `method: linear` or no `curve_points`, behavior is unchanged.

**Interpretation**: given a timeline progress value (X axis), the curve returns the video progress (Y axis) — which frame of the video to show at that moment. A steep slope = fast playback; a shallow slope = slow-mo.

### Preview Playback

**File**: `src/components/editor/Timeline.tsx`

Currently (line 229):
```typescript
const progress = (currentTime - tStart) / (tEnd - tStart)
```

With curve:
```typescript
const linearProgress = (currentTime - tStart) / (tEnd - tStart)
const progress = evaluateCurve(activeTransition.remap, linearProgress)
```

`evaluateCurve` does piecewise-linear interpolation:
1. Binary search for the segment where `points[i][0] <= linearProgress < points[i+1][0]`
2. Lerp: `videoProgress = lerp(points[i][1], points[i+1][1], (linearProgress - points[i][0]) / (points[i+1][0] - points[i][0]))`
3. Return `videoProgress`

This is O(log N) per frame where N is the number of control points (typically 3-8).

### Curve Editor UI

**File**: `src/components/editor/TransitionPanel.tsx` — new `CurveEditor` component in Details tab, below remap info.

A `<canvas>` element (~full panel width x 150px) showing:
- X axis = timeline progress (0-1, left to right)
- Y axis = video progress (0-1, bottom to top)
- Faint diagonal line as linear reference
- Control points as draggable circles (8px radius)
- Curve as connected line segments between points
- Audio intelligence beat markers as vertical dashed lines on X axis (positioned by converting beat times to timeline progress for this transition's time range)

**Interactions**:
- **Click** empty area on the curve to add a control point
- **Drag** a control point to reshape (constrained: X must stay between neighbors, Y clamped 0-1)
- **Right-click** or **double-click** a point to remove it (start [0,0] and end [1,1] are fixed)
- **Reset** button clears to linear (removes all interior points)

**State**: stored as `curve_points` in the remap object. Saved on mouse-up via the existing `onRemapChange` handler (extended to include curve data).

### Final Assembly (Backend)

**File**: `narrative.py` `assemble_final`

Currently uses uniform `setpts`:
```
setpts={1/speed_factor}*PTS
```

With curve, generate a per-frame PTS expression. For N frames in the video:
1. For each output frame `i` (0 to N-1):
   - `timelineProgress = i / (N-1)`
   - `videoProgress = evaluateCurve(curve_points, timelineProgress)`
   - `sourcePTS = videoProgress * totalDuration`
2. Use ffmpeg's `select` filter to pick the nearest source frame, or generate a frame-accurate `setpts` expression

Simpler approach: decode all frames with OpenCV/ffmpeg, reorder them according to the curve, re-encode. This is what the frame cache already does conceptually — just apply the curve to the frame index mapping.

---

## Implementation

### Component 1: `evaluateCurve` utility

Shared between frontend (TypeScript) and backend (Python). Piecewise-linear interpolation of control points.

**TypeScript** (`src/lib/remap-curve.ts`):
```typescript
export function evaluateCurve(
  remap: { method: string; curve_points?: [number, number][] },
  linearProgress: number
): number {
  if (remap.method !== 'curve' || !remap.curve_points || remap.curve_points.length < 2) {
    return linearProgress
  }
  const pts = remap.curve_points
  if (linearProgress <= pts[0][0]) return pts[0][1]
  if (linearProgress >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]

  // Binary search for segment
  let lo = 0, hi = pts.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (pts[mid][0] <= linearProgress) lo = mid
    else hi = mid
  }
  const t = (linearProgress - pts[lo][0]) / (pts[hi][0] - pts[lo][0])
  return pts[lo][1] + t * (pts[hi][1] - pts[lo][1])
}
```

**Python** (same logic in `narrative.py`).

### Component 2: CurveEditor canvas component

New component in TransitionPanel Details tab. Renders on a `<canvas>`, handles mouse events for drag/add/remove points. Receives `remap` and `onRemapChange` props.

### Component 3: Transition type extension

Add `curve_points?: [number, number][]` to `Transition.remap` type.

### Component 4: Backend persistence

The `_handle_update_transition_remap` handler already saves remap fields. Extend to also persist `curve_points`. The ruamel round-trip handler preserves existing fields.

### Component 5: Assembly curve remap

In `assemble_final`, when `remap.method == 'curve'`, decode the source video frame-by-frame, compute the output-to-source frame mapping using `evaluateCurve`, and re-encode with reordered frames.

---

## Benefits

- **Precise beat sync**: slow-mo a visual peak to land exactly on a beat drop
- **Non-destructive**: the curve edits playback, not the source video
- **Visual feedback**: beat markers on the curve show where beats land relative to video frames
- **Simple model**: piecewise-linear is easy to understand, edit, and evaluate

---

## Trade-offs

- **Canvas rendering**: custom canvas UI is more complex than standard React components, but necessary for smooth drag interactions on a 2D surface
- **Piecewise-linear vs bezier**: piecewise-linear has "corners" at control points. Bezier would be smoother but harder to implement, especially the constrained dragging. Can upgrade later.
- **Assembly complexity**: frame-by-frame re-encoding is slower than a single `setpts` filter, but only applies when curves are used

---

## Dependencies

- Audio intelligence data (for beat markers on the curve editor)
- `remap` field on transitions (already exists)
- Canvas API (built into browsers, no dependencies)

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Curve type | Piecewise-linear | Simple to implement, evaluate, and understand. Bezier is a future upgrade. |
| Control points | [timelineProgress, videoProgress] pairs | Normalized 0-1 makes them resolution/duration independent |
| Fixed endpoints | [0,0] and [1,1] always present | Video must start at start and end at end |
| Storage | `curve_points` array in `remap` object | Extends existing remap without breaking backward compat |
| Beat markers | Overlaid on X axis of curve editor | Shows where beats land so user knows where to slow-mo |
| Assembly | Frame-by-frame decode/remap/encode | Most accurate; single `setpts` expression can't handle arbitrary curves cleanly |

---

## Migration Path

1. **Phase 1**: `evaluateCurve` utility + preview playback integration (Timeline.tsx)
2. **Phase 2**: CurveEditor canvas component in TransitionPanel
3. **Phase 3**: Backend persistence of curve_points
4. **Phase 4**: Assembly integration with frame-by-frame remap

---

## Future Considerations

- **Bezier curves**: upgrade from piecewise-linear to smooth bezier segments with control handles
- **Curve presets**: "ease-in", "ease-out", "beat sync" (auto-generate curve from audio intelligence)
- **Per-effect curves**: separate time remap per beat effect type (e.g., slow pulse but normal zoom)
- **Curve copy/paste**: copy a curve from one transition to another

---

**Status**: Design Specification
**Recommendation**: Implement Phase 1 + 2 first (preview + UI), then Phase 3 + 4 (persistence + assembly)
**Related Documents**: [local.frontend-gaps](local.frontend-gaps.md)
