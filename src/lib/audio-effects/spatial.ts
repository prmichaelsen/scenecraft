/**
 * M13 task-50: Spatial effect implementations.
 *
 * Implements the two spatial-category effect factories:
 *   - `buildPan`         — `StereoPannerNode` wrapper (animatable: pan ∈ [-1, +1])
 *   - `buildStereoWidth` — mid/side matrix via splitter + gains + merger
 *                          (animatable: width ∈ [0, 2]; 0=mono, 1=identity, 2=doubled side)
 *
 * Both satisfy `EffectNode` so they can be composed into the track chain
 * built by task-47. `setParam` / `scheduleCurve` target the animatable
 * param(s); unknown param names are silently ignored (matches the stub
 * factory pattern established by task-46 so consumers can probe safely).
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md (R8, R9).
 */

import type { CurvePoint } from '../audio-client'
import type { EffectNode } from '../audio-effect-types'

/**
 * Schedule a curve of [x, y] points on an AudioParam using linear ramps.
 *
 * `points` are normalized x ∈ [0, 1]; they are mapped to absolute
 * AudioContext time via `startTime + x * duration`. An initial
 * `setValueAtTime` anchors the value at `startTime`, then each subsequent
 * point becomes a `linearRampToValueAtTime`.
 *
 * Local helper rather than a shared utility — task-48/49/51 can hoist
 * this into `audio-curves.ts` if they want. Keeping it private here
 * avoids landing shared infra that the other task-in-parallel agents
 * might conflict with.
 */
function scheduleLinearCurve(
  param: AudioParam,
  points: CurvePoint[],
  startTime: number,
  duration: number,
): void {
  if (points.length === 0) return
  const sorted = [...points].sort((a, b) => a[0] - b[0])
  // Anchor at t0 with the first point's value.
  param.setValueAtTime(sorted[0][1], startTime)
  for (let i = 1; i < sorted.length; i++) {
    const [x, y] = sorted[i]
    const t = startTime + Math.max(0, Math.min(1, x)) * duration
    param.linearRampToValueAtTime(y, t)
  }
}

/**
 * Pan effect — a direct `StereoPannerNode`.
 *
 * Input and output are the same panner; `pan` is the single animatable
 * param in [-1, +1] (left → right).
 */
export function buildPan(
  ctx: AudioContext,
  _staticParams: Record<string, unknown>,
): EffectNode {
  const panner = ctx.createStereoPanner()

  return {
    input: panner,
    output: panner,
    setParam: (name, value, when) => {
      if (name === 'pan') {
        panner.pan.setValueAtTime(value, when ?? ctx.currentTime)
      }
      // Unknown params silently ignored (see module docstring).
    },
    scheduleCurve: (name, points, startTime, duration) => {
      if (name === 'pan') {
        scheduleLinearCurve(panner.pan, points, startTime, duration)
      }
    },
    dispose: () => {
      try {
        panner.disconnect()
      } catch {
        // Already disconnected — ignore.
      }
    },
  }
}

/**
 * Stereo width effect — classic mid/side processing.
 *
 * Graph:
 *
 *   input ─┬─ splitter ─┬─ L → midSumL  ─┐                          ┌─ midOutL ─┐
 *          │            │                ├─ mid (gain = 0.5) ───────┤           │
 *          │            └─ R → midSumR  ─┘                          └─ midOutR ─┤
 *          │                                                                    ├─ merger → output
 *          │            ┌─ L → sideDiffL ┐                          ┌─ sideL  ──┤
 *          └─ splitter' ┤                 ├─ side (gain = 0.5·W) ───┤(gain=+1) ─┤
 *                       └─ R → sideDiffR ┘                          └─ sideR  ──┘
 *                          (inverted)                                 (gain=-1)
 *
 * Math:
 *   L = 0.5·(mid_in) + (W·0.5)·(L − R)  =  (0.5 + 0.5W)·L + (0.5 − 0.5W)·R
 *   R = 0.5·(mid_in) − (W·0.5)·(L − R)  =  (0.5 − 0.5W)·L + (0.5 + 0.5W)·R
 *
 * Verify width endpoints:
 *   W = 0  → L' = 0.5L + 0.5R, R' = 0.5L + 0.5R  (mono sum, both channels equal)
 *   W = 1  → L' = L, R' = R                      (identity passthrough)
 *   W = 2  → L' = 1.5L − 0.5R, R' = −0.5L + 1.5R (doubled side, extra wide)
 *
 * The single animatable param is `width` ∈ [0, 2] on the `side` gain; `mid`
 * stays at 0.5 permanently (not exposed, not animated).
 *
 * Implementation note: we split the L/R channels with a ChannelSplitter,
 * feed them into two parallel "mid" and "side" paths, then merge back to
 * a stereo ChannelMerger. A ChannelMerger treats input 0 as L and input 1
 * as R, so we route mid+side to L and mid−side to R via per-channel gains.
 */
