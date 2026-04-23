/**
 * InlineCurveEditor — reusable canvas-based curve editor.
 *
 * Extracted from TransitionPanel.tsx's AnimCurveEditor / OpacityCurveEditor
 * (M13 task-53, spec R37-R42).
 *
 * Renders a polyline with diamond keyframes. Supports:
 *   - click-to-add point
 *   - drag-to-move point (single or multi-select)
 *   - shift-click multi-select
 *   - double-click to delete
 *   - right-click to cycle interpolation (or per-point easing via onPointRightClick)
 *   - optional playhead indicator
 *   - optional endpoint locking (time-remap use case) and endpoint mirror on shift
 *
 * The component is stateless with respect to the curve data — parent owns `points`
 * and applies updates via `onChange`. Internal state covers only interaction
 * (dragging, hovering, selection, box-select).
 *
 * Color is assigned by the parent (R42 color map is parent responsibility).
 * Stacking multiple editors on the same lane is the parent's job (R41);
 * the component renders one curve per instance.
 *
 * ## Copy/paste integration (M13 task-56, spec R43-R47)
 *
 * When the parent supplies `selectedIndices` + `onSelectionChange` with
 * `multiSelect=true`, the parent can lift the selection into a cross-curve
 * / cross-track `SelectedKeyframe[]` and pass it to `useAutomationClipboard`.
 * The hook listens at window-level for Ctrl+C / Ctrl+V and handles
 * serialization, trackDelta resolution, and the single-undo-unit batch
 * POST to `/effect-curves/batch`.
 *
 * This component doesn't own the keyboard — it just reports selection to the
 * parent. See `src/components/editor/useAutomationClipboard.ts`.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import {
  evaluateCurve,
  getEasing,
  EASING_LABELS,
  type CurvePoint,
} from '@/lib/remap-curve'

export type Interpolation = 'bezier' | 'linear' | 'step'

const INTERPOLATION_CYCLE: Interpolation[] = ['bezier', 'linear', 'step']

export type InlineCurveEditorProps = {
  /** Curve points, each [x, y] or [x, y, easingType]. Parent owns this state. */
  points: CurvePoint[]
  /** Called with the full new points array whenever the user edits the curve. */
  onChange: (newPoints: CurvePoint[]) => void

  // ---- Interpolation (curve-level) ----
  /**
   * Curve-level interpolation mode. When supplied, right-clicking a diamond
   * calls `onInterpolationChange` with the next value in the cycle
   * (bezier -> linear -> step -> bezier). If you want per-point easing
   * cycling instead (legacy transition-panel behavior), leave this undefined
   * and pass `onPointRightClick`.
   */
  interpolation?: Interpolation
  onInterpolationChange?: (next: Interpolation) => void

  // ---- Visual ----
  color?: string
  /** Aspect ratio (width / height) used when rendered responsively. */
  aspect?: number
  /** Explicit height override; if omitted, height is derived from width/aspect. */
  height?: number
  /** Container class override for the wrapping div. */
  className?: string

  // ---- Coordinate system ----
  /** X-range (time) domain for the stored point values. Default [0, 1]. */
  timeRange?: [number, number]
  /** Y-range (value) domain. Default [0, 1]. */
  valueRange?: [number, number]
  /**
   * Visible x-window. If omitted, equals `timeRange` (editor shows the whole curve).
   * Use this to align with an external timeline scroll.
   */
  xWindow?: [number, number]

  // ---- Rendering options ----
  /** Show gridlines + axis labels. Default true. */
  showGrid?: boolean
  /** Label shown on the Y axis (rotated). */
  yLabel?: string
  /** 'diagonal' draws a 0->valueMax diagonal guide (time-remap); 'horizontal' draws a dashed line at a y-value; 'none' draws nothing. */
  referenceLine?: 'diagonal' | 'horizontal' | 'none'
  /** Y value for the horizontal reference line (in domain units). Default = valueRange max. */
  referenceLineY?: number
  /** Fill area under the curve with a tinted color. Default true. */
  fillUnderCurve?: boolean
  /** Render a 100% dashed reference line when `valueRange[1] > 1`. Default true. */
  showMaxReferenceLine?: boolean

  // ---- Playhead ----
  /** Current playback time (in timeRange units). If provided, a playhead marker draws. */
  playheadTime?: number

  // ---- Interaction options ----
  /** Click-on-empty-space adds a new point. Default true. */
  addOnClick?: boolean
  /** Lock endpoint movement. `{x:true}` pins x of endpoints; `{y:true}` pins y of endpoints (time-remap). */
  lockEndpoints?: { x?: boolean; y?: boolean }
  /** When dragging an endpoint with shift held, mirror its y to the other endpoint. Default false. */
  endpointMirrorOnShift?: boolean
  /** When non-null, right-clicking a diamond calls this instead of cycling interpolation. */
  onPointRightClick?: (idx: number, point: CurvePoint) => void
  /** Disable all interaction (still renders). */
  readOnly?: boolean
  /** Skip double-click delete on endpoints. Default true. */
  lockEndpointDelete?: boolean

  // ---- Multi-select ----
  /**
   * When true, shift-click toggles multi-selection; dragging any selected diamond
   * moves ALL selected diamonds by the same (Δt, Δv). Default false.
   */
  multiSelect?: boolean
  /** Controlled selection set; if omitted, component manages its own. */
  selectedIndices?: Set<number>
  onSelectionChange?: (set: Set<number>) => void

  // ---- Labels on hovered points ----
  /** Show a % readout near hovered/dragged diamonds. Default true. */
  showValueLabels?: boolean
  /** Formatter for the hover label. Default: percent. */
  formatValueLabel?: (value: number) => string

  /** Short hint text shown beneath the canvas. Default shows a sensible default; pass `null` to hide. */
  hintText?: string | null
}

