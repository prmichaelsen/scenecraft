/**
 * Audio-reactive parameter bindings (M21).
 *
 * A binding is a per-frame mapping from a SceneContext signal to a
 * primitive parameter value. Authoring a scene-as-data, you can write:
 *
 *   color:     { source: beat.toggle, mode: values, values: [[1,0,0],[0,0,1]] }
 *   intensity: { source: master.level, scale: 0.8, offset: 0.2 }
 *
 * — and the evaluator resolves these against the live SceneContext just
 * before invoking the primitive's apply(), so the same primitive
 * (`static_color`, `rotating_head`, …) becomes audio-reactive without a
 * new entry in the registry.
 *
 * Sources are exposed as a flat dotted namespace; resolveBindings walks
 * the params object shallowly and rewrites bound entries to literals.
 * Literals (numbers, arrays, strings) pass through untouched.
 *
 * Modes (extensible — start with these two):
 *   - "linear" (default): out = source * (scale ?? 1) + (offset ?? 0)
 *   - "values":           out = values[ floor(source) mod values.length ]
 *
 * "values" is the discrete picker — `beat.toggle` cycles 0,1,0,1,… so
 * a 2-element values array flips per beat. Generalizes to any beat-step
 * pattern (4-element values + beat.index = bar-stepping).
 */

import type { SceneContext } from './scene-types'

// ── Binding shape + type-guard ────────────────────────────────────────────

export type Binding =
  | { source: string; mode?: 'linear'; scale?: number; offset?: number }
  | { source: string; mode: 'values'; values: unknown[] }

/**
 * Type-guard distinguishing a Binding from a literal param value. We only
 * treat plain objects with a string `source` field as bindings — arrays
 * (color tuples) and primitive values pass through.
 */
export function isBinding(v: unknown): v is Binding {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const src = (v as { source?: unknown }).source
  return typeof src === 'string'
}

// ── Source registry ───────────────────────────────────────────────────────

/**
 * Scalar accessors for every source name. Keep these cheap — invoked
 * per frame per bound param. ``beat.toggle`` is integer-truncated by
 * the values-mode resolver below; emitting beatIndex directly keeps the
 * source itself meaningful (e.g., for linear-mode "fade through the bar").
 *
 * beat.age is +Infinity until the first beat; coerce to 0 there so
 * linear-mode bindings don't blow up.
 */
const SOURCES: Record<string, (ctx: SceneContext) => number> = {
  'master.level':     (c) => c.masterLevel,
  'master.low_level': (c) => c.masterLowLevel,
  'beat.age':         (c) => (c.beatAge === Infinity ? 0 : c.beatAge),
  'beat.intensity':   (c) => c.lastBeatIntensity,
  'beat.index':       (c) => c.beatIndex,
  'beat.toggle':      (c) => c.beatIndex,        // values-mode picks parity
  'playhead.time':    (c) => c.playheadTime,
}

export function listBindingSources(): readonly string[] {
  return Object.keys(SOURCES)
}

// ── Resolution ────────────────────────────────────────────────────────────

/**
 * Evaluate a single binding against the current SceneContext. Returns the
 * binding's resolved value (number for linear mode, anything from the
 * values array for values mode).
 *
 * Unknown sources warn once per call and return 0 — never throws, since
 * a typo in a chat-authored scene shouldn't break the render loop.
 */
export function resolveBinding(b: Binding, ctx: SceneContext): unknown {
  const fn = SOURCES[b.source]
  if (!fn) {
    console.warn(`[bindings] unknown source: ${b.source}`)
    return 0
  }
  const raw = fn(ctx)
  if ('mode' in b && b.mode === 'values') {
    if (!Array.isArray(b.values) || b.values.length === 0) return undefined
    // Wrap negative or non-integer values into the array. Math.floor
    // first so ``beat.toggle`` (integer) and ``master.level`` (continuous)
    // both index sensibly.
    const idx = Math.floor(raw)
    const len = b.values.length
    return b.values[((idx % len) + len) % len]
  }
  // Linear (default).
  const scale = (b as { scale?: number }).scale ?? 1
  const offset = (b as { offset?: number }).offset ?? 0
  return raw * scale + offset
}

/**
 * Walk a params object and resolve any binding values against the
 * SceneContext. Returns a new object — does NOT mutate input. Allocates
 * one object per call; per-frame budget for a typical scene (5-10 keys)
 * is fine for 60fps.
 *
 * Walks one level deep only — bindings nested inside arrays of
 * sub-objects (e.g. composite ``layers``) are resolved recursively when
 * the composite primitive dispatches each sub-layer.
 */
export function resolveBindings(
  params: Record<string, unknown>,
  ctx: SceneContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k in params) {
    const v = params[k]
    out[k] = isBinding(v) ? resolveBinding(v, ctx) : v
  }
  return out
}
