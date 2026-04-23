/**
 * M13 task-55: Touch-record state machine hook.
 *
 * Wires a `MacroKnob` into the live-recording pipeline:
 *   - Maintains the per-knob arm state (idle / armed / recording)
 *   - During an active gesture while playback is playing + knob armed,
 *     samples at ~33Hz via rAF, writes samples to a ref-stored buffer
 *     (not React state — one re-render per frame would be too heavy)
 *   - Feeds live-audible values back into the AudioParam via
 *     `setTargetAtTime` so the user hears their gesture
 *   - On commit (mouseup / playback stop / unmount / effect disable / undo):
 *     simplifies the buffer, merges it into the curve's existing points
 *     over the gesture's time range, POSTs the new points to the server
 *     (which is one undo unit), and returns the knob to `armed` state.
 *   - When playback is NOT playing, a gesture direct-edits the curve at the
 *     playhead (single-point update) per R26 — no recording transition.
 *
 * R29a: if `requestUndo()` is called while in `recording`, the in-flight
 * gesture commits first, THEN the host's `postUndo` runs. Knob stays armed.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md — R20-R27, R29a.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  sampleCurveAt,
  type AudioContextLike,
  type AudioParamLike,
  type CurvePoint,
} from '@/lib/curve-scheduler'
import { simplifyCurve, type RawSample } from '@/lib/curve-simplification'

/** `AudioParamLike` + the one method the touch-record path adds on top:
 *  `setTargetAtTime` for live audible feedback during a drag (R21). */
