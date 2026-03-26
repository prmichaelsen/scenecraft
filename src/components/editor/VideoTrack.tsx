import { useRef, useEffect, useCallback, type RefObject } from 'react'
import type { KeyframeWithTime } from './Timeline'

type VideoTrackProps = {
  keyframes: KeyframeWithTime[]
  pxPerSec: number
  projectName: string
  selectedId: string | null
  onKeyframeClick: (kf: KeyframeWithTime) => void
  onKeyframeDrag: (id: string, newTimeSeconds: number) => void
  onKeyframeDragEnd: (id: string, newTimeSeconds: number) => void
  scrollRef: RefObject<HTMLDivElement | null>
}

export function VideoTrack({
  keyframes,
  pxPerSec,
  projectName,
  selectedId,
  onKeyframeClick,
  onKeyframeDrag,
  onKeyframeDragEnd,
  scrollRef,
}: VideoTrackProps) {
  const dragState = useRef<{
    dragging: boolean
    keyframeId: string
    startX: number
    startTime: number
    prevKfTime: number
    nextKfTime: number
    didMove: boolean
  } | null>(null)

  const handleEdgeMouseDown = useCallback((e: React.MouseEvent, kf: KeyframeWithTime, idx: number) => {
    e.stopPropagation()
    e.preventDefault()

    // Clamp bounds: can't go before previous keyframe or after next
    const prevKf = idx > 0 ? keyframes[idx - 1] : null
    const nextKf = idx < keyframes.length - 1 ? keyframes[idx + 1] : null

    dragState.current = {
      dragging: true,
      keyframeId: kf.id,
      startX: e.clientX,
      startTime: kf.timeSeconds,
      prevKfTime: prevKf ? prevKf.timeSeconds + 0.1 : 0,
      nextKfTime: nextKf ? nextKf.timeSeconds - 0.1 : Infinity,
      didMove: false,
    }
  }, [keyframes])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const ds = dragState.current
      if (!ds?.dragging || !scrollRef.current) return

      const deltaX = e.clientX - ds.startX
      const deltaTime = deltaX / pxPerSec
      const newTime = Math.max(ds.prevKfTime, Math.min(ds.nextKfTime, ds.startTime + deltaTime))

      if (Math.abs(deltaX) > 2) {
        ds.didMove = true
      }

      onKeyframeDrag(ds.keyframeId, newTime)
    }

    const handleMouseUp = () => {
      const ds = dragState.current
      if (!ds?.dragging) return

      if (ds.didMove) {
        // Calculate final position from the drag
        const kf = keyframes.find((k) => k.id === ds.keyframeId)
        if (kf) {
          onKeyframeDragEnd(ds.keyframeId, kf.timeSeconds)
        }
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

  return (
    <div className="relative h-full overflow-visible">
      {keyframes.map((kf, i) => {
        const x = kf.timeSeconds * pxPerSec
        const nextKf = keyframes[i + 1]
        const nextX = nextKf ? nextKf.timeSeconds * pxPerSec : x + 60
        const width = Math.max(nextX - x, 2)
        const isSelected = kf.id === selectedId
        const isDragging = dragState.current?.keyframeId === kf.id

        return (
          <div
            key={kf.id}
            className={`absolute top-0 h-full group ${isSelected ? 'bg-blue-500/10' : ''}`}
            style={{ left: x, width }}
            onClick={(e) => {
              if (dragState.current?.didMove) return
              e.stopPropagation()
              onKeyframeClick(kf)
            }}
          >
            {/* Draggable left edge handle */}
            <div
              className={`absolute top-0 left-0 w-2 h-full cursor-col-resize z-30 group/edge ${isDragging ? 'bg-yellow-500/60' : 'hover:bg-yellow-500/40'}`}
              onMouseDown={(e) => handleEdgeMouseDown(e, kf, i)}
            >
              <div className={`w-px h-full ${isSelected ? 'bg-blue-500' : 'bg-gray-700'}`} />
            </div>

            {/* Thumbnail */}
            {kf.hasSelectedImage ? (
              <img
                src={`/api/files/${projectName}/selected_keyframes/${kf.id}.png`}
                alt={kf.id}
                className={`absolute top-1 left-3 h-[calc(100%-8px)] aspect-video object-cover rounded-sm transition-opacity ${isSelected ? 'opacity-100 ring-1 ring-blue-500' : 'opacity-70 group-hover:opacity-100'}`}
                loading="lazy"
                draggable={false}
              />
            ) : (
              <div className="absolute top-1 left-3 h-[calc(100%-8px)] aspect-video bg-gray-800/50 rounded-sm flex items-center justify-center">
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