export function buildStereoWidth(
  ctx: AudioContext,
  _staticParams: Record<string, unknown>,
): EffectNode {
  // Input fans out into both the mid-computation path and the
  // side-computation path. Both need access to L and R independently.
  const inputFan = ctx.createGain()
  inputFan.gain.value = 1

  const splitter = ctx.createChannelSplitter(2)
  inputFan.connect(splitter)

  // --- Mid path: mid = 0.5·(L + R), same scalar to both output channels.
  const midSum = ctx.createGain()
  midSum.gain.value = 0.5
  splitter.connect(midSum, 0) // L
  splitter.connect(midSum, 1) // R
  // midSum now holds a mono signal equal to 0.5·(L+R).

  // --- Side path: side = 0.5·(L − R). `side` is the user-animatable gain,
  // default 1.0 (scale factor on top of the base 0.5·(L−R)).
  // We need (L − R), so run L through +1 and R through −1, sum them, then
  // apply 0.5, then apply the width gain.
  const sideL = ctx.createGain()
  sideL.gain.value = 1
  const sideR = ctx.createGain()
  sideR.gain.value = -1
  splitter.connect(sideL, 0) // L
  splitter.connect(sideR, 1) // R

  const sideBase = ctx.createGain()
  sideBase.gain.value = 0.5
  sideL.connect(sideBase)
  sideR.connect(sideBase)
  // sideBase now holds 0.5·(L−R).

  const sideWidth = ctx.createGain()
  sideWidth.gain.value = 1 // default width = 1 → identity
  sideBase.connect(sideWidth)
  // sideWidth now holds width · 0.5·(L−R).

  // --- Merge back to stereo:
  //   L' = mid + side
  //   R' = mid − side
  const merger = ctx.createChannelMerger(2)

  // Route mid to both L and R.
  midSum.connect(merger, 0, 0) // mid → L
  midSum.connect(merger, 0, 1) // mid → R

  // Route side to L with +1 and to R with −1.
  const sideToL = ctx.createGain()
  sideToL.gain.value = 1
  const sideToR = ctx.createGain()
  sideToR.gain.value = -1
  sideWidth.connect(sideToL)
  sideWidth.connect(sideToR)
  sideToL.connect(merger, 0, 0) // +side → L
  sideToR.connect(merger, 0, 1) // −side → R

  return {
    input: inputFan,
    output: merger,
    setParam: (name, value, when) => {
      if (name === 'width') {
        sideWidth.gain.setValueAtTime(value, when ?? ctx.currentTime)
      }
    },
    scheduleCurve: (name, points, startTime, duration) => {
      if (name === 'width') {
        scheduleLinearCurve(sideWidth.gain, points, startTime, duration)
      }
    },
    dispose: () => {
      // Disconnect every node defensively.
      for (const n of [
        inputFan,
        splitter,
        midSum,
        sideL,
        sideR,
        sideBase,
        sideWidth,
        sideToL,
        sideToR,
        merger,
      ]) {
        try {
          n.disconnect()
        } catch {
          // Already disconnected — ignore.
        }
      }
    },
  }
}