export interface AudioParamLiveLike extends AudioParamLike {
  setTargetAtTime: (target: number, startTime: number, timeConstant: number) => unknown
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ArmState = 'idle' | 'armed' | 'recording'

export interface TouchRecordCommitPayload {
  effectId: string
  paramName: string
  /** Merged final points after simplification (replaces curve). */
  points: CurvePoint[]
  /** [gestureStart_t, gestureEnd_t] in project-time seconds. */
  gestureRange: readonly [number, number]
  /** Interpolation mode the committed curve uses. Default `bezier`. */
  interpolation: 'bezier' | 'linear' | 'step'
}

export interface TouchRecordDeps {
  /** Stable id: `${effect_id}.${param_name}`. Only used for logs / tests. */
  effectId: string
  paramName: string
  /** Param spec range + scale-aware native-unit mapping is done upstream;
   * the hook feeds *native* values into `param.setTargetAtTime`. */
  paramNativeValue: (normalised: number) => number
  /** Live WebAudio param for setTargetAtTime feedback (optional — hook is
   * a no-op on live-feedback if null; state machine still works). */
  param: AudioParamLiveLike | null
  /** Live AudioContext — `currentTime` is the authoritative recording clock. */
  audioCtx: AudioContextLike | null
  /** Current project-time (playhead) in seconds. Used for direct-edit
   * commits while paused and for gesture timestamp anchoring when playing. */
  getPlayheadSeconds: () => number
  /** Transport state — true iff global playback is currently playing. */
  isPlaying: () => boolean
  /** Existing curve state for this (effect, param) — may be empty.
   * The hook reads this snapshot on gesture start; callers SHOULD refresh
   * between gestures (e.g. after a commit). */
  getExistingCurve: () => { points: CurvePoint[]; interpolation: 'bezier' | 'linear' | 'step' } | null
  /** Whether the owning effect is currently enabled. The hook watches this
   * via `setEnabled`; disabling mid-record triggers a commit per R15/R20. */
  isEffectEnabled: () => boolean
  /** Called on each commit — host persists the curve + pushes an undo unit. */
  onCommit: (payload: TouchRecordCommitPayload) => void
  /** Called by the host's Ctrl+Z handler to undo the most recent commit.
   * The hook takes no action itself; it only ensures any in-flight gesture
   * is committed first (R29a). */
  postUndo: () => void
  /** Low-level rAF hooks — overridable for tests (see `mockRaf`). */
  raf?: (cb: FrameRequestCallback) => number
  cancelRaf?: (handle: number) => void
  /** `performance.now`-like clock for rAF throttling. Overridable for tests. */
  now?: () => number
}

export interface TouchRecordApi {
  state: ArmState
  /** Toggle between `idle` and `armed`. No-op while `recording`. */
  toggleArm: () => void
  /** Programmatically set arm state (host uses for "disarm all" bulk action). */
  setArmState: (s: ArmState) => void
  /** Pointer-down on the knob. Starts the gesture. */
  onGestureStart: () => void
  /** Pointer-move / drag-value-change on the knob. */
  onGestureChange: (normalised: number) => void
  /** Pointer-up on the knob. Ends the gesture. */
  onGestureEnd: () => void
  /** Host's Ctrl+Z arrives here — commits mid-record gesture first, then
   *  invokes `postUndo`. Safe to call even when not recording. */
  requestUndo: () => void
  /** Test helper: read the current raw sample count. Undocumented for prod. */
  _debugSampleCount: () => number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target rAF sampling interval in ms. 33 Hz ≈ 30.3ms. */
const SAMPLE_INTERVAL_MS = 30

/** Simplification tolerance: 2% of knob range per R24. */
const SIMPLIFY_TOLERANCE = 0.02

/** Time-constant for the setTargetAtTime live-audible feedback (R23 note). */
const LIVE_FEEDBACK_TIME_CONSTANT = 0.01

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTouchRecord(deps: TouchRecordDeps): TouchRecordApi {
  const [state, setState] = useState<ArmState>('idle')

  // Gesture buffer + metadata. Ref-stored so rAF writes don't trigger
  // re-renders (~33 per second would be wasteful).
  const bufferRef = useRef<RawSample[]>([])
  const gestureRef = useRef<{
    startProjectT: number | null
    startAudioCtxT: number | null
    lastNormalised: number
    latestNormalised: number
  }>({
    startProjectT: null,
    startAudioCtxT: null,
    lastNormalised: 0,
    latestNormalised: 0,
  })

  // rAF handle + throttle tracking.
  const rafHandleRef = useRef<number | null>(null)
  const lastSampleAtRef = useRef<number>(0)

  // Track deps in refs so rAF closure always sees latest values.
  const depsRef = useRef(deps)
  depsRef.current = deps

  const stateRef = useRef<ArmState>('idle')
  stateRef.current = state

  // ------------------------------------------------------------------
  // Commit pipeline — shared by mouseup, playback-stop, unmount, undo,
  // effect-disable. Idempotent: safe to call when not recording (no-op).
  // ------------------------------------------------------------------
  const commitIfRecording = useCallback((): boolean => {
    if (stateRef.current !== 'recording') return false
    const d = depsRef.current
    const buf = bufferRef.current
    const g = gestureRef.current

    // Append a final sample at the current gesture end so commits include
    // the very last user intent even if the last rAF hasn't fired yet.
    if (buf.length === 0 || buf[buf.length - 1][1] !== g.latestNormalised) {
      if (d.audioCtx && g.startAudioCtxT !== null && d.isPlaying()) {
        const t = g.startProjectT! + (d.audioCtx.currentTime - g.startAudioCtxT)
        buf.push([t, g.latestNormalised])
      }
    }

    const simplified = simplifyCurve(buf, SIMPLIFY_TOLERANCE)
    const existing = d.getExistingCurve()
    const existingPoints = existing?.points ?? []
    const interpolation = existing?.interpolation ?? 'bezier'

    // Replace-in-range (R24 Option A): strip existing points that fall
    // inside [gestureStart, gestureEnd], then merge simplified in and sort.
    const gStart = g.startProjectT ?? (simplified[0]?.time ?? 0)
    const gEnd =
      simplified.length > 0
        ? simplified[simplified.length - 1].time
        : gStart
    const kept = existingPoints.filter(
      (p) => p.time < gStart || p.time > gEnd,
    )
    const merged = [...kept, ...simplified].sort((a, b) => a.time - b.time)

    d.onCommit({
      effectId: d.effectId,
      paramName: d.paramName,
      points: merged,
      gestureRange: [gStart, gEnd],
      interpolation,
    })

    // Reset gesture state, return to armed.
    bufferRef.current = []
    gestureRef.current = {
      startProjectT: null,
      startAudioCtxT: null,
      lastNormalised: g.latestNormalised,
      latestNormalised: g.latestNormalised,
    }
    stopSampling()
    setState('armed')
    stateRef.current = 'armed'
    return true
  }, [])

  // ------------------------------------------------------------------
  // rAF sampling loop. Runs while `state === 'recording'`; pushes the
  // current knob value to the buffer at ≥30Hz.
  // ------------------------------------------------------------------
  const tickSampling = useCallback(() => {
    if (stateRef.current !== 'recording') {
      rafHandleRef.current = null
      return
    }
    const d = depsRef.current
    const now = d.now ? d.now() : performance.now()
    const elapsed = now - lastSampleAtRef.current
    if (elapsed >= SAMPLE_INTERVAL_MS) {
      const g = gestureRef.current
      if (d.audioCtx && g.startAudioCtxT !== null && g.startProjectT !== null) {
        const projectT = g.startProjectT + (d.audioCtx.currentTime - g.startAudioCtxT)
        bufferRef.current.push([projectT, g.latestNormalised])
      }
      lastSampleAtRef.current = now
    }
    const raf = d.raf ?? requestAnimationFrame
    rafHandleRef.current = raf(tickSampling)
  }, [])

  const stopSampling = useCallback(() => {
    const d = depsRef.current
    if (rafHandleRef.current !== null) {
      const cancel = d.cancelRaf ?? cancelAnimationFrame
      cancel(rafHandleRef.current)
      rafHandleRef.current = null
    }
  }, [])

  const startSampling = useCallback(() => {
    const d = depsRef.current
    const raf = d.raf ?? requestAnimationFrame
    const now = d.now ? d.now() : performance.now()
    lastSampleAtRef.current = now
    // Seed the buffer with the first sample so the committed curve spans
    // from gestureStart regardless of rAF timing.
    const g = gestureRef.current
    if (d.audioCtx && g.startAudioCtxT !== null && g.startProjectT !== null) {
      bufferRef.current.push([g.startProjectT, g.latestNormalised])
    }
    rafHandleRef.current = raf(tickSampling)
  }, [tickSampling])

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  const toggleArm = useCallback(() => {
    if (stateRef.current === 'recording') return
    setState((s) => {
      const next = s === 'idle' ? 'armed' : 'idle'
      stateRef.current = next
      return next
    })
  }, [])

  const setArmState = useCallback((s: ArmState) => {
    setState(s)
    stateRef.current = s
    if (s !== 'recording') stopSampling()
  }, [stopSampling])

  const onGestureStart = useCallback(() => {
    const d = depsRef.current
    const playing = d.isPlaying()
    const armState = stateRef.current

    if (armState === 'armed' && playing && d.audioCtx) {
      // Enter recording (R21).
      const ctxT = d.audioCtx.currentTime
      const projectT = d.getPlayheadSeconds()
      gestureRef.current = {
        startProjectT: projectT,
        startAudioCtxT: ctxT,
        lastNormalised: gestureRef.current.latestNormalised,
        latestNormalised: gestureRef.current.latestNormalised,
      }
      bufferRef.current = []
      setState('recording')
      stateRef.current = 'recording'
      startSampling()
    } else if (armState === 'armed' && !playing) {
      // Direct-edit (R26): armed + paused → commit to curve at playhead.
      gestureRef.current = {
        startProjectT: d.getPlayheadSeconds(),
        startAudioCtxT: d.audioCtx?.currentTime ?? null,
        lastNormalised: gestureRef.current.latestNormalised,
        latestNormalised: gestureRef.current.latestNormalised,
      }
    } else {
      // Idle (not armed): per R21 no-op — live audible feedback only, no
      // curve mutation, no recording transition. Reset any anchor so
      // `onGestureEnd` does not accidentally direct-edit.
      gestureRef.current = {
        startProjectT: null,
        startAudioCtxT: null,
        lastNormalised: gestureRef.current.latestNormalised,
        latestNormalised: gestureRef.current.latestNormalised,
      }
    }
  }, [startSampling])

  const onGestureChange = useCallback((normalised: number) => {
    const d = depsRef.current
    gestureRef.current.latestNormalised = normalised

    // Live audible feedback (R21 spec: unarmed + playing still feeds audio).
    if (d.param && d.audioCtx) {
      try {
        d.param.setTargetAtTime(
          d.paramNativeValue(normalised),
          d.audioCtx.currentTime,
          LIVE_FEEDBACK_TIME_CONSTANT,
        )
      } catch {
        // happy-dom / mock params may not implement setTargetAtTime;
        // swallow — state machine is independent of audio.
      }
    }

    // If blending with an existing curve at the playhead is needed (to avoid
    // snapping on touch-in), the caller can use `sampleCurveAt` directly;
    // we don't auto-blend here — gesture value IS the intended new value.
    void sampleCurveAt // keep the import live for the reference in the task doc
  }, [])

  const onGestureEnd = useCallback(() => {
    const d = depsRef.current
    if (stateRef.current === 'recording') {
      commitIfRecording()
      return
    }
    // Direct-edit commit (R26): only if the gesture was meaningful (has a
    // start anchor + a latest value different from the curve's existing
    // value at the playhead).
    const g = gestureRef.current
    if (g.startProjectT === null) return
    const existing = d.getExistingCurve()
    const existingPoints = existing?.points ?? []
    const interp = existing?.interpolation ?? 'bezier'

    const t = g.startProjectT
    const v = g.latestNormalised
    const existingV =
      existingPoints.length > 0
        ? sampleCurveAt(existingPoints, interp, t)
        : null
    if (existingV !== null && Math.abs(existingV - v) < 1e-9) {
      // No meaningful change — skip commit (R26 prevents noise entries).
      gestureRef.current.startProjectT = null
      return
    }

    // Replace any existing point within a tight window around the playhead
    // with the new value (equivalent to editing a keyframe). If no point is
    // close, insert a new one.
    const REPLACE_WINDOW = 1e-6
    const merged: CurvePoint[] = existingPoints
      .filter((p) => Math.abs(p.time - t) > REPLACE_WINDOW)
      .concat([{ time: t, value: v }])
      .sort((a, b) => a.time - b.time)

    d.onCommit({
      effectId: d.effectId,
      paramName: d.paramName,
      points: merged,
      gestureRange: [t, t],
      interpolation: interp,
    })
    gestureRef.current.startProjectT = null
  }, [commitIfRecording])

  const requestUndo = useCallback(() => {
    // R29a: if mid-record, commit the in-flight gesture FIRST, then undo.
    commitIfRecording()
    depsRef.current.postUndo()
  }, [commitIfRecording])

  // ------------------------------------------------------------------
  // Side-effect: watch transport + effect-enabled. Commit on playback
  // stop or effect disable while recording (R22, R15/R20).
  // ------------------------------------------------------------------
  useEffect(() => {
    if (stateRef.current !== 'recording') return
    if (!deps.isPlaying() || !deps.isEffectEnabled()) {
      commitIfRecording()
    }
    // We intentionally react to these as live-computed signals each render.
  })

  // ------------------------------------------------------------------
  // Side-effect: unmount-time commit (R22).
  // ------------------------------------------------------------------
  useEffect(() => {
    return () => {
      commitIfRecording()
      stopSampling()
    }
  }, [commitIfRecording, stopSampling])

  return {
    state,
    toggleArm,
    setArmState,
    onGestureStart,
    onGestureChange,
    onGestureEnd,
    requestUndo,
    _debugSampleCount: () => bufferRef.current.length,
  }
}
