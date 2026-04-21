import { useCallback, useEffect, useRef, useState } from 'react'
import { CurveEditor, type CurvePoint as _CurvePoint } from './CurveEditor'
import type { CurvePoint } from '@/lib/audio-client'

type Props = {
  curve: CurvePoint[] | null | undefined
  onChange: (curve: CurvePoint[]) => void
  /** 'normalised' → x in [0, 1] (clip space); 'seconds' → x in [0, xAxisMax] (absolute track time) */
  xAxis: 'normalised' | 'seconds'
  /** Required when xAxis === 'seconds'; the max x value (e.g. project duration). */
  xAxisMax?: number
  /** dB range. Default [-60, +12]. */
  yRange?: [number, number]
  /** Debounce before committing `onChange` to the parent after drag. */
  debounceMs?: number
  label?: string
}

const DEFAULT_YRANGE: [number, number] = [-60, 12]
const GRIDLINE_DB = [-48, -24, -12, -6, 0, 6, 12]

/**
 * Thin wrapper around the shared {@link CurveEditor} configured for dB
 * volume curves. Clip curves use normalised x ∈ [0, 1]; track curves use
 * absolute seconds. The Y-axis draws dB gridlines at standard breakpoints
 * with unity (0 dB) emphasised. Interaction model (shift-drag endpoints,
 * double-click to remove, etc.) matches the other curve editors in the app.
 */
export function VolumeCurveEditor({
  curve,
  onChange,
  xAxis,
  xAxisMax,
  yRange = DEFAULT_YRANGE,
  debounceMs = 200,
  label,
}: Props) {
  const xMin = 0
  const xMax = xAxis === 'normalised' ? 1 : Math.max(xAxisMax ?? 1, 0.01)

  // Mirror the incoming curve into local state so drag feels instant; commit
  // upstream after a short debounce so rapid drags don't thrash the server.
  const normalised = normalizeCurve(curve, xMin, xMax, yRange[0], yRange[1])
  const [points, setPoints] = useState<_CurvePoint[]>(normalised)
  const prevIncoming = useRef<string>(JSON.stringify(curve))
  useEffect(() => {
    const key = JSON.stringify(curve)
    if (key !== prevIncoming.current) {
      prevIncoming.current = key
      setPoints(normalizeCurve(curve, xMin, xMax, yRange[0], yRange[1]))
    }
  }, [curve, xMin, xMax, yRange])

  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleChange = useCallback((next: _CurvePoint[]) => {
    setPoints(next)
    if (commitTimer.current) clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => {
      const cleaned = next.map((p) => [p[0], p[1]] as CurvePoint)
      prevIncoming.current = JSON.stringify(cleaned)
      onChange(cleaned)
    }, debounceMs)
  }, [onChange, debounceMs])

  const xAxisLabels: [string, string] = xAxis === 'normalised'
    ? ['0', '1.0']
    : ['0s', `${xMax.toFixed(1)}s`]

  return (
    <CurveEditor
      points={points}
      onChange={handleChange}
      xRange={[xMin, xMax]}
      yRange={yRange}
      defaultY={0}
      xAxisLabels={xAxisLabels}
      yAxisLabel="dB"
      yTicks={GRIDLINE_DB
        .filter((db) => db >= yRange[0] && db <= yRange[1])
        .map((db) => ({
          value: db,
          label: db === 0 ? '0' : db > 0 ? `+${db}` : `${db}`,
          emphasised: db === 0,
        }))}
      formatY={(db) => db === 0 ? '0 dB' : db > 0 ? `+${db.toFixed(1)} dB` : `${db.toFixed(1)} dB`}
      aspect={4}
      label={label}
    />
  )
}

function normalizeCurve(
  curve: CurvePoint[] | null | undefined,
  xMin: number, xMax: number,
  yMin: number, yMax: number,
): _CurvePoint[] {
  const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v
  if (!curve || curve.length === 0) {
    return [[xMin, 0], [xMax, 0]]
  }
  const sorted = [...curve]
    .map((p) => [clamp(p[0], xMin, xMax), clamp(p[1], yMin, yMax)] as _CurvePoint)
    .sort((a, b) => a[0] - b[0])
  if (sorted[0][0] !== xMin) sorted.unshift([xMin, sorted[0][1]])
  if (sorted[sorted.length - 1][0] !== xMax) sorted.push([xMax, sorted[sorted.length - 1][1]])
  return sorted
}
