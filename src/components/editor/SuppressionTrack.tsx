import { useCallback, useRef, memo } from 'react'
import type { BeatSuppression, EffectType } from '@/lib/beatlab-client'

const EFFECT_DOT_COLORS: Record<EffectType, string> = {
  pulse: 'bg-yellow-500',
  zoom: 'bg-blue-500',
  shake: 'bg-red-500',
  glow: 'bg-purple-500',
  flash: 'bg-white',
  echo: 'bg-teal-500',
}

type SuppressionTrackProps = {
  suppressions: BeatSuppression[]
  pxPerSec: number
  onAddSuppression: (from: number, to: number) => void
  onResizeSuppression: (id: string, from: number, to: number) => void
  selectedSuppressionId: string | null
  selectedSuppressionIds: Set<string>
  onSuppressionClick: (id: string, shiftKey?: boolean) => void
  scrollLeft: number
  viewportWidth: number
}

export const SuppressionTrack = memo(function SuppressionTrack({
  suppressions,
  pxPerSec,
  onAddSuppression,
  onResizeSuppression,
  selectedSuppressionId,
  selectedSuppressionIds,
  onSuppressionClick,
  scrollLeft,
  viewportWidth,
}: SuppressionTrackProps) {
  const BUFFER_PX = 300
  const dragRef = useRef<{ startTime: number; rect: DOMRect } | null>(null)

  // Click+drag to create suppression zone (no modifier key needed on this track)
  const handleTrackMouseDown = useCallback((e: React.MouseEvent) => {
    // Only create on primary button, no modifier needed since this is the dedicated track
    if (e.button !== 0) return
    // Don't start drag if clicking on a suppression zone
    if ((e.target as HTMLElement).closest('[data-suppression]')) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const startTime = x / pxPerSec

    dragRef.current = { startTime, rect }

    const handleMouseUp = (ev: MouseEvent) => {
      if (dragRef.current) {
        const endX = ev.clientX - dragRef.current.rect.left
        const endTime = endX / pxPerSec
        const from = Math.min(dragRef.current.startTime, endTime)
        const to = Math.max(dragRef.current.startTime, endTime)
        if (to - from > 0.1) {
          onAddSuppression(from, to)
        }
        dragRef.current = null
      }
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mouseup', handleMouseUp)
  }, [pxPerSec, onAddSuppression, scrollLeft])

  return (
    <div
      className="relative h-full overflow-visible cursor-crosshair"
      onMouseDown={handleTrackMouseDown}
    >
      {suppressions.map((s) => {
        const leftPx = s.from * pxPerSec
        const rightPx = s.to * pxPerSec
        if (rightPx < scrollLeft - BUFFER_PX || leftPx > scrollLeft + viewportWidth + BUFFER_PX) return null
        const isSelected = s.id === selectedSuppressionId
        const isMultiSelected = selectedSuppressionIds.has(s.id)
        const widthPx = (s.to - s.from) * pxPerSec
        const hasTypeFilter = s.effectTypes && s.effectTypes.length > 0
        return (
          <div
            key={s.id}
            data-suppression
            className={`absolute top-0 h-full pointer-events-auto cursor-pointer ${isSelected ? 'bg-red-900/30 border-l-2 border-r-2 border-red-500' : isMultiSelected ? 'bg-red-900/30 border-l-2 border-r-2 border-teal-500' : 'bg-red-900/15 border-l border-r border-red-800/30 hover:bg-red-900/25'}`}
            style={{
              left: leftPx,
              width: widthPx,
            }}
            title={`Suppressed: ${s.from.toFixed(1)}s - ${s.to.toFixed(1)}s${hasTypeFilter ? ` (${s.effectTypes!.join(', ')})` : ' (all)'}`}
            onClick={(e) => { e.stopPropagation(); onSuppressionClick(s.id, e.shiftKey) }}
          >
            {/* Type indicator dots */}
            {widthPx > 30 && (
              <div className="absolute top-0.5 left-1/2 -translate-x-1/2 flex gap-0.5 pointer-events-none">
                {hasTypeFilter ? (
                  s.effectTypes!.map((t) => (
                    <div key={t} className={`w-1.5 h-1.5 rounded-full ${EFFECT_DOT_COLORS[t]} opacity-70`} />
                  ))
                ) : (
                  <span className="text-[7px] text-red-400/60 font-mono">ALL</span>
                )}
              </div>
            )}


            {/* Resize handles */}
            <div
              className="absolute top-0 left-0 w-2 h-full cursor-col-resize hover:bg-red-500/40 z-10"
              onMouseDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                const startX = e.clientX
                const origFrom = s.from
                const handleMove = (ev: MouseEvent) => {
                  const delta = (ev.clientX - startX) / pxPerSec
                  const newFrom = Math.max(0, Math.min(s.to - 0.1, origFrom + delta))
                  onResizeSuppression(s.id, newFrom, s.to)
                }
                const handleUp = () => {
                  document.removeEventListener('mousemove', handleMove)
                  document.removeEventListener('mouseup', handleUp)
                }
                document.addEventListener('mousemove', handleMove)
                document.addEventListener('mouseup', handleUp)
              }}
            />
            <div
              className="absolute top-0 right-0 w-2 h-full cursor-col-resize hover:bg-red-500/40 z-10"
              onMouseDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                const startX = e.clientX
                const origTo = s.to
                const handleMove = (ev: MouseEvent) => {
                  const delta = (ev.clientX - startX) / pxPerSec
                  const newTo = Math.max(s.from + 0.1, origTo + delta)
                  onResizeSuppression(s.id, s.from, newTo)
                }
                const handleUp = () => {
                  document.removeEventListener('mousemove', handleMove)
                  document.removeEventListener('mouseup', handleUp)
                }
                document.addEventListener('mousemove', handleMove)
                document.addEventListener('mouseup', handleUp)
              }}
            />
          </div>
        )
      })}
    </div>
  )
})
