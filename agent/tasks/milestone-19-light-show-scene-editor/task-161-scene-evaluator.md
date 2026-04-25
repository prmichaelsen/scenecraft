# Task 161: Layered Scene Evaluator

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — R39-R48
**Estimated Time**: 1.5 hours
**Dependencies**: tasks 159 (client), 160 (primitives)
**Status**: Not Started

---

## Objective

Implement the per-frame layered evaluator: live override > timeline placement > fallback. Compute scene-local time per layer (wall clock for live, playhead-relative for placements), merge sparse stored params with catalog defaults, call the right primitive's `apply()`, multiply final intensity by fade envelopes, return the active-layer label.

---

## Steps

### 1. New file `scenecraft/src/plugins/light_show/scene-evaluator.ts`

```ts
import type { FixtureState } from './primitives'
import { PRIMITIVE_REGISTRY, resolveParams } from './primitives'
import type { SceneRow, PlacementRow, LiveOverrideRow } from './light-show-client'
import { deactivateLive } from './light-show-client'

export type SceneContext = { /* existing — playhead, master-bus, beats */ }

export type EvaluatorArgs = {
  playheadTime: number
  wallClockMs: number
  scenesById: Map<string, SceneRow>
  placements: PlacementRow[]
  liveOverride: LiveOverrideRow
  states: FixtureState[]
  context: SceneContext
  fallbackScene: { id: string; label: string; apply: (t, states, ctx) => void } | null
  projectName: string  // for triggering DELETE /live when fade completes
}

export type EvaluatorResult = {
  activeLayer: 'live' | 'timeline' | 'fallback' | 'none'
  label?: string
}

export function evaluateLayeredScene(args: EvaluatorArgs): EvaluatorResult {
  // 1. Live override
  if (args.liveOverride.active) {
    return evaluateLive(args, args.liveOverride)
  }
  // 2. Timeline placement
  const active = args.placements
    .filter(p => p.start_time <= args.playheadTime && args.playheadTime <= p.end_time)
    .sort((a, b) =>
      b.display_order - a.display_order ||
      a.created_at.localeCompare(b.created_at)
    )
  if (active.length > 0) {
    return evaluateTimeline(args, active[0])
  }
  // 3. Fallback
  if (args.fallbackScene) {
    args.fallbackScene.apply(args.playheadTime, args.states, args.context)
    return { activeLayer: 'fallback', label: args.fallbackScene.label }
  }
  return { activeLayer: 'none' }
}
```

### 2. `evaluateLive` — wall-clock scene time + fade envelope (R39, R46, R47)

```ts
function evaluateLive(args: EvaluatorArgs, override: LiveOverrideRow & { active: true }): EvaluatorResult {
  const activatedAtMs = Date.parse(override.activated_at)
  const sceneTime = (args.wallClockMs - activatedAtMs) / 1000

  // Resolve which scene applies (library or inline)
  const { type, sparseParams, label } = resolveLiveOverrideScene(override, args.scenesById)
  const params = resolveParams(sparseParams, type)
  const apply = PRIMITIVE_REGISTRY[type]
  if (!apply) {
    console.error(`[evaluator] unknown primitive type for live override: ${type}`)
    return { activeLayer: 'none' }
  }
  apply(sceneTime, args.states, params, args.context)

  // Fade-in (R46)
  const fadeIn = override.fade_in_sec
  if (fadeIn > 0 && sceneTime < fadeIn) {
    const m = sceneTime / fadeIn
    for (const s of args.states) s.intensity *= m
  }

  // Fade-out (R47)
  if (override.deactivation_started_at) {
    const deactStartMs = Date.parse(override.deactivation_started_at)
    const sinceDeact = (args.wallClockMs - deactStartMs) / 1000
    const fadeOut = override.fade_out_sec
    if (fadeOut <= 0 || sinceDeact >= fadeOut) {
      // Fade complete — physically delete the row, return as if no override
      void deactivateLive(args.projectName).catch(() => {/* swallow; row deletion may race */})
      // Note: this frame still applies the override at zero intensity (or near-zero);
      // next frame, fetch will return active:false and we'll fall through.
      for (const s of args.states) s.intensity = 0
    } else {
      const m = 1 - sinceDeact / fadeOut
      for (const s of args.states) s.intensity *= m
    }
  }
  return { activeLayer: 'live', label }
}
```

### 3. `evaluateTimeline` — playhead-relative scene time + fade envelope (R40, R40a, R42-R45)

