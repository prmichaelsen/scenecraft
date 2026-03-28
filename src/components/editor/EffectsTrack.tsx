import { useCallback, useRef } from 'react'
import type { UserEffect, BeatSuppression, EffectType } from '@/lib/beatlab-client'

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
  suppressions: BeatSuppression[]
  pxPerSec: number
  selectedEffectId: string | null
  onEffectClick: (effect: UserEffect) => void
  onAddEffect: (time: number) => void
  onEffectDrag: (id: string, newTime: number) => void
}

export function EffectsTrack({
  effects,
  suppressions,
  pxPerSec,
  selectedEffectId,
  onEffectClick,
  onAddEffect,
  onEffectDrag,
}: EffectsTrackProps) {
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

    const handleMouseUp = () => {
      dragState.current = null
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [pxPerSec, onEffectDrag])

  const handleTrackDoubleClick = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const time = x / pxPerSec
    onAddEffect(time)
  }, [pxPerSec, onAddEffect])

  return (
    <div
      className="relative h-full overflow-visible"
      onDoubleClick={handleTrackDoubleClick}
    >
      {/* Suppression zones */}
      {suppressions.map((s) => (
        <div
          key={s.id}
          className="absolute top-0 h-full bg-red-900/15 border-l border-r border-red-800/30"
          style={{
            left: s.from * pxPerSec,
            width: (s.to - s.from) * pxPerSec,
          }}
          title={`Suppressed: ${s.from.toFixed(1)}s - ${s.to.toFixed(1)}s`}
        />
      ))}

      {/* Effect markers */}
      {effects.map((fx) => {
        const x = fx.time * pxPerSec
        const w = Math.max(fx.duration * pxPerSec, 4)
        const isSelected = fx.id === selectedEffectId
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
              onEffectClick(fx)
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
}
