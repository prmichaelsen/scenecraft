/**
 * M13 task-48: Curve → AudioParam scheduling engine.
 *
 * Bridges `effect_curves.points` (normalized 0..1, with time in seconds) and
 * WebAudio's `AudioParam` scheduling API. Handles:
 *
 *   - Initial scheduling (R16): per-interpolation mode, with unit-scale
 *     mapping from normalized [0,1] to each param's native range (R17).
 *   - Seek-aware rescheduling (R18): cancels pending schedules and
 *     reschedules only points at/after the seek position, using evaluated
 *     seek-position value as the first anchor.
 *   - Interpolation modes (R19):
 *       bezier → dense Float32Array via BezierSampler, scheduled with
 *                `setValueCurveAtTime`.
 *       linear → `setValueAtTime(first) + linearRampToValueAtTime(each)`.
 *       step   → `setValueAtTime` per point only (no ramps).
 *
 * This module is framework-free and works with any `AudioParam`-like object
 * (real WebAudio or a mock with the standard method surface), so tests can
 * exercise it with plain spy functions.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md (R16-R19).
 */

import type { EffectParamSpec, ParamScale } from './audio-effect-types'

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * A single control point in an `effect_curves` row. `time` is absolute
 * project-time in seconds; `value` is normalized to [0, 1].
 *
 * Note: this intentionally differs from `./audio-client`'s `CurvePoint`
 * tuple `[x, dB]` — that type is for volume curves (dB-valued), while
 * effect curves are normalized and object-shaped per spec R2.
 */
export interface CurvePoint {
  time: number
  value: number
}

/** Shape matching `EffectCurve` from spec R2. Only the fields we need. */
export interface EffectCurveLite {
  points: CurvePoint[]
  interpolation: 'bezier' | 'linear' | 'step'
}

/**
 * Minimal AudioParam surface we depend on. Accepts real `AudioParam` or
 * any mock that exposes the same method set (e.g. test spies).
 *
 * Methods are typed as function-typed properties (rather than method
 * signatures) with loose return types so `vi.fn()` spies satisfy the
 * structural type without needing awkward overload cloning in tests.
 */
export interface AudioParamLike {
  setValueAtTime: (value: number, startTime: number) => unknown
  linearRampToValueAtTime: (value: number, endTime: number) => unknown
  setValueCurveAtTime: (
    values: Float32Array,
    startTime: number,
    duration: number,
  ) => unknown
  cancelScheduledValues: (cancelTime: number) => unknown
}

/** Subset of `AudioContext` we need — just `currentTime`. */
export interface AudioContextLike {
  readonly currentTime: number
}

/** One (param, curve, spec) triple for batch scheduling. */
export interface ScheduleTarget {
  param: AudioParamLike
  curve: EffectCurveLite
  spec: EffectParamSpec
}

// ----------------------------------------------------------------------------
// Unit mappers
// ----------------------------------------------------------------------------

/**
 * Clamp x to [0, 1]. Values outside this range are treated as defects at
 * the data layer (spec R6 clamps on write) but we defensively clamp here
 * too — AudioParam throws if we schedule a value outside its native range.
 */
