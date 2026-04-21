import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Pure canvas-based curve editor. No knowledge of transitions, clips, tracks,
 * or save endpoints — consumers feed `points` in and receive `onChange(points)`
 * out. Matches the interaction model of the inline `AnimCurveEditor` in
 * TransitionPanel:
 *   - click empty area → add point at cursor
 *   - drag point → move (X clamped between neighbors)
 *   - shift-drag endpoint → both endpoints move to the same Y (matched level)
 *   - double-click interior point → remove (min 2 points preserved)
 *   - right-click point → delete (alternative to double-click)
 *
 * Optional `lockY` forces endpoints fully locked + interior points lock Y —
 * used by time-remap curves where X is the only meaningful dimension.
 */

export type CurvePoint = [number, number] | [number, number, number]

export type CurveEditorProps = {
  points: CurvePoint[]
  /** Called on every interaction; parent debounces if needed. */
  onChange: (points: CurvePoint[]) => void

  /** X-axis range. Default [0, 1]. */
  xRange?: [number, number]
  /** Y-axis range. Default [0, 1]. */
  yRange?: [number, number]

  /** Reference value for the reset button. Default mid-Y. */
  defaultY?: number

  /** Left/right X-axis labels shown under the canvas. Default "0%" / "100%". */
  xAxisLabels?: [string, string]
  /** Y-axis label (vertical). Default empty. */
  yAxisLabel?: string
  /**
   * Extra horizontal gridlines at these Y values (drawn faintly with their
   * value labels on the left). Useful for dB axis.
   */
  yTicks?: Array<{ value: number; label?: string; emphasised?: boolean }>
  /** Formatter for the value tooltip shown while hovering/dragging a point. */
  formatY?: (y: number) => string

  /** Point + curve colour. Default "#60a5fa". */
  color?: string
  /** Width:height ratio. Default 3. */
  aspect?: number

  /** Endpoints fully locked, interior points lock Y. For time-remap curves. */
  lockY?: boolean
  /** Draw reference line as diagonal y=x instead of horizontal at defaultY. */
  diagonalRef?: boolean

  /**
   * Optional playhead overlay, expressed as a fraction of the X-range [0, 1].
   * Not drawn when undefined.
   */
  playheadProgress?: number

  /** Optional header label shown above the canvas. */
  label?: string
}

const DEFAULT_X_RANGE: [number, number] = [0, 1]
const DEFAULT_Y_RANGE: [number, number] = [0, 1]
const DEFAULT_COLOR = '#60a5fa'
const PAD = 10

