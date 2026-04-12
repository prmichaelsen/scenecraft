import { useCallback, useRef, memo } from 'react'
import type { UserEffect, EffectType } from '@/lib/beatlab-client'

const EFFECT_COLORS: Record<EffectType, string> = {
  pulse: 'bg-yellow-500',
  zoom: 'bg-blue-500',
  shake: 'bg-red-500',
  glow: 'bg-purple-500',
  flash: 'bg-white',
}

const EFFECT_LABEL_COLORS: Record<EffectType, string> = {
  pulse: 'text-yellow-300',
  zoom: 'text-blue-300',
  shake: 'text-red-300',
  glow: 'text-purple-300',
  flash: 'text-gray-200',
}

type EffectsTrackProps = {
  effects: UserEffect[]
  pxPerSec: number
  selectedEffectId: string | null
  selectedEffectIds: Set<string>
  onEffectClick: (effect: UserEffect, e?: { shiftKey?: boolean }) => void
  onSelectEffectsInRange: (from: number, to: number) => void
  onAddEffect: (time: number) => void
  onEffectDrag: (id: string, newTime: number) => void
  onEffectDragEnd: (id: string, newTime: number) => void
  scrollLeft: number
  viewportWidth: number
}

export const EffectsTrack = memo(function EffectsTrack({
  effects,
  pxPerSec,
  selectedEffectId,
  selectedEffectIds,
  onEffectClick,
  onSelectEffectsInRange,
  onAddEffect,
  onEffectDrag,
  onEffectDragEnd,
  scrollLeft,
  viewportWidth,
}: EffectsTrackProps) {
  const BUFFER_PX = 300
  const dragState = useRef<{ dragging: boolean; id: string; startX: number; startTime: number } | null>(null)
  const didDrag = useRef(false)

  const handleMouseDown = useCallback((e: React.MouseEvent, effect: UserEffect) => {
    e.stopPropagation()
    e.preventDefault()
    dragState.current = { dragging: true, id: effect.id, startX: e.clientX, startTime: effect.time }
    didDrag.current = false

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragState.current?.dragging) return
      const deltaX = ev.clientX - dragState.current.startX
      if (Math.abs(deltaX) > 2) didDrag.current = true
      const newTime = Math.max(0, dragState.current.startTime + deltaX / pxPerSec)
      onEffectDrag(dragState.current.id, newTime)
    }

    const handleMouseUp = (ev: MouseEvent) => {
      if (didDrag.current && dragState.current) {
        const deltaX = ev.clientX - dragState.current.startX
        const newTime = Math.max(0, dragState.current.startTime + deltaX / pxPerSec)
        onEffectDragEnd(dragState.current.id, newTime)
      }
      dragState.current = null
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [pxPerSec, onEffectDrag])

  // Alt+drag to select effects in range
  const handleTrackMouseDown = useCallback((e: React.MouseEvent) => {
    if (!e.altKey) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const startTime = x / pxPerSec

    const handleMouseUp = (ev: MouseEvent) => {
      const endX = ev.clientX - rect.left
      const endTime = endX / pxPerSec
      const from = Math.min(startTime, endTime)
      const to = Math.max(startTime, endTime)
      if (to - from > 0.05) onSelectEffectsInRange(from, to)
      document.removeEventListener('mouseup', handleMouseUp)
    }
    document.addEventListener('mouseup', handleMouseUp)
  }, [pxPerSec, onSelectEffectsInRange])

  const handleTrackDoubleClick = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const time = x / pxPerSec
    onAddEffect(time)
  }, [pxPerSec, onAddEffect])

  return (
    <div
      className="relative h-full overflow-visible"
      onClick={handleTrackDoubleClick}
      onMouseDown={handleTrackMouseDown}
    >
      {/* Effect markers */}
      {effects.map((fx) => {
        const x = fx.time * pxPerSec
        const w = Math.max(fx.duration * pxPerSec, 4)
        if (x + w < scrollLeft - BUFFER_PX || x > scrollLeft + viewportWidth + BUFFER_PX) return null
        const isSelected = fx.id === selectedEffectId || selectedEffectIds.has(fx.id)
        const color = EFFECT_COLORS[fx.type] || 'bg-gray-500'
        const labelColor = EFFECT_LABEL_COLORS[fx.type] || 'text-gray-300'

        return (
          <div
            key={fx.id}
            className={`absolute top-1 bottom-1 rounded-sm cursor-grab active:cursor-grabbing group ${isSelected ? 'ring-1 ring-white z-20' : 'z-10'}`}
            style={{ left: x, width: w, opacity: 0.3 + fx.intensity * 0.7 }}
            onMouseDown={(e) => handleMouseDown(e, fx)}
            onClick={(e) => {
              if (didDrag.current) { didDrag.current = false; return }
              e.stopPropagation()
              onEffectClick(fx, { shiftKey: e.shiftKey })
            }}
          >
            <div className={`w-full h-full ${color} rounded-sm`} />

            {/* Label */}
            {w > 20 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className={`text-[7px] font-mono ${labelColor} drop-shadow-sm`}>
                  {fx.type}
                </span>
              </div>
            )}

            {/* Hover tooltip */}
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-gray-800 text-xs text-gray-300 px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none">
              {fx.type} @ {fx.time.toFixed(2)}s — {(fx.intensity * 100).toFixed(0)}% — {fx.duration.toFixed(2)}s
            </div>
          </div>
        )
      })}
    </div>
  )
})
