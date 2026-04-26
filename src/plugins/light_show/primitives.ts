/**
 * Frontend primitive registry for the light_show scene editor.
 *
 * - PRIMITIVE_REGISTRY: maps catalog ``type`` -> apply() function.
 * - resolveParams: merges catalog defaults under stored sparse params (the
 *   FALLBACK direction — explicit overrides win per-key).
 * - assertCatalogRegistryParity: enforces R31 (catalog ids ↔ registry keys
 *   match exactly; fires loud when one drifts ahead of the other).
 *
 * Catalog import strategy: fetched via REST at module init (Option B from
 * task-160). No filesystem coupling between repos, no new deps. Trade:
 * the catalog isn't available synchronously at import; ensureCatalogLoaded
 * resolves a Promise instead. Evaluator awaits this once at panel mount.
 *
 * M21 additions:
 * - ``fixtures: string[]`` filter on built-in primitives (intersected with
 *   role) so a single primitive can target an arbitrary id list.
 * - ``composite`` primitive: dispatches multiple sub-layers under one
 *   scene, each with its own type/params/filters. Bindings inside
 *   sub-layer params resolve against the same SceneContext.
 */

import { fetchPrimitivesCatalog, type PrimitiveCatalogEntry } from './light-show-client'
import type { FixtureState } from './fixtures'
import type { SceneContext } from './scene-types'
import { resolveBindings } from './bindings'

export type PrimitiveApplyFn = (
  sceneTime: number,
  states: FixtureState[],
  /** Already merged with catalog defaults via resolveParams — apply()
   *  reads required keys directly without falling back. */
  params: Record<string, unknown>,
  context: SceneContext,
) => void

// ── Primitive implementations ────────────────────────────────────────────

/**
 * Build the per-fixture filter predicate from ``role`` and ``fixtures``
 * params. Both are optional; when both are set, a fixture must match
 * BOTH (role AND id allow-list — intersection, not union). Returns null
 * for "match every fixture" so the hot path can skip the predicate
 * entirely on the no-filter case.
 */
function _buildFilter(
  params: Record<string, unknown>,
): ((s: FixtureState) => boolean) | null {
  const role = params.role as string | undefined
  const fixtures = params.fixtures as string[] | undefined
  const idSet =
    Array.isArray(fixtures) && fixtures.length > 0 ? new Set(fixtures) : null
  if (role === undefined && idSet === null) return null
  return (s) => {
    if (role !== undefined && s.role !== role) return false
    if (idSet !== null && !idSet.has(s.id)) return false
    return true
  }
}

/**
 * Sinusoidal pan/tilt sweep with hold color + intensity.
 * Spec R32-R37: at sceneTime=0 pan=0 tilt=tilt_center; quarter-period
 * pan=+pan_amplitude; half-period pan=0; three-quarter pan=-pan_amplitude.
 */
export function applyRotatingHead(
  t: number,
  states: FixtureState[],
  params: Record<string, unknown>,
  _context: SceneContext,
): void {
  const filter = _buildFilter(params)
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
    if (filter !== null && !filter(s)) continue
    s.intensity = intensity
    s.color = [color[0], color[1], color[2]]
    s.pan = Math.sin(panPhase) * panAmp
    s.tilt = tiltCenter + Math.sin(tiltPhase) * tiltAmp
  }
}

/**
 * Hold a color + intensity. No animation; intentionally does NOT touch
 * pan/tilt (R38) so it composes cleanly with separate movement primitives.
 */
export function applyStaticColor(
  _t: number,
  states: FixtureState[],
  params: Record<string, unknown>,
  _context: SceneContext,
): void {
  const filter = _buildFilter(params)
  const intensity = params.intensity as number
  const color = params.color as [number, number, number]
  for (const s of states) {
    if (filter !== null && !filter(s)) continue
    s.intensity = intensity
    s.color = [color[0], color[1], color[2]]
    // pan/tilt deliberately untouched (R38)
  }
}

/**
 * Run multiple sub-primitives within a single scene.
 *
 * params shape:
 *   { layers: [{type: string, params: Record<string, unknown>}, ...] }
 *
 * Each sub-layer goes through the full resolution pipeline:
 *   stored sparse params → catalog defaults → context-bound bindings
 *
 * Layers run sequentially in declaration order; later layers overwrite
 * earlier ones for any fixtures they touch. Bindings inside sub-layer
 * params resolve against the same SceneContext as the top level — there
 * is no nested context, no per-layer time offset (use a separate scene
 * + placement for that).
 *
 * Unknown sub-layer types or malformed entries warn and skip; one bad
 * layer never breaks the rest of the composite.
 */
