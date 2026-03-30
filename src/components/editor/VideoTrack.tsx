import { useRef, useEffect, useCallback, type RefObject } from 'react'
import type { KeyframeWithTime } from './Timeline'
import { beatlabFileUrl } from '@/lib/beatlab-client'

type VideoTrackProps = {
  keyframes: KeyframeWithTime[]
  pxPerSec: number
  projectName: string
  selectedId: string | null
  duration: number
  onKeyframeClick: (kf: KeyframeWithTime) => void
  onKeyframeDrag: (id: string, newTimeSeconds: number) => void
  onKeyframeDragEnd: (id: string, newTimeSeconds: number) => void
  scrollRef: RefObject<HTMLDivElement | null>
  scrollLeft: number
  viewportWidth: number
}

type DragState = {
  dragging: boolean
  type: 'edge' | 'reorder'
  keyframeId: string
  startX: number
  startTime: number
  minTime: number
  maxTime: number
  didMove: boolean
}

export function VideoTrack({
  keyframes,
  pxPerSec,
  projectName,
  selectedId,
  duration,
  onKeyframeClick,
  onKeyframeDrag,
  onKeyframeDragEnd,
  scrollRef,
  scrollLeft,
  viewportWidth,
}: VideoTrackProps) {
  const dragState = useRef<DragState | null>(null)
  const didDrag = useRef(false)

  const handleEdgeMouseDown = useCallback((e: React.MouseEvent, kf: KeyframeWithTime, idx: number) => {
    e.stopPropagation()
    e.preventDefault()
    const prevKf = idx > 0 ? keyframes[idx - 1] : null
    const nextKf = idx < keyframes.length - 1 ? keyframes[idx + 1] : null
    dragState.current = {
      dragging: true,
      type: 'edge',
      keyframeId: kf.id,
      startX: e.clientX,
      startTime: kf.timeSeconds,
      minTime: prevKf ? prevKf.timeSeconds + 0.1 : 0,
      maxTime: nextKf ? nextKf.timeSeconds - 0.1 : duration,
      didMove: false,
    }
  }, [keyframes, duration])

  const handleBodyMouseDown = useCallback((e: React.MouseEvent, kf: KeyframeWithTime) => {
    // Don't start body drag if clicking on the edge handle
    if ((e.target as HTMLElement).closest('[data-edge-handle]')) return
    e.stopPropagation()
    e.preventDefault()
    // Find neighbors for bounds
    const sortedKfs = [...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds)
    const idx = sortedKfs.findIndex((k) => k.id === kf.id)
    const prevKf = idx > 0 ? sortedKfs[idx - 1] : null
    const nextKf = idx < sortedKfs.length - 1 ? sortedKfs[idx + 1] : null
    dragState.current = {
      dragging: true,
      type: 'reorder',
      keyframeId: kf.id,
      startX: e.clientX,
      startTime: kf.timeSeconds,
      minTime: prevKf ? prevKf.timeSeconds + 0.1 : 0,
      maxTime: nextKf ? nextKf.timeSeconds - 0.1 : duration,
      didMove: false,
    }
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const ds = dragState.current
      if (!ds?.dragging || !scrollRef.current) return
      const deltaX = e.clientX - ds.startX
      const deltaTime = deltaX / pxPerSec
      const newTime = Math.max(ds.minTime, Math.min(ds.maxTime, ds.startTime + deltaTime))
      if (Math.abs(deltaX) > 2) { ds.didMove = true; didDrag.current = true }
      onKeyframeDrag(ds.keyframeId, newTime)
    }

    const handleMouseUp = () => {
      const ds = dragState.current
      if (!ds?.dragging) return
      if (ds.didMove) {
        const kf = keyframes.find((k) => k.id === ds.keyframeId)
        if (kf) onKeyframeDragEnd(ds.keyframeId, kf.timeSeconds)
      }
      dragState.current = null
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [pxPerSec, onKeyframeDrag, onKeyframeDragEnd, keyframes, scrollRef])

  const BUFFER_PX = 300

  return (
    <div className="relative h-full overflow-visible">
      {keyframes.map((kf, i) => {
        const x = kf.timeSeconds * pxPerSec
        const nextKf = keyframes[i + 1]
        const nextX = nextKf ? nextKf.timeSeconds * pxPerSec : x + 60
        const width = Math.max(nextX - x, 2)
        // Viewport culling: skip keyframes outside visible range
        if (nextX < scrollLeft - BUFFER_PX || x > scrollLeft + viewportWidth + BUFFER_PX) return null
        const isSelected = kf.id === selectedId
        const ds = dragState.current
        const isDraggingEdge = ds?.keyframeId === kf.id && ds?.type === 'edge'
        const isDraggingBody = ds?.keyframeId === kf.id && ds?.type === 'reorder'

        return (
          <div
            key={kf.id}
            className={`absolute top-0 h-full group ${isSelected ? 'bg-blue-500/10' : ''} ${isDraggingBody ? 'opacity-80 z-40' : ''}`}
            style={{ left: x, width }}
            onMouseDown={(e) => handleBodyMouseDown(e, kf)}
            onClick={(e) => {
              if (didDrag.current) { didDrag.current = false; return }
              e.stopPropagation()
              onKeyframeClick(kf)
            }}
          >
            {/* Draggable left edge handle */}
            <div
              data-edge-handle
              className={`absolute top-0 left-0 w-2 h-full cursor-col-resize z-30 ${isDraggingEdge ? 'bg-yellow-500/60' : 'hover:bg-yellow-500/40'}`}
              onMouseDown={(e) => handleEdgeMouseDown(e, kf, i)}
            >
              <div className={`w-px h-full ${isSelected ? 'bg-blue-500' : 'bg-gray-700'}`} />
            </div>

            {/* Thumbnail — skip when region is too narrow to see it */}
            {kf.hasSelectedImage && width > 20 ? (
              <img
                src={`${beatlabFileUrl(projectName, `selected_keyframes/${kf.id}.png`)}?v=${kf.selected ?? 0}`}
                alt={kf.id}
                className={`absolute top-1 left-3 h-[calc(100%-8px)] aspect-video object-cover rounded-sm transition-opacity cursor-grab active:cursor-grabbing ${isSelected ? 'opacity-100 ring-1 ring-blue-500' : 'opacity-70 group-hover:opacity-100'}`}
                loading="lazy"
                draggable={false}
              />
            ) : (
              <div className="absolute top-1 left-3 h-[calc(100%-8px)] aspect-video bg-gray-800/50 rounded-sm flex items-center justify-center cursor-grab active:cursor-grabbing">
                <span className="text-[8px] text-gray-600">{kf.id}</span>
              </div>
            )}

            {/* Section label */}
            <div className="absolute bottom-0.5 left-3 text-[8px] text-gray-500 truncate max-w-[60px]">
              {kf.section}
            </div>

            {/* Hover tooltip */}
            <div className="absolute top-full left-0 mt-1 hidden group-hover:block bg-gray-800 text-xs text-gray-300 px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none">
              {kf.id} @ {formatTimestamp(kf.timeSeconds)} — {kf.section}
              <span className="text-gray-500 ml-1">
                ({formatDuration(nextKf ? nextKf.timeSeconds - kf.timeSeconds : 0)})
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  const whole = Math.floor(s)
  const frac = s - whole
  if (frac < 0.005) {
    return `${m}:${whole.toString().padStart(2, '0')}`
  }
  return `${m}:${whole.toString().padStart(2, '0')}.${Math.round(frac * 100).toString().padStart(2, '0')}`
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m${Math.round(s)}s`
}
