# Task 170: Split Transform Z Curve into Independent Scale X / Scale Y

**Milestone**: Unassigned (follow-up to M1 task-2 "Animated Transform Curves")
**Design Reference**: [Split Transform Z Curve into Independent Scale X / Scale Y](../../design/local.split-z-into-scalex-scaley.md)
**Estimated Time**: 4–6 hours (cross-repo: engine migration + serialization + render, frontend type + UI tab + curve editor extension)
**Dependencies**: Existing curve infrastructure (M1 task-2 "Animated Transform Curves" — implemented 2026-04-10); no runtime dependencies on other in-flight work.
**Status**: Not Started

---

## Objective

Replace the single `transform_z_curve` (uniform scale) on the `transitions` table with two independent curves, `transform_scale_x_curve` and `transform_scale_y_curve`. Non-uniform scaling becomes expressible (squash, stretch, anamorphic zoom, vertical-only zoom, etc.). Existing projects render identically after migration — the z curve is copied into both scale curves. UI gains a fourth pill tab on `TransformCurveEditor` (`X | Y | Scale X | Scale Y`). Render pipeline reads both curves and passes independent `fx` / `fy` to `cv2.resize`.

---

## Context

`transform_z_curve` was added in M1 task-2 as a uniform scale control alongside X and Y offset curves on transitions. It runs through a single `cv2.resize(frame, (int(w*scale), int(h*scale)))` call in `narrative.py`, followed by a center-crop / pad back to original output dimensions. The single-scalar design can't express non-uniform scaling — any "squash on the beat" or anamorphic-zoom effect is impossible today.

The curve infrastructure already handles N-curve overlays (X/Y today, both with independent colors and faded non-active rendering). Adding a fourth curve is an additive extension: one more tab label, one more color, one more serialization field pair. The render pipeline change is also additive — `cv2.resize` already accepts independent `fx` and `fy`; we just stop pinning them to the same value.

Project convention on backwards compatibility: "No feature flags, no backwards-compat shims, greenfield with no external users" (per `feedback_no_feature_flags.md` and related memory). The migration drops the old `transform_z_curve` column in one shot — there's no period where both names coexist.

---

## Steps

### 1. Engine: schema migration

In `scenecraft-engine/src/scenecraft/db.py`, add an idempotent migration that:

1. Adds two new nullable TEXT columns: `transform_scale_x_curve`, `transform_scale_y_curve`.
2. For every transition row, copies `transform_z_curve` into both new columns (if `transform_z_curve` is not null and the new columns are null — idempotent).
3. Drops the `transform_z_curve` column.

SQL sketch:

```sql
ALTER TABLE transitions ADD COLUMN transform_scale_x_curve TEXT;
ALTER TABLE transitions ADD COLUMN transform_scale_y_curve TEXT;

UPDATE transitions
SET transform_scale_x_curve = transform_z_curve,
    transform_scale_y_curve = transform_z_curve
WHERE transform_z_curve IS NOT NULL
  AND transform_scale_x_curve IS NULL
  AND transform_scale_y_curve IS NULL;

ALTER TABLE transitions DROP COLUMN transform_z_curve;
```

Migration framework details: follow the same pattern as M1 task-2's migration that originally added `transform_z_curve`. Make sure the migration bumps whatever version number gates re-runs so it doesn't try to drop a column that's already gone.

### 2. Engine: serialization

In `scenecraft-engine/src/scenecraft/db.py`:
- `_row_to_transition` (or the equivalent row→dict serializer): drop the `transform_z_curve` read, add `transform_scale_x_curve` + `transform_scale_y_curve` reads.
- `add_transition`: accept the two new fields in inputs, default them to `null` when the caller doesn't provide them (runtime default of 1.0 is applied at evaluation time, not at insert time).
- `update_transition`: same treatment.

