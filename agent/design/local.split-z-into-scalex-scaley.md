# Split Transform Z Curve into Independent Scale X / Scale Y

**Concept**: Replace the single `transform_z_curve` (uniform scale) on transitions with two independent `transform_scale_x_curve` and `transform_scale_y_curve`, enabling non-uniform scaling (squash, stretch, anamorphic zoom) and dropping the uniform-only constraint.
**Created**: 2026-04-26
**Status**: Proposal

---

## Overview

`local.animated-transform-curves.md` (M1 task-2, implemented 2026-04-10) added a third "Z" curve alongside X and Y to animate uniform scale on transitions — a single value that drives both horizontal and vertical scaling through a `cv2.resize` call in `narrative.py`. That covered zoom-in / zoom-out effects with one curve.

This design splits Z into two independent curves, `scale_x` and `scale_y`, so users can drive horizontal and vertical scale independently. The single-curve model couldn't express non-uniform scales — squash, stretch, anamorphic zooms, horizon-preserving vertical stretch, etc. All of those are real creative needs for motion-design transitions and none fit a single scalar.

---

## Problem Statement

- `transform_z_curve` drives uniform scale only — horizontal and vertical are locked together, so any squash/stretch animation is impossible.
- Anamorphic / non-square aspect effects (e.g., stretch to widescreen for a split second on a beat drop) aren't expressible.
- Independent-axis zoom (vertical zoom during a pan reveal, horizontal-only "letterbox squeeze") requires two curves.
- The existing tab label "Z" is borrowed from 3D coordinate nomenclature for what's really a 2D scale — confusing for users whose mental model is "scale X, scale Y" (the terminology every compositing app uses: AE, Resolve, Nuke).

---

## Solution

### Data Model

Replace the single column with two:

```sql
-- drop: transform_z_curve
-- add:
transform_scale_x_curve TEXT  -- JSON array of [progress, value, easing?], range 0–10, default 1.0
transform_scale_y_curve TEXT  -- same format, same range, same default
```

Same JSON curve representation as the existing `transform_x_curve` / `transform_y_curve`. Same range and default (0 to 10, reference line at 1.0) that Z had.

**No backwards-compat column kept.** Per the "no feature flags / no backwards-compat shims" project posture, the old `transform_z_curve` is dropped entirely post-migration; nothing reads it after this change ships.

### Migration (existing projects)

One-shot migration in `db.py` (runs on engine startup against any project DB):

```python
# For every transition row:
#   if transform_z_curve is not null and the two new cols are null:
#     transform_scale_x_curve = transform_z_curve       (copy the same curve)
#     transform_scale_y_curve = transform_z_curve       (copy the same curve)
#   then:
#     DROP COLUMN transform_z_curve
```

Copying the z curve into both scale_x and scale_y preserves every existing zoom animation exactly — old uniform-scale projects render identically after migration. The new ability to animate x and y independently is additive; users don't lose anything.

### Frontend: TransformCurveEditor

Replace the three-tab pill bar `X | Y | Z` with four flat tabs `X | Y | Scale X | Scale Y`.

- **Axis colors** (unchanged X/Y; new for the two scales):
  - X (translate) = cyan
  - Y (translate) = magenta
  - Scale X = yellow
  - Scale Y = orange
- **Non-active curves** render as faded overlay lines, same as today (4 curves overlaid, 1 active for editing).
- **Y-axis label changes per active tab**: "X Offset" / "Y Offset" / "Scale X" / "Scale Y".
- **Ranges**:
  - X: -1.0 to +1.0 (center = 0)
  - Y: -1.0 to +1.0 (center = 0)
  - Scale X: 0 to 10.0 (bottom = 0, reference line at 1.0)
  - Scale Y: 0 to 10.0 (same)
- **Default curves**: X/Y flat at 0, Scale X + Scale Y flat at 1.0.
- **Interaction**: same as today — click to add, drag to move, double-click to remove, right-click to cycle easing, click a faded non-active-tab point auto-switches + begins drag.

The only structural change is one more tab and one more curve on the overlay; the canvas, the hit-testing, the serialization — all existing machinery.

### Render Pipeline

`_apply_transform()` in `narrative.py` extends to read two scales instead of one:

```python
# Before (uniform):
# scale = _evaluate_curve(transform_z_curve, progress)
# scaled = cv2.resize(frame, (int(w*scale), int(h*scale)))

# After (non-uniform):
scale_x = _evaluate_curve(transform_scale_x_curve, progress)  # default 1.0
scale_y = _evaluate_curve(transform_scale_y_curve, progress)  # default 1.0
scaled = cv2.resize(frame, (int(w * scale_x), int(h * scale_y)))
# then: center-crop or pad to original (w, h) as the existing Z path already does
```

`cv2.resize` already accepts independent fx/fy scaling — no new rendering primitive needed. The center-crop / pad logic after resize stays identical; it was written against output dimensions, not the input scale relationship.

---

## Implementation

### Engine (`scenecraft-engine`)

| File | Changes |
|---|---|
| `src/scenecraft/db.py` | Migration that adds `transform_scale_x_curve` + `transform_scale_y_curve`, copies `transform_z_curve` content into both, drops `transform_z_curve`. `_row_to_transition`, `add_transition`, `update_transition` serialization updated. |
| `src/scenecraft/api_server.py` | Response serialization: emit `transformScaleXCurve` + `transformScaleYCurve` in place of `transformZCurve`. `update-transition-style` handler and `copy-transition-style` field list + paste style fields updated. |
| `src/scenecraft/render/narrative.py` | `_apply_transform` reads the two new curves and passes independent `fx`/`fy` to `cv2.resize`. |

### Frontend (`scenecraft`)

| File | Changes |
|---|---|
| `src/routes/project/$name/editor.tsx` | `Transition` type: drop `transformZCurve`, add `transformScaleXCurve` + `transformScaleYCurve`; update loader mapping. |
| `src/components/editor/TransformCurveEditor.tsx` | Pill bar gains one tab (now X / Y / Scale X / Scale Y). Canvas overlays 4 curves. Axis color constants + labels extended. Defaults: Scale X and Scale Y both flat at 1.0. |
| `src/components/editor/TransitionPanel.tsx` | Pass the extra curve props; read/write from/to the new fields. |

### Search + replace scope

Any identifier referencing the old name needs updating. Estimated touch list from today's grep:

- `transformZCurve` (frontend): type members, prop names, serialize/deserialize sites.
- `transform_z_curve` (engine): DB schema, migration, serialization, render.
- UI strings `"Z"` in the pill bar and `"Scale"` y-axis label.

No uses were found elsewhere in the tree, but the implementer should `grep -rE "transform_?z|transformZ" src` to confirm before landing.

---

## Benefits

- **Non-uniform scale unlocks real motion-design work.** Squash/stretch beat hits, anamorphic zooms, horizon-preserving vertical stretches, split-letterbox transitions. None of these were expressible before.
- **Zero-visible-change migration.** Every existing project's zoom animations continue rendering identically — the z-into-both-scales copy preserves uniform behavior by default.
- **Better nomenclature.** "Scale X / Scale Y" matches AE / Resolve / Nuke terminology; less confusing than a mystery "Z" in a 2D context.
- **Single render primitive still works.** `cv2.resize` handles `fx`/`fy` independently; no new rendering code needed.
- **Cost to add: one tab, one curve.** The editor already handles N-curve overlays — adding a fourth is trivial.

---

## Trade-offs

- **Transitions table gains a column net-one.** -1 drop of `transform_z_curve`, +2 of `transform_scale_x_curve` / `transform_scale_y_curve`. Minor schema delta.
- **Four tabs is more pill-bar surface than three.** If the transition panel gets narrow, tabs might wrap. Acceptable at typical dock widths; narrow-mode polish can come later if needed.
- **No backwards-compat shim.** Anything serializing or deserializing against the old `transform_z_curve` / `transformZCurve` name breaks until updated. Addressed by the all-or-nothing migration landing in one PR that touches all call sites.
- **UI ambiguity risk.** Having "X" + "Y" (translate) and "Scale X" + "Scale Y" side-by-side, a user might briefly wonder which "X" is which. Clear labels + distinct colors (cyan vs yellow; magenta vs orange) mitigate. If it's an issue in practice, grouping the tabs (`[X Y]` `[Scale X Scale Y]` visually) is a cheap follow-up.

---

## Dependencies

- Existing curve infrastructure: `CurveEditor`, `TransformCurveEditor`, `_evaluate_curve`, serialization helpers. All reused unchanged except for the N=3→N=4 curve count.
- Existing migration system in `db.py`. Adds one more ALTER/UPDATE/DROP block.

