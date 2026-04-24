# Task 139: Scene Evaluator (TS)

**Milestone**: [M17 - Track Contribution Point and Light Show Plugin](../../milestones/milestone-17-track-contribution-point-and-light-show-plugin.md)
**Design Reference**: [local.track-contribution-point-and-light-show-plugin.md § Part 4 (scene animation pipeline)](../../design/local.track-contribution-point-and-light-show-plugin.md)
**Estimated Time**: 6 hours
**Dependencies**: task-138 (needs seeded scenes + fixtures to evaluate against)
**Status**: Not Started

---

## Objective

Implement the frontend TypeScript scene evaluator. Given a scene row (parameters_schema + animation JSON), a set of parameter bindings (static or curves), a time remap curve, trim_in/out, and a list of fixtures, produce a 512-channel-per-universe buffer at time `t`. Apply output overlays. Combine multiple tracks via `merge_mode`.

---

## Context

The evaluator is the brain of the 3D preview. It runs per frame in the browser. It must be fast (<5ms per 50-fixture rig per frame). It interprets the scene DSL (concrete grammar determined by the seed scenes in task-138) and applies the tr-level parameter bindings + output overlays + merge math.

Scenes reference fixtures by role (`@role.moving_head`) or by `fixture_group` parameter; the evaluator resolves these against the rig at eval time.

---

## Steps

### 1. Type definitions

`src/plugins/light_show/types.ts`:

```ts
export interface FixtureRef {
  id: string
  profileId: string
  universeId: string
  address: number
  role: string
  position: { x: number, y: number, z: number }
  rotation: { x: number, y: number, z: number }
}

export interface Scene {
  id: string
  label: string
  parametersSchema: ParameterDef[]
  animation: AnimationTree
}

export interface ParameterDef {
  name: string
  type: 'number' | 'hue' | 'color' | 'fixture_ref' | 'fixture_ref[]' | 'role'
  default: unknown
  range?: [number, number]
}

export type AnimationTree =
  | { type: 'channels', target: string | string[], channels: Record<string, ChannelAnimation> }
  | { type: 'steps', target: string | string[], steps: StepDef[], rate: number | ParamRef }
  | { type: 'sequence', ... }
  // grammar grows as seed scenes demand

export interface ChannelAnimation {
  curveType: 'pulse_wave' | 'sine' | 'linear' | 'hold' | ...
  rate?: number | ParamRef
  phaseOffsetPerFixture?: number
  width?: number
  value?: number | ParamRef
  // ... other curve-specific fields
}

export type ParamRef = { $param: string }          // { $param: 'hue' }
export type RoleRef = { $role: string }            // { $role: 'moving_head' }

export interface UniverseBuffer {
  universeId: string
  channels: Uint8Array          // length 512
}

export type MergeMode = 'top_wins' | 'additive' | 'max' | 'latest' | 'multiply' | 'min'
```

### 2. Role resolver

`src/plugins/light_show/role-resolver.ts`:

```ts
export function resolveTarget(
  target: string | string[] | RoleRef,
  fixtures: FixtureRef[]
): FixtureRef[] {
  // @role.moving_head → filter by role
  // specific fixture id → lookup
  // array of either → union
  // RoleRef object → filter by role
}
```

### 3. Parameter binding resolver

`src/plugins/light_show/parameter-resolver.ts`:

```ts
export function resolveParameter(
  binding: StaticBinding | CurveBinding | undefined,
  def: ParameterDef,
  tCurveLocal: number   // 0..1 within tr duration
): unknown {
  if (binding === undefined) return def.default
  if ('static' in binding) return binding.static
  if ('curve' in binding) return evaluateCurve(binding.curve, tCurveLocal)
  throw new Error('unreachable')
}
```

### 4. Curve evaluator

`src/plugins/light_show/curve.ts`:

```ts
export type Curve = {
  points: { t: number, value: number, easing?: 'linear' | 'hold' | 'ease' }[]
}

export function evaluateCurve(curve: Curve, t: number): number {
  // Find surrounding points, interpolate per easing
}
```

### 5. Scene evaluator

`src/plugins/light_show/evaluator.ts`:

```ts
export function evaluateScene(
  scene: Scene,
  params: Record<string, unknown>,
  fixtures: FixtureRef[],
  profileById: Map<string, FixtureProfile>,
  sceneTime: number
): Partial<Record<string, ChannelValues>> {
  // Dispatch on animation.type
  switch (scene.animation.type) {
    case 'channels':
      return evaluateChannelsNode(scene.animation, params, fixtures, profileById, sceneTime)
    case 'steps':
      return evaluateStepsNode(scene.animation, params, fixtures, profileById, sceneTime)
    // ...
  }
}
```

`evaluateChannelsNode` iterates resolved targets, for each fixture iterates its channels per `channels` config, computes channel value for sceneTime. Returns per-fixture per-channel values.

### 6. Transition evaluator