```ts
function evaluateTimeline(args: EvaluatorArgs, p: PlacementRow): EvaluatorResult {
  const scene = args.scenesById.get(p.scene_id)
  if (!scene) {
    console.warn(`[evaluator] placement ${p.id} references unknown scene ${p.scene_id}`)
    return { activeLayer: 'none' }
  }
  const sceneTime = args.playheadTime - p.start_time
  const params = resolveParams(scene.params, scene.type)
  const apply = PRIMITIVE_REGISTRY[scene.type]
  if (!apply) {
    console.error(`[evaluator] unknown primitive type: ${scene.type}`)
    return { activeLayer: 'none' }
  }
  apply(sceneTime, args.states, params, args.context)

  // Fade-in (R43): for sceneTime in [0, fade_in_sec), m = sceneTime / fade_in_sec
  let fadeMul = 1
  if (p.fade_in_sec > 0 && sceneTime < p.fade_in_sec) {
    fadeMul *= Math.max(0, sceneTime / p.fade_in_sec)
  }
  // Fade-out (R44): timeToEnd = end_time - playheadTime; in [0, fade_out_sec), m = timeToEnd / fade_out_sec
  const timeToEnd = p.end_time - args.playheadTime
  if (p.fade_out_sec > 0 && timeToEnd < p.fade_out_sec) {
    fadeMul *= Math.max(0, timeToEnd / p.fade_out_sec)
  }
  if (fadeMul < 1) {
    for (const s of args.states) s.intensity *= fadeMul
  }

  return { activeLayer: 'timeline', label: scene.label }
}
```

### 4. `resolveLiveOverrideScene` helper

Resolves the override row to `{type, sparseParams, label}`:
- If `scene_id` is set: look up the library scene, use its `type` + `params`
- If inline: use `inline_type` + parsed `inline_params_json`
- `label` comes from the override row (or scene's label, or "directive" — backend already applied default)

### 5. Notes for R47 race

When fade completes, the evaluator issues `DELETE /live` to physically remove the row. There's a small race: the frame that detects fade-complete also fires the delete; the `DELETE` returns to the client and the next state-fetch (via WS event) shows `active: false`. The frontend should tolerate the row appearing in `active: true` state with `deactivation_started_at` past `fade_out_sec` for one extra frame — handled by setting intensity to 0 in that frame.

### 6. Fade envelope: intensity-only (R42)

Critical: fade envelope multiplies `state.intensity` ONLY. `state.color`, `state.pan`, `state.tilt` pass through untouched. This is the explicit semantic from clarification-14 Q 3.1.

---

## Verification

Spec base tests:
- [ ] `evaluator-live-wins` (R39)
- [ ] `evaluator-timeline-wins-when-no-live` (R40)
- [ ] `evaluator-fallback-when-neither` (R41)
- [ ] `fade-envelope-only-intensity` (R42)
- [ ] `evaluator-merges-sparse-params-with-catalog-defaults` (R39, R40, R40a)
- [ ] `evaluator-uses-undefined-when-no-default-and-not-stored` (R40a)

Edge tests:
- [ ] `scene-timeline-overlap-highest-display-order-wins` (R40)
- [ ] `scene-timeline-overlap-tie-broken-by-created-at` (R40)
- [ ] `fade-in-at-boundary-zero` (R43)
- [ ] `fade-in-midway` (R43)
- [ ] `fade-in-after-window` (R43)
- [ ] `fade-out-at-end` (R44)
- [ ] `fade-in-and-out-overlap-short-placement` (R45)
- [ ] `fade-in-and-out-overlap-midpoint` (R45)
- [ ] `live-override-fade-out-completes-and-row-deleted` (R47)
- [ ] `live-override-fade-out-in-progress` (R47)
- [ ] `scrub-backward-into-fade-in-window` (R43, R48 — determinism)

Quality:
- [ ] `tsc --noEmit` clean
- [ ] No allocations in the per-frame hot path beyond what the primitive needs (state-object reuse; no `[...args]` spreads)
- [ ] Multiple evaluations at the same `playheadTime` produce identical state outputs (R48 determinism)

---

## Notes

- The evaluator runs every frame inside r3f's `useFrame` callback (task-162). Hot path; avoid heap allocations.
- `wallClockMs` should come from `Date.now()` once per frame, passed in by the caller — not computed inside the evaluator (testability).
- Keep this module pure-functional aside from the necessary side-effect of `DELETE /live` on fade completion. That's the one IO escape; rest is pure state mutation.