function clamp01(x: number): number {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/**
 * Map a normalized [0, 1] value to its native unit per the given scale.
 *
 *   linear → `min + n · (max - min)`
 *   log    → `min · (max / min) ^ n`  (assumes min > 0)
 *   db     → `min + n · (max - min)`  (dB is already perceived logarithmically;
 *                                      UI maps linearly in dB space)
 *   hz     → `min · (max / min) ^ n`  (Hz is perceived logarithmically)
 *
 * Spec R17.
 */
export function normalizedToNative(
  n: number,
  scale: ParamScale,
  range: { min: number; max: number },
): number {
  const c = clamp01(n)
  switch (scale) {
    case 'linear':
    case 'db':
      return range.min + c * (range.max - range.min)
    case 'log':
    case 'hz': {
      // log / hz both use geometric interpolation in normalized space.
      // Guards against non-positive `min` (which would make the ratio
      // undefined): fall back to linear if the range is invalid.
      if (range.min <= 0 || range.max <= 0) {
        return range.min + c * (range.max - range.min)
      }
      return range.min * Math.pow(range.max / range.min, c)
    }
  }
}

// ----------------------------------------------------------------------------
// Curve evaluation (used by BezierSampler + seek anchoring)
// ----------------------------------------------------------------------------

/**
 * Sort `points` by time, ascending. Returns a new array; does not mutate.
 */
function sortedPoints(points: CurvePoint[]): CurvePoint[] {
  return [...points].sort((a, b) => a.time - b.time)
}

/**
 * Sample a curve's value at time `t` using the specified interpolation mode.
 * Outside the curve's time range, clamps to the nearest endpoint.
 * Returns 0 for empty curves.
 */
export function sampleCurveAt(
  points: CurvePoint[],
  interpolation: 'bezier' | 'linear' | 'step',
  t: number,
): number {
  if (points.length === 0) return 0
  const sorted = sortedPoints(points)
  if (sorted.length === 1) return sorted[0].value
  if (t <= sorted[0].time) return sorted[0].value
  const last = sorted[sorted.length - 1]
  if (t >= last.time) return last.value

  // Find bracketing indices i-1 ... i where sorted[i-1].time <= t < sorted[i].time.
  let i = 1
  for (; i < sorted.length; i++) {
    if (t < sorted[i].time) break
  }
  const p0 = sorted[i - 1]
  const p1 = sorted[i]

  if (interpolation === 'step') {
    return p0.value
  }

  const span = p1.time - p0.time || 1e-9
  const u = (t - p0.time) / span

  if (interpolation === 'linear') {
    return p0.value + u * (p1.value - p0.value)
  }

  // Bezier: use a Catmull-Rom-ish ease (smoothstep) between adjacent points.
  // A real cubic Bezier would need explicit control points; spec leaves the
  // exact shape to implementation as long as it's smooth and passes through
  // every keyframe. Smoothstep `3u² - 2u³` gives C¹-continuous easing with
  // zero-slope at each keyframe, which matches the typical "curve" feel.
  const smooth = u * u * (3 - 2 * u)
  return p0.value + smooth * (p1.value - p0.value)
}

// ----------------------------------------------------------------------------
// Bezier dense sampling
// ----------------------------------------------------------------------------

/**
 * Produces a densely-sampled `Float32Array` from a bezier-interpolated
 * `CurvePoint[]`. The output is native-unit values (post unit-mapping) in
 * evenly-spaced time bins covering `[startTime, startTime + duration]`.
 *
 * `setValueCurveAtTime` requires at least 2 samples.
 */
export class BezierSampler {
  /** Default curve sample rate (samples per second). 100 Hz is plenty for
   * knob automation smoothness. Independent of the audio sample rate. */
  static readonly DEFAULT_SAMPLE_RATE = 100

  /**
   * @param points      Sorted or unsorted CurvePoints (normalized values).
   * @param startTime   Absolute project-time of the first output sample.
   * @param duration    Duration (seconds) covered by the output samples.
   * @param spec        Param spec — used to map normalized → native.
   * @param sampleRate  Curve sample rate (Hz). Defaults to 100.
   */
  static sample(
    points: CurvePoint[],
    startTime: number,
    duration: number,
    spec: EffectParamSpec,
    sampleRate: number = BezierSampler.DEFAULT_SAMPLE_RATE,
  ): Float32Array {
    const n = Math.max(2, Math.ceil(duration * sampleRate))
    const out = new Float32Array(n)
    if (points.length === 0) {
      return out
    }
    const sorted = sortedPoints(points)
    for (let i = 0; i < n; i++) {
      const t = startTime + (duration * i) / (n - 1)
      const normalized = sampleCurveAt(sorted, 'bezier', t)
      out[i] = normalizedToNative(normalized, spec.scale, spec.range)
    }
    return out
  }
}

// ----------------------------------------------------------------------------
// Scheduling
// ----------------------------------------------------------------------------

/**
 * Schedule `curve` on `audioParam`, starting at `startTime` (AudioContext
 * time, not project time) and covering `duration` seconds. Normalized point
 * values are converted to native units before scheduling.
 *
 * Cancels any pre-existing schedule on the param first (R16).
 *
 * For bezier curves, `startTime` + `duration` define the time window of the
 * dense Float32Array. For linear/step, each point's `time` is treated as
 * project-time offset from the curve's first point, then added to
 * `startTime` in AudioContext space. If a caller wants project-time ==
 * audio-context-time (common when scheduling from t=0), pass
 * `startTime = audioCtx.currentTime + point.time` semantics handled here.
 *
 * Semantics: points are stored with `time` in absolute project seconds. The
 * `startTime` param is the AudioContext time corresponding to the curve's
 * virtual t=0. A point with `time = 2.5` on a curve scheduled at
 * `startTime = audioCtx.currentTime` will fire at
 * `audioCtx.currentTime + 2.5`.
 */
export function scheduleCurve(
  audioParam: AudioParamLike,
  curve: EffectCurveLite,
  spec: EffectParamSpec,
  startTime: number,
  duration: number,
): void {
  audioParam.cancelScheduledValues(0)
  const points = sortedPoints(curve.points)
  if (points.length === 0) return

  if (curve.interpolation === 'bezier') {
    const arr = BezierSampler.sample(points, 0, duration, spec)
    // setValueCurveAtTime requires duration > 0 and array length >= 2.
    if (duration > 0 && arr.length >= 2) {
      audioParam.setValueCurveAtTime(arr, startTime, duration)
    } else {
      // Degenerate: fall back to a single setValueAtTime with the first
      // point's native value so the param still gets its correct value.
      const v = normalizedToNative(points[0].value, spec.scale, spec.range)
      audioParam.setValueAtTime(v, startTime)
    }
    return
  }

  if (curve.interpolation === 'step') {
    for (const p of points) {
      const v = normalizedToNative(p.value, spec.scale, spec.range)
      audioParam.setValueAtTime(v, startTime + p.time)
    }
    return
  }

  // Linear: anchor with setValueAtTime at the first point, then
  // linearRampToValueAtTime for each subsequent point.
  const first = points[0]
  const firstV = normalizedToNative(first.value, spec.scale, spec.range)
  audioParam.setValueAtTime(firstV, startTime + first.time)
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const v = normalizedToNative(p.value, spec.scale, spec.range)
    audioParam.linearRampToValueAtTime(v, startTime + p.time)
  }
}

