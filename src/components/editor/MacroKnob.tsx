/**
 * M13 task-54: Per-param knob tile for the Macro Panel.
 *
 * Renders a single animatable parameter as a circular knob with arm / enable
 * / visible controls plus a native-unit readout. The knob widget is a small
 * SVG arc; dragging vertically moves the value in normalised 0..1 space.
 *
 * Non-goals (land in task-55):
 *   - Touch-record state machine (recording lifecycle, rAF sampling)
 *   - AudioParam scheduling on gesture
 *   - Curve commit / undo integration
 *
 * This component only emits gesture-values via onGesture. The parent decides
 * what to do with them — in task-55 the parent will wire it into the mixer +
 * recording state machine.
 *
 * Spec reference: agent/specs/local.effect-curves-macro-panel.md R32-R34.
 */

import { useCallback, useRef, useState, type CSSProperties } from 'react'
import type { ParamScale } from '@/lib/audio-effect-types'
import { formatHz } from '@/lib/frequency-labels'
import {
  useTouchRecord,
  type ArmState as HookArmState,
  type TouchRecordDeps,
} from './useTouchRecord'

/** Arm state visible to callers. Kept as a re-export so consumers that
 * import `ArmState` from MacroKnob continue to compile. */
export type ArmState = HookArmState

export interface MacroKnobProps {
  /** owning effect id — echoed back to gesture callbacks so the parent can route */
  effect_id: string
  /** param name within the effect (e.g. 'threshold') */
  param_name: string
  /** current normalised value in [0, 1] */
  value: number
  /** native-unit range (used for readout + display only) */
  range: { min: number; max: number }
  /** native-unit scale mapping (used by the readout formatter) */
  scale: ParamScale
  /** Current arm state (idle / armed / recording). Ignored when
   *  `touchRecordDeps` is provided — the hook owns state. */
  armed: ArmState
  /** whether the owning effect is enabled (affects power-button color) */
  enabled: boolean
  /** whether the curve is drawn inline on the timeline (eye icon state) */
  visible: boolean
  /** human-readable label shown above the knob */
  label: string
  /** pixel diameter of the knob widget itself (tile is larger) */
  size?: number
  /** called on each pointer move with the new normalised value (0..1) */
  onGesture: (normalised: number, meta: { effect_id: string; param_name: string; phase: 'start' | 'move' | 'end' }) => void
  /** user clicked the arm circle */
  onArmToggle: () => void
  /** user clicked the power button */
  onEnableToggle: () => void
  /** user clicked the eye icon */
  onVisibleToggle: () => void
  /**
   * M13 task-55: when provided, wires pointer gestures through the
   * touch-record state machine (audible feedback, rAF sampling, commit
   * on mouseup / playback-stop / disable / undo). Omit to preserve the
   * legacy parent-controlled behaviour (MacroPanel shell today).
   */
  touchRecordDeps?: TouchRecordDeps
}

/** Convert a normalised [0, 1] value to native units for display. */
function toNative(v: number, range: { min: number; max: number }, scale: ParamScale): number {
  const clamped = Math.max(0, Math.min(1, v))
  if (scale === 'log' || scale === 'hz') {
    const minL = Math.log(Math.max(range.min, 1e-6))
    const maxL = Math.log(Math.max(range.max, 1e-6))
    return Math.exp(minL + (maxL - minL) * clamped)
  }
  // linear & db behave the same for value mapping; the formatter handles the
  // "dB" suffix.
  return range.min + (range.max - range.min) * clamped
}

