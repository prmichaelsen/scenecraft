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

const EFFECT_DOT_COLORS: Record<EffectType, string> = {
  pulse: 'bg-yellow-500',
  zoom: 'bg-blue-500',
  shake: 'bg-red-500',
  glow: 'bg-purple-500',
  flash: 'bg-white',
}

const ALL_EFFECT_TYPES: EffectType[] = ['pulse', 'zoom', 'shake', 'glow', 'flash']

type EffectsTrackProps = {
  effects: UserEffect[]
  suppressions: BeatSuppression[]
  pxPerSec: number
  selectedEffectId: string | null
  onEffectClick: (effect: UserEffect) => void
  onAddEffect: (time: number) => void
  onEffectDrag: (id: string, newTime: number) => void
  onEffectDragEnd: (id: string, newTime: number) => void
  onAddSuppression: (from: number, to: number) => void
  onDeleteSuppression: (id: string) => void
  onResizeSuppression: (id: string, from: number, to: number) => void
  onUpdateSuppressionTypes: (id: string, effectTypes: EffectType[] | undefined) => void
  selectedSuppressionId: string | null
  onSuppressionClick: (id: string) => void
}

export function EffectsTrack({
  effects,
  suppressions,
  pxPerSec,
  selectedEffectId,
  onEffectClick,
  onAddEffect,
  onEffectDrag,
  onEffectDragEnd,
  onAddSuppression,
  onDeleteSuppression: _onDeleteSuppression,
  onResizeSuppression,
  onUpdateSuppressionTypes,
  selectedSuppressionId,
  onSuppressionClick,
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

  // Shift+drag to create suppression zone
  const suppressionDragRef = useRef<{ startTime: number; rect: DOMRect } | null>(null)

  const handleTrackMouseDown = useCallback((e: React.MouseEvent) => {
    if (!e.shiftKey) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const startTime = x / pxPerSec
    suppressionDragRef.current = { startTime, rect }

    const handleMouseMove = (_ev: MouseEvent) => {
      // Visual feedback could be added here with a temp overlay
    }

    const handleMouseUp = (ev: MouseEvent) => {
      if (suppressionDragRef.current) {
        const endX = ev.clientX - suppressionDragRef.current.rect.left
        const endTime = endX / pxPerSec
        const from = Math.min(suppressionDragRef.current.startTime, endTime)
        const to = Math.max(suppressionDragRef.current.startTime, endTime)
        if (to - from > 0.1) {
          onAddSuppression(from, to)
        }
        suppressionDragRef.current = null
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [pxPerSec, onAddSuppression])

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
      onMouseDown={handleTrackMouseDown}
    >
      {/* Suppression zones */}
      {suppressions.map((s) => {
        const isSelected = s.id === selectedSuppressionId
        const widthPx = (s.to - s.from) * pxPerSec
        const hasTypeFilter = s.effectTypes && s.effectTypes.length > 0
        return (
          <div
            key={s.id}
            className={`absolute top-0 h-full pointer-events-auto cursor-pointer ${isSelected ? 'bg-red-900/30 border-l-2 border-r-2 border-red-500' : 'bg-red-900/15 border-l border-r border-red-800/30 hover:bg-red-900/25'}`}
            style={{
              left: s.from * pxPerSec,
              width: widthPx,
            }}
            title={`Suppressed: ${s.from.toFixed(1)}s - ${s.to.toFixed(1)}s${hasTypeFilter ? ` (${s.effectTypes!.join(', ')})` : ' (all)'}`}
            onClick={(e) => { e.stopPropagation(); onSuppressionClick(s.id) }}
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

            {/* Type toggle editor (shown when selected) */}
            {isSelected && (
              <div
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex gap-0.5 bg-gray-900/90 border border-red-500/50 rounded px-1 py-0.5 z-50 pointer-events-auto"
                onClick={(e) => e.stopPropagation()}
              >
                {ALL_EFFECT_TYPES.map((t) => {
                  const active = !hasTypeFilter || s.effectTypes!.includes(t)
                  return (
                    <button
                      key={t}
                      className={`text-[8px] px-1 py-0.5 rounded transition-colors ${active ? `${EFFECT_DOT_COLORS[t]} text-black font-bold` : 'bg-gray-800 text-gray-500'}`}
                      title={`${active ? 'Unsuppress' : 'Suppress'} ${t}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!hasTypeFilter) {
                          // Currently suppressing all — switch to suppressing all except this one
                          onUpdateSuppressionTypes(s.id, ALL_EFFECT_TYPES.filter((et) => et !== t))
                        } else {
                          const current = s.effectTypes!
                          if (current.includes(t)) {
                            const next = current.filter((et) => et !== t)
                            onUpdateSuppressionTypes(s.id, next.length === 0 ? undefined : next)
                          } else {
                            const next = [...current, t]
                            onUpdateSuppressionTypes(s.id, next.length === ALL_EFFECT_TYPES.length ? undefined : next)
                          }
                        }
                      }}
                    >
                      {t[0].toUpperCase()}
                    </button>
                  )
                })}
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
