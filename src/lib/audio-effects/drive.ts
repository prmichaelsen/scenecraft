/**
 * M13 task-51: Drive / saturation effect.
 *
 * One `buildDrive(ctx, staticParams)` factory produces a WaveShaper-based
 * saturation node with a character-selectable curve. `character` is static
 * per spec R9 — changing it requires rebuilding the effect. `amount` and
 * `mix` (wet) are animatable.
 *
 * Routing:
 *
 *   input → preGain(amount) → waveShaper(curve) → wetGain → output
 *   input → dryGain(1-mix) ──────────────────────→ output
 *
 * The WaveShaper curve is precomputed once per (character, curve-length)
 * tuple and cached at module scope — drive curves are deterministic so
 * there's no reason to regenerate them per instance.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md — R8 distortion
 * family.
 */

import type { CurvePoint } from '../audio-client'
import type { EffectNode } from '../audio-effect-types'

/**
 * Supported saturation voicings. Each maps to a distinct waveshaper curve
 * produced by `makeCurve()`. Kept as a string union so the registry can
 * stringify `staticParams.character` and type-narrow.
 */
export type DriveCharacter = 'tape' | 'tube' | 'transistor' | 'fuzz'

const CURVE_SAMPLES = 1024

// ── Curve builders ───────────────────────────────────────────────────────

function buildTapeCurve(): Float32Array {
  // Gentle tanh soft-saturation; knee ~0.7. "Tape"-like: smooth musical
  // compression of peaks, no abrupt clipping.
  const curve = new Float32Array(CURVE_SAMPLES)
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const x = (i / (CURVE_SAMPLES - 1)) * 2 - 1
    curve[i] = Math.tanh(1.5 * x)
  }
  return curve
}

function buildTubeCurve(): Float32Array {
  // Asymmetric saturation — positive half compresses harder than negative,
  // producing even-harmonic bias characteristic of single-ended tube amps.
  const curve = new Float32Array(CURVE_SAMPLES)
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const x = (i / (CURVE_SAMPLES - 1)) * 2 - 1
    curve[i] = x >= 0 ? Math.tanh(2 * x) : Math.tanh(0.8 * x)
  }
  return curve
}

function buildTransistorCurve(): Float32Array {
  // Harder clipping — cubic soft-clip that transitions to a flat ceiling
  // around ±0.75. Represents solid-state overdrive (tighter, more aggressive).
  const curve = new Float32Array(CURVE_SAMPLES)
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const x = (i / (CURVE_SAMPLES - 1)) * 2 - 1
    const scaled = x * 2
    let y: number
    if (scaled >= 1) y = 1
    else if (scaled <= -1) y = -1
    else y = scaled - (scaled * scaled * scaled) / 3
    curve[i] = y
  }
  return curve
}

function buildFuzzCurve(): Float32Array {
  // Near-square wave via high-gain sign-preserving clip. The `k` term drives
  // the knee sharpness — at 12 the output is nearly a rail-to-rail square
  // with a narrow transition band.
  const curve = new Float32Array(CURVE_SAMPLES)
  const k = 12
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const x = (i / (CURVE_SAMPLES - 1)) * 2 - 1
    // Sigmoidal fuzz: y = ((1+k)·x) / (1 + k·|x|)
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x))
  }
  return curve
}

// Cache curves at module load so every drive instance shares the same
// Float32Arrays (no per-instance allocation; shared GPU-side upload on nodes
// that support it).
const CURVE_CACHE: Record<DriveCharacter, Float32Array> = {
  tape: buildTapeCurve(),
  tube: buildTubeCurve(),
  transistor: buildTransistorCurve(),
  fuzz: buildFuzzCurve(),
}

/** Publicly exposed curve accessor — used by tests and debugging tooling. */
export function getDriveCurve(character: DriveCharacter): Float32Array {
  return CURVE_CACHE[character]
}

// ── Utilities ────────────────────────────────────────────────────────────

