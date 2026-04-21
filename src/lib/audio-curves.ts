/**
 * Client-side twin of `scenecraft.audio.curves` (Python, engine repo).
 *
 * Volume curves are stored as `[[x, dB], ...]`. Clip curves use normalized
 * x ∈ [0, 1]; track curves use absolute seconds. Evaluation is linear
 * interpolation between points, clamping to the nearest endpoint outside
 * the point range — same semantics as `np.interp`.
 *
 * All functions are pure and framework-free so they can be unit-tested
 * without WebAudio.
 */

import type { CurvePoint } from './audio-client'

/** Convert dB → linear gain. 0 dB → 1.0; -6 dB → ≈0.5012; -60 dB → ≈0.001. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

/**
 * Sample a dB curve at a single x. `null`/empty curve returns 0 dB (unity).
 * Clamps to the nearest endpoint's y outside the curve's x range.
 */
export function sampleCurveDb(
  curve: CurvePoint[] | null | undefined,
  xQuery: number,
): number {
  if (!curve || curve.length === 0) return 0
  const sorted = [...curve].sort((a, b) => a[0] - b[0])
  if (xQuery <= sorted[0][0]) return sorted[0][1]
  if (xQuery >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1]
  for (let i = 1; i < sorted.length; i++) {
    const [x1, y1] = sorted[i]
    if (xQuery <= x1) {
      const [x0, y0] = sorted[i - 1]
      const t = (xQuery - x0) / (x1 - x0)
      return y0 + t * (y1 - y0)
    }
  }
  return sorted[sorted.length - 1][1] // unreachable; satisfies TS
}

/** Sample a dB curve and convert to linear gain. */
export function sampleCurveLinear(
  curve: CurvePoint[] | null | undefined,
  xQuery: number,
): number {
  return dbToLinear(sampleCurveDb(curve, xQuery))
}

/**
 * Clip curves are stored with normalized x. Convert an absolute playhead
 * time to the corresponding normalized x for a clip's own curve, then
 * sample dB.
 */
export function sampleClipDbAtPlayhead(
  clip: { start_time: number; end_time: number; volume_curve: CurvePoint[] | null | undefined },
  playheadSeconds: number,
): number {
  const span = Math.max(clip.end_time - clip.start_time, 1e-9)
  const xNorm = (playheadSeconds - clip.start_time) / span
  return sampleCurveDb(clip.volume_curve, xNorm)
}

/** Linear-gain convenience form of sampleClipDbAtPlayhead. */
export function sampleClipLinearAtPlayhead(
  clip: { start_time: number; end_time: number; volume_curve: CurvePoint[] | null | undefined },
  playheadSeconds: number,
): number {
  return dbToLinear(sampleClipDbAtPlayhead(clip, playheadSeconds))
}

/**
 * Track curves are stored with absolute-seconds x. Sample at a playhead
 * time directly.
 */
export function sampleTrackDbAtPlayhead(
  track: { volume_curve: CurvePoint[] | null | undefined },
  playheadSeconds: number,
): number {
  return sampleCurveDb(track.volume_curve, playheadSeconds)
}

/** Linear-gain convenience form of sampleTrackDbAtPlayhead. */
export function sampleTrackLinearAtPlayhead(
  track: { volume_curve: CurvePoint[] | null | undefined },
  playheadSeconds: number,
): number {
  return dbToLinear(sampleTrackDbAtPlayhead(track, playheadSeconds))
}
