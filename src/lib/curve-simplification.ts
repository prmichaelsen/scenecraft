/**
 * M13 task-55: Curve simplification for touch-record commits.
 *
 * Pure, framework-free reducer that collapses a densely-sampled raw buffer
 * of `[time, value]` samples into a minimal set of keyframes whose linear
 * interpolation stays within `tolerance` of the original buffer.
 *
 * Algorithm: Douglas-Peucker.
 *
 *   The spec (R24) allows either Schneider's bezier-fitting (more optimal,
 *   harder) or Douglas-Peucker on (t, v) pairs with linear-interpolation
 *   error (less optimal, easier). We pick Douglas-Peucker for v1 — the
 *   output curves are then stored with `interpolation: 'bezier'` and the
 *   curve-scheduler's BezierSampler smooths them at schedule time, so the
 *   user-visible result is still smooth even though the control-point set
 *   was reduced via a linear error metric.
 *
 * The implementation intentionally preserves the FIRST and LAST samples
 * (endpoints) so the committed curve's duration matches the gesture's
 * `[gesture_start_t, gesture_end_t]` exactly — required by R24 for the
 * "replace points in range" merge semantics.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md — R24.
 */

import type { CurvePoint } from './curve-scheduler'

/** Raw sample tuple captured during a gesture: `[timeSeconds, normalizedValue]`. */
export type RawSample = readonly [time: number, value: number]

/**
 * Simplify a raw sample buffer to a minimal set of `CurvePoint`s whose
 * linear interpolation approximates the originals within `tolerance`.
 *
 * `tolerance` is in normalized-value units (e.g. `0.02` = 2% of knob range).
 * The time axis is NOT used in the error metric — only the deviation of the
 * interpolated `value` from each raw `value` at its own `time` matters.
 *
 * Input MUST be in ascending `time` order. Non-monotonic time is not
 * handled — the caller (the touch-record hook) guarantees monotonic
 * samples via `audioCtx.currentTime` (strictly increases during a gesture).
 *
 * - Empty input returns `[]`
 * - Single-sample input returns one point
 * - Two-sample input returns both endpoints (no simplification possible)
 * - Larger inputs are reduced recursively; endpoints are always kept
 */
export function simplifyCurve(
  samples: readonly RawSample[],
  tolerance: number,
): CurvePoint[] {
  if (samples.length === 0) return []
  if (samples.length === 1) {
    const [t, v] = samples[0]
    return [{ time: t, value: v }]
  }
  if (samples.length === 2) {
    return samples.map(([t, v]) => ({ time: t, value: v }))
  }

  // Douglas-Peucker in the (t, value) plane, using *value-axis* perpendicular
  // distance. This is simpler and more appropriate than euclidean distance
  // because `time` and `value` have different units/scales; we only want to
  // bound value-error.
  const keep = new Uint8Array(samples.length)
  keep[0] = 1
  keep[samples.length - 1] = 1
  reduce(samples, 0, samples.length - 1, tolerance, keep)

  const out: CurvePoint[] = []
  for (let i = 0; i < samples.length; i++) {
    if (keep[i]) {
      const [t, v] = samples[i]
      out.push({ time: t, value: v })
    }
  }
  return out
}

/**
 * Recursive DP step. For the span `[lo, hi]` inclusive, find the sample
 * whose *value* deviates furthest from the linear interpolation between
 * `samples[lo]` and `samples[hi]` at its own `time`. If that deviation
 * exceeds `tolerance`, keep it and recurse on both halves; otherwise the
 * whole span collapses to just the two endpoints.
 */
function reduce(
  samples: readonly RawSample[],
  lo: number,
  hi: number,
  tolerance: number,
  keep: Uint8Array,
): void {
  if (hi - lo < 2) return

  const [t0, v0] = samples[lo]
  const [t1, v1] = samples[hi]
  const dt = t1 - t0

  let maxIdx = -1
  let maxErr = 0

  for (let i = lo + 1; i < hi; i++) {
    const [ti, vi] = samples[i]
    // Linear interpolation between endpoints at `ti`.
    const interpolated = dt === 0 ? v0 : v0 + ((ti - t0) / dt) * (v1 - v0)
    const err = Math.abs(vi - interpolated)
    if (err > maxErr) {
      maxErr = err
      maxIdx = i
    }
  }

  if (maxIdx >= 0 && maxErr > tolerance) {
    keep[maxIdx] = 1
    reduce(samples, lo, maxIdx, tolerance, keep)
    reduce(samples, maxIdx, hi, tolerance, keep)
  }
}
