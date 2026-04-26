/**
 * Per-frame layered scene evaluator (M19, spec R39-R48).
 *
 * Precedence: live override > timeline placement > fallback. Each layer
 * computes its own scene-local time:
 *   - LIVE: scene_time = (wallClockMs - activated_at) / 1000 — wall-clock,
 *     so the cue runs from when it fired regardless of where the playhead
 *     is. Fade-in starts at activate; fade-out starts at deactivate.
 *   - TIMELINE: scene_time = playheadTime - placement.start_time — frame-
 *     deterministic; scrubbing back/forward moves through the scene.
 *   - FALLBACK: scene_time = playheadTime; pre-MVP scenes (rainbow_chase
 *     etc.) keep their existing semantics.
 *
 * Fade envelope is intensity-ONLY (R42 / clarification-14 Q 3.1) — color,
 * pan, tilt pass through untouched so they compose with whatever follows.
 *
 * Hot path: zero heap allocations beyond what the primitive itself needs
 * (no spreads, no array filters in the steady state — the per-frame
 * placement scan is a single linear loop).
 */

import { PRIMITIVE_REGISTRY, resolveParams } from './primitives'
import { resolveBindings } from './bindings'
import type { FixtureState } from './fixtures'
import type {
  SceneRow,
  PlacementRow,
  LiveOverrideRow,
} from './light-show-client'
import { deactivateLive } from './light-show-client'
import type { SceneContext } from './scene-types'

export type FallbackSceneAdapter = {
  id: string
  label: string
  apply: (sceneTime: number, states: FixtureState[], context: SceneContext) => void
}

export type EvaluatorArgs = {
  playheadTime: number
  wallClockMs: number
  scenesById: Map<string, SceneRow>
  placements: readonly PlacementRow[]
  liveOverride: LiveOverrideRow
  states: FixtureState[]
  context: SceneContext
  /** Pre-existing dropdown-picked scene (rainbow_chase etc.) used as the
   *  transitional R41 fallback. Pass null to fall through to no-output. */
  fallbackScene: FallbackSceneAdapter | null
  /** Required by the live-override fade-out finalizer; the evaluator fires
   *  DELETE /live when fade completes. */
  projectName: string
}

export type EvaluatorResult = {
  activeLayer: 'live' | 'timeline' | 'fallback' | 'none'
  label?: string
}

const NONE: EvaluatorResult = { activeLayer: 'none' }

// Track in-flight DELETE /live calls to avoid spamming the network when a
// fade completes — single firing per fade-completion event.
const _liveFinalizationFired = new Set<string>()

export function _resetEvaluatorState(): void {
  _liveFinalizationFired.clear()
}

export function evaluateLayeredScene(args: EvaluatorArgs): EvaluatorResult {
  // R39: live override wins
  if (args.liveOverride.active) {
    return _evaluateLive(args, args.liveOverride)
  }
  // R40: timeline placement wins over fallback
  const active = _selectActivePlacement(args.placements, args.playheadTime)
  if (active) {
    return _evaluateTimeline(args, active)
  }
  // R41: fallback (transitional)
  if (args.fallbackScene) {
    args.fallbackScene.apply(args.playheadTime, args.states, args.context)
    return { activeLayer: 'fallback', label: args.fallbackScene.label }
  }
  return NONE
}

/**
 * Pick the winning placement among any that overlap the playhead.
 * Highest display_order wins; ties broken by oldest created_at first
 * (deterministic). Linear scan, no allocations.
 */
function _selectActivePlacement(
  placements: readonly PlacementRow[],
  t: number,
): PlacementRow | null {
  let best: PlacementRow | null = null
  for (const p of placements) {
    if (p.start_time > t || t > p.end_time) continue
    if (best === null) {
      best = p
      continue
    }
    if (p.display_order > best.display_order) {
      best = p
    } else if (p.display_order === best.display_order) {
      // Tie-break: oldest first
      if (p.created_at < best.created_at) best = p
    }
  }
  return best
}

/**
 * Parse the SQLite datetime() format ('YYYY-MM-DD HH:MM:SS' UTC) into ms.
 * Date.parse on the bare space-separated form is implementation-defined;
 * canonicalize to ISO 8601 with explicit Z so it parses cross-runtime.
 */
function _parseSqliteTimestamp(ts: string): number {
  return Date.parse(ts.replace(' ', 'T') + 'Z')
}

