import { useState, useCallback, useEffect } from 'react'
import type { UserEffect, EffectType } from '@/lib/beatlab-client'

const EFFECT_TYPES: EffectType[] = ['pulse', 'zoom', 'shake', 'glow', 'flash']

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

  return (
    <div className="shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col" style={{ width: parseInt(localStorage.getItem('beatlab-side-panel-width') || '360', 10) }}>
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
  )
}
