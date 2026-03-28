import type { KeyframeWithTime } from './Timeline'
import type { Transition } from '@/routes/project/$name/editor'

type TransitionTrackProps = {
  transitions: Transition[]
  keyframes: KeyframeWithTime[]
  pxPerSec: number
  selectedId: string | null
  onTransitionClick: (tr: Transition) => void
}

export function TransitionTrack({
  transitions,
  keyframes,
  pxPerSec,
  selectedId,
  onTransitionClick,
}: TransitionTrackProps) {
  const kfMap = new Map(keyframes.map((kf) => [kf.id, kf]))

  return (
    <div className="absolute inset-0 pointer-events-none overflow-visible">
      {transitions.map((tr) => {
        const fromKf = kfMap.get(tr.from)
        const toKf = kfMap.get(tr.to)
        if (!fromKf || !toKf) return null

        const x = fromKf.timeSeconds * pxPerSec
        const endX = toKf.timeSeconds * pxPerSec
        const width = endX - x
        if (width <= 0) return null

        const isSelected = tr.id === selectedId
        const hasCandidates = Object.values(tr.candidates).some((arr) => arr.length > 0)

        return (
          <div
            key={tr.id}
            className={`absolute top-0 h-full pointer-events-none group ${isSelected ? 'z-20' : 'z-10'}`}
            style={{ left: x, width }}
          >
            {/* Transition bar — only this is clickable */}
            <div
              className={`absolute bottom-0 left-0 right-0 h-3 rounded-t-sm cursor-pointer pointer-events-auto transition-colors ${
                isSelected
                  ? 'bg-orange-500/40 border-t border-orange-500'
                  : hasCandidates
                    ? 'bg-orange-500/15 hover:bg-orange-500/25 border-t border-orange-500/30'
                    : 'bg-gray-700/20 hover:bg-gray-700/40 border-t border-gray-700/40'
              }`}
              onClick={(e) => {
                e.stopPropagation()
                onTransitionClick(tr)
              }}
            >
              {/* Label */}
              {width > 50 && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className={`text-[7px] font-mono truncate px-1 ${isSelected ? 'text-orange-300' : 'text-gray-500'}`}>
                    {tr.id}
                  </span>
                </div>
              )}
            </div>

            {/* Hover tooltip */}
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-gray-800 text-xs text-gray-300 px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none">
              {tr.id}: {tr.from} → {tr.to} ({tr.durationSeconds.toFixed(1)}s, {tr.slots} slot{tr.slots !== 1 ? 's' : ''})
              {hasCandidates && <span className="text-orange-400 ml-1">{Object.values(tr.candidates).reduce((s, a) => s + a.length, 0)} videos</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