function assertStaticParam(name: string): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[audio-effects/drive] param "${name}" is static (non-animatable); ignoring runtime mutation. ` +
      `Rebuild the effect with a new staticParams to change it.`,
  )
}

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
  const values = new Float32Array(points.length)
  for (let i = 0; i < points.length; i++) values[i] = points[i][1]
  param.setValueCurveAtTime(values, startTime, duration)
}

function safeDisconnect(node: AudioNode): void {
  try {
    node.disconnect()
  } catch {
    // already disconnected
  }
}

function resolveCharacter(staticParams: Record<string, unknown>): DriveCharacter {
  const raw = staticParams['character']
  if (typeof raw === 'string' && raw in CURVE_CACHE) return raw as DriveCharacter
  // Registry stores `character` as a numeric index (0..4); translate.
  if (typeof raw === 'number') {
    const ordered: DriveCharacter[] = ['tape', 'tube', 'transistor', 'fuzz']
    const idx = Math.round(raw)
    if (idx >= 0 && idx < ordered.length) return ordered[idx]
  }
  return 'tape'
}

// ── Builder ──────────────────────────────────────────────────────────────

/**
 * Build a WaveShaper-based drive/saturation effect.
 *
 *   - `amount` (0..1) scales the pre-gain: at 0 the signal enters the shaper
 *     at unity (minimal harmonic distortion); at 1 it's pre-amped by ~10×
 *     so the tanh/clip curve bites hard.
 *   - `mix` (a.k.a. `wet`) crossfades dry ↔ shaped paths in parallel.
 *   - `character` is baked at build() time via WaveShaperNode.curve.
 */
export function buildDrive(ctx: AudioContext, staticParams: Record<string, unknown>): EffectNode {
  const character = resolveCharacter(staticParams)

  const input = ctx.createGain()
  const output = ctx.createGain()
  const preGain = ctx.createGain()
  const shaper = ctx.createWaveShaper()
  const wetGain = ctx.createGain()
  const dryGain = ctx.createGain()

  // WaveShaperNode.curve typing demands a Float32Array backed by an
  // ArrayBuffer (not SharedArrayBuffer). Our cached curves use the default
  // ArrayBuffer at runtime; cast through `unknown` to silence TS's
  // over-cautious generic narrowing.
  shaper.curve = CURVE_CACHE[character] as unknown as Float32Array<ArrayBuffer>
  shaper.oversample = '2x'

  // Pre-gain scale: map [0..1] amount → [1..10] pre-amp multiplier.
  // At amount=0 we still pass unity gain so "dry" mix=0 is truly clean.
  preGain.gain.value = 1 + 0.3 * 9 // matches registry default `amount=0.3`
  dryGain.gain.value = 0 // registry default mix=1.0 → fully wet
  wetGain.gain.value = 1

  input.connect(preGain).connect(shaper).connect(wetGain).connect(output)
  input.connect(dryGain).connect(output)

  const amountToPreGain = (amount: number) => 1 + amount * 9

  return {
    input,
    output,
    setParam: (name, value) => {
      if (name === 'character') {
        assertStaticParam(name)
        return
      }
      const when = ctx.currentTime
      if (name === 'amount') {
        preGain.gain.setValueAtTime(amountToPreGain(value), when)
      } else if (name === 'mix' || name === 'wet') {
        wetGain.gain.setValueAtTime(value, when)
        dryGain.gain.setValueAtTime(1 - value, when)
      }
      // `tone` is a stub — tonal shaping would require an additional
      // biquad; left for a follow-up refinement. We silently accept the
      // value without mutating the graph.
    },
    scheduleCurve: (name, points, startTime, duration) => {
      if (name === 'character') {
        assertStaticParam(name)
        return
      }
      if (name === 'amount') {
        const scaled: CurvePoint[] = points.map(([t, v]) => [t, amountToPreGain(v)])
        applyCurve(preGain.gain, scaled, startTime, duration)
      } else if (name === 'mix' || name === 'wet') {
        const dryPoints: CurvePoint[] = points.map(([t, v]) => [t, 1 - v])
        applyCurve(wetGain.gain, points, startTime, duration)
        applyCurve(dryGain.gain, dryPoints, startTime, duration)
      }
    },
    dispose: () => {
      safeDisconnect(input)
      safeDisconnect(preGain)
      safeDisconnect(shaper)
      safeDisconnect(wetGain)
      safeDisconnect(dryGain)
      safeDisconnect(output)
    },
  }
}
