/**
 * Shared helpers for the WebAudio mixer graph (M15).
 *
 * Both the live mixer (`audio-mixer.ts`) and the offline renderer
 * (`mix-render.ts`) build the same topology:
 *
 *     source → clipGain → crossfadeGain → trackGain → masterGain → dest
 *
 * The only differences between the two paths are (a) analyser taps (live only,
 * for UI level meters) and (b) activation / deactivation bookkeeping (live
 * only, since offline schedules everything up-front). Beyond that, the curve
 * scheduling math, the crossfade curves, and the db-to-linear conversions must
 * be identical — any drift between live and offline is exactly the "bit-
 * identical parity" failure mode M15 is meant to prevent.
 *
 * This module is typed on `BaseAudioContext` so it composes with both
 * `AudioContext` and `OfflineAudioContext`. All factory methods used here
 * (`createGain`, `createBufferSource`, `createChannelSplitter`, `createAnalyser`)
 * live on `BaseAudioContext`.
 */

import type { AudioClip, AudioTrack, CurvePoint } from './audio-client'
import { dbToLinear, sampleClipDbAtPlayhead, sampleTrackDbAtPlayhead } from './audio-curves'
import { EFFECT_TYPES, type EffectNode } from './audio-effect-types'
import type { TrackEffect } from './audio-graph'

// ── Shared constants ──────────────────────────────────────────────────────

export const CROSSFADE_CURVE_LEN = 128

/** Precomputed cos(t·π/2) for 0 ≤ t ≤ 1 — equal-power fade-out side. */
export const COS_CURVE = (() => {
  const arr = new Float32Array(CROSSFADE_CURVE_LEN)
  for (let i = 0; i < CROSSFADE_CURVE_LEN; i++) {
    const t = i / (CROSSFADE_CURVE_LEN - 1)
    arr[i] = Math.cos((t * Math.PI) / 2)
  }
  return arr
})()

/** Precomputed sin(t·π/2) — equal-power fade-in side. */
export const SIN_CURVE = (() => {
  const arr = new Float32Array(CROSSFADE_CURVE_LEN)
  for (let i = 0; i < CROSSFADE_CURVE_LEN; i++) {
    const t = i / (CROSSFADE_CURVE_LEN - 1)
    arr[i] = Math.sin((t * Math.PI) / 2)
  }
  return arr
})()

export const sortedCurvePoints = (curve: CurvePoint[] | null | undefined): CurvePoint[] => {
  if (!curve || curve.length === 0) return []
  return [...curve].sort((a, b) => a[0] - b[0])
}

// ── Solo / mute semantics ─────────────────────────────────────────────────

/**
 * A track is effectively muted if it's explicitly muted, OR if any track in
 * the project is solo'd and this track isn't one of them. Shared between live
 * + offline so the two paths can never disagree on which tracks contribute.
 */
export function isTrackEffectivelyMuted(track: AudioTrack, allTracks: readonly AudioTrack[]): boolean {
  if (track.muted) return true
  const anySolo = allTracks.some((t) => t.solo)
  if (anySolo && !track.solo) return true
  return false
}

// ── Clip-curve scheduling ─────────────────────────────────────────────────

/**
 * Schedule a clip's volume_curve against the given AudioParam, starting at
 * `paramAnchorTime` (the AudioContext clock time that corresponds to
 * `playhead` on the timeline). Points earlier than `playhead` are skipped;
 * points past `end_time` are ignored.
 *
 * `paramAnchorTime` is `ctx.currentTime` in live playback and
 * `max(0, clip.start_time - renderStart)` in offline rendering (since the
 * offline clock starts at 0 corresponding to `renderStart` on the timeline).
 */
export function scheduleClipCurveOnParam(
  param: AudioParam,
  clip: AudioClip,
  playhead: number,
  paramAnchorTime: number,
): void {
  param.cancelScheduledValues(paramAnchorTime)

  if (clip.muted) {
    param.setValueAtTime(0, paramAnchorTime)
    return
  }

  const anchorDb = sampleClipDbAtPlayhead(clip, playhead)
  param.setValueAtTime(dbToLinear(anchorDb), paramAnchorTime)

  const { start_time, end_time } = clip
  const span = Math.max(end_time - start_time, 1e-9)
  const pts = sortedCurvePoints(clip.volume_curve)
  for (const [xNorm, db] of pts) {
    const xSec = start_time + xNorm * span
    if (xSec <= playhead) continue
    if (xSec > end_time) break
    const dtCtx = xSec - playhead
    param.linearRampToValueAtTime(dbToLinear(db), paramAnchorTime + dtCtx)
  }
}

/**
 * Schedule a track's volume_curve (points are in absolute seconds) against
 * the given AudioParam. `paramAnchorTime` semantics match
 * `scheduleClipCurveOnParam`.
 *
 * Offline rendering should pass `effectiveMuted = isTrackEffectivelyMuted(...)`
 * and `paramAnchorTime = 0` (the offline clock starts at 0 corresponding to
 * the render start). Live passes `ctx.currentTime`.
 */
export function scheduleTrackCurveOnParam(
  param: AudioParam,
  track: AudioTrack,
  playhead: number,
  paramAnchorTime: number,
  effectiveMuted: boolean,
): void {
  param.cancelScheduledValues(paramAnchorTime)

  if (effectiveMuted) {
    param.setValueAtTime(0, paramAnchorTime)
    return
  }

  const anchorDb = sampleTrackDbAtPlayhead(track, playhead)
  param.setValueAtTime(dbToLinear(anchorDb), paramAnchorTime)

  const pts = sortedCurvePoints(track.volume_curve)
  for (const [xSec, db] of pts) {
    if (xSec <= playhead) continue
    const dtCtx = xSec - playhead
    param.linearRampToValueAtTime(dbToLinear(db), paramAnchorTime + dtCtx)
  }
}