export function applyComposite(
  t: number,
  states: FixtureState[],
  params: Record<string, unknown>,
  context: SceneContext,
): void {
  const layers = params.layers
  if (!Array.isArray(layers)) {
    console.warn('[composite] missing or non-array `layers`; nothing to render')
    return
  }
  for (const raw of layers) {
    if (typeof raw !== 'object' || raw === null) continue
    const type = (raw as { type?: unknown }).type
    if (typeof type !== 'string') {
      console.warn('[composite] layer missing string `type`; skipping')
      continue
    }
    const apply = PRIMITIVE_REGISTRY[type]
    if (!apply) {
      console.warn(`[composite] unknown sub-layer type: ${type}`)
      continue
    }
    const subStored =
      ((raw as { params?: unknown }).params as Record<string, unknown>) ?? {}
    const merged = resolveParams(subStored, type)
    const resolved = resolveBindings(merged, context)
    apply(t, states, resolved, context)
  }
}

// ── Registry + catalog ───────────────────────────────────────────────────

export const PRIMITIVE_REGISTRY: Record<string, PrimitiveApplyFn> = {
  rotating_head: applyRotatingHead,
  static_color: applyStaticColor,
  composite: applyComposite,
}

let CATALOG: { primitives: PrimitiveCatalogEntry[] } | null = null
let _loadPromise: Promise<{ primitives: PrimitiveCatalogEntry[] }> | null = null

/**
 * Fetch the catalog from the backend (cached for subsequent calls). Concurrent
 * callers share the same in-flight promise. Returns the full catalog wrapped
 * as ``{primitives: [...]}`` (verbatim from primitives_catalog.yaml).
 */
export function ensureCatalogLoaded(
  projectName: string,
): Promise<{ primitives: PrimitiveCatalogEntry[] }> {
  if (CATALOG) return Promise.resolve(CATALOG)
  if (_loadPromise) return _loadPromise
  _loadPromise = fetchPrimitivesCatalog(projectName).then((cat) => {
    assertCatalogRegistryParity(cat)
    CATALOG = cat
    return cat
  })
  return _loadPromise
}

/**
 * Test / introspection helper: install a catalog directly without fetching.
 * Used by the evaluator's tests and by storybook-style fixtures.
 */
export function _setCatalogForTest(
  catalog: { primitives: PrimitiveCatalogEntry[] } | null,
): void {
  CATALOG = catalog
  _loadPromise = null
}

export function getCatalog(): { primitives: PrimitiveCatalogEntry[] } | null {
  return CATALOG
}

/**
 * R31: enforce that every catalog entry has a matching registry apply()
 * and vice versa. Drift in either direction surfaces as a thrown error
 * with both sides of the diff so the dev knows what to fix.
 */
export function assertCatalogRegistryParity(catalog: {
  primitives: PrimitiveCatalogEntry[]
}): void {
  const catalogIds = new Set(catalog.primitives.map((p) => p.id))
  const registryIds = new Set(Object.keys(PRIMITIVE_REGISTRY))
  const missingFromRegistry = [...catalogIds].filter((id) => !registryIds.has(id))
  const missingFromCatalog = [...registryIds].filter((id) => !catalogIds.has(id))
  if (missingFromRegistry.length || missingFromCatalog.length) {
    throw new Error(
      `Primitive catalog ↔ registry drift detected. ` +
        `In catalog but no apply(): ${missingFromRegistry.join(',') || 'none'}. ` +
        `In registry but no catalog entry: ${missingFromCatalog.join(',') || 'none'}.`,
    )
  }
}

// ── Param resolution ─────────────────────────────────────────────────────

/**
 * Merge stored sparse params over catalog defaults for the given primitive
 * type. Stored values win per-key. Required by the evaluator (task-161)
 * before invoking apply() — primitives expect fully-resolved params, not
 * sparse storage shape.
 *
 * If the catalog isn't loaded yet, throws — caller should ``await
 * ensureCatalogLoaded(projectName)`` first.
 */
export function resolveParams(
  storedParams: Record<string, unknown>,
  primitiveType: string,
): Record<string, unknown> {
  if (!CATALOG) {
    throw new Error(
      'resolveParams called before catalog loaded; await ensureCatalogLoaded first',
    )
  }
  const entry = CATALOG.primitives.find((p) => p.id === primitiveType)
  if (!entry) throw new Error(`unknown primitive type: ${primitiveType}`)
  const defaults: Record<string, unknown> = {}
  const props = (entry.params_schema as { properties?: Record<string, unknown> })?.properties ?? {}
  for (const [key, schema] of Object.entries(props)) {
    const def = (schema as { default?: unknown })?.default
    if (def !== undefined) defaults[key] = def
  }
  return { ...defaults, ...storedParams }
}