/**
 * Reschedule `curve` on `audioParam` starting from `seekTime` (project
 * seconds). Drops all points with `time < seekTime`. Anchors the schedule
 * at the curve's evaluated value at `seekTime` so there's no wrong-value
 * glitch (R18).
 *
 * `seekTime` is project-time; `audioCtx.currentTime` is the AudioContext
 * anchor we schedule from. Point times are converted to AudioContext time
 * via: `audioCtx.currentTime + (point.time - seekTime)`.
 */
export function rescheduleFromSeek(
  audioParam: AudioParamLike,
  curve: EffectCurveLite,
  spec: EffectParamSpec,
  seekTime: number,
  audioCtx: AudioContextLike,
): void {
  audioParam.cancelScheduledValues(0)
  const sorted = sortedPoints(curve.points)
  if (sorted.length === 0) return

  // Points at or after the seek position — these are the only ones we
  // schedule. Earlier points are implicit in the anchor value.
  const future = sorted.filter((p) => p.time >= seekTime)

  // Anchor value at the seek position itself, evaluated via the curve's
  // interpolation mode — this prevents the initial ramp from wrong-value.
  const anchorValueNorm = sampleCurveAt(sorted, curve.interpolation, seekTime)
  const anchorValueNative = normalizedToNative(anchorValueNorm, spec.scale, spec.range)

  const ctxStart = audioCtx.currentTime
  audioParam.setValueAtTime(anchorValueNative, ctxStart)

  if (future.length === 0) {
    // No future points — anchor is all we need.
    return
  }

  if (curve.interpolation === 'bezier') {
    // Build a dense array from seekTime to the last future point.
    const last = future[future.length - 1]
    const duration = Math.max(last.time - seekTime, 0)
    if (duration > 0) {
      // Sample from absolute seekTime → last.time (project space), then
      // schedule anchored at ctxStart.
      const n = Math.max(2, Math.ceil(duration * BezierSampler.DEFAULT_SAMPLE_RATE))
      const arr = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const tProject = seekTime + (duration * i) / (n - 1)
        const norm = sampleCurveAt(sorted, 'bezier', tProject)
        arr[i] = normalizedToNative(norm, spec.scale, spec.range)
      }
      audioParam.setValueCurveAtTime(arr, ctxStart, duration)
    }
    return
  }

  if (curve.interpolation === 'step') {
    for (const p of future) {
      if (p.time === seekTime) continue // anchor covers this already
      const v = normalizedToNative(p.value, spec.scale, spec.range)
      audioParam.setValueAtTime(v, ctxStart + (p.time - seekTime))
    }
    return
  }

  // Linear: anchor is already set; ramp to each future point.
  for (const p of future) {
    if (p.time === seekTime) continue
    const v = normalizedToNative(p.value, spec.scale, spec.range)
    audioParam.linearRampToValueAtTime(v, ctxStart + (p.time - seekTime))
  }
}

/**
 * Convenience: schedule a batch of (param, curve, spec) triples all at the
 * same startTime + duration. Equivalent to calling `scheduleCurve` for each
 * entry; kept as a named helper so callers (audio-mixer build path) can
 * signal intent and so we have a single place to add optimizations later.
 */
export function scheduleCurveBatch(
  targets: ScheduleTarget[],
  startTime: number,
  duration: number,
): void {
  for (const t of targets) {
    scheduleCurve(t.param, t.curve, t.spec, startTime, duration)
  }
}
