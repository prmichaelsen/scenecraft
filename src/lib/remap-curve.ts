/**
 * Curve point: [x, y] or [x, y, easingType]
 *
 * The easing type on a point controls the interpolation of the segment
 * ARRIVING at that point (i.e. from the previous point to this one).
 * The first point's easing is ignored (no incoming segment).
 *
 * Easing types:
 *   0 = linear (default, backward compatible)
 *   1 = ease-in  (slow start, fast end — cubic-bezier(0.42, 0, 1, 1))
 *   2 = ease-out (fast start, slow end — cubic-bezier(0, 0, 0.58, 1))
 *   3 = ease-in-out (slow start+end — cubic-bezier(0.42, 0, 0.58, 1))
 *   4 = step (holds previous value, jumps at end)
 */

export type CurvePoint = [number, number, number?]

export const EASING_NAMES = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'step'] as const
export const EASING_LABELS = ['—', '⟋', '⟍', '~', '⌐'] as const
export const EASING_COUNT = EASING_NAMES.length

/** Get the easing type for a point (defaults to 0=linear) */
export function getEasing(p: CurvePoint): number {
  return p[2] ?? 0
}

/** Cubic bezier evaluation for a single axis */
function cubicBezier(t: number, p1: number, p2: number): number {
  // Attempt to solve cubic bezier: B(t) = 3(1-t)²t·p1 + 3(1-t)t²·p2 + t³
  // We need to find t for a given x, then evaluate y.
  // For simplicity, use the direct parametric approach since our control points
  // map x->x (we only bend the y mapping).
  const t2 = t * t
  const t3 = t2 * t
  const mt = 1 - t
  const mt2 = mt * mt
  return 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t3
}

/** Apply easing to a linear 0-1 parameter */
function applyEasing(t: number, easingType: number): number {
  switch (easingType) {
    case 1: // ease-in: cubic-bezier(0.42, 0, 1, 1) — approximate with power curve
      return cubicBezier(t, 0, 0)  // t³ feel
    case 2: // ease-out: cubic-bezier(0, 0, 0.58, 1)
      return cubicBezier(t, 1, 1)  // fast start
    case 3: // ease-in-out: cubic-bezier(0.42, 0, 0.58, 1)
      return cubicBezier(t, 0, 1)  // S-curve
    case 4: // step: hold then jump
      return t >= 1 ? 1 : 0
    default: // 0 = linear
      return t
  }
}

/**
 * Evaluate a curve with per-segment easing.
 *
 * Backward compatible: [number, number][] arrays work as before (linear).
 */
export function evaluateCurve(
  curvePoints: CurvePoint[] | undefined,
  linearProgress: number,
): number {
  if (!curvePoints || curvePoints.length < 2) return linearProgress

  const p = Math.max(0, Math.min(1, linearProgress))

  if (p <= curvePoints[0][0]) return curvePoints[0][1]
  if (p >= curvePoints[curvePoints.length - 1][0]) return curvePoints[curvePoints.length - 1][1]

  // Binary search for the segment
  let lo = 0
  let hi = curvePoints.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (curvePoints[mid][0] <= p) lo = mid
    else hi = mid
  }

  const [x0, y0] = curvePoints[lo]
  const [x1, y1] = curvePoints[hi]
  const easing = getEasing(curvePoints[hi]) // easing on the destination point
  const dx = x1 - x0
  if (dx === 0) return y0

  const t = (p - x0) / dx
  const easedT = applyEasing(t, easing)
  return y0 + easedT * (y1 - y0)
}
