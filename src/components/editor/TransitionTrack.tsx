import { useRef, useCallback } from 'react'
import type { KeyframeWithTime } from './Timeline'
import type { Transition } from '@/routes/project/$name/editor'

type TransitionTrackProps = {
  transitions: Transition[]
  keyframes: KeyframeWithTime[]
  pxPerSec: number
  selectedId: string | null
  onTransitionClick: (tr: Transition) => void
  onBoundaryDrag: (keyframeId: string, newTimeSeconds: number) => void
  onBoundaryDragEnd: (keyframeId: string, newTimeSeconds: number) => void
}

export function TransitionTrack({
  transitions,
  keyframes,
  pxPerSec,
  selectedId,
  onTransitionClick,
  onBoundaryDrag,
  onBoundaryDragEnd,
}: TransitionTrackProps) {
  const kfMap = new Map(keyframes.map((kf) => [kf.id, kf]))
  const dragState = useRef<{ dragging: boolean; keyframeId: string; startX: number; startTime: number; minTime: number; maxTime: number } | null>(null)
  const didDrag = useRef(false)

  const handleEdgeDown = useCallback((e: React.MouseEvent, keyframeId: string, currentTime: number, minTime: number, maxTime: number) => {
    e.stopPropagation()
    e.preventDefault()
    dragState.current = { dragging: true, keyframeId, startX: e.clientX, startTime: currentTime, minTime, maxTime }
    didDrag.current = false

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragState.current?.dragging) return
      const deltaX = ev.clientX - dragState.current.startX
      if (Math.abs(deltaX) > 2) didDrag.current = true
      const newTime = Math.max(dragState.current.minTime, Math.min(dragState.current.maxTime, dragState.current.startTime + deltaX / pxPerSec))
      onBoundaryDrag(dragState.current.keyframeId, newTime)
    }

    const handleMouseUp = (ev: MouseEvent) => {
      if (didDrag.current && dragState.current) {
        const deltaX = ev.clientX - dragState.current.startX
        const newTime = Math.max(dragState.current.minTime, Math.min(dragState.current.maxTime, dragState.current.startTime + deltaX / pxPerSec))
        onBoundaryDragEnd(dragState.current.keyframeId, newTime)
      }
      dragState.current = null
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [pxPerSec, onBoundaryDrag, onBoundaryDragEnd])

  return (
    <div className="absolute inset-0 pointer-events-none overflow-visible">
      {transitions.map((tr) => {
        const fromKf = kfMap.get(tr.from)
        const toKf = kfMap.get(tr.to)
        if (!fromKf || !toKf) return null

        const x = fromKf.timeSeconds * pxPerSec + 3
        const endX = toKf.timeSeconds * pxPerSec
        const width = endX - x
        if (width <= 0) return null

        const isSelected = tr.id === selectedId
        const hasCandidates = Object.values(tr.candidates).some((arr) => arr.length > 0)

        // Compute speed for display
        const timelineDur = toKf.timeSeconds - fromKf.timeSeconds
        const speed = tr.durationSeconds > 0 && timelineDur > 0 ? (tr.durationSeconds / timelineDur).toFixed(2) : null

        // Find neighboring keyframes for drag bounds
        const sortedKfs = [...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds)
        const fromIdx = sortedKfs.findIndex((k) => k.id === tr.from)
        const toIdx = sortedKfs.findIndex((k) => k.id === tr.to)

        return (
          <div
            key={tr.id}
            className={`absolute top-0 h-full pointer-events-none group ${isSelected ? 'z-20' : 'z-10'}`}
            style={{ left: x, width }}
          >
            {/* Transition bar */}
            <div
              className={`absolute bottom-0 left-0 right-0 h-3 rounded-t-sm cursor-pointer pointer-events-auto transition-colors bg-orange-500/15 hover:bg-orange-500/25 border-t border-orange-500/30 ${
                isSelected ? 'ring-1 ring-orange-500' : ''
              }`}
              onClick={(e) => {
                if (didDrag.current) { didDrag.current = false; return }
                e.stopPropagation()
                onTransitionClick(tr)
              }}
            >
              {/* Left edge drag handle */}
              <div
                className="absolute top-0 left-0 w-2 h-full cursor-col-resize hover:bg-orange-500/40 pointer-events-auto z-10"
                onMouseDown={(e) => {
                  const prevKf = fromIdx > 0 ? sortedKfs[fromIdx - 1] : null
                  handleEdgeDown(e, tr.from, fromKf.timeSeconds, prevKf ? prevKf.timeSeconds + 0.1 : 0, toKf.timeSeconds - 0.1)
                }}
              />

              {/* Right edge drag handle */}
              <div
                className="absolute top-0 right-0 w-2 h-full cursor-col-resize hover:bg-orange-500/40 pointer-events-auto z-10"
                onMouseDown={(e) => {
                  const nextKf = toIdx < sortedKfs.length - 1 ? sortedKfs[toIdx + 1] : null
                  handleEdgeDown(e, tr.to, toKf.timeSeconds, fromKf.timeSeconds + 0.1, nextKf ? nextKf.timeSeconds - 0.1 : Infinity)
                }}
              />

              {/* Label */}
              {width > 50 && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className={`text-[7px] font-mono truncate px-1 ${isSelected ? 'text-orange-300' : 'text-gray-500'}`}>
                    {tr.id}{speed && speed !== '1.00' ? ` ${speed}x` : ''}
                  </span>
                </div>
              )}
            </div>

            {/* Hover tooltip */}
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-gray-800 text-xs text-gray-300 px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none">
              {tr.id}: {tr.from} → {tr.to} ({timelineDur.toFixed(1)}s on timeline, {tr.durationSeconds.toFixed(1)}s video)
              {speed && <span className="text-orange-400 ml-1">{speed}x</span>}
              {hasCandidates && <span className="text-orange-400 ml-1">{Object.values(tr.candidates).reduce((s, a) => s + a.length, 0)} videos</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