// ── Crossfade scheduling ──────────────────────────────────────────────────

/**
 * Schedule equal-power crossfade curves on two overlapping clips' crossfade
 * gains. `paramAnchorTime` is the AudioContext clock value corresponding to
 * `playhead` on the timeline — in live playback that's `ctx.currentTime`; in
 * offline render it's 0 (offline starts at 0 → `renderStart`).
 *
 * No-op when overlap is empty.
 */
export function scheduleCrossfadeOnParams(
  incumbentParam: AudioParam,
  newcomerParam: AudioParam,
  incumbent: AudioClip,
  newcomer: AudioClip,
  playhead: number,
  paramAnchorTime: number,
): void {
  const overlapStart = Math.max(incumbent.start_time, newcomer.start_time)
  const overlapEnd = Math.min(incumbent.end_time, newcomer.end_time)
  const duration = Math.max(0, overlapEnd - overlapStart)
  if (duration <= 0) return
  const fadeStartCtx = paramAnchorTime + Math.max(0, overlapStart - playhead)
  incumbentParam.cancelScheduledValues(paramAnchorTime)
  newcomerParam.cancelScheduledValues(paramAnchorTime)
  incumbentParam.setValueCurveAtTime(COS_CURVE, fadeStartCtx, duration)
  newcomerParam.setValueCurveAtTime(SIN_CURVE, fadeStartCtx, duration)
}

// ── Effect-chain builder (shared by live mixer + offline renderer) ────────

/**
 * Handle for a serial effect chain (used for the master bus in both live and
 * offline paths). The chain's `input` is where the upstream signal connects;
 * the chain's `output` drives the downstream node(s).
 */
export interface EffectChainHandle {
  /** Upstream attach point — always present, even when the chain is empty. */
  readonly input: AudioNode
  /** Downstream attach point — always present, even when the chain is empty. */
  readonly output: AudioNode
  /** The individual effect nodes in order. Empty for empty chains. */
  readonly effects: readonly EffectNode[]
  /** Tear down every internal node (effects + passthrough). Safe to call once. */
  dispose(): void
}

/**
 * Build a serial effect chain for the master bus.
 *
 *     input → effect_1 → effect_2 → … → effect_N → output
 *
 * When `effects` is empty we return a single passthrough GainNode as both
 * `input` and `output`, so callers never need to special-case the empty case.
 *
 * Effects are sorted by `order_index` before wiring. Unknown `effect_type`s
 * are skipped with a console warning (matches `buildTrackChain`'s behavior in
 * audio-graph.ts).
 *
 * Disabled effects (`enabled === false`) are currently included in the chain
 * — the master-bus MVP doesn't expose a bypass toggle. If the agent needs
 * per-effect enable/disable on the master bus later, route these through the
 * same `BypassManager` that audio-graph.ts uses.
 *
 * Typed on `BaseAudioContext` so the same builder works for live playback
 * (AudioContext) and offline rendering (OfflineAudioContext). The
 * `EFFECT_TYPES[type].build()` factories are typed with `AudioContext` but
 * only call methods that also exist on `BaseAudioContext` (createGain,
 * createBiquadFilter, createDynamicsCompressor, createOscillator,
 * createStereoPanner, createChannelSplitter, createChannelMerger,
 * createWaveShaper, createDelay, currentTime). We cast at the call site to
 * satisfy the factory signature without a deeper type refactor.
 */
export function buildEffectChain(
  ctx: BaseAudioContext,
  effects: readonly TrackEffect[],
): EffectChainHandle {
  // Always create head/tail passthroughs so `input` and `output` are stable
  // references the caller can wire once, regardless of chain length or
  // future mutations.
  const inputNode = ctx.createGain()
  inputNode.gain.value = 1
  const outputNode = ctx.createGain()
  outputNode.gain.value = 1

  const sorted = [...effects].sort((a, b) => a.order_index - b.order_index)
  const built: EffectNode[] = []
  for (const row of sorted) {
    const spec = EFFECT_TYPES[row.effect_type]
    if (!spec) {
      if (typeof console !== 'undefined') {
        console.warn(`[mix-graph] unknown effect_type=${row.effect_type} in chain`)
      }
      continue
    }
    // Factories accept AudioContext; all methods they call also live on
    // BaseAudioContext (see docstring). Cast is safe at runtime.
    const node = spec.build(ctx as AudioContext, row.static_params)
    built.push(node)
  }

  // Wire in series: inputNode → fx[0] → fx[1] → ... → fx[N-1] → outputNode.
  let cursor: AudioNode = inputNode
  for (const ef of built) {
    cursor.connect(ef.input)
    cursor = ef.output
  }
  cursor.connect(outputNode)

  let disposed = false

  return {
    input: inputNode,
    output: outputNode,
    effects: built,
    dispose() {
      if (disposed) return
      disposed = true
      // Tear down from tail to head so we never sever a live connection
      // that a downstream disposer still expects to iterate.
      try { outputNode.disconnect() } catch { /* ignore */ }
      for (let i = built.length - 1; i >= 0; i--) {
        try { built[i].dispose() } catch { /* ignore */ }
      }
      try { inputNode.disconnect() } catch { /* ignore */ }
    },
  }
}
