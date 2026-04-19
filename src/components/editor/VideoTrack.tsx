import { useRef, useState, useEffect, useCallback, memo, type RefObject } from 'react'
import type { KeyframeWithTime } from './Timeline'
import { scenecraftFileUrl } from '@/lib/scenecraft-client'

type VideoTrackProps = {
  keyframes: KeyframeWithTime[]
  pxPerSec: number
  projectName: string
  selectedId: string | null
  selectedIds: Set<string>
  duration: number
  onKeyframeClick: (kf: KeyframeWithTime, shiftKey?: boolean) => void
  onKeyframeDrag: (id: string, newTimeSeconds: number) => void
  onKeyframeDragEnd: (id: string, newTimeSeconds: number) => void
  scrollRef: RefObject<HTMLDivElement | null>
  scrollLeft: number
  viewportWidth: number
  onDropVideo?: (keyframeId: string, poolPath: string) => void
  onDropImage?: (keyframeId: string, imagePath: string) => void
  onDropStagedImage?: (keyframeId: string, stagingId: string, variant: number) => void
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

export const VideoTrack = memo(function VideoTrack({
  keyframes,
  pxPerSec,
  projectName,
  selectedId,
  selectedIds,
  duration,
  onKeyframeClick,
  onKeyframeDrag,
  onKeyframeDragEnd,
  scrollRef,
  scrollLeft,
  viewportWidth,
  onDropVideo,
  onDropImage,
  onDropStagedImage,
}: VideoTrackProps) {
  const dragState = useRef<DragState | null>(null)
  const didDrag = useRef(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const handleEdgeMouseDown = useCallback((e: React.MouseEvent, kf: KeyframeWithTime, idx: number) => {
    e.stopPropagation()
    e.preventDefault()
    const prevKf = idx > 0 ? keyframes[idx - 1] : null
    const nextKf = idx < keyframes.length - 1 ? keyframes[idx + 1] : null
    let edgeMin = prevKf ? prevKf.timeSeconds + 0.1 : 0
    let edgeMax = nextKf ? nextKf.timeSeconds - 0.1 : duration
    if (edgeMin > kf.timeSeconds) edgeMin = Math.max(0, kf.timeSeconds - 30)
    if (edgeMax < kf.timeSeconds) edgeMax = kf.timeSeconds + 30
    dragState.current = {
      dragging: true,
      type: 'edge',
      keyframeId: kf.id,
      startX: e.clientX,
      startTime: kf.timeSeconds,
      minTime: edgeMin,
      maxTime: edgeMax,
      didMove: false,
    }
  }, [keyframes, duration])

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

    const handleMouseUp = (e: MouseEvent) => {
      const ds = dragState.current
      if (!ds?.dragging) return
      if (ds.didMove) {
        const deltaX = e.clientX - ds.startX
        const newTime = Math.max(ds.minTime, Math.min(ds.maxTime, ds.startTime + deltaX / pxPerSec))
        onKeyframeDragEnd(ds.keyframeId, newTime)
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
        const isMultiSelected = selectedIds.has(kf.id)
        const ds = dragState.current
        const isDraggingEdge = ds?.keyframeId === kf.id && ds?.type === 'edge'
        const isDraggingBody = ds?.keyframeId === kf.id && ds?.type === 'reorder'
        const isDragging = isDraggingEdge || isDraggingBody
        // Show durations on this kf and the one before when dragging
        const isPrevOfDragged = ds?.dragging && nextKf && ds.keyframeId === nextKf.id
        const showDuration = isDragging || isPrevOfDragged
        const dur = nextKf ? nextKf.timeSeconds - kf.timeSeconds : 0

        return (
          <div
            key={kf.id}
            className={`absolute top-0 h-full group ${dropTarget === kf.id ? 'bg-green-500/20 ring-1 ring-green-500' : ''} ${isSelected ? 'bg-blue-500/10' : ''} ${isMultiSelected ? 'bg-teal-500/30 ring-1 ring-teal-500/50' : ''} ${isDraggingBody ? 'opacity-80 z-40' : ''}`}
            style={{ left: x, width }}
            onClick={(e) => {
              if (didDrag.current) { didDrag.current = false; return }
              e.stopPropagation()
              onKeyframeClick(kf, e.shiftKey)
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-scenecraft-pool-path') || e.dataTransfer.types.includes('application/x-scenecraft-staging-path')) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDropTarget(kf.id)
              }
            }}
            onDragLeave={() => setDropTarget((prev) => prev === kf.id ? null : prev)}
            onDrop={(e) => {
              e.preventDefault()
              setDropTarget(null)
              const poolPath = e.dataTransfer.getData('application/x-scenecraft-pool-path')
              if (poolPath) {
                const isImage = /\.(png|jpg|jpeg|webp)$/i.test(poolPath)
                if (isImage && onDropImage) {
                  onDropImage(kf.id, poolPath)
                } else if (!isImage && onDropVideo) {
                  onDropVideo(kf.id, poolPath)
                }
                return
              }
              const stagingId = e.dataTransfer.getData('application/x-scenecraft-staging-id')
              const variant = e.dataTransfer.getData('application/x-scenecraft-variant')
              if (stagingId && variant && onDropStagedImage) {
                onDropStagedImage(kf.id, stagingId, parseInt(variant, 10))
              }
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
                src={`${scenecraftFileUrl(projectName, `selected_keyframes/${kf.id}.png`)}?v=${kf.selected ?? 0}`}
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

            {/* KF ID */}
            <div className="absolute top-0.5 right-0.5 text-[7px] text-gray-500/70 font-mono pointer-events-none">{kf.id.replace('kf_', '')}</div>

            {/* Label / section */}
            <div className="absolute bottom-0.5 left-3 text-[8px] truncate max-w-[80px]" style={kf.labelColor ? { color: kf.labelColor } : undefined}>
              {kf.label ? (
                <span className="font-medium">{kf.label}</span>
              ) : (
                <span className="text-gray-500">{kf.section}</span>
              )}
            </div>

            {/* Duration overlay during drag */}
            {showDuration && (
              <div className="absolute top-0 left-1/2 -translate-x-1/2 bg-black/80 text-yellow-300 text-[10px] font-mono px-1.5 py-0.5 rounded-b z-50 pointer-events-none whitespace-nowrap">
                {formatDuration(dur)}
              </div>
            )}

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
})

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
