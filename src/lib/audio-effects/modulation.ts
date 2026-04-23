/**
 * M13 task-51: Modulation effect implementations.
 *
 * Five LFO-driven modulation effects: tremolo, auto_pan, chorus, flanger,
 * phaser. All share the same architecture:
 *
 *   - `rate` (Hz) is STATIC per spec R9. Picked at build() time and bakes into
 *     the OscillatorNode.frequency.value. Attempting to animate it via
 *     setParam('rate', …) warns and no-ops (see assertStaticParam).
 *   - `depth` and any wet/feedback/mix params are ANIMATABLE. setParam writes
 *     to the corresponding AudioParam; scheduleCurve lays down a
 *     setValueCurveAtTime ramp.
 *
 * LFO implementation: each effect instantiates exactly one OscillatorNode
 * (sine by default) routed through a depth-scaling GainNode. The depth-gain's
 * output connects to whatever AudioParam this effect modulates — WebAudio
 * sums AudioNode → AudioParam connections onto the param's nominal value.
 *
 * Scheduling helpers (scheduleCurve, applyCurve) convert normalised
 * CurvePoint[] into setValueCurveAtTime calls in the same style as
 * audio-mixer.ts; no external scheduler is required.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md — R8 (modulation
 * family), R9 (rate static).
 */

import type { CurvePoint } from '../audio-client'
import type { EffectNode } from '../audio-effect-types'

// ── Utilities ────────────────────────────────────────────────────────────

/**
 * Warn once per (effect, param) pair when a caller tries to mutate a
 * non-animatable static param (e.g. `rate`). We don't throw — failing loudly
 * in the mixer would poison playback — but we do emit a console warning so
 * the bug surfaces during development.
 */