In `scenecraft-engine/src/scenecraft/api_server.py`:
- Response serialization: emit `transformScaleXCurve` and `transformScaleYCurve` (camelCase to match today's `transformXCurve` / `transformYCurve`). Drop `transformZCurve` emission.
- `update-transition-style` handler: accept the new camelCase field names; drop `transformZCurve` handling.
- `copy-transition-style` field list: replace `transform_z_curve` with the two new column names.
- Paste-style fields: same replacement.

### 3. Engine: render pipeline

In `scenecraft-engine/src/scenecraft/render/narrative.py`, update `_apply_transform()`:

```python
# Before (conceptually):
# scale = _evaluate_curve(transform_z_curve, progress) or 1.0
# scaled = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR)

# After:
scale_x = _evaluate_curve(transform_scale_x_curve, progress) if transform_scale_x_curve else 1.0
scale_y = _evaluate_curve(transform_scale_y_curve, progress) if transform_scale_y_curve else 1.0
scaled = cv2.resize(frame, None, fx=scale_x, fy=scale_y, interpolation=cv2.INTER_LINEAR)
# center-crop / pad to original (w, h) — unchanged from today's logic
```

The center-crop / pad logic that follows is written against output dimensions, not input scales, so it's independent of how fx/fy were chosen.

### 4. Frontend: type + loader

In `scenecraft/src/routes/project/$name/editor.tsx`:
- `Transition` type: drop `transformZCurve?: CurvePoint[]`, add `transformScaleXCurve?: CurvePoint[]` and `transformScaleYCurve?: CurvePoint[]`.
- Loader mapping (wherever `transformZCurve` is unpacked from the API response): replace with the two new field names.

### 5. Frontend: TransformCurveEditor — fourth tab + fourth curve

In `scenecraft/src/components/editor/TransformCurveEditor.tsx`:

- Add one more tab to the pill bar. New layout: `X | Y | Scale X | Scale Y`.
- Add one more entry to the `AXES` / `axisColors` constants (whatever the file calls its per-axis config):
  - `{ key: 'scaleX', label: 'Scale X', color: '#eab308' /* yellow-500 */, yLabel: 'Scale X', yMin: 0, yMax: 10, defaultFlat: 1.0 }`
  - `{ key: 'scaleY', label: 'Scale Y', color: '#f97316' /* orange-500 */, yLabel: 'Scale Y', yMin: 0, yMax: 10, defaultFlat: 1.0 }`
- Canvas overlay loop: now paints 4 curves instead of 3 (one active, three faded). No structural change; the existing N-curve loop just picks up the extra entry.
- Click-on-faded-point-auto-switches-tab logic: no change needed if the logic already walks all curves to find the nearest point — just make sure the iteration covers all four.
- Rename the old "Z" tab label to "Scale Y" (or drop it and add both; doesn't matter structurally — the existing tab's curve prop gets routed to `transformScaleYCurve` and a new tab is added for `transformScaleXCurve`). Suggest cleaner: drop the Z tab entirely, add both scales fresh, so no semantic drift.

### 6. Frontend: TransitionPanel

In `scenecraft/src/components/editor/TransitionPanel.tsx`:
- Where `transformZCurve` is read from the transition: replace with reads of `transformScaleXCurve` + `transformScaleYCurve`.
- Where `transformZCurve` is written via the update API: replace with writes of both new fields.
- The `TransformCurveEditor` component receives the two new curve props in place of `zCurve`.

### 7. Verify no stale references

```
grep -rE "transform_?z|transformZ" scenecraft-engine/src scenecraft/src
```

After the changes above land, this grep should return zero hits. Any remaining occurrence is a missed call site.

### 8. Smoke test

1. Open an existing project that has transitions with `transform_z_curve` populated (any project with a non-default zoom on a transition works).
2. Run the engine with the migration. `journalctl -u scenecraft-engine` should show the migration applying cleanly.
3. Open the editor, navigate to the transitions panel, verify:
   - The pill bar shows `X | Y | Scale X | Scale Y`.
   - Clicking the `Scale X` tab shows the curve (inherited from the old z curve) editable at full range.
   - Clicking the `Scale Y` tab shows the same curve (also copied from z).
   - Dragging `Scale X` independently of `Scale Y` produces non-uniform scaling in the preview.
4. Export the project (or render a transition preview) — compare against a pre-migration render of the same project: they should be visually identical when `Scale X` and `Scale Y` are both left at the inherited-from-z values.

---

## Verification

- [ ] `transitions` table has `transform_scale_x_curve` and `transform_scale_y_curve` columns (verify via `PRAGMA table_info(transitions)`).
- [ ] `transitions` table no longer has `transform_z_curve` column.
- [ ] Migration is idempotent — re-running engine startup against an already-migrated project is a no-op with no errors.
- [ ] For every pre-existing transition that had a non-null `transform_z_curve`, both `transform_scale_x_curve` and `transform_scale_y_curve` contain the same curve data after migration.
- [ ] `GET /transitions` (or whatever route returns transitions) emits `transformScaleXCurve` and `transformScaleYCurve`; does NOT emit `transformZCurve`.
- [ ] `update-transition-style` accepts the two new camelCase fields; rejects or ignores `transformZCurve`.
- [ ] `copy-transition-style` / paste-style lists include the two new field names.
- [ ] `narrative.py` `_apply_transform` calls `cv2.resize(frame, None, fx=scale_x, fy=scale_y, ...)` with independent values.
- [ ] Defaults: if both curves are null, render applies `fx=1.0, fy=1.0` (no-op scale).
- [ ] Frontend `Transition` type has `transformScaleXCurve` and `transformScaleYCurve`; does NOT have `transformZCurve`.
- [ ] `TransformCurveEditor` pill bar shows 4 tabs: `X | Y | Scale X | Scale Y`.
- [ ] Axis colors match the design: X cyan, Y magenta, Scale X yellow, Scale Y orange.
- [ ] Default Scale X and Scale Y curves are flat at 1.0 (matches old Z default).
- [ ] Canvas overlays 4 curves (one active, three faded) without clipping or z-order bugs.
- [ ] `grep -rE "transform_?z|transformZ" scenecraft-engine/src scenecraft/src` returns zero hits.
- [ ] Render equivalence: a pre-migration project renders byte-identically after migration if Scale X and Scale Y are left at the z-inherited values.
- [ ] Non-uniform render: setting Scale X = 2.0 and Scale Y = 1.0 produces a horizontally-stretched frame (verifiable by eye in the preview).

---

## Expected Output

**Files Modified (scenecraft-engine):**
- `src/scenecraft/db.py` — migration (ALTER ADD × 2, UPDATE copy, ALTER DROP); `_row_to_transition`, `add_transition`, `update_transition` serialization.
- `src/scenecraft/api_server.py` — response serialization, update-style handler, copy-style field list, paste-style fields.
- `src/scenecraft/render/narrative.py` — `_apply_transform` reads two curves.

**Files Modified (scenecraft):**
- `src/routes/project/$name/editor.tsx` — `Transition` type + loader mapping.
- `src/components/editor/TransformCurveEditor.tsx` — 4th tab, 4th curve, color + range constants.
- `src/components/editor/TransitionPanel.tsx` — wire the two new curves through.

**Files Created:** None.

---

## Key Design Decisions

### Data

| Decision | Choice | Rationale |
|---|---|---|
| Column naming | `transform_scale_x_curve` + `transform_scale_y_curve` | Matches existing `transform_x_curve` / `transform_y_curve` prefix; "scale" is explicit |
| Drop old `transform_z_curve` | Yes, in the same migration | No backwards-compat shims; greenfield posture |
| Migration data handling | Copy z curve into BOTH new scale curves | Zero-visible-change for existing projects; uniform zoom preserved |

### UI

| Decision | Choice | Rationale |
|---|---|---|
| Tab layout | Flat 4 tabs (`X | Y | Scale X | Scale Y`) | Simplest extension; stays one-level |
| Axis colors | X cyan, Y magenta, Scale X yellow, Scale Y orange | Keeps existing X/Y colors; warm pair for the two scales separates them visually |
| Default curves | X/Y flat at 0; Scale X/Y flat at 1.0 | No-op on mount; matches old Z default |

### Render

| Decision | Choice | Rationale |
|---|---|---|
| Independent fx/fy in cv2.resize | Yes | cv2 supports this directly; no new primitive |
| Center-crop / pad to source dims | Unchanged | Existing logic is output-dimension-based, independent of fx/fy |

---

## Common Issues and Solutions

### Issue 1: Migration fails on projects where z curve was never written

**Symptom**: `UPDATE transitions SET ...` errors or no-ops on projects whose transitions all have `transform_z_curve IS NULL`.
**Solution**: That's expected — the `WHERE` clause handles it. The new columns stay null on those rows; render-time defaults (1.0) kick in.

### Issue 2: Grep finds `transform_z_curve` in a test fixture or migration-framework file

**Symptom**: `grep -rE "transform_?z|transformZ"` returns hits after the refactor.
**Solution**: Check if they're references to the old migration's history (acceptable — historical migrations should not be rewritten) or live reads (must be replaced). Update live reads.

### Issue 3: Pre-migration projects render differently after migration

**Symptom**: An existing transition's zoom looks different after upgrade.
**Solution**: Migration bug — z curve wasn't copied into both scale curves. Inspect the migrated row: `SELECT transform_scale_x_curve, transform_scale_y_curve FROM transitions WHERE id = ...`; both should equal whatever z was. Fix the migration's copy logic.

### Issue 4: Canvas overlay order means Scale Y hides Scale X (or vice versa)

**Symptom**: One of the two scale curves isn't visible on the canvas.
**Solution**: Draw order matters for overlays. Active curve should draw last (on top); faded curves draw first. If both faded curves have the same opacity, a higher-index iteration wins. Usually fine with 4 curves, but inspect the draw loop if something looks hidden.

### Issue 5: User reports their old animation "looks the same, I thought something changed"

**Symptom**: Not a bug — the migration preserves uniform zoom exactly. User has to explicitly set Scale X ≠ Scale Y to see a difference.
**Solution**: Document in release notes / in-app tooltip. The feature is "you CAN now animate X and Y independently," not "things that were uniform become non-uniform automatically."

---

## Notes

- This design supersedes the Z curve from `local.animated-transform-curves.md`. The older doc remains as history; do NOT edit that doc as part of this task — the new design is authoritative for the scale functionality.
- The migration should be in the same engine version bump as the frontend change — landing half the stack on a user's box produces a broken editor (either the API emits field names the frontend doesn't know, or the frontend requests fields the engine doesn't write).
- Rendering equivalence is the regression guard. If you can't produce identical output for a uniform-scale transition pre-and-post migration, something is wrong with the curve copy or the evaluator.
- No frontend tests are in the repo (per memory); don't add a test framework as part of this task. Testing is smoke + manual verification.

---

**Next Task**: TBD
**Related Design Docs**:
- [Split Transform Z Curve into Independent Scale X / Scale Y](../../design/local.split-z-into-scalex-scaley.md) — this task's design
- [Animated Transform Curves (X, Y, Z)](../../design/local.animated-transform-curves.md) — the original design this supersedes

**Estimated Completion Date**: TBD