const HIT_RADIUS = 6
const PAD = 10

/**
 * Helper: snap a sorted copy of `points` (parent caller passes pre-sorted already,
 * but internal render/hit-testing re-sorts to be safe).
 */
function sortPoints(pts: CurvePoint[]): CurvePoint[] {
  return [...pts].sort((a, b) => a[0] - b[0])
}

export function InlineCurveEditor(props: InlineCurveEditorProps) {
  const {
    points,
    onChange,
    interpolation,
    onInterpolationChange,
    color = '#0ea5e9',
    aspect = 3,
    height: heightProp,
    className = 'w-full rounded border border-gray-700 cursor-crosshair',
    timeRange = [0, 1],
    valueRange = [0, 1],
    xWindow,
    showGrid = true,
    yLabel,
    referenceLine = 'none',
    referenceLineY,
    fillUnderCurve = true,
    showMaxReferenceLine = true,
    playheadTime,
    addOnClick = true,
    lockEndpoints,
    endpointMirrorOnShift = false,
    onPointRightClick,
    readOnly = false,
    lockEndpointDelete = true,
    multiSelect = false,
    selectedIndices: controlledSelection,
    onSelectionChange,
    showValueLabels = true,
    formatValueLabel,
    hintText,
  } = props

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [dragAnchor, setDragAnchor] = useState<{ x: number; y: number; origPoints: CurvePoint[] } | null>(null)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [internalSelection, setInternalSelection] = useState<Set<number>>(new Set())
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({
    w: 240,
    h: heightProp ?? Math.round(240 / aspect),
  })
  const [boxSelect, setBoxSelect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  const selection = controlledSelection ?? internalSelection
  const setSelection = useCallback(
    (next: Set<number>) => {
      if (onSelectionChange) onSelectionChange(next)
      if (!controlledSelection) setInternalSelection(next)
    },
    [controlledSelection, onSelectionChange],
  )

  const W = canvasSize.w
  const H = canvasSize.h

  const [tMin, tMax] = timeRange
  const [vMin, vMax] = valueRange
  const [xwMin, xwMax] = xWindow ?? [tMin, tMax]

  // Coordinate conversion: curve-space (time/value in domain units) <-> canvas pixels.
  const toCanvas = useCallback(
    (x: number, y: number): [number, number] => {
      const xSpan = xwMax - xwMin || 1
      const ySpan = vMax - vMin || 1
      const px = PAD + ((x - xwMin) / xSpan) * (W - 2 * PAD)
      const py = H - PAD - ((y - vMin) / ySpan) * (H - 2 * PAD)
      return [px, py]
    },
    [W, H, xwMin, xwMax, vMin, vMax],
  )

  const fromCanvas = useCallback(
    (cx: number, cy: number): [number, number] => {
      const xSpan = xwMax - xwMin || 1
      const ySpan = vMax - vMin || 1
      const x = xwMin + ((cx - PAD) / (W - 2 * PAD)) * xSpan
      const y = vMin + ((H - PAD - cy) / (H - 2 * PAD)) * ySpan
      return [
        Math.max(tMin, Math.min(tMax, x)),
        Math.max(vMin, Math.min(vMax, y)),
      ]
    },
    [W, H, xwMin, xwMax, vMin, vMax, tMin, tMax],
  )

  const mouseToCanvas = useCallback((e: React.MouseEvent): [number, number] | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }, [])

  // ResizeObserver for responsive canvas. Only applied when heightProp is not set.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect
      if (width > 0) {
        setCanvasSize({
          w: width,
          h: heightProp ?? Math.round(width / aspect),
        })
      }
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [aspect, heightProp])

  // Canvas drawing.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, W, H)

    if (showGrid) {
      ctx.strokeStyle = '#333'
      ctx.lineWidth = 0.5
      for (let i = 0; i <= 4; i++) {
        const [x] = toCanvas(xwMin + (i / 4) * (xwMax - xwMin), vMin)
        const [, y] = toCanvas(xwMin, vMin + (i / 4) * (vMax - vMin))
        ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, H - PAD); ctx.stroke()
      }

      if (yLabel) {
        ctx.fillStyle = '#666'
        ctx.font = '8px monospace'
        ctx.textAlign = 'center'
        ctx.save()
        ctx.translate(8, H / 2)
        ctx.rotate(-Math.PI / 2)
        ctx.fillText(yLabel, 0, 0)
        ctx.restore()
      }

      ctx.fillStyle = '#555'
      ctx.font = '7px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(`${Math.round((vMin) * 100)}%`, PAD, H - PAD + 9)
      ctx.textAlign = 'right'
      ctx.fillText(`${Math.round(Math.min(1, vMax) * 100)}%`, W - PAD, H - PAD + 9)
      ctx.textAlign = 'left'
      ctx.fillText(`${Math.round(vMax * 100)}%`, 1, PAD + 3)
    }

    // Max reference line at y=1 when valueRange extends beyond 1.
    if (showMaxReferenceLine && vMax > 1) {
      const [, y100] = toCanvas(xwMin, 1)
      ctx.strokeStyle = '#444'
      ctx.lineWidth = 0.5
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(PAD, y100)
      ctx.lineTo(W - PAD, y100)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#444'
      ctx.font = '7px monospace'
      ctx.textAlign = 'left'
      ctx.fillText('100%', 1, y100 + 3)
    }

    // Reference line.
    if (referenceLine !== 'none') {
      ctx.strokeStyle = '#555'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      if (referenceLine === 'diagonal') {
        const [lx0, ly0] = toCanvas(xwMin, vMin)
        const [lx1, ly1] = toCanvas(xwMax, Math.min(vMax, 1))
        ctx.moveTo(lx0, ly0)
        ctx.lineTo(lx1, ly1)
      } else {
        const refY = referenceLineY ?? vMax
        const [lx0, ly0] = toCanvas(xwMin, refY)
        const [lx1] = toCanvas(xwMax, refY)
        ctx.moveTo(lx0, ly0)
        ctx.lineTo(lx1, ly0)
      }
      ctx.stroke()
      ctx.setLineDash([])
    }

    const sorted = sortPoints(points)

    // Draw curve polyline.
    // We always use the per-point easing (`getEasing`) because `evaluateCurve` is the shared
    // source-of-truth evaluator; curve-level `interpolation` affects what the parent writes
    // into new points but doesn't change how existing points are rendered.
    if (sorted.length >= 1) {
      const STEPS_PER_SEGMENT = 24
      const curvePath: [number, number][] = []
      for (let i = 0; i < sorted.length; i++) {
        if (i === 0) {
          curvePath.push(toCanvas(sorted[0][0], sorted[0][1]))
        } else {
          const [x0] = sorted[i - 1]
          const [x1, y1] = sorted[i]
          const easing = getEasing(sorted[i])
          if (easing === 0) {
            curvePath.push(toCanvas(x1, y1))
          } else {
            for (let s = 1; s <= STEPS_PER_SEGMENT; s++) {
              const t = s / STEPS_PER_SEGMENT
              // Pass [0, x1-x0] normalized — evaluateCurve expects linearProgress 0..1 of the whole curve,
              // so we reconstruct the absolute time for its binary search.
              const absT = x0 + t * (x1 - x0)
              const val = evaluateCurve(sorted, absT)
              curvePath.push(toCanvas(absT, val))
            }
          }
        }
      }

      ctx.strokeStyle = color + '66'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (let i = 0; i < curvePath.length; i++) {
        if (i === 0) ctx.moveTo(curvePath[i][0], curvePath[i][1])
        else ctx.lineTo(curvePath[i][0], curvePath[i][1])
      }
      ctx.stroke()

      if (fillUnderCurve && curvePath.length > 0) {
        ctx.fillStyle = color + '11'
        ctx.beginPath()
        const [bx0, by0] = toCanvas(sorted[0][0], vMin)
        ctx.moveTo(bx0, by0)
        for (const [cx, cy] of curvePath) ctx.lineTo(cx, cy)
        const [bxN, byN] = toCanvas(sorted[sorted.length - 1][0], vMin)
        ctx.lineTo(bxN, byN)
        ctx.closePath()
        ctx.fill()
      }
    }

    // Draw diamonds.
    for (let i = 0; i < sorted.length; i++) {
      const [cx, cy] = toCanvas(sorted[i][0], sorted[i][1])
      const isEndpoint = i === 0 || i === sorted.length - 1
      const isHovered = hoveredIdx === i
      const isDragging = draggingIdx === i
      const isSelected = selection.has(i)

      if (!isEndpoint) {
        const [, bottomY] = toCanvas(xwMin, vMin)
        ctx.strokeStyle = isDragging || isSelected ? color : isHovered ? color + 'aa' : color + '44'
        ctx.lineWidth = 1
        ctx.setLineDash([2, 2])
        ctx.beginPath()
        ctx.moveTo(cx, bottomY)
        ctx.lineTo(cx, cy)
        ctx.stroke()
        ctx.setLineDash([])
      }

      const r = isDragging ? 3.5 : isHovered || isSelected ? 3 : 2.5
      if (isEndpoint) {
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fillStyle = isDragging || isSelected ? color : isHovered ? color : '#555'
        ctx.fill()
        ctx.strokeStyle = isDragging || isSelected ? '#fff' : '#888'
        ctx.lineWidth = 0.5
        ctx.stroke()
      } else {
        ctx.beginPath()
        ctx.moveTo(cx, cy - r)
        ctx.lineTo(cx + r, cy)
        ctx.lineTo(cx, cy + r)
        ctx.lineTo(cx - r, cy)
        ctx.closePath()
        ctx.fillStyle = color
        ctx.fill()
        ctx.strokeStyle = isSelected ? '#fff' : '#fff'
        ctx.lineWidth = isSelected ? 1 : 0.5
        ctx.stroke()
      }

      if (showValueLabels && (isHovered || isDragging)) {
        ctx.fillStyle = color
        ctx.font = '7px monospace'
        ctx.textAlign = cx > W / 2 ? 'right' : 'left'
        const labelX = cx > W / 2 ? cx - 8 : cx + 8
        const labelText = formatValueLabel
          ? formatValueLabel(sorted[i][1])
          : `${Math.round(sorted[i][1] * 100)}%`
        ctx.fillText(labelText, labelX, cy + 3)
      }
      const ptEasing = getEasing(sorted[i])
      if (i > 0 && ptEasing > 0) {
        ctx.fillStyle = color + 'cc'
        ctx.font = 'bold 8px monospace'
        ctx.textAlign = 'center'
        ctx.fillText(EASING_LABELS[ptEasing] ?? '?', cx, cy - r - 3)
      }
    }

    // Box-select overlay.
    if (boxSelect) {
      const { x0, y0, x1, y1 } = boxSelect
      ctx.strokeStyle = color + 'aa'
      ctx.fillStyle = color + '22'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      const bx = Math.min(x0, x1)
      const by = Math.min(y0, y1)
      const bw = Math.abs(x1 - x0)
      const bh = Math.abs(y1 - y0)
      ctx.beginPath()
      ctx.rect(bx, by, bw, bh)
      ctx.fill()
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Playhead.
    if (playheadTime != null && sorted.length >= 2) {
      const clamped = Math.max(tMin, Math.min(tMax, playheadTime))
      const val = evaluateCurve(sorted, clamped)
      const [phx, phy] = toCanvas(clamped, val)
      const [, bottomY] = toCanvas(xwMin, vMin)
      const [, topY] = toCanvas(xwMin, vMax)

      ctx.strokeStyle = '#ffffff44'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(phx, topY)
      ctx.lineTo(phx, bottomY)
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(phx, phy, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#fff'
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [
    points, hoveredIdx, draggingIdx, selection, boxSelect,
    color, showGrid, yLabel, referenceLine, referenceLineY, fillUnderCurve,
    showMaxReferenceLine, playheadTime, formatValueLabel, showValueLabels,
    W, H, xwMin, xwMax, vMin, vMax, tMin, tMax, toCanvas,
  ])

  // Hit-test a canvas position against all diamonds. Returns sorted-index, or null.
  const hitTestPoint = useCallback(
    (cx: number, cy: number): number | null => {
      const sorted = sortPoints(points)
      for (let i = 0; i < sorted.length; i++) {
        const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
        if (Math.hypot(cx - px, cy - py) < HIT_RADIUS) return i
      }
      return null
    },
    [points, toCanvas],
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return
      if (e.button === 2) return // right-click handled by onContextMenu
      const pos = mouseToCanvas(e)
      if (!pos) return
      const sorted = sortPoints(points)
      const hitIdx = hitTestPoint(pos[0], pos[1])

      if (hitIdx !== null) {
        // Endpoint lock — refuse drag when both axes locked.
        if (
          lockEndpoints?.x && lockEndpoints?.y &&
          (hitIdx === 0 || hitIdx === sorted.length - 1)
        ) {
          return
        }
        // Multi-select via shift-click: toggle selection, don't drag.
        if (multiSelect && e.shiftKey) {
          const next = new Set(selection)
          if (next.has(hitIdx)) next.delete(hitIdx)
          else next.add(hitIdx)
          setSelection(next)
          return
        }
        setDraggingIdx(hitIdx)
        setDragAnchor({ x: pos[0], y: pos[1], origPoints: sorted })
        // If multi-select is on and the clicked point is in the selection,
        // the drag moves all selected. Otherwise clear selection + select this one implicitly.
        if (multiSelect && !selection.has(hitIdx)) {
          setSelection(new Set([hitIdx]))
        }
        return
      }

      // Empty-space click: either start box-select (shift) or add a new point.
      if (multiSelect && e.shiftKey) {
        setBoxSelect({ x0: pos[0], y0: pos[1], x1: pos[0], y1: pos[1] })
        return
      }
      if (multiSelect) {
        // Clear selection on plain click in empty space.
        setSelection(new Set())
      }
      if (!addOnClick) return
      const [nx, ny] = fromCanvas(pos[0], pos[1])
      const newPoints: CurvePoint[] = [...points, [nx, ny]]
      newPoints.sort((a, b) => a[0] - b[0])
      onChange(newPoints)
    },
    [
      readOnly, points, onChange, hitTestPoint, mouseToCanvas, fromCanvas,
      lockEndpoints, multiSelect, selection, setSelection, addOnClick,
    ],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const pos = mouseToCanvas(e)
      if (!pos) return

      if (boxSelect) {
        setBoxSelect({ ...boxSelect, x1: pos[0], y1: pos[1] })
        return
      }

      if (draggingIdx !== null && dragAnchor && !readOnly) {
        const sorted = dragAnchor.origPoints
        const [anchorX, anchorY] = fromCanvas(dragAnchor.x, dragAnchor.y)
        const [curX, curY] = fromCanvas(pos[0], pos[1])
        const dx = curX - anchorX
        const dy = curY - anchorY

        // Determine which indices move. If multi-select is on and the dragged
        // index is part of the selection, move all of them by (dx, dy).
        const movingIndices: Set<number> =
          multiSelect && selection.has(draggingIdx)
            ? new Set(selection)
            : new Set([draggingIdx])

        const next: CurvePoint[] = sorted.map((pt, i) => {
          if (!movingIndices.has(i)) return pt
          const isEndpoint = i === 0 || i === sorted.length - 1
          const lockX = (lockEndpoints?.x && isEndpoint) ?? false
          const lockY = (lockEndpoints?.y && isEndpoint) ?? false
          const newX = lockX ? pt[0] : Math.max(tMin, Math.min(tMax, pt[0] + dx))
          const newY = lockY ? pt[1] : Math.max(vMin, Math.min(vMax, pt[1] + dy))
          const easing = pt[2]
          return easing != null ? [newX, newY, easing] : [newX, newY]
        })

        // Clamp non-endpoint x-ordering: when a single point is dragged between its neighbors,
        // enforce minX/maxX so the sort order stays stable. When multi-dragging we allow the
        // group to cross neighbors (the parent will re-sort on save).
        if (movingIndices.size === 1) {
          const only = draggingIdx
          const prev = next[only - 1]?.[0]
          const succ = next[only + 1]?.[0]
          let x = next[only][0]
          if (prev != null && x < prev) x = prev
          if (succ != null && x > succ) x = succ
          next[only] = next[only][2] != null
            ? [x, next[only][1], next[only][2]!]
            : [x, next[only][1]]
        }

        // Endpoint mirror on shift.
        if (endpointMirrorOnShift && e.shiftKey && movingIndices.size === 1) {
          const i = draggingIdx
          const isEndpoint = i === 0 || i === sorted.length - 1
          if (isEndpoint && !lockEndpoints?.y) {
            const otherIdx = i === 0 ? sorted.length - 1 : 0
            const oe = next[otherIdx][2]
            next[otherIdx] = oe != null
              ? [next[otherIdx][0], next[i][1], oe]
              : [next[otherIdx][0], next[i][1]]
          }
        }

        onChange(next)
        return
      }

      if (!readOnly) {
        setHoveredIdx(hitTestPoint(pos[0], pos[1]))
      }
    },
    [
      readOnly, boxSelect, draggingIdx, dragAnchor, multiSelect, selection,
      mouseToCanvas, fromCanvas, hitTestPoint, onChange, tMin, tMax, vMin, vMax,
      lockEndpoints, endpointMirrorOnShift,
    ],
  )

  const handleMouseUp = useCallback(() => {
    if (boxSelect) {
      // Commit box-select: find diamonds inside the rect and set selection.
      const { x0, y0, x1, y1 } = boxSelect
      const rx0 = Math.min(x0, x1)
      const ry0 = Math.min(y0, y1)
      const rx1 = Math.max(x0, x1)
      const ry1 = Math.max(y0, y1)
      const sorted = sortPoints(points)
      const next = new Set<number>()
      for (let i = 0; i < sorted.length; i++) {
        const [cx, cy] = toCanvas(sorted[i][0], sorted[i][1])
        if (cx >= rx0 && cx <= rx1 && cy >= ry0 && cy <= ry1) next.add(i)
      }
      setSelection(next)
      setBoxSelect(null)
      return
    }
    if (draggingIdx !== null) {
      setDraggingIdx(null)
      setDragAnchor(null)
    }
  }, [boxSelect, draggingIdx, points, setSelection, toCanvas])

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return
      const pos = mouseToCanvas(e)
      if (!pos) return
      const hit = hitTestPoint(pos[0], pos[1])
      if (hit == null) return
      const sorted = sortPoints(points)
      if (lockEndpointDelete && (hit === 0 || hit === sorted.length - 1)) return
      const next = sorted.filter((_, j) => j !== hit)
      onChange(next)
      setHoveredIdx(null)
      if (multiSelect) {
        const s = new Set<number>()
        for (const idx of selection) {
          if (idx < hit) s.add(idx)
          else if (idx > hit) s.add(idx - 1)
        }
        setSelection(s)
      }
    },
    [readOnly, mouseToCanvas, hitTestPoint, lockEndpointDelete, points, onChange, multiSelect, selection, setSelection],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      if (readOnly) return
      const pos = mouseToCanvas(e)
      if (!pos) return
      const hit = hitTestPoint(pos[0], pos[1])
      if (hit == null) return
      const sorted = sortPoints(points)
      if (onPointRightClick) {
        onPointRightClick(hit, sorted[hit])
        return
      }
      if (interpolation != null && onInterpolationChange) {
        const curIdx = INTERPOLATION_CYCLE.indexOf(interpolation)
        const nextIdx = (curIdx + 1) % INTERPOLATION_CYCLE.length
        onInterpolationChange(INTERPOLATION_CYCLE[nextIdx])
      }
    },
    [readOnly, mouseToCanvas, hitTestPoint, points, onPointRightClick, interpolation, onInterpolationChange],
  )

  const handleMouseLeave = useCallback(() => {
    setHoveredIdx(null)
    if (boxSelect) setBoxSelect(null)
    if (draggingIdx !== null) {
      setDraggingIdx(null)
      setDragAnchor(null)
    }
  }, [boxSelect, draggingIdx])

  const defaultHint = 'Click add · Drag move · Dbl-click remove'
  const resolvedHint = hintText === null ? null : (hintText ?? defaultHint)

  return (
    <div className="space-y-1">
      <canvas
        ref={canvasRef}
        data-testid="inline-curve-editor-canvas"
        className={className}
        style={{
          width: '100%',
          height: heightProp != null ? `${heightProp}px` : 'auto',
          aspectRatio: heightProp != null ? undefined : `${aspect} / 1`,
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      />
      {resolvedHint != null && (
        <div className="text-[8px] text-gray-600">{resolvedHint}</div>
      )}
    </div>
  )
}

export default InlineCurveEditor
