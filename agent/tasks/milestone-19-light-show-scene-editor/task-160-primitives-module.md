# Task 160: Frontend `primitives.ts` Module

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — R31-R38
**Estimated Time**: 1 hour
**Dependencies**: task-152 (catalog YAML exists)
**Status**: Not Started

---

## Objective

Implement the frontend primitive registry: TypeScript `apply()` functions for `rotating_head` and `static_color`, the registry that maps `type` → apply function, the catalog import (YAML → JS object), and the registry/catalog drift assertion.

---

## Steps

### 1. Catalog import strategy

Two acceptable approaches; pick one and document:

**Option A — Vite raw import + js-yaml**:
```ts
import catalogRaw from '@/../scenecraft-engine/src/scenecraft/plugins/light_show/primitives_catalog.yaml?raw'
import yaml from 'js-yaml'
const CATALOG = yaml.load(catalogRaw) as { primitives: PrimitiveCatalogEntry[] }
```
- Cross-repo path (frontend importing from engine repo) — works if repos colocated; brittle if not
- Adds `js-yaml` dependency

**Option B — Fetch via REST `/primitives` at module init**:
```ts
let CATALOG: { primitives: PrimitiveCatalogEntry[] } | null = null
export async function ensureCatalogLoaded(projectName: string) {
  if (CATALOG) return CATALOG
  CATALOG = await fetchPrimitivesCatalog(projectName)
  return CATALOG
}
```
- No filesystem coupling; works regardless of repo layout
- Slightly later catalog availability (after first project context)

**Recommendation: Option B** for cleaner repo decoupling. Document in code.

### 2. Primitive `apply()` functions

```ts
export type FixtureState = {
  id: string
  role: string
  intensity: number
  color: [number, number, number]
  pan: number
  tilt: number
}

export type PrimitiveApplyFn = (
  sceneTime: number,
  states: FixtureState[],
  params: Record<string, unknown>,  // already merged with catalog defaults by evaluator
  context: SceneContext,
) => void

export function applyRotatingHead(t, states, params, _ctx): void {
  const role = params.role as string | undefined
  const periodSec = params.period_sec as number
  const panAmp = params.pan_amplitude_rad as number
  const tiltCenter = params.tilt_center_rad as number
  const tiltAmp = params.tilt_amplitude_rad as number
  const tiltPeriod = params.tilt_period_sec as number
  const intensity = params.intensity as number
  const color = params.color as [number, number, number]
  const panPhase = (t / periodSec) * 2 * Math.PI
  const tiltPhase = (t / tiltPeriod) * 2 * Math.PI
  for (const s of states) {
    if (role !== undefined && s.role !== role) continue
    s.intensity = intensity
    s.color = [color[0], color[1], color[2]]
    s.pan = Math.sin(panPhase) * panAmp
    s.tilt = tiltCenter + Math.sin(tiltPhase) * tiltAmp
  }
}

export function applyStaticColor(t, states, params, _ctx): void {
  const role = params.role as string | undefined
  const intensity = params.intensity as number
  const color = params.color as [number, number, number]
  for (const s of states) {
    if (role !== undefined && s.role !== role) continue
    s.intensity = intensity
    s.color = [color[0], color[1], color[2]]
    // pan/tilt deliberately untouched (R38)
  }
}
```

### 3. PRIMITIVE_REGISTRY

```ts
export const PRIMITIVE_REGISTRY: Record<string, PrimitiveApplyFn> = {
  rotating_head: applyRotatingHead,
  static_color: applyStaticColor,
}
```

### 4. Catalog ↔ registry assertion (R31)

After catalog loads (option A: at import; option B: in `ensureCatalogLoaded`):

```ts
function assertCatalogRegistryParity(catalog: { primitives: PrimitiveCatalogEntry[] }) {
  const catalogIds = new Set(catalog.primitives.map(p => p.id))
  const registryIds = new Set(Object.keys(PRIMITIVE_REGISTRY))
  const missingFromRegistry = [...catalogIds].filter(id => !registryIds.has(id))
  const missingFromCatalog = [...registryIds].filter(id => !catalogIds.has(id))
  if (missingFromRegistry.length || missingFromCatalog.length) {
    throw new Error(
      `Primitive catalog ↔ registry drift detected. ` +
      `In catalog but no apply(): ${missingFromRegistry.join(',') || 'none'}. ` +
      `In registry but no catalog entry: ${missingFromCatalog.join(',') || 'none'}.`
    )
  }
}
```

### 5. Param resolution helper for evaluator (used in task-161)

```ts
export function resolveParams(
  storedParams: Record<string, unknown>,
  primitiveType: string,
): Record<string, unknown> {
  const entry = CATALOG?.primitives.find(p => p.id === primitiveType)
  if (!entry) throw new Error(`unknown primitive type: ${primitiveType}`)
  const defaults: Record<string, unknown> = {}
  const props = (entry.params_schema as any).properties ?? {}
  for (const [key, schema] of Object.entries(props)) {
    if ((schema as any).default !== undefined) defaults[key] = (schema as any).default
  }
  return { ...defaults, ...storedParams }
}
```

This is what implements R40a (merge stored sparse params over catalog defaults at evaluator time).

---

## Verification

Spec base tests (frontend):
- [ ] `apply-rotating-head-at-zero` (R32)
- [ ] `apply-rotating-head-quarter-period` (R33)
- [ ] `apply-rotating-head-respects-role-filter` (R36)
- [ ] `applyStaticColor` doesn't modify pan/tilt (R38)

Edge tests (frontend):
- [ ] `primitive-registry-catalog-mismatch-assertion` (R31) — assertion fires loudly when registry/catalog drift exists

Module:
- [ ] `tsc --noEmit` clean for `primitives.ts`
- [ ] `applyRotatingHead` produces deterministic state mutations (same `t` + params → same state output)
- [ ] `resolveParams` returns merged result with stored values winning per-key over catalog defaults
- [ ] `resolveParams` for a key not in catalog AND not in stored params returns `undefined` for that key (per R40a: primitive interprets undefined per its own contract)

---

## Notes

- This is the FIRST scenecraft module that imports YAML at build time. If we go option A, this is where to install `js-yaml` (`npm i js-yaml @types/js-yaml`). If option B, no new deps.
- Vitest doesn't exist yet on the frontend. Per project memory, install vitest when a task needs tests — this task does. Do `npm i -D vitest @vitest/ui` and add a `test` script to `package.json` before writing the unit tests.
