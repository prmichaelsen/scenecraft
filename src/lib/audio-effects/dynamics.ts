/**
 * M13 task-49: Dynamics effect builders (compressor, gate, limiter).
 *
 * Each builder returns an {@link EffectNode} that wraps a native WebAudio
 * {@link DynamicsCompressorNode}. The three effects share the same underlying
 * node type but differ in default parameters and the set of user-animatable
 * params exposed through `setParam`.
 *
 * Gate strategy (v1 MVP):
 *   WebAudio has no first-class gate. We approximate a gate as a compressor
 *   with a very high ratio (20:1) and a zero knee, so signals below the
 *   threshold are pushed down hard. This is NOT a true gate (it attenuates
 *   rather than fully muting), but it is the cheapest approximation that
 *   avoids a ScriptProcessor / AudioWorklet hop for v1. A future task can
 *   swap in an AudioWorklet-based hard gate; the EffectNode shape will not
 *   change. See task-49 notes.
 *
 * Limiter strategy:
 *   DynamicsCompressorNode with ratio clamped to its max (20:1), fastest
 *   attack the node accepts, and a short release (50 ms default). The
 *   `threshold` param acts as the ceiling.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md R8, R9.
 */

import type { CurvePoint } from '../audio-client'
import type { EffectNode } from '../audio-effect-types'

// ── Internal helpers ────────────────────────────────────────────────────

type ParamMap = Record<string, AudioParam>

function wrapDynamicsNode(
  ctx: AudioContext,
  node: DynamicsCompressorNode,
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

// ── Compressor ─────────────────────────────────────────────────────────

/**
 * Build a compressor effect backed by a DynamicsCompressorNode.
 *
 * Animatable params: `threshold` (dB, -100..0), `ratio` (1..20),
 * `attack` (s, 0.001..1), `release` (s, 0.001..1), `knee` (dB, 0..40).
 */
export function buildCompressor(
  ctx: AudioContext,
  _staticParams: Record<string, unknown>,
): EffectNode {
  const node = ctx.createDynamicsCompressor()
  // Reasonable default compression curve (overridden by setParam after build).
  node.threshold.setValueAtTime(-24, ctx.currentTime)
  node.ratio.setValueAtTime(4, ctx.currentTime)
  node.attack.setValueAtTime(0.003, ctx.currentTime)
  node.release.setValueAtTime(0.25, ctx.currentTime)
  node.knee.setValueAtTime(30, ctx.currentTime)
  return wrapDynamicsNode(
    ctx,
    node,
    {
      threshold: node.threshold,
      ratio: node.ratio,
      attack: node.attack,
      release: node.release,
      knee: node.knee,
    },
    'compressor',
  )
}

// ── Gate ───────────────────────────────────────────────────────────────

/**
 * Build a noise-gate effect as a high-ratio compressor approximation. v1
 * MVP strategy documented at the top of this file.
 *
 * Animatable params: `threshold` (dB), `attack` (s), `release` (s).
 */
export function buildGate(
  ctx: AudioContext,
  _staticParams: Record<string, unknown>,
): EffectNode {
  const node = ctx.createDynamicsCompressor()
  // Gate-ish defaults: push down anything below threshold hard.
  node.threshold.setValueAtTime(-40, ctx.currentTime)
  node.ratio.setValueAtTime(20, ctx.currentTime)
  node.attack.setValueAtTime(0.005, ctx.currentTime)
  node.release.setValueAtTime(0.1, ctx.currentTime)
  node.knee.setValueAtTime(0, ctx.currentTime)
  return wrapDynamicsNode(
    ctx,
    node,
    {
      threshold: node.threshold,
      attack: node.attack,
      release: node.release,
    },
    'gate',
  )
}

// ── Limiter ────────────────────────────────────────────────────────────

/**
 * Build a limiter effect — a DynamicsCompressor pinned to ratio >= 20 with
 * the fastest attack the browser allows. The `ceiling` param maps to the
 * underlying DynamicsCompressor `threshold` AudioParam (since the node only
 * exposes a threshold, and a limiter's threshold IS its ceiling).
 *
 * Animatable params: `ceiling` (dB, ceiling — maps to threshold),
 * `release` (s).
 */
export function buildLimiter(
  ctx: AudioContext,
  _staticParams: Record<string, unknown>,
): EffectNode {
  const node = ctx.createDynamicsCompressor()
  node.threshold.setValueAtTime(-0.3, ctx.currentTime)
  node.ratio.setValueAtTime(20, ctx.currentTime)
  // Fastest attack the node accepts. DynamicsCompressorNode requires > 0.
  node.attack.setValueAtTime(0.001, ctx.currentTime)
  node.release.setValueAtTime(0.05, ctx.currentTime)
  node.knee.setValueAtTime(0, ctx.currentTime)
  return wrapDynamicsNode(
    ctx,
    node,
    {
      // Registry spec names this `ceiling`; the native node exposes
      // `threshold`. They are the same concept for a limiter.
      ceiling: node.threshold,
      release: node.release,
    },
    'limiter',
  )
}
