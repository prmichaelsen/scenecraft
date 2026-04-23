/**
 * M13 task-49: EQ effect builders (peaking band, high-pass, low-pass).
 *
 * All three effects wrap a single {@link BiquadFilterNode} with a different
 * `type`. The EQ band is a peaking filter — its `gain` param is active.
 * Highpass / lowpass filters use `frequency` as the `cutoff` param and `Q`
 * as resonance. Biquad `gain` is ignored for highpass/lowpass.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md R8, R9.
 */

import type { CurvePoint } from '../audio-client'
import type { EffectNode } from '../audio-effect-types'

// ── Internal helpers ────────────────────────────────────────────────────

type ParamMap = Record<string, AudioParam>

function wrapBiquad(
  ctx: AudioContext,
  node: BiquadFilterNode,
  params: ParamMap,
  label: string,
): EffectNode {
  const resolve = (name: string): AudioParam => {
    const p = params[name]
    if (!p) {
      throw new Error(`[${label}] unknown animatable param: ${name}`)
    }
    return p
  }

  return {
    input: node,
    output: node,
    setParam: (name, value, when) => {
      const p = resolve(name)
      p.setValueAtTime(value, when ?? ctx.currentTime)
    },
    scheduleCurve: (name, points, startTime, duration) => {
      const p = resolve(name)
      // TODO(post-merge): use task-48 helper (scheduleCurveOnParam) once it
      // lands. For now, passthrough setValueAtTime per point.
      for (const [x, v] of points as CurvePoint[]) {
        const t = startTime + x * duration
        p.setValueAtTime(v, t)
      }
    },
    dispose: () => {
      try {
        node.disconnect()
      } catch {
        // already disconnected — ignore
      }
    },
  }
}

// ── EQ Band (peaking) ──────────────────────────────────────────────────

/**
 * Build a single EQ band backed by a peaking BiquadFilter.
 *
 * Animatable params: `freq` (Hz, 20..20000), `gain` (dB, -24..24),
 * `q` (0.1..30).
 */
export function buildEQBand(
  ctx: AudioContext,
  _staticParams: Record<string, unknown>,
): EffectNode {
  const node = ctx.createBiquadFilter()
  node.type = 'peaking'
  node.frequency.setValueAtTime(1000, ctx.currentTime)
  node.gain.setValueAtTime(0, ctx.currentTime)
  node.Q.setValueAtTime(1, ctx.currentTime)
  return wrapBiquad(
    ctx,
    node,
    {
      freq: node.frequency,
      gain: node.gain,
      q: node.Q,
    },
    'eq_band',
  )
}

// ── High-pass filter ───────────────────────────────────────────────────

/**
 * Build a high-pass filter backed by a BiquadFilter (type='highpass').
 *
 * Animatable params: `cutoff` (Hz, 20..20000), `q` (0.1..30, resonance).
 */
export function buildHighpass(
  ctx: AudioContext,
  _staticParams: Record<string, unknown>,
): EffectNode {
  const node = ctx.createBiquadFilter()
  node.type = 'highpass'
  node.frequency.setValueAtTime(80, ctx.currentTime)
  node.Q.setValueAtTime(0.707, ctx.currentTime)
  return wrapBiquad(
    ctx,
    node,
    {
      cutoff: node.frequency,
      q: node.Q,
    },
    'highpass',
  )
}

// ── Low-pass filter ────────────────────────────────────────────────────

/**
 * Build a low-pass filter backed by a BiquadFilter (type='lowpass').
 *
 * Animatable params: `cutoff` (Hz, 20..20000), `q` (0.1..30, resonance).
 */
export function buildLowpass(
  ctx: AudioContext,
  _staticParams: Record<string, unknown>,
): EffectNode {
  const node = ctx.createBiquadFilter()
  node.type = 'lowpass'
  node.frequency.setValueAtTime(8000, ctx.currentTime)
  node.Q.setValueAtTime(0.707, ctx.currentTime)
  return wrapBiquad(
    ctx,
    node,
    {
      cutoff: node.frequency,
      q: node.Q,
    },
    'lowpass',
  )
}