function _evaluateLive(
  args: EvaluatorArgs,
  override: Extract<LiveOverrideRow, { active: true }>,
): EvaluatorResult {
  const activatedAtMs = _parseSqliteTimestamp(override.activated_at)
  const sceneTime = (args.wallClockMs - activatedAtMs) / 1000

  const resolved = _resolveLiveScene(override, args.scenesById)
  if (!resolved) return NONE
  const merged = resolveParams(resolved.sparseParams, resolved.type)
  const params = resolveBindings(merged, args.context)
  const apply = PRIMITIVE_REGISTRY[resolved.type]
  if (!apply) {
    console.error(`[scene-evaluator] unknown primitive type for live: ${resolved.type}`)
    return NONE
  }
  apply(sceneTime, args.states, params, args.context)

  // Fade-in (R46) — intensity only
  let fadeMul = 1
  if (override.fade_in_sec > 0 && sceneTime < override.fade_in_sec) {
    fadeMul = Math.max(0, sceneTime / override.fade_in_sec)
  }

  // Fade-out (R47)
  if (override.deactivation_started_at) {
    const deactStartMs = _parseSqliteTimestamp(override.deactivation_started_at)
    const sinceDeact = (args.wallClockMs - deactStartMs) / 1000
    const fadeOut = override.fade_out_sec
    if (fadeOut <= 0 || sinceDeact >= fadeOut) {
      // Fade complete — single-fire the row delete; subsequent frames
      // skip until the WS push refreshes liveOverride to {active: false}.
      const key = `${activatedAtMs}-${deactStartMs}`
      if (!_liveFinalizationFired.has(key)) {
        _liveFinalizationFired.add(key)
        void deactivateLive(args.projectName).catch(() => {
          /* swallow — row may already be gone via concurrent action */
        })
      }
      fadeMul = 0
    } else {
      fadeMul *= Math.max(0, 1 - sinceDeact / fadeOut)
    }
  }

  if (fadeMul < 1) {
    for (const s of args.states) s.intensity *= fadeMul
  }

  return { activeLayer: 'live', label: resolved.label ?? override.label }
}

function _evaluateTimeline(
  args: EvaluatorArgs,
  p: PlacementRow,
): EvaluatorResult {
  const scene = args.scenesById.get(p.scene_id)
  if (!scene) {
    console.warn(`[scene-evaluator] placement ${p.id} references unknown scene ${p.scene_id}`)
    return NONE
  }
  const sceneTime = args.playheadTime - p.start_time
  const merged = resolveParams(scene.params, scene.type)
  const params = resolveBindings(merged, args.context)
  const apply = PRIMITIVE_REGISTRY[scene.type]
  if (!apply) {
    console.error(`[scene-evaluator] unknown primitive type: ${scene.type}`)
    return NONE
  }
  apply(sceneTime, args.states, params, args.context)

  // R43 fade-in: in [0, fade_in_sec) intensity *= sceneTime / fade_in
  // R44 fade-out: timeToEnd in [0, fade_out_sec) intensity *= timeToEnd / fade_out
  // R45: when fade-in + fade-out windows overlap (short placement),
  // multiply both factors so the curve still tapers correctly.
  let fadeMul = 1
  if (p.fade_in_sec > 0 && sceneTime < p.fade_in_sec) {
    fadeMul *= Math.max(0, sceneTime / p.fade_in_sec)
  }
  const timeToEnd = p.end_time - args.playheadTime
  if (p.fade_out_sec > 0 && timeToEnd < p.fade_out_sec) {
    fadeMul *= Math.max(0, timeToEnd / p.fade_out_sec)
  }
  if (fadeMul < 1) {
    for (const s of args.states) s.intensity *= fadeMul
  }

  return { activeLayer: 'timeline', label: scene.label }
}

function _resolveLiveScene(
  override: Extract<LiveOverrideRow, { active: true }>,
  scenesById: Map<string, SceneRow>,
): { type: string; sparseParams: Record<string, unknown>; label?: string } | null {
  if (override.scene_id) {
    const lib = scenesById.get(override.scene_id)
    if (!lib) {
      console.warn(`[scene-evaluator] live override references missing scene ${override.scene_id}`)
      return null
    }
    return { type: lib.type, sparseParams: lib.params, label: lib.label }
  }
  if (override.inline_type && override.inline_params) {
    return {
      type: override.inline_type,
      sparseParams: override.inline_params,
      label: override.label,
    }
  }
  console.warn('[scene-evaluator] live override has neither scene_id nor inline fields')
  return null
}

// Internal: exported for tests only.
export const _internal = {
  selectActivePlacement: _selectActivePlacement,
  resolveLiveScene: _resolveLiveScene,
}