export function CurveEditor({
  points,
  onChange,
  xRange = DEFAULT_X_RANGE,
  yRange = DEFAULT_Y_RANGE,
  defaultY,
  xAxisLabels = ['0%', '100%'],
  yAxisLabel,
  yTicks,
  formatY,
  color = DEFAULT_COLOR,
  aspect = 3,
  lockY = false,
  diagonalRef = false,
  playheadProgress,
  label,
}: CurveEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 240, h: Math.round(240 / aspect) })
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const W = size.w
  const H = size.h

  const [xMin, xMax] = xRange
  const [yMin, yMax] = yRange
  const xSpan = Math.max(xMax - xMin, 1e-9)
  const ySpan = Math.max(yMax - yMin, 1e-9)

  const resolvedDefaultY = defaultY ?? (yMin + yMax) / 2

  // Resize observer
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width
      if (w > 0) setSize({ w, h: Math.round(w / aspect) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [aspect])

  const toCanvas = useCallback((x: number, y: number): [number, number] => [
    PAD + ((x - xMin) / xSpan) * (W - 2 * PAD),
    H - PAD - ((y - yMin) / ySpan) * (H - 2 * PAD),
  ], [W, H, xMin, xSpan, yMin, ySpan])

  const fromCanvas = useCallback((cx: number, cy: number): [number, number] => {
    const x = ((cx - PAD) / (W - 2 * PAD)) * xSpan + xMin
    const y = ((H - PAD - cy) / (H - 2 * PAD)) * ySpan + yMin
    return [
      Math.max(xMin, Math.min(xMax, x)),
      Math.max(yMin, Math.min(yMax, y)),
    ]
  }, [W, H, xMin, xMax, xSpan, yMin, yMax, ySpan])

  const mouseToCanvas = (e: React.MouseEvent | MouseEvent): [number, number] | null => {
    const cvs = canvasRef.current
    if (!cvs) return null
    const rect = cvs.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

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

    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, W, H)

    // Base grid
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 0.5
    for (let i = 0; i <= 4; i++) {
      const [gx] = toCanvas(xMin + (i / 4) * xSpan, yMin)
      const [, gy] = toCanvas(xMin, yMin + (i / 4) * ySpan)
      ctx.beginPath(); ctx.moveTo(PAD, gy); ctx.lineTo(W - PAD, gy); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(gx, PAD); ctx.lineTo(gx, H - PAD); ctx.stroke()
    }

    // Y ticks (custom values, used for dB axis)
    if (yTicks) {
      ctx.font = '7px monospace'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      for (const tick of yTicks) {
        if (tick.value < yMin || tick.value > yMax) continue
        const [, y] = toCanvas(xMin, tick.value)
        ctx.strokeStyle = tick.emphasised ? '#445580' : '#2a3248'
        ctx.lineWidth = 0.5
        ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke()
        if (tick.label) {
          ctx.fillStyle = tick.emphasised ? '#8aa3e8' : '#5a6580'
          ctx.fillText(tick.label, PAD - 2, y)
        }
      }
    }

    // Axis labels
    ctx.fillStyle = '#666'
    ctx.font = '8px monospace'
    if (yAxisLabel) {
      ctx.save()
      ctx.translate(8, H / 2)
      ctx.rotate(-Math.PI / 2)
      ctx.textAlign = 'center'
      ctx.fillText(yAxisLabel, 0, 0)
      ctx.restore()
    }
    ctx.fillStyle = '#555'
    ctx.font = '7px monospace'
    ctx.textAlign = 'left'
    ctx.fillText(xAxisLabels[0], PAD, H - PAD + 9)
    ctx.textAlign = 'right'
    ctx.fillText(xAxisLabels[1], W - PAD, H - PAD + 9)

    // Reference line (diagonal or horizontal at defaultY)
    ctx.strokeStyle = '#555'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    if (diagonalRef) {
      const [lx0, ly0] = toCanvas(xMin, yMin)
      const [lx1, ly1] = toCanvas(xMax, yMax)
      ctx.moveTo(lx0, ly0); ctx.lineTo(lx1, ly1)
    } else {
      const [, ly] = toCanvas(xMin, resolvedDefaultY)
      ctx.moveTo(PAD, ly); ctx.lineTo(W - PAD, ly)
    }
    ctx.stroke()
    ctx.setLineDash([])

    // Sorted points
    const sorted = [...points].sort((a, b) => a[0] - b[0]) as CurvePoint[]

    // Curve (linear segments between points — easing not supported here,
    // same as OpacityCurveEditor in TransitionPanel)
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < sorted.length; i++) {
      const [cx, cy] = toCanvas(sorted[i][0], sorted[i][1])
      if (i === 0) ctx.moveTo(cx, cy)
      else ctx.lineTo(cx, cy)
    }
    ctx.stroke()

    // Fill area under curve
    if (sorted.length > 0) {
      ctx.fillStyle = color + '11'
      ctx.beginPath()
      const [bx0, byBottom] = toCanvas(sorted[0][0], yMin)
      ctx.moveTo(bx0, byBottom)
      for (const p of sorted) {
        const [cx, cy] = toCanvas(p[0], p[1])
        ctx.lineTo(cx, cy)
      }
      const [bxN] = toCanvas(sorted[sorted.length - 1][0], yMin)
      ctx.lineTo(bxN, byBottom)
      ctx.closePath()
      ctx.fill()
    }

    // Points
    for (let i = 0; i < sorted.length; i++) {
      const [cx, cy] = toCanvas(sorted[i][0], sorted[i][1])
      const isEndpoint = i === 0 || i === sorted.length - 1
      const isHovered = hoveredIdx === i
      const isDragging = draggingIdx === i
      const r = isDragging ? 3.5 : isHovered ? 3 : 2.5

      if (isEndpoint) {
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fillStyle = isDragging ? color : isHovered ? color : '#555'
        ctx.fill()
        ctx.strokeStyle = isDragging ? '#fff' : '#888'
        ctx.lineWidth = 0.5
        ctx.stroke()
      } else {
        // Diamond marker for interior points
        ctx.beginPath()
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy)
        ctx.closePath()
        ctx.fillStyle = color
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 0.5
        ctx.stroke()
      }

      if ((isHovered || isDragging) && formatY) {
        ctx.fillStyle = color
        ctx.font = '7px monospace'
        ctx.textAlign = cx > W / 2 ? 'right' : 'left'
        const labelX = cx > W / 2 ? cx - 8 : cx + 8
        ctx.fillText(formatY(sorted[i][1]), labelX, cy + 3)
      }
    }

    // Playhead overlay
    if (playheadProgress != null) {
      const clamped = Math.max(0, Math.min(1, playheadProgress))
      const xAt = xMin + clamped * xSpan
      const [phx] = toCanvas(xAt, yMin)
      const [, topY] = toCanvas(xMin, yMax)
      const [, bottomY] = toCanvas(xMin, yMin)
      ctx.strokeStyle = '#ffffff44'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(phx, topY); ctx.lineTo(phx, bottomY)
      ctx.stroke()
    }
  }, [points, hoveredIdx, draggingIdx, W, H, xMin, xMax, xSpan, yMin, yMax, ySpan, resolvedDefaultY, diagonalRef, color, xAxisLabels, yAxisLabel, yTicks, formatY, playheadProgress, toCanvas])

  const hitTest = useCallback((cx: number, cy: number): number | null => {
    const sorted = [...points].sort((a, b) => a[0] - b[0])
    for (let i = 0; i < sorted.length; i++) {
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(cx - px, cy - py) < 8) {
        return points.indexOf(sorted[i])
      }
    }
    return null
  }, [points, toCanvas])

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      // Right-click: remove interior point
      e.preventDefault()
      const pos = mouseToCanvas(e)
      if (!pos) return
      const idx = hitTest(pos[0], pos[1])
      if (idx === null) return
      const sortedByX = [...points].sort((a, b) => a[0] - b[0])
      const sortedIdx = sortedByX.indexOf(points[idx])
      if (sortedIdx <= 0 || sortedIdx >= sortedByX.length - 1) return // don't delete endpoints
      const next = points.filter((_, i) => i !== idx)
      onChange(next)
      return
    }
    const pos = mouseToCanvas(e)
    if (!pos) return
    const idx = hitTest(pos[0], pos[1])
    if (idx !== null) {
      setDraggingIdx(idx)
      return
    }
    // Click on empty area → add point at cursor
    const [nx, ny] = fromCanvas(pos[0], pos[1])
    const next: CurvePoint[] = [...points, [nx, ny] as CurvePoint]
    next.sort((a, b) => a[0] - b[0])
    onChange(next)
  }

  // Use window listeners during drag to keep tracking outside the canvas
  useEffect(() => {
    if (draggingIdx === null) return
    const onMove = (e: MouseEvent) => {
      const pos = mouseToCanvas(e)
      if (!pos) return
      const [nx, ny] = fromCanvas(pos[0], pos[1])
      const sorted = [...points].sort((a, b) => a[0] - b[0])
      const realSortedIdx = sorted.indexOf(points[draggingIdx])
      if (realSortedIdx === -1) return

      // lockY: fully lock endpoints; interior points lock Y only
      if (lockY && (realSortedIdx === 0 || realSortedIdx === sorted.length - 1)) return

      const minX = sorted[realSortedIdx - 1]?.[0] ?? xMin
      const maxX = sorted[realSortedIdx + 1]?.[0] ?? xMax
      const isEndpoint = realSortedIdx === 0 || realSortedIdx === sorted.length - 1
      const clampedX = isEndpoint
        ? sorted[realSortedIdx][0] // endpoints keep their X
        : Math.max(minX, Math.min(maxX, nx))
      const newY = lockY ? sorted[realSortedIdx][1] : ny
      const existingEasing = sorted[realSortedIdx][2]
      const nextPoint: CurvePoint = existingEasing != null
        ? [clampedX, newY, existingEasing]
        : [clampedX, newY]
      sorted[realSortedIdx] = nextPoint

      // Shift-drag endpoint: move both endpoints to the same Y
      if (e.shiftKey && isEndpoint && !lockY) {
        const otherIdx = realSortedIdx === 0 ? sorted.length - 1 : 0
        const otherEasing = sorted[otherIdx][2]
        sorted[otherIdx] = otherEasing != null
          ? [sorted[otherIdx][0], newY, otherEasing]
          : [sorted[otherIdx][0], newY]
      }
      onChange(sorted)
    }
    const onUp = () => setDraggingIdx(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [draggingIdx, points, onChange, fromCanvas, lockY, xMin, xMax])

  const handleMouseMove = (e: React.MouseEvent) => {
    if (draggingIdx !== null) return
    const pos = mouseToCanvas(e)
    if (!pos) { setHoveredIdx(null); return }
    setHoveredIdx(hitTest(pos[0], pos[1]))
  }

  const handleDoubleClick = (e: React.MouseEvent) => {
    const pos = mouseToCanvas(e)
    if (!pos) return
    const idx = hitTest(pos[0], pos[1])
    if (idx === null) return
    const sortedByX = [...points].sort((a, b) => a[0] - b[0])
    const sortedIdx = sortedByX.indexOf(points[idx])
    if (sortedIdx <= 0 || sortedIdx >= sortedByX.length - 1) return
    const next = points.filter((_, i) => i !== idx)
    onChange(next)
    setHoveredIdx(null)
  }

  const handleReset = () => {
    const next: CurvePoint[] = [[xMin, resolvedDefaultY], [xMax, resolvedDefaultY]]
    onChange(next)
  }

  const hasChanges = points.length > 2 || points.some((p) => p[1] !== resolvedDefaultY || (p[2] != null && p[2] > 0))

  return (
    <div className="space-y-1">
      {(label || hasChanges) && (
        <div className="flex items-center justify-between">
          {label ? <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span> : <span />}
          <button
            type="button"
            onClick={handleReset}
            disabled={!hasChanges}
            className="text-[10px] text-gray-500 hover:text-gray-300 disabled:text-gray-700"
            title="Reset to default"
          >
            reset
          </button>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="w-full rounded border border-gray-700 cursor-crosshair"
        style={{ width: '100%', height: 'auto', aspectRatio: `${aspect} / 1` }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredIdx(null)}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="text-[8px] text-gray-600">
        <span className="text-gray-500">Click</span> add · <span className="text-gray-500">Drag</span> move · <span className="text-gray-500">Shift-drag endpoint</span> match both · <span className="text-gray-500">Dbl-click</span> remove
      </div>
    </div>
  )
}
