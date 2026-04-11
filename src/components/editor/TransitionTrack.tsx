import { useRef, useState, useCallback } from 'react'
import type { KeyframeWithTime } from './Timeline'
import type { Transition } from '@/routes/project/$name/editor'

type TransitionTrackProps = {
  transitions: Transition[]
  keyframes: KeyframeWithTime[]
  pxPerSec: number
  selectedId: string | null
  duration: number
  onTransitionClick: (tr: Transition, shiftKey?: boolean) => void
  selectedIds?: Set<string>
  onBoundaryDrag: (keyframeId: string, newTimeSeconds: number) => void
  onBoundaryDragEnd: (keyframeId: string, newTimeSeconds: number) => void
  onRemapChange: (transitionId: string, targetDuration: number) => void
  onRetryRender?: (tr: Transition) => void
  onDropVideo?: (transitionId: string, poolPath: string, sourceTransitionId?: string) => void
  renderProgress?: Record<string, number>
  scrollLeft: number
  viewportWidth: number
  isActiveTrack?: boolean
}

export function TransitionTrack({
  transitions,
  keyframes,
  pxPerSec,
  selectedId,
  onTransitionClick,
  selectedIds,
  onBoundaryDrag,
  onBoundaryDragEnd,
  onRemapChange,
  onRetryRender,
  onDropVideo,
  renderProgress,
  duration,
  scrollLeft,
  viewportWidth,
  isActiveTrack,
}: TransitionTrackProps) {
  const kfMap = new Map(keyframes.map((kf) => [kf.id, kf]))
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragState = useRef<{ dragging: boolean; keyframeId: string; transitionId: string; otherKfTime: number; startX: number; startTime: number; minTime: number; maxTime: number } | null>(null)
  const didDrag = useRef(false)

  const handleEdgeDown = useCallback((e: React.MouseEvent, keyframeId: string, transitionId: string, otherKfTime: number, currentTime: number, minTime: number, maxTime: number) => {
    e.stopPropagation()
    e.preventDefault()
    dragState.current = { dragging: true, keyframeId, transitionId, otherKfTime, startX: e.clientX, startTime: currentTime, minTime, maxTime }
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
        console.log(`[TransitionTrack] mouseUp ${dragState.current.keyframeId}: startTime=${dragState.current.startTime.toFixed(2)} deltaX=${deltaX} pxPerSec=${pxPerSec} rawTime=${(dragState.current.startTime + deltaX / pxPerSec).toFixed(2)} clampedTime=${newTime.toFixed(2)} min=${dragState.current.minTime.toFixed(2)} max=${dragState.current.maxTime.toFixed(2)}`)
        onBoundaryDragEnd(dragState.current.keyframeId, newTime)
        // Compute new timeline duration and update remap
        const newDuration = Math.abs(newTime - dragState.current.otherKfTime)
        onRemapChange(dragState.current.transitionId, newDuration)
      }
      dragState.current = null
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [pxPerSec, onBoundaryDrag, onBoundaryDragEnd])

  const BUFFER_PX = 300

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
        // Viewport culling
        if (endX < scrollLeft - BUFFER_PX || x > scrollLeft + viewportWidth + BUFFER_PX) return null

        const isSelected = tr.id === selectedId || (selectedIds?.has(tr.id) ?? false)
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
            {/* Render progress bar */}
            {renderProgress?.[tr.id] != null && (() => {
              const p = renderProgress[tr.id] ?? 0
              const done = p >= 1
              return (
                <div
                  className={`absolute top-0 left-0 right-0 h-6 ${done ? 'bg-sky-900/30' : 'bg-red-900/30'} rounded overflow-hidden pointer-events-auto cursor-pointer shadow-[0_2px_4px_rgba(0,0,0,0.3)]`}
                  onClick={(e) => { e.stopPropagation(); onRetryRender?.(tr) }}
                  title="Click to retry frame decode"
                >
                  <div
                    className={`h-full rounded transition-[width] duration-200 ${done ? 'bg-sky-400/50 shadow-[0_0_6px_rgba(56,189,248,0.4)]' : 'bg-red-500/50 shadow-[0_0_6px_rgba(239,68,68,0.4)]'}`}
                    style={{ width: `${p * 100}%` }}
                  />
                </div>
              )
            })()}

            {/* Duration label above transition bar */}
            {width > 30 && (
              <div className="absolute bottom-3 left-0 right-0 flex items-center justify-center pointer-events-none">
                <span className="text-[8px] font-mono text-gray-600">{timelineDur.toFixed(2)}s</span>
              </div>
            )}

            {/* Transition bar */}
            <div
              className={`absolute bottom-0 left-0 right-0 h-3 rounded-t-sm cursor-pointer pointer-events-auto transition-colors border-t ${
                dropTarget === tr.id
                  ? 'bg-green-500/30 border-green-500/60 ring-1 ring-green-500'
                  : tr.hidden
                    ? `bg-yellow-500/10 hover:bg-yellow-500/15 border-yellow-500/20 border-dashed ${isSelected ? 'ring-1 ring-yellow-500' : ''}`
                    : `bg-orange-500/15 hover:bg-orange-500/25 border-orange-500/30 ${isSelected ? 'ring-1 ring-orange-500' : ''}`
              }`}
              onClick={(e) => {
                if (didDrag.current) { didDrag.current = false; return }
                e.stopPropagation()
                onTransitionClick(tr, e.shiftKey)
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/x-beatlab-pool-path')) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                  setDropTarget(tr.id)
                }
              }}
              onDragLeave={() => setDropTarget((prev) => prev === tr.id ? null : prev)}
              onDrop={(e) => {
                e.preventDefault()
                setDropTarget(null)
                const poolPath = e.dataTransfer.getData('application/x-beatlab-pool-path')
                const sourceTrId = e.dataTransfer.getData('application/x-beatlab-source-tr')
                if (poolPath && onDropVideo) {
                  onDropVideo(tr.id, poolPath, sourceTrId || undefined)
                }
              }}
            >
              {/* Left edge drag handle — only interactive on active track */}
              {isActiveTrack !== false && (
                <div
                  className="absolute top-0 left-0 w-2 h-full cursor-col-resize hover:bg-orange-500/40 pointer-events-auto z-10"
                  onMouseDown={(e) => {
                    const prevKf = fromIdx > 0 ? sortedKfs[fromIdx - 1] : null
                    handleEdgeDown(e, tr.from, tr.id, toKf.timeSeconds, fromKf.timeSeconds, prevKf ? prevKf.timeSeconds + 0.1 : 0, toKf.timeSeconds - 0.1)
                  }}
                />
              )}

              {/* Right edge drag handle — only interactive on active track */}
              {isActiveTrack !== false && (
                <div
                  className="absolute top-0 right-0 w-2 h-full cursor-col-resize hover:bg-orange-500/40 pointer-events-auto z-10"
                  onMouseDown={(e) => {
                    const nextKf = toIdx < sortedKfs.length - 1 ? sortedKfs[toIdx + 1] : null
                    handleEdgeDown(e, tr.to, tr.id, fromKf.timeSeconds, toKf.timeSeconds, fromKf.timeSeconds + 0.1, nextKf ? nextKf.timeSeconds - 0.1 : (duration || Infinity))
                  }}
                />
              )}

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
              {tr.id}: {tr.from} → {tr.to} ({timelineDur.toFixed(2)}s on timeline, {tr.durationSeconds.toFixed(2)}s video)
              {speed && <span className="text-orange-400 ml-1">{speed}x</span>}
              {hasCandidates && <span className="text-orange-400 ml-1">{Object.values(tr.candidates).reduce((s, a) => s + a.length, 0)} videos</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
