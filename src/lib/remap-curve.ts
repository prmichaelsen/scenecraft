/**
 * Evaluate a piecewise-linear time remap curve.
 *
 * Given a linear progress value (0-1 representing timeline position),
 * returns the video progress (0-1 representing which frame to show).
 *
 * Points are [timelineProgress, videoProgress] pairs, sorted by X.
 * Must start at [0,0] and end at [1,1].
 *
 * A steep slope = fast playback. A shallow slope = slow-mo.
 */
export function evaluateCurve(
  curvePoints: [number, number][] | undefined,
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
  const dx = x1 - x0
  if (dx === 0) return y0

  const t = (p - x0) / dx
  return y0 + t * (y1 - y0)
}