```ts
export function evaluateTransition(
  tr: Transition,
  sceneById: Map<string, Scene>,
  t: number                       // absolute time
): Partial<Record<string, ChannelValues>> {
  if (t < tr.startTime || t > tr.endTime) return {}
  const trLocal = (t - tr.startTime) / (tr.endTime - tr.startTime)

  // 1. Time remap
  const remappedLocal = applyTimeRemap(tr.timeRemapCurve, trLocal)
  const sceneTime = tr.trimIn + remappedLocal * (tr.trimOut - tr.trimIn)

  // 2. Resolve parameters
  const scene = sceneById.get(tr.sceneId)!
  const params = resolveAllParameters(tr.parameterBindings, scene.parametersSchema, trLocal)

  // 3. Scene eval
  const rawOutput = evaluateScene(scene, params, fixtures, profileById, sceneTime)

  // 4. Apply output overlays
  return applyOverlays(rawOutput, tr.overlays, trLocal)
}
```

### 7. Output overlay implementations

`src/plugins/light_show/overlays.ts`:

```ts
export function applyOverlay(raw: ChannelValues, overlay: Overlay, tLocal: number): ChannelValues {
  switch (overlay.type) {
    case 'hue_shift': return applyHueShift(raw, evaluateCurveOrStatic(overlay.curve, tLocal))
    case 'intensity_multiplier': return applyIntensityMultiplier(raw, evaluateCurveOrStatic(overlay.curve, tLocal))
    case 'saturation_scale': ...
    case 'color_filter': ...
    case 'strobe_mask': ...
  }
}
```

### 8. Track composer

`src/plugins/light_show/composer.ts`:

```ts
export function composeUniverseBuffer(
  tracks: TrackWithTransitions[],
  sceneById: Map<string, Scene>,
  fixtures: FixtureRef[],
  profileById: Map<string, FixtureProfile>,
  t: number,
  universeCount: number
): UniverseBuffer[] {
  // Initialize universe buffers to zero
  // For each track (in display_order), evaluate active tr at time t, merge into buffer per track.mergeMode
  // Return per-universe 512-byte buffers
}

function mergeChannelValue(existing: number, incoming: number, mode: MergeMode, trackIndex: number): number {
  switch (mode) {
    case 'top_wins': return incoming     // caller ensures correct order
    case 'additive': return Math.min(255, existing + incoming)
    case 'max': return Math.max(existing, incoming)
    case 'multiply': return Math.round((existing / 255) * (incoming / 255) * 255)
    case 'min': return Math.min(existing, incoming)
    case 'latest': return incoming       // order in tracks already reflects activation latest-first
  }
}
```

### 9. Tests (install `vitest` if absent)

- Role resolver: `@role.moving_head` → correct subset
- Curve evaluator: linear / hold / ease at boundary times
- Parameter resolver: static, curve, missing → default
- Scene eval per seed primitive at known parameter values:
  - `blackout` → all zeros
  - `full_on` → targeted fixtures' intensity = 255
  - `strobe(rate=2)` → intensity alternating at 2Hz
  - `rainbow_sweep(rate=1)` → hue values across fixtures with phase offset
- Transition eval: outside time range → empty; inside → correct output
- Overlay: hue_shift +90 on (R=255, G=0, B=0) → yellow
- Composer: top-wins with higher-order track overriding; multiply dimming lower layer; additive clamping at 255

---

## Verification

- [ ] All scene primitive types from task-138's seed evaluate correctly
- [ ] Parameter resolution handles static, curve, and missing (default) cases
- [ ] Role resolution returns correct fixtures for each role type
- [ ] Output overlays implement hue_shift, intensity_multiplier, saturation_scale, color_filter, strobe_mask
- [ ] All merge modes produce correct blended output
- [ ] Evaluator performance: <5ms per frame for 50-fixture rig (benchmark test)
- [ ] Unit tests pass

---

## Key Design Decisions

See [design doc § Part 4](../../design/local.track-contribution-point-and-light-show-plugin.md).

| Decision | Choice | Rationale |
|---|---|---|
| Scene parameter binding vs overlay | Two distinct pipeline stages | Scene params feed IN to eval; overlays apply AFTER. Distinct semantics — a strobe with no hue param still needs hue-shift |
| DSL type dispatch | Outer shape (`animation.type`) selects interpretation | Extensible; each primitive's shape is type-safe in its own handler |
| Time remap | Applied to tr-local time before computing scene time | Allows stretching/squeezing scene's internal clock independently of tr duration |
| Merge order | Track display_order ascending; later track overwrites earlier under `top_wins` | Mirrors video compositing |

---

## Notes

- The full DSL grammar is out of scope — only the grammar needed to evaluate the seeded primitives. A post-M17 design doc will specify the full grammar.
- Evaluator is pure (no side effects). Enables easy testing and future Python port for real DMX output.
- All channel values clamp to 0-255 at the merge boundary.

---

**Next Task**: [task-140-3d-preview-panel.md](./task-140-3d-preview-panel.md)
**Related Design Docs**: [local.track-contribution-point-and-light-show-plugin.md](../../design/local.track-contribution-point-and-light-show-plugin.md)
