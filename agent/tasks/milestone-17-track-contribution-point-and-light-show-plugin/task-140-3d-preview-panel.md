# Task 140: 3D Preview Panel + UniverseContext

**Milestone**: [M17 - Track Contribution Point and Light Show Plugin](../../milestones/milestone-17-track-contribution-point-and-light-show-plugin.md)
**Design Reference**: [local.track-contribution-point-and-light-show-plugin.md § Part 5](../../design/local.track-contribution-point-and-light-show-plugin.md)
**Estimated Time**: 10 hours
**Dependencies**: task-137 (PluginHost.registerTrackType + registerPanel), task-139 (evaluator)
**Status**: Not Started

---

## Objective

Ship the 3D preview panel: a three.js + @react-three/fiber scene that renders fixtures at their 3D positions with additive cone beams colored and intensity-modulated by the evaluator's per-frame universe output. Drive the scene from a `UniverseContext` populated by evaluator output at the current playhead time.

---

## Context

The 3D preview is how users see what their show will look like. It runs on every playhead tick (20Hz via existing `useCurrentTime`) plus every r3f frame (up to 60fps). It must feel responsive; any per-frame evaluator call should be <5ms (task-139 performance target).

The scene stack is locked (three.js + r3f + drei, confirmed in design doc). Volumetric beams use the additive-cone MVP approach (translucent cones with soft-edge shader); ray-marched upgrade is post-M17.

No Zustand. State management follows the scenecraft convention: React Context + `useSyncExternalStore`, matching `JobStateContext`.

---

## Steps

### 1. Install dependencies

```bash
npm install three @react-three/fiber @react-three/drei
npm install --save-dev @types/three
```

Commit to `package.json`.

### 2. Define `UniverseContext`

`src/contexts/UniverseContext.tsx` — mirror `JobStateContext` shape exactly:

```tsx
type UniverseStore = {
  universes: Map<string, Uint8Array>       // universeId → 512-byte buffer
  fixtures: FixtureRef[]                   // snapshot for the 3D scene
  profileById: Map<string, FixtureProfile>
  scenesById: Map<string, Scene>
  override: { sceneId: string, params: Record<string, unknown> } | null
}

type UniverseContextValue = {
  getBuffer: (universeId: string) => Uint8Array | null
  getFixtures: () => FixtureRef[]
  setOverride: (override: UniverseStore['override']) => void
  clearOverride: () => void
  subscribe: (cb: () => void) => () => void
  getSnapshot: () => number
}
```

- `storeRef` holds the mutable state
- `listeners: Set<() => void>` + `changeCounter` — matches existing convention
- Setters mutate storeRef and call `notify()`
- Per-frame evaluator integration: a `useEffect` subscribes to scenecraft's `CurrentTimeContext` AND polls a WS channel for track/scene/fixture updates; on any relevant change, recompose universe buffers via the task-139 composer and notify subscribers

### 3. Fixture geometry

`src/plugins/light_show/fixtures/` — simple meshes per role:

- **moving_head**: box (yoke) + cylindrical head + cone beam
- **par**: short cylinder + cone beam
- **strobe**: disc/panel
- **laser**: thin long cone (beam-only)
- **fog**: small cube (no visible emitter in most scenes)
- **wash**: rectangular panel + wide cone

Low-poly geometry, materials from drei. Instanced where multiple fixtures share geometry.

### 4. Additive cone beam shader

`src/plugins/light_show/BeamCone.tsx`:

