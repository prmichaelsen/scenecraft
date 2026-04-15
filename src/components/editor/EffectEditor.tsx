import { useState, useCallback, useEffect, useRef } from 'react'
import type { UserEffect, EffectType } from '@/lib/scenecraft-client'
import { getPluginEffects } from '@/lib/plugin-api'

const EFFECT_TYPES: EffectType[] = ['pulse', 'zoom', 'shake', 'glow', 'flash', 'echo']
const pluginEffectIds = getPluginEffects().map((e) => e.id)

type EffectEditorProps = {
  effect: UserEffect
  onUpdate: (updated: UserEffect) => void
  onDelete: (id: string) => void
  onClose: () => void
}

export function EffectEditor({ effect, onUpdate, onDelete, onClose }: EffectEditorProps) {
  const [type, setType] = useState(effect.type)
  const [intensity, setIntensity] = useState(effect.intensity)
  const [duration, setDuration] = useState(effect.duration)
  const [time, setTime] = useState(effect.time)

  useEffect(() => {
    setType(effect.type)
    setIntensity(effect.intensity)
    setDuration(effect.duration)
    setTime(effect.time)
  }, [effect.id, effect.type, effect.intensity, effect.duration, effect.time])

  const save = useCallback(() => {
    onUpdate({ ...effect, type, intensity, duration, time })
  }, [effect, type, intensity, duration, time, onUpdate])

  const STORAGE_KEY = 'scenecraft-side-panel-width'
  const MIN_WIDTH = 240
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return 360
    return Math.max(MIN_WIDTH, parseInt(localStorage.getItem(STORAGE_KEY) || '360', 10))
  })
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = startX.current - e.clientX
      const newWidth = Math.max(MIN_WIDTH, startWidth.current + delta)
      setWidth(newWidth)
    }
    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false
        localStorage.setItem(STORAGE_KEY, String(width))
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [width])

  return (
    <div className="relative flex shrink-0" style={{ width }}>
      <div
        className="w-1 cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500 transition-colors shrink-0"
        onMouseDown={(e) => { isDragging.current = true; startX.current = e.clientX; startWidth.current = width; e.preventDefault() }}
      />
      <div className="flex-1 bg-gray-900 border-l border-gray-800 overflow-y-auto flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
        <div className="text-sm font-medium text-yellow-300">{effect.id}</div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => onDelete(effect.id)}
            className="text-xs text-red-500/70 hover:text-red-400 transition-colors"
          >
            Delete
          </button>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">
            &times;
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Type</label>
          <div className="flex gap-1">
            {EFFECT_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => { setType(t); onUpdate({ ...effect, type: t, intensity, duration, time }) }}
                className={`flex-1 text-[10px] px-2 py-1.5 rounded transition-colors ${type === t ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
              >
                {t}
              </button>
            ))}
            {pluginEffectIds.map((t) => (
              <button
                key={t}
                onClick={() => { setType(t as EffectType); onUpdate({ ...effect, type: t as EffectType, intensity, duration, time }) }}
                className={`flex-1 text-[10px] px-2 py-1.5 rounded transition-colors ${type === t ? 'bg-purple-600 text-white' : 'bg-gray-800 text-purple-400 hover:text-purple-200'}`}
              >
                {t} <span className="text-[8px] opacity-60">plugin</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">
            Time: {time.toFixed(2)}s
          </label>
          <input
            type="range"
            min={0}
            max={600}
            step={0.01}
            value={time}
            onChange={(e) => setTime(parseFloat(e.target.value))}
            onMouseUp={save}
            className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer"
          />
        </div>

        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">
            Intensity: {(intensity * 100).toFixed(0)}%
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={intensity}
            onChange={(e) => setIntensity(parseFloat(e.target.value))}
            onMouseUp={save}
            className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer"
          />
        </div>

        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">
            Duration: {duration.toFixed(2)}s
          </label>
          <input
            type="range"
            min={0.05}
            max={2}
            step={0.01}
            value={duration}
            onChange={(e) => setDuration(parseFloat(e.target.value))}
            onMouseUp={save}
            className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer"
          />
        </div>
      </div>
      </div>
    </div>
  )
}
