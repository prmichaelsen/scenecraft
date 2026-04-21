import { useCallback, useEffect, useRef, useState } from 'react'
import type { CurvePoint } from '@/lib/audio-client'

type Props = {
  curve: CurvePoint[] | null | undefined
  onChange: (curve: CurvePoint[]) => void
  /** 'normalised' → x in [0, 1] (clip space); 'seconds' → x in [0, xAxisMax] (absolute track time) */
  xAxis: 'normalised' | 'seconds'
  /** Required when xAxis === 'seconds'; the max x value (e.g. project duration). */
  xAxisMax?: number
  /** dB range, default [-60, +12]. */
  yRange?: [number, number]
  /** Debounce before calling onChange after drag, default 200ms. */
  debounceMs?: number
  label?: string
  height?: number
}

const DEFAULT_YRANGE: [number, number] = [-60, 12]
const GRIDLINES_DB = [-48, -24, -12, -6, 0, 6, 12]

/**
 * Canvas-based volume curve editor. Coordinates are stored as [x, dB].
 * - Drag points to move, click empty area to add, right-click to remove.
 * - First/last points are locked to x = min/max (not deletable).
 * - Changes commit via onChange after a debounce window.
 */
export function VolumeCurveEditor({
  curve,
  onChange,
  xAxis,
  xAxisMax,
  yRange = DEFAULT_YRANGE,
  debounceMs = 200,
  label,
  height = 120,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 320, h: height })
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)

  const xMin = 0
  const xMax = xAxis === 'normalised' ? 1 : Math.max(xAxisMax ?? 1, 0.01)
  const [yMin, yMax] = yRange

  // Local state so dragging feels immediate; commit on settle via debounce
  const initial = normalizeCurve(curve, xMin, xMax, yMin, yMax)
  const [points, setPoints] = useState<CurvePoint[]>(initial)
  const incoming = JSON.stringify(curve)
  const prevIncoming = useRef<string>(incoming)
  useEffect(() => {
    if (prevIncoming.current !== incoming && draggingIdx === null) {
      prevIncoming.current = incoming
      setPoints(normalizeCurve(curve, xMin, xMax, yMin, yMax))
    }
  }, [incoming, curve, xMin, xMax, yMin, yMax, draggingIdx])

  // Debounced commit
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commit = useCallback((next: CurvePoint[]) => {
    if (commitTimer.current) clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => {
      prevIncoming.current = JSON.stringify(next)
      onChange(next)
    }, debounceMs)
  }, [onChange, debounceMs])

  // Resize observer
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width
      if (w > 0) setSize({ w, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [height])

  const PAD_L = 36
  const PAD_R = 8
  const PAD_T = 8
  const PAD_B = 18
  const W = size.w
  const H = size.h

  const toCanvas = useCallback((x: number, db: number): [number, number] => [
    PAD_L + ((x - xMin) / (xMax - xMin)) * (W - PAD_L - PAD_R),
    PAD_T + (1 - (db - yMin) / (yMax - yMin)) * (H - PAD_T - PAD_B),
  ], [W, H, xMin, xMax, yMin, yMax])

  const fromCanvas = useCallback((cx: number, cy: number): [number, number] => {
    const x = clamp(((cx - PAD_L) / (W - PAD_L - PAD_R)) * (xMax - xMin) + xMin, xMin, xMax)
    const db = clamp(yMax - ((cy - PAD_T) / (H - PAD_T - PAD_B)) * (yMax - yMin), yMin, yMax)
    return [x, db]
  }, [W, H, xMin, xMax, yMin, yMax])

  // Draw
  useEffect(() => {
    const cvs = canvasRef.current
    if (!cvs) return
    const ctx = cvs.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    cvs.width = W * dpr
    cvs.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    // Background
    ctx.fillStyle = '#0e1320'
    ctx.fillRect(0, 0, W, H)

    // dB gridlines + labels
    ctx.strokeStyle = '#222a3b'
    ctx.lineWidth = 0.5
    ctx.fillStyle = '#5a6580'
    ctx.font = '9px monospace'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const db of GRIDLINES_DB) {
      if (db < yMin || db > yMax) continue
      const [, y] = toCanvas(xMin, db)
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke()
      ctx.fillStyle = db === 0 ? '#8aa3e8' : '#5a6580'
      ctx.fillText(db === 0 ? '0' : db > 0 ? `+${db}` : `${db}`, PAD_L - 3, y)
    }

    // 0 dB (unity) reference
    {
      const [, y0] = toCanvas(xMin, 0)
      ctx.strokeStyle = '#2a3a5a'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(PAD_L, y0); ctx.lineTo(W - PAD_R, y0); ctx.stroke()
      ctx.setLineDash([])
    }

    // X axis labels
    ctx.textAlign = 'left'
    ctx.fillStyle = '#5a6580'
    ctx.font = '9px monospace'
    const xLabelLeft = xAxis === 'normalised' ? '0' : '0s'
    const xLabelRight = xAxis === 'normalised' ? '1.0' : `${xMax.toFixed(1)}s`
    ctx.fillText(xLabelLeft, PAD_L, H - 3)
    ctx.textAlign = 'right'
    ctx.fillText(xLabelRight, W - PAD_R, H - 3)

    // Curve (linear segments between points, sorted by x)
    const sorted = [...points].sort((a, b) => a[0] - b[0])
    if (sorted.length > 0) {
      ctx.strokeStyle = '#60a5fa'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      const [x0, y0] = toCanvas(sorted[0][0], sorted[0][1])
      ctx.moveTo(x0, y0)
      for (let i = 1; i < sorted.length; i++) {
        const [x, y] = toCanvas(sorted[i][0], sorted[i][1])
        ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Filled area below curve (visual aid)
      ctx.fillStyle = 'rgba(96, 165, 250, 0.08)'
      ctx.beginPath()
      ctx.moveTo(x0, H - PAD_B)
      for (const p of sorted) {
        const [x, y] = toCanvas(p[0], p[1])
        ctx.lineTo(x, y)
      }
      const last = toCanvas(sorted[sorted.length - 1][0], sorted[sorted.length - 1][1])
      ctx.lineTo(last[0], H - PAD_B)
      ctx.closePath()
      ctx.fill()

      // Points
      for (let i = 0; i < sorted.length; i++) {
        const [x, y] = toCanvas(sorted[i][0], sorted[i][1])
        ctx.fillStyle = i === draggingIdx ? '#fbbf24' : '#93c5fd'
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill()
      }
    }
  }, [points, W, H, xMin, xMax, yMin, yMax, xAxis, draggingIdx, toCanvas])

  const hitTest = (cx: number, cy: number): number | null => {
    const sorted = [...points].sort((a, b) => a[0] - b[0])
    let best = -1
    let bestDist = 16 * 16
    for (let i = 0; i < sorted.length; i++) {
      const [x, y] = toCanvas(sorted[i][0], sorted[i][1])
      const d = (cx - x) ** 2 + (cy - y) ** 2
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    return best >= 0 ? findOriginalIdx(points, sorted[best]) : null
  }

  const mouseToCanvas = (e: React.MouseEvent | MouseEvent): [number, number] | null => {
    const cvs = canvasRef.current
    if (!cvs) return null
    const rect = cvs.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  const onMouseDown = (e: React.MouseEvent) => {
    const pos = mouseToCanvas(e)
    if (!pos) return
    if (e.button === 2) {
      e.preventDefault()
      const idx = hitTest(pos[0], pos[1])
      if (idx !== null && points.length > 2) {
        const next = points.filter((_, i) => i !== idx)
        setPoints(next)
        commit(next)
      }
      return
    }
    const idx = hitTest(pos[0], pos[1])
    if (idx !== null) {
      setDraggingIdx(idx)
    } else {
      // Add a new point
      const [x, db] = fromCanvas(pos[0], pos[1])
      const next = [...points, [x, db] as CurvePoint].sort((a, b) => a[0] - b[0])
      setPoints(next)
      commit(next)
      const newIdx = next.findIndex((p) => p[0] === x && p[1] === db)
      setDraggingIdx(newIdx >= 0 ? newIdx : null)
    }
  }

  useEffect(() => {
    if (draggingIdx === null) return
    const move = (e: MouseEvent) => {
      const pos = mouseToCanvas(e)
      if (!pos) return
      const [rawX, db] = fromCanvas(pos[0], pos[1])
      const next = points.map((p, i) => {
        if (i !== draggingIdx) return p
        // Lock endpoints at boundaries to preserve span
        const isFirst = i === 0
        const isLast = i === points.length - 1
        const x = isFirst ? xMin : isLast ? xMax : rawX
        return [x, db] as CurvePoint
      })
      setPoints(next)
      commit(next)
    }
    const up = () => setDraggingIdx(null)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [draggingIdx, points, fromCanvas, commit, xMin, xMax])

  const reset = () => {
    const next: CurvePoint[] = [[xMin, 0], [xMax, 0]]
    setPoints(next)
    commit(next)
  }

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
          <button
            type="button"
            onClick={reset}
            className="text-[10px] text-gray-500 hover:text-gray-300"
            title="Reset to 0 dB (unity)"
          >
            reset
          </button>
        </div>
      )}
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height, cursor: draggingIdx !== null ? 'grabbing' : 'crosshair' }}
        onMouseDown={onMouseDown}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function normalizeCurve(
  curve: CurvePoint[] | null | undefined,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
): CurvePoint[] {
  if (!curve || curve.length === 0) {
    return [[xMin, 0], [xMax, 0]]
  }
  const sorted = [...curve].map((p) => [clamp(p[0], xMin, xMax), clamp(p[1], yMin, yMax)] as CurvePoint).sort((a, b) => a[0] - b[0])
  if (sorted[0][0] !== xMin) sorted.unshift([xMin, sorted[0][1]])
  if (sorted[sorted.length - 1][0] !== xMax) sorted.push([xMax, sorted[sorted.length - 1][1]])
  return sorted
}

function findOriginalIdx(points: CurvePoint[], target: CurvePoint): number {
  for (let i = 0; i < points.length; i++) {
    if (points[i][0] === target[0] && points[i][1] === target[1]) return i
  }
  return -1
}