- `<mesh>` with a cone geometry oriented along fixture's pan/tilt
- Custom `shaderMaterial` (via drei's `shaderMaterial`) with:
  - Additive blending (`THREE.AdditiveBlending`)
  - `color` uniform (from fixture's RGB channels, hue from color)
  - `intensity` uniform (from fixture's dimmer channel / 255)
  - Fragment computes: soft falloff near edges, full alpha at tip, faded along length
- Updated per frame via `useFrame` reading `UniverseContext`'s buffer for the fixture's channels

### 5. Scene component

`src/plugins/light_show/LightShow3DPanel.tsx`:

```tsx
export function LightShow3DPanel() {
  return (
    <Canvas camera={{ position: [0, 5, -8], fov: 50 }}>
      <ambientLight intensity={0.1} />
      <StageFloor />
      <TrussGeometry />
      <Fixtures />
      <OrbitControls />
    </Canvas>
  )
}

function Fixtures() {
  const universe = useUniverseContext()
  const fixtures = universe.getFixtures()
  return <>
    {fixtures.map(f => <FixtureRenderer key={f.id} fixture={f} />)}
  </>
}

function FixtureRenderer({ fixture }: { fixture: FixtureRef }) {
  const universe = useUniverseContext()
  useFrame(() => {
    const buffer = universe.getBuffer(fixture.universeId)
    // Look up channel values for this fixture, apply to meshes (pan/tilt rotation, color/intensity uniforms)
  })
  // Return role-specific geometry + beam
}
```

### 6. Pan/tilt animation

Read fixture profile's channel map, extract pan + tilt channel addresses, read values from universe buffer, normalize to radians (pan usually 0-540°, tilt 0-270°), apply to the head mesh's rotation.

### 7. Color/intensity application

Read dimmer + RGB channels from universe buffer. Update cone beam material's `color` and `intensity` uniforms. If fixture uses CMY, convert to RGB.

### 8. Playback mode

`UniverseContext` subscribes to `useCurrentTime()`. On tick:
- Load latest tracks/transitions/scenes/fixtures (cached with dirty checks)
- For each universe: run composer with current playhead time → new buffer
- Update storeRef.universes map
- Notify subscribers (but the 3D scene polls via `useFrame`, so notification is mostly for non-3D consumers like inspector panels)

### 9. Register the panel

In `src/plugins/light_show/index.ts`:

```ts
PluginHost.registerPanel({
  id: 'light_show.preview_3d',
  title: 'Light Preview',
  Component: LightShow3DPanel,
})
```

Also register in the panel layout so it appears in the default workspace.

### 10. Performance profiling

Benchmark with the seeded demo rig:
- 15 fixtures (4 movers, 8 pars, 2 strobes, 1 fog)
- 3 active tracks, each with an active transition
- Frame rate at 60fps target

If r3f frame time exceeds 16ms, profile with React DevTools + three.js stats. Likely hotspots:
- Too many useState/re-renders — use refs + direct mesh mutation in useFrame
- Shader uniform updates — batch per frame
- Evaluator recomputing per frame — cache by time quantized to frame period

### 11. Tests

- Visual regression: render golden scenes for known rig + known tracks at known playhead times, compare to reference images
- Unit: `UniverseContext` subscribe/notify/getBuffer behavior
- Integration: evaluator → UniverseContext → 3D scene — end-to-end render without console errors

---

## Verification

- [ ] `three`, `@react-three/fiber`, `@react-three/drei` added to package.json
- [ ] `UniverseContext` implemented following `JobStateContext` pattern (Context + useSyncExternalStore, no Zustand)
- [ ] `LightShow3DPanel` registered with PluginHost
- [ ] Panel appears in dockview workspace
- [ ] Fixtures render at their 3D positions with correct role-specific geometry
- [ ] Pan/tilt animation reflects universe channel values
- [ ] Additive cone beams render with color from RGB channels and intensity from dimmer channel
- [ ] Playhead scrubbing updates the 3D scene in real time
- [ ] Performance: 60fps maintained with 15-fixture demo rig
- [ ] Visual regression tests pass

---

## Key Design Decisions

See [design doc § Part 5](../../design/local.track-contribution-point-and-light-show-plugin.md).

| Decision | Choice | Rationale |
|---|---|---|
| 3D stack | three.js + r3f + drei | Industry standard for React + 3D in 2026; ASLS Studio validates for DMX |
| Beam rendering | Additive translucent cones for MVP | Credible in dark scenes; ~1 day work; ray-marched is post-M17 polish |
| State shape | React Context + useSyncExternalStore mirroring JobStateContext | Project convention; no Zustand |
| Per-frame eval | useFrame reads from context's buffer directly; store updates on playhead tick | Decouples 60fps render from 20Hz eval |
| Fixture geometry | Low-poly per-role meshes | Visual clarity > photorealism at M17 |

---

## Notes

- OrbitControls from drei — standard free camera for prototype. Preset views (front, top, stage-POV) can come later.
- Stage floor + truss geometry is cosmetic — a simple grid and horizontal beam give users orientation cues.
- Keep the scene dark by default (low ambient light) so additive beams read well.
- No sRGB/linear color-space drama yet — three.js default is fine at M17. Color correctness is a polish pass.

---

**Next Task**: [task-141-scene-list-candidates-polish.md](./task-141-scene-list-candidates-polish.md)
**Related Design Docs**: [local.track-contribution-point-and-light-show-plugin.md](../../design/local.track-contribution-point-and-light-show-plugin.md)