/** Format a native-unit value with an appropriate suffix. */
function formatNative(v: number, scale: ParamScale): string {
  if (scale === 'hz') return formatHz(v)
  if (scale === 'db') {
    const sign = v >= 0 ? '+' : ''
    return `${sign}${v.toFixed(1)} dB`
  }
  // linear / log → plain decimal with smart precision
  const abs = Math.abs(v)
  if (abs >= 10) return v.toFixed(1)
  if (abs >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

/** Convert normalised [0, 1] to a sweep angle on the knob. */
const KNOB_SWEEP_DEG = 270 // Spec R33: 270-315° sweep. 270° keeps the indicator clear of the tick row.
const KNOB_START_DEG = 135 // bottom-left

function valueToAngle(v: number): number {
  return KNOB_START_DEG + Math.max(0, Math.min(1, v)) * KNOB_SWEEP_DEG
}

function polar(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
}

/**
 * Describe the arc path from KNOB_START_DEG up to the current angle.
 */
function arcPath(cx: number, cy: number, r: number, valueNorm: number): string {
  const end = valueToAngle(valueNorm)
  const [sx, sy] = polar(cx, cy, r, KNOB_START_DEG)
  const [ex, ey] = polar(cx, cy, r, end)
  const largeArc = valueNorm * KNOB_SWEEP_DEG > 180 ? 1 : 0
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`
}

/** Full-range arc (the background track). */
function bgArcPath(cx: number, cy: number, r: number): string {
  const [sx, sy] = polar(cx, cy, r, KNOB_START_DEG)
  const [ex, ey] = polar(cx, cy, r, KNOB_START_DEG + KNOB_SWEEP_DEG)
  const largeArc = KNOB_SWEEP_DEG > 180 ? 1 : 0
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`
}

// Pixels of vertical drag required to traverse the full 0→1 range.
const NORMAL_DRAG_RANGE_PX = 200
// Shift-drag precision: full traverse takes 1000px.
const PRECISION_DRAG_RANGE_PX = 1000

export function MacroKnob(props: MacroKnobProps) {
  const {
    effect_id,
    param_name,
    value,
    range,
    scale,
    armed,
    enabled,
    visible,
    label,
    size = 48,
    onGesture,
    onArmToggle,
    onEnableToggle,
    onVisibleToggle,
    touchRecordDeps,
  } = props

  // When deps are supplied, the hook takes over gesture lifecycle.
  // The hook is always called (rules of hooks) — when deps is null the
  // hook runs with a no-op deps object and contributes no side effects.
  const noopDeps: TouchRecordDeps = useRef<TouchRecordDeps>({
    effectId: effect_id,
    paramName: param_name,
    paramNativeValue: (n) => n,
    param: null,
    audioCtx: null,
    getPlayheadSeconds: () => 0,
    isPlaying: () => false,
    isEffectEnabled: () => true,
    getExistingCurve: () => null,
    onCommit: () => {},
    postUndo: () => {},
  }).current

  const activeDeps = touchRecordDeps ?? noopDeps
  const hook = useTouchRecord(activeDeps)
  const hookControlled = touchRecordDeps !== undefined

  const effectiveArm: ArmState = hookControlled ? hook.state : armed

  const dragRef = useRef<{
    startY: number
    startValue: number
    precision: boolean
    active: boolean
  } | null>(null)
  const [dragging, setDragging] = useState(false)

  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    e.preventDefault()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = {
      startY: e.clientY,
      startValue: value,
      precision: e.shiftKey,
      active: true,
    }
    setDragging(true)
    onGesture(value, { effect_id, param_name, phase: 'start' })
    if (hookControlled) hook.onGestureStart()
  }, [value, onGesture, effect_id, param_name, hookControlled, hook])

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    if (!d || !d.active) return
    // Update precision flag on-the-fly so the user can press/release shift mid-drag.
    d.precision = e.shiftKey
    const dy = d.startY - e.clientY // up = increase
    const rng = d.precision ? PRECISION_DRAG_RANGE_PX : NORMAL_DRAG_RANGE_PX
    const delta = dy / rng
    const next = Math.max(0, Math.min(1, d.startValue + delta))
    onGesture(next, { effect_id, param_name, phase: 'move' })
    if (hookControlled) hook.onGestureChange(next)
  }, [onGesture, effect_id, param_name, hookControlled, hook])

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    if (!d || !d.active) return
    d.active = false
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    setDragging(false)
    onGesture(value, { effect_id, param_name, phase: 'end' })
    if (hookControlled) hook.onGestureEnd()
  }, [onGesture, value, effect_id, param_name, hookControlled, hook])

  const handleArmToggleClick = useCallback(() => {
    if (hookControlled) {
      hook.toggleArm()
    }
    onArmToggle()
  }, [hookControlled, hook, onArmToggle])

  const diameter = Math.max(24, size)
  const radius = diameter / 2 - 2
  const cx = diameter / 2
  const cy = diameter / 2

  // Needle endpoint at the current value.
  const [nx, ny] = polar(cx, cy, radius - 3, valueToAngle(value))

  const nativeValue = toNative(value, range, scale)
  const nativeStr = formatNative(nativeValue, scale)

  const tileStyle: CSSProperties = {
    width: Math.max(48, size + 24),
  }

  // Arm ring color: red when armed, fully-saturated red + glow while recording,
  // grey when idle (spec R32).
  const armColor = effectiveArm === 'idle' ? '#4b5563' : '#ef4444'
  const armGlow = effectiveArm === 'recording' ? '0 0 6px rgba(239,68,68,0.8)' : 'none'

  return (
    <div
      className="flex flex-col items-center select-none"
      style={tileStyle}
      data-testid="macro-knob-tile"
      data-effect-id={effect_id}
      data-param-name={param_name}
      data-tile-width={tileStyle.width}
    >
      <div className="text-[10px] leading-tight text-gray-300 text-center truncate w-full" title={label}>
        {label}
      </div>

      <svg
        width={diameter}
        height={diameter}
        viewBox={`0 0 ${diameter} ${diameter}`}
        role="slider"
        aria-label={`${label} knob`}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={value}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          cursor: dragging ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
        data-testid="macro-knob-svg"
      >
        {/* background arc */}
        <path
          d={bgArcPath(cx, cy, radius)}
          stroke="#1f2937"
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
        />
        {/* value arc */}
        <path
          d={arcPath(cx, cy, radius, value)}
          stroke={enabled ? '#4d9eff' : '#6b7280'}
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
        />
        {/* hub */}
        <circle cx={cx} cy={cy} r={Math.max(4, radius * 0.35)} fill="#111827" stroke="#374151" strokeWidth={1} />
        {/* needle */}
        <line
          x1={cx}
          y1={cy}
          x2={nx}
          y2={ny}
          stroke={enabled ? '#e5e7eb' : '#9ca3af'}
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>

      <div className="text-[9px] text-gray-400 tabular-nums mt-0.5 truncate w-full text-center" data-testid="macro-knob-readout">
        {nativeStr}
      </div>

      <div className="flex items-center gap-1 mt-1">
        {/* Arm circle (spec R32) */}
        <button
          type="button"
          onClick={handleArmToggleClick}
          className="rounded-full"
          style={{
            width: 14,
            height: 14,
            borderRadius: 999,
            border: `2px solid ${armColor}`,
            background: effectiveArm === 'idle' ? '#374151' : armColor,
            boxShadow: armGlow,
          }}
          aria-label={effectiveArm === 'idle' ? 'Arm knob' : 'Disarm knob'}
          aria-pressed={effectiveArm !== 'idle'}
          data-testid="macro-knob-arm"
        />

        {/* Power button (spec R32) */}
        <button
          type="button"
          onClick={onEnableToggle}
          className="flex items-center justify-center rounded-sm"
          style={{
            width: 14,
            height: 14,
            background: 'transparent',
            color: enabled ? '#4d9eff' : '#4b5563',
            border: '1px solid currentColor',
          }}
          aria-label={enabled ? 'Disable effect' : 'Enable effect'}
          aria-pressed={enabled}
          data-testid="macro-knob-power"
        >
          <svg width={9} height={9} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M8 2 v5" />
            <path d="M4 6 a 5 5 0 1 0 8 0" />
          </svg>
        </button>

        {/* Eye icon (spec R32) */}
        <button
          type="button"
          onClick={onVisibleToggle}
          className="flex items-center justify-center"
          style={{
            width: 14,
            height: 14,
            background: 'transparent',
            color: visible ? '#a7f3d0' : '#4b5563',
          }}
          aria-label={visible ? 'Hide curve on timeline' : 'Show curve on timeline'}
          aria-pressed={visible}
          data-testid="macro-knob-visible"
        >
          {visible ? (
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
              <circle cx={12} cy={12} r={3} />
            </svg>
          ) : (
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a20.3 20.3 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a20.3 20.3 0 0 1-3.17 4.19" />
              <path d="M1 1l22 22" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