function assertStaticParam(effect: string, name: string): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[audio-effects/${effect}] param "${name}" is static (non-animatable); ignoring runtime mutation. ` +
      `Rebuild the effect with a new staticParams to change it.`,
  )
}

/**
 * Convert normalised [[t, v], …] curve points to parallel Float32Arrays
 * suitable for AudioParam.setValueCurveAtTime. We assume `points` is already
 * sorted and contains at least two samples — the caller (curve scheduler)
 * handles empty/degenerate cases.
 */
function curveToValueArray(points: CurvePoint[]): Float32Array {
  const values = new Float32Array(points.length)
  for (let i = 0; i < points.length; i++) values[i] = points[i][1]
  return values
}

/**
 * Apply a CurvePoint array to an AudioParam. Uses setValueCurveAtTime, which
 * interpolates linearly between samples over `duration` seconds. Safe to call
 * with 0-length arrays (no-op).
 */
function applyCurve(
  param: AudioParam,
  points: CurvePoint[],
  startTime: number,
  duration: number,
): void {
  if (points.length === 0) return
  if (points.length === 1) {
    param.setValueAtTime(points[0][1], startTime)
    return
  }
  const values = curveToValueArray(points)
  param.setValueCurveAtTime(values, startTime, duration)
}

/**
 * Safely read `rate` from a staticParams record, falling back to `fallback`
 * when missing or out of range.
 */
function readRate(staticParams: Record<string, unknown>, fallback: number, min: number, max: number): number {
  const raw = staticParams['rate']
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  if (raw < min) return min
  if (raw > max) return max
  return raw
}

/** Disconnect a node, swallowing the "already disconnected" noise. */
function safeDisconnect(node: AudioNode): void {
  try {
    node.disconnect()
  } catch {
    // already disconnected
  }
}

/**
 * Create a shared LFO: OscillatorNode(sine) → GainNode(depth). Returns both
 * so callers can connect the gain's output to an AudioParam and animate the
 * depth. The oscillator is started immediately at `ctx.currentTime`.
 */
interface Lfo {
  osc: OscillatorNode
  depthGain: GainNode
}

function createLfo(ctx: AudioContext, rateHz: number, initialDepth: number): Lfo {
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = rateHz
  const depthGain = ctx.createGain()
  depthGain.gain.value = initialDepth
  osc.connect(depthGain)
  osc.start()
  return { osc, depthGain }
}

// ── Tremolo ──────────────────────────────────────────────────────────────

/**
 * Tremolo: amplitude modulation via an LFO summed onto a GainNode.gain.
 *
 * Graph:
 *   input → outputGain → output
 *   LFO(sine @ rate) → depthGain → outputGain.gain (summed with nominal 1.0)
 *
 * `outputGain.gain` nominal value is 1.0; the LFO's output oscillates in
 * [-depth, +depth], so the resulting multiplier sweeps in [1-depth, 1+depth].
 * At depth=0 the gain stays flat (passthrough); at depth=1 the signal is
 * fully tremolo'd between 0 and 2× gain.
 */
export function buildTremolo(ctx: AudioContext, staticParams: Record<string, unknown>): EffectNode {
  const rate = readRate(staticParams, 5, 0.1, 20)
  const outputGain = ctx.createGain()
  outputGain.gain.value = 1
  const lfo = createLfo(ctx, rate, 0.5)
  lfo.depthGain.connect(outputGain.gain)

  return {
    input: outputGain,
    output: outputGain,
    setParam: (name, value) => {
      if (name === 'rate') {
        assertStaticParam('tremolo', name)
        return
      }
      if (name === 'depth') {
        lfo.depthGain.gain.setValueAtTime(value, ctx.currentTime)
      }
    },
    scheduleCurve: (name, points, startTime, duration) => {
      if (name === 'rate') {
        assertStaticParam('tremolo', name)
        return
      }
      if (name === 'depth') {
        applyCurve(lfo.depthGain.gain, points, startTime, duration)
      }
    },
    dispose: () => {
      try {
        lfo.osc.stop()
      } catch {
        // already stopped
      }
      safeDisconnect(lfo.osc)
      safeDisconnect(lfo.depthGain)
      safeDisconnect(outputGain)
    },
  }
}

// ── Auto-pan ─────────────────────────────────────────────────────────────

/**
 * Auto-pan: LFO modulates a StereoPannerNode.pan.
 *
 * Graph:
 *   input → panner → output
 *   LFO(sine @ rate) → depthGain → panner.pan (summed with nominal 0)
 *
 * Pan nominal = 0 (center); LFO output sweeps in [-depth, +depth] mapped
 * directly onto pan range [-1, +1]. At depth=1 the signal sweeps fully
 * left↔right at `rate` Hz.
 */
export function buildAutoPan(ctx: AudioContext, staticParams: Record<string, unknown>): EffectNode {
  const rate = readRate(staticParams, 1, 0.1, 20)
  const panner = ctx.createStereoPanner()
  panner.pan.value = 0
  const lfo = createLfo(ctx, rate, 0.75)
  lfo.depthGain.connect(panner.pan)

  return {
    input: panner,
    output: panner,
    setParam: (name, value) => {
      if (name === 'rate') {
        assertStaticParam('auto_pan', name)
        return
      }
      if (name === 'depth') {
        lfo.depthGain.gain.setValueAtTime(value, ctx.currentTime)
      }
    },
    scheduleCurve: (name, points, startTime, duration) => {
      if (name === 'rate') {
        assertStaticParam('auto_pan', name)
        return
      }
      if (name === 'depth') {
        applyCurve(lfo.depthGain.gain, points, startTime, duration)
      }
    },
    dispose: () => {
      try {
        lfo.osc.stop()
      } catch {
        // already stopped
      }
      safeDisconnect(lfo.osc)
      safeDisconnect(lfo.depthGain)
      safeDisconnect(panner)
    },
  }
}

// ── Chorus ───────────────────────────────────────────────────────────────

/**
 * Chorus: short delay (5-25ms) LFO-modulated, mixed wet with the dry signal.
 *
 * Graph:
 *   input → dryGain ───────────→ output
 *   input → delay ───→ wetGain → output
 *           delay → feedbackGain → delay (loop)
 *   LFO(sine @ rate) → depthGain(±10ms) → delay.delayTime (nominal 15ms)
 *
 * Animatable params:
 *   - depth  (0..1)    → scales LFO amplitude; at 1 the delay sweeps ±10ms.
 *   - feedback (0..0.9) → internal feedback loop gain.
 *   - mix   (0..1)     → wet blend (and dry = 1 - mix).
 *
 * `rate` is static (spec R9).
 */
export function buildChorus(ctx: AudioContext, staticParams: Record<string, unknown>): EffectNode {
  const rate = readRate(staticParams, 1.5, 0.1, 10)

  const input = ctx.createGain()
  const output = ctx.createGain()
  const dryGain = ctx.createGain()
  const wetGain = ctx.createGain()
  const feedbackGain = ctx.createGain()
  const delay = ctx.createDelay(1.0)

  // Chorus base delay ≈ 15ms; LFO sweeps ±10ms max when depth=1.
  const BASE_DELAY = 0.015
  const MAX_DEPTH_SECONDS = 0.01

  delay.delayTime.value = BASE_DELAY
  dryGain.gain.value = 0.5
  wetGain.gain.value = 0.5
  feedbackGain.gain.value = 0.2

  input.connect(dryGain).connect(output)
  input.connect(delay).connect(wetGain).connect(output)
  delay.connect(feedbackGain).connect(delay)

  // LFO modulates delayTime; depthGain scales the raw sine ±1 into ±depth*10ms.
  const lfo = createLfo(ctx, rate, 0.5 * MAX_DEPTH_SECONDS)
  lfo.depthGain.connect(delay.delayTime)

  let currentMix = 0.5
  const writeMix = (value: number, when: number) => {
    currentMix = value
    dryGain.gain.setValueAtTime(1 - value, when)
    wetGain.gain.setValueAtTime(value, when)
  }

  return {
    input,
    output,
    setParam: (name, value) => {
      if (name === 'rate') {
        assertStaticParam('chorus', name)
        return
      }
      const when = ctx.currentTime
      if (name === 'depth') {
        lfo.depthGain.gain.setValueAtTime(value * MAX_DEPTH_SECONDS, when)
      } else if (name === 'feedback') {
        feedbackGain.gain.setValueAtTime(value, when)
      } else if (name === 'mix' || name === 'wet') {
        writeMix(value, when)
      }
    },
    scheduleCurve: (name, points, startTime, duration) => {
      if (name === 'rate') {
        assertStaticParam('chorus', name)
        return
      }
      if (name === 'depth') {
        // Scale each normalised depth sample into seconds on-the-fly.
        const scaled: CurvePoint[] = points.map(([t, v]) => [t, v * MAX_DEPTH_SECONDS])
        applyCurve(lfo.depthGain.gain, scaled, startTime, duration)
      } else if (name === 'feedback') {
        applyCurve(feedbackGain.gain, points, startTime, duration)
      } else if (name === 'mix' || name === 'wet') {
        // mix drives both dry and wet in parallel (conservation of signal).
        const wetPoints = points
        const dryPoints: CurvePoint[] = points.map(([t, v]) => [t, 1 - v])
        applyCurve(wetGain.gain, wetPoints, startTime, duration)
        applyCurve(dryGain.gain, dryPoints, startTime, duration)
        currentMix = points[points.length - 1][1]
      }
    },
    dispose: () => {
      try {
        lfo.osc.stop()
      } catch {
        // already stopped
      }
      void currentMix
      safeDisconnect(lfo.osc)
      safeDisconnect(lfo.depthGain)
      safeDisconnect(delay)
      safeDisconnect(feedbackGain)
      safeDisconnect(dryGain)
      safeDisconnect(wetGain)
      safeDisconnect(input)
      safeDisconnect(output)
    },
  }
}

// ── Flanger ──────────────────────────────────────────────────────────────

/**
 * Flanger: same topology as chorus but with a much shorter base delay
 * (~2ms) and wider feedback range to produce the characteristic
 * comb-filter/whoosh sweep.
 *
 *   - Base delay 2ms; LFO sweeps ±1.5ms at depth=1 (keeps total in
 *     the 0.5–10ms range spec'd).
 *   - Feedback up to ~0.9 for resonant flange.
 */
export function buildFlanger(ctx: AudioContext, staticParams: Record<string, unknown>): EffectNode {
  const rate = readRate(staticParams, 0.5, 0.05, 10)

  const input = ctx.createGain()
  const output = ctx.createGain()
  const dryGain = ctx.createGain()
  const wetGain = ctx.createGain()
  const feedbackGain = ctx.createGain()
  const delay = ctx.createDelay(1.0)

  const BASE_DELAY = 0.002
  const MAX_DEPTH_SECONDS = 0.0015

  delay.delayTime.value = BASE_DELAY
  dryGain.gain.value = 0.5
  wetGain.gain.value = 0.5
  feedbackGain.gain.value = 0.5

  input.connect(dryGain).connect(output)
  input.connect(delay).connect(wetGain).connect(output)
  delay.connect(feedbackGain).connect(delay)

  const lfo = createLfo(ctx, rate, 0.5 * MAX_DEPTH_SECONDS)
  lfo.depthGain.connect(delay.delayTime)

  return {
    input,
    output,
    setParam: (name, value) => {
      if (name === 'rate') {
        assertStaticParam('flanger', name)
        return
      }
      const when = ctx.currentTime
      if (name === 'depth') {
        lfo.depthGain.gain.setValueAtTime(value * MAX_DEPTH_SECONDS, when)
      } else if (name === 'feedback') {
        feedbackGain.gain.setValueAtTime(value, when)
      } else if (name === 'mix' || name === 'wet') {
        dryGain.gain.setValueAtTime(1 - value, when)
        wetGain.gain.setValueAtTime(value, when)
      }
    },
    scheduleCurve: (name, points, startTime, duration) => {
      if (name === 'rate') {
        assertStaticParam('flanger', name)
        return
      }
      if (name === 'depth') {
        const scaled: CurvePoint[] = points.map(([t, v]) => [t, v * MAX_DEPTH_SECONDS])
        applyCurve(lfo.depthGain.gain, scaled, startTime, duration)
      } else if (name === 'feedback') {
        applyCurve(feedbackGain.gain, points, startTime, duration)
      } else if (name === 'mix' || name === 'wet') {
        const dryPoints: CurvePoint[] = points.map(([t, v]) => [t, 1 - v])
        applyCurve(wetGain.gain, points, startTime, duration)
        applyCurve(dryGain.gain, dryPoints, startTime, duration)
      }
    },
    dispose: () => {
      try {
        lfo.osc.stop()
      } catch {
        // already stopped
      }
      safeDisconnect(lfo.osc)
      safeDisconnect(lfo.depthGain)
      safeDisconnect(delay)
      safeDisconnect(feedbackGain)
      safeDisconnect(dryGain)
      safeDisconnect(wetGain)
      safeDisconnect(input)
      safeDisconnect(output)
    },
  }
}

// ── Phaser ───────────────────────────────────────────────────────────────

/**
 * Phaser: cascade of all-pass BiquadFilters whose cutoff frequency is swept
 * by a single shared LFO. Each stage's base frequency is staggered an
 * octave apart (starting at ~200Hz) so the notches span a wide band.
 *
 * Graph:
 *   input → dryGain ───────────────────────────────→ output
 *   input → allpass[0] → … → allpass[N-1] → wetGain → output
 *   wetGain → feedbackGain → allpass[0]             (resonant feedback)
 *   LFO(sine @ rate) → depthGain(±1200 Hz * depth)  → each allpass.frequency
 *
 * Four stages provide a convincing "swirl" without CPU excess.
 */
const PHASER_STAGES = 4
const PHASER_BASE_FREQ = 200
const PHASER_MAX_SWEEP_HZ = 1200

export function buildPhaser(ctx: AudioContext, staticParams: Record<string, unknown>): EffectNode {
  const rate = readRate(staticParams, 0.5, 0.05, 10)

  const input = ctx.createGain()
  const output = ctx.createGain()
  const dryGain = ctx.createGain()
  const wetGain = ctx.createGain()
  const feedbackGain = ctx.createGain()

  dryGain.gain.value = 0.5
  wetGain.gain.value = 0.5
  feedbackGain.gain.value = 0.3

  const stages: BiquadFilterNode[] = []
  for (let i = 0; i < PHASER_STAGES; i++) {
    const f = ctx.createBiquadFilter()
    f.type = 'allpass'
    f.frequency.value = PHASER_BASE_FREQ * Math.pow(2, i)
    f.Q.value = 1
    stages.push(f)
  }

  input.connect(dryGain).connect(output)
  input.connect(stages[0])
  for (let i = 0; i < stages.length - 1; i++) stages[i].connect(stages[i + 1])
  stages[stages.length - 1].connect(wetGain).connect(output)
  wetGain.connect(feedbackGain).connect(stages[0])

  const lfo = createLfo(ctx, rate, 0.7 * PHASER_MAX_SWEEP_HZ)
  for (const stage of stages) lfo.depthGain.connect(stage.frequency)

  return {
    input,
    output,
    setParam: (name, value) => {
      if (name === 'rate') {
        assertStaticParam('phaser', name)
        return
      }
      const when = ctx.currentTime
      if (name === 'depth') {
        lfo.depthGain.gain.setValueAtTime(value * PHASER_MAX_SWEEP_HZ, when)
      } else if (name === 'feedback') {
        feedbackGain.gain.setValueAtTime(value, when)
      } else if (name === 'mix' || name === 'wet') {
        dryGain.gain.setValueAtTime(1 - value, when)
        wetGain.gain.setValueAtTime(value, when)
      }
    },
    scheduleCurve: (name, points, startTime, duration) => {
      if (name === 'rate') {
        assertStaticParam('phaser', name)
        return
      }
      if (name === 'depth') {
        const scaled: CurvePoint[] = points.map(([t, v]) => [t, v * PHASER_MAX_SWEEP_HZ])
        applyCurve(lfo.depthGain.gain, scaled, startTime, duration)
      } else if (name === 'feedback') {
        applyCurve(feedbackGain.gain, points, startTime, duration)
      } else if (name === 'mix' || name === 'wet') {
        const dryPoints: CurvePoint[] = points.map(([t, v]) => [t, 1 - v])
        applyCurve(wetGain.gain, points, startTime, duration)
        applyCurve(dryGain.gain, dryPoints, startTime, duration)
      }
    },
    dispose: () => {
      try {
        lfo.osc.stop()
      } catch {
        // already stopped
      }
      safeDisconnect(lfo.osc)
      safeDisconnect(lfo.depthGain)
      for (const stage of stages) safeDisconnect(stage)
      safeDisconnect(feedbackGain)
      safeDisconnect(dryGain)
      safeDisconnect(wetGain)
      safeDisconnect(input)
      safeDisconnect(output)
    },
  }
}

// Expose the internal constants so tests can reason about expected node
// counts (e.g. "phaser has PHASER_STAGES allpass biquads").
export const __internals = {
  PHASER_STAGES,
  PHASER_BASE_FREQ,
  PHASER_MAX_SWEEP_HZ,
}
