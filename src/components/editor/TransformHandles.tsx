import { useRef, useEffect, useCallback, useState } from 'react'
import type { Transition } from '@/routes/project/$name/editor'
import { evaluateCurve } from '@/lib/remap-curve'

type TransformHandlesProps = {
  containerRef: React.RefObject<HTMLDivElement | null>
  transition: Transition | null
  linearProgress: number
  transformMode: boolean
  onCurvePinUpdate: (trId: string, curveKey: string, progress: number, value: number) => void
  onAnchorUpdate: (trId: string, anchorX: number, anchorY: number) => void
  onMaskCenterUpdate: (trId: string, cx: number, cy: number) => void
}

const HANDLE_SIZE = 8
const CROSSHAIR_SIZE = 20
const RING_SIZE = 12

type HandleType = 'position' | 'scale-tl' | 'scale-tr' | 'scale-bl' | 'scale-br' | 'mask-center'

export function TransformHandles({
  containerRef,
  transition: tr,
  linearProgress,
  transformMode,
  onCurvePinUpdate,
  onAnchorUpdate,
  onMaskCenterUpdate,
}: TransformHandlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const dragState = useRef<{
    type: HandleType
    startX: number
    startY: number
    startValX: number
    startValY: number
    isAlt: boolean
  } | null>(null)

  // Track container size
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setSize({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [containerRef])

  // Compute current transform values from curves at linearProgress
  const getTransformValues = useCallback(() => {
    if (!tr) return { x: 0, y: 0, scale: 1, anchorX: 0.5, anchorY: 0.5 }
    const p = linearProgress
    const x = tr.transformXCurve ? evaluateCurve(tr.transformXCurve, p) : (tr.transformX ?? 0)
    const y = tr.transformYCurve ? evaluateCurve(tr.transformYCurve, p) : (tr.transformY ?? 0)
    // The single scale handle drives uniform scale — read whichever curve
    // is present (both should match when the drag handle was the source
    // of the edit). Prefer ScaleX with ScaleY as fallback; if the two
    // have diverged (user dragged them independently in the curve
    // editor), display uses ScaleX which is the X-axis component.
    const scale = tr.transformScaleXCurve
      ? evaluateCurve(tr.transformScaleXCurve, p)
      : tr.transformScaleYCurve
        ? evaluateCurve(tr.transformScaleYCurve, p)
        : 1
    return {
      x, y, scale,
      anchorX: tr.anchorX ?? 0.5,
      anchorY: tr.anchorY ?? 0.5,
    }
  }, [tr, linearProgress])

  // Draw handles
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !transformMode || !tr || size.w === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    const vals = getTransformValues()
    const w = size.w
    const h = size.h

    // Bounding box corners: scale around anchor then offset by position
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => {
      const sx = (u - vals.anchorX) * vals.scale + vals.anchorX
      const sy = (v - vals.anchorY) * vals.scale + vals.anchorY
      return [(sx + vals.x) * w, (sy + vals.y) * h]
    })

    // Dashed bounding box
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(corners[0][0], corners[0][1])
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1])
    ctx.closePath()
    ctx.stroke()
    ctx.setLineDash([])

    // Scale corner handles
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.lineWidth = 1
    for (const [cx, cy] of corners) {
      ctx.fillRect(cx - HANDLE_SIZE / 2, cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
      ctx.strokeRect(cx - HANDLE_SIZE / 2, cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
    }

    // Position crosshair + ring at anchor (offset by position)
    const px = (vals.anchorX + vals.x) * w
    const py = (vals.anchorY + vals.y) * h
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(px - CROSSHAIR_SIZE / 2, py)
    ctx.lineTo(px + CROSSHAIR_SIZE / 2, py)
    ctx.moveTo(px, py - CROSSHAIR_SIZE / 2)
    ctx.lineTo(px, py + CROSSHAIR_SIZE / 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(px, py, RING_SIZE / 2, 0, Math.PI * 2)
    ctx.stroke()

    // Mask center (if mask active)
    if (tr.maskRadius != null) {
      const mx = (tr.maskCenterX ?? 0.5) * w
      const my = (tr.maskCenterY ?? 0.5) * h
      ctx.fillStyle = 'rgba(56, 189, 248, 0.8)'
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(mx, my, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }, [transformMode, tr, size, getTransformValues])

  // Hit test
  const hitTest = useCallback((ex: number, ey: number): HandleType | null => {
    if (!tr) return null
    const vals = getTransformValues()
    const w = size.w
    const h = size.h

    // Position handle
    const px = (vals.anchorX + vals.x) * w
    const py = (vals.anchorY + vals.y) * h
    if (Math.hypot(ex - px, ey - py) < CROSSHAIR_SIZE) return 'position'

    // Scale corners
    const cornerNames: HandleType[] = ['scale-tl', 'scale-tr', 'scale-br', 'scale-bl']
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => {
      const sx = (u - vals.anchorX) * vals.scale + vals.anchorX
      const sy = (v - vals.anchorY) * vals.scale + vals.anchorY
      return [(sx + vals.x) * w, (sy + vals.y) * h]
    })
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(ex - corners[i][0], ey - corners[i][1]) < HANDLE_SIZE * 1.5) return cornerNames[i]
    }

    // Mask center
    if (tr.maskRadius != null) {
      const mx = (tr.maskCenterX ?? 0.5) * w
      const my = (tr.maskCenterY ?? 0.5) * h
      if (Math.hypot(ex - mx, ey - my) < 10) return 'mask-center'
    }

    return null
  }, [tr, size, getTransformValues])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!transformMode || !tr) return
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    const ex = e.clientX - rect.left
    const ey = e.clientY - rect.top
    const hit = hitTest(ex, ey)
    if (!hit) return

    e.preventDefault()
    e.stopPropagation()

    const vals = getTransformValues()
    dragState.current = {
      type: hit,
      startX: e.clientX,
      startY: e.clientY,
      startValX: hit === 'position' ? vals.x : hit === 'mask-center' ? (tr.maskCenterX ?? 0.5) : vals.scale,
      startValY: hit === 'position' ? vals.y : hit === 'mask-center' ? (tr.maskCenterY ?? 0.5) : vals.scale,
      isAlt: e.altKey,
    }

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragState.current || !tr) return
      const dx = (ev.clientX - dragState.current.startX) / size.w
      const dy = (ev.clientY - dragState.current.startY) / size.h
      const ds = dragState.current

      if (ds.type === 'position') {
        if (ds.isAlt) {
          // Alt+drag: move anchor (static, not curve)
          const newAnchorX = Math.max(0, Math.min(1, (tr.anchorX ?? 0.5) + dx))
          const newAnchorY = Math.max(0, Math.min(1, (tr.anchorY ?? 0.5) + dy))
          onAnchorUpdate(tr.id, newAnchorX, newAnchorY)
        } else {
          // Normal drag: auto-keyframe position curves
          let newX = ds.startValX + dx
          let newY = ds.startValY + dy
          if (ev.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) newY = ds.startValY
            else newX = ds.startValX
          }
          onCurvePinUpdate(tr.id, 'transformXCurve', linearProgress, newX)
          onCurvePinUpdate(tr.id, 'transformYCurve', linearProgress, newY)
        }
      } else if (ds.type.startsWith('scale-')) {
        const vals = getTransformValues()
        const containerRect = containerRef.current?.getBoundingClientRect()
        const anchorPx = vals.anchorX * size.w
        const anchorPy = vals.anchorY * size.h
        const startDist = Math.hypot(ds.startX - (containerRect?.left ?? 0) - anchorPx, ds.startY - (containerRect?.top ?? 0) - anchorPy)
        const curDist = Math.hypot(ev.clientX - (containerRect?.left ?? 0) - anchorPx, ev.clientY - (containerRect?.top ?? 0) - anchorPy)
        if (startDist > 5) {
          const newScale = Math.max(0.01, ds.startValX * (curDist / startDist))
          // The single scale handle pins both axes to the same value —
          // preserves the pre-split "uniform scale" UX for the drag
          // handle; users wanting non-uniform scale use the curve
          // editor's Scale X / Scale Y tabs directly.
          onCurvePinUpdate(tr.id, 'transformScaleXCurve', linearProgress, newScale)
          onCurvePinUpdate(tr.id, 'transformScaleYCurve', linearProgress, newScale)
        }
      } else if (ds.type === 'mask-center') {
        const newX = Math.max(0, Math.min(1, ds.startValX + dx))
        const newY = Math.max(0, Math.min(1, ds.startValY + dy))
        onMaskCenterUpdate(tr.id, newX, newY)
      }
    }

    const handleMouseUp = () => {
      dragState.current = null
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [transformMode, tr, size, linearProgress, hitTest, getTransformValues, onCurvePinUpdate, onAnchorUpdate, onMaskCenterUpdate, containerRef])

  if (!transformMode || !tr) return null

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-auto cursor-crosshair"
      style={{ width: size.w, height: size.h }}
      onMouseDown={handleMouseDown}
    />
  )
}