---

## Testing Strategy

- **Migration correctness**: populate a test DB with a transition that has `transform_z_curve = [[0, 0.5], [1, 2.0]]`, run the migration, assert `transform_scale_x_curve` and `transform_scale_y_curve` both equal the original and `transform_z_curve` column is gone.
- **Render equivalence for uniform inputs**: a transition with `scale_x = scale_y = flat-at-1.0` produces byte-identical output to the same transition under the old z path at flat-at-1.0 (regression guard).
- **Non-uniform render**: a transition with `scale_x = 2.0`, `scale_y = 1.0` produces a horizontally-stretched frame that crops to original dimensions; visually verifiable.
- **Frontend tab switching**: clicking each of the 4 pills activates the correct curve; faded-non-active-point click auto-switches tab.
- **Default values**: a newly-created transition has `scale_x` and `scale_y` both flat at 1.0 (not null).

---

## Migration Path

1. **Engine**: add migration to `db.py`. Idempotent — skips projects already migrated.
2. **Engine**: update all serialization / render call sites in one change (`api_server.py`, `narrative.py`, any other reader of `transform_z_curve`).
3. **Frontend**: update `Transition` type, rename field in `TransitionPanel`, add 4th tab to `TransformCurveEditor`.
4. **Land engine + frontend together** (single PR or paired PRs merged close in time) so no version of the stack reads the old column or ships the old field name.
5. **Smoke-test** against a project that has existing transitions with z curves — verify the render output is identical before and after the change (using the "uniform inputs" test case above).

Self-hosters follow the same path on their engine upgrade. The migration runs on first engine startup post-upgrade.

---

## Key Design Decisions

### Data

| Decision | Choice | Rationale |
|---|---|---|
| Column naming | `transform_scale_x_curve` + `transform_scale_y_curve` | Matches existing `transform_x_curve` / `transform_y_curve` prefix; "scale" makes semantics obvious |
| Drop old `transform_z_curve` column | Yes | "No backwards-compat shims" project posture; greenfield with no external users; one-shot migration preserves existing data |
| Migration strategy | Copy z curve into BOTH scale_x and scale_y | Zero-visible-change for existing projects; uniform zoom preserved |

### UI

| Decision | Choice | Rationale |
|---|---|---|
| Tab layout | Flat four tabs `X \| Y \| Scale X \| Scale Y` | Simplest extension of today's pill bar; stays one-level |
| Axis colors | X cyan, Y magenta, Scale X yellow, Scale Y orange | Keeps existing X/Y colors; yellow/orange as a warm pair conceptually separates "translate" from "scale" |
| Default curves | X/Y flat at 0; Scale X/Scale Y flat at 1.0 | Matches the original Z default; no-op on mount |

### Render

| Decision | Choice | Rationale |
|---|---|---|
| Independent fx/fy in cv2.resize | Yes | cv2 already supports it; no new primitive |
| Center-crop / pad back to source dims | Unchanged | Existing logic is output-dimension-based, not input-scale-based |

---

## Future Considerations

- **Skew / rotation curves.** A future extension that completes the 2D affine set: `transform_rotate_curve` (degrees over progress), `transform_skew_x_curve`, `transform_skew_y_curve`. Same editor pattern scales.
- **Per-axis pivot control.** Scale currently pivots on frame center. Pivot-x / pivot-y curves would allow corner-anchored zoom effects.
- **Aspect-locked editing mode.** A UI toggle to drag Scale X and Scale Y together when uniform scaling is desired — reverse of the core split. Low priority; most users will want one or the other, not both.
- **Grouped tab nesting.** If four flat tabs become crowded, collapse to `[Translate ▸ X Y]` `[Scale ▸ X Y]` with nested tabs. Defer until the pill bar starts wrapping on narrow dock widths.
- **3D scale / rotation.** Actual 3D transforms (Z-axis rotation, perspective) are a separate feature with a separate render path. Not this design.

---

**Status**: Proposal — ready to implement. Schema delta is net +1 column and additive; migration preserves existing data; UI extension is one more tab + one more curve.
**Recommendation**: Implement in one PR-pair spanning `scenecraft-engine` and `scenecraft`. Estimated 4–6 hours including migration testing.
**Related Documents**:
- `agent/design/local.animated-transform-curves.md` — the design this one supersedes (the Z curve it introduces is the one being split here)
