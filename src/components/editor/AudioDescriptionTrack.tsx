import { useState } from 'react'
import type { AudioDescription, AudioEvent } from '@/lib/beatlab-client'

type AudioDescriptionTrackProps = {
  descriptions: AudioDescription[]
  audioEvents: AudioEvent[]
  pxPerSec: number
  scrollLeft: number
  viewportWidth: number
  onSectionClick: (section: AudioDescription) => void
}

const SECTION_COLORS = [
  'bg-teal-600/40 hover:bg-teal-600/60',
  'bg-indigo-600/40 hover:bg-indigo-600/60',
  'bg-rose-600/40 hover:bg-rose-600/60',
  'bg-amber-600/40 hover:bg-amber-600/60',
  'bg-emerald-600/40 hover:bg-emerald-600/60',
  'bg-violet-600/40 hover:bg-violet-600/60',
  'bg-cyan-600/40 hover:bg-cyan-600/60',
  'bg-pink-600/40 hover:bg-pink-600/60',
]

const STEM_COLORS: Record<string, string> = {
  kick: 'bg-red-400',
  snare: 'bg-blue-400',
  hh: 'bg-gray-400',
  crash: 'bg-yellow-400',
  ride: 'bg-green-400',
  bass: 'bg-orange-400',
  vocals: 'bg-purple-400',
}

function stemColor(stem: string): string {
  return STEM_COLORS[stem] || 'bg-gray-400'
}

export function AudioDescriptionTrack({
  descriptions,
  audioEvents,
  pxPerSec,
  scrollLeft,
  viewportWidth,
  onSectionClick,
}: AudioDescriptionTrackProps) {
  const [hoveredEvent, setHoveredEvent] = useState<AudioEvent | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const BUFFER_PX = 300

  if (descriptions.length === 0) return null

  return (
    <div className="relative h-10">
      {/* Section bars */}
      {descriptions.map((sec, i) => {
        const x = sec.startTime * pxPerSec
        const w = (sec.endTime - sec.startTime) * pxPerSec
        const endX = x + w
        if (endX < scrollLeft - BUFFER_PX || x > scrollLeft + viewportWidth + BUFFER_PX) return null

        const colorClass = SECTION_COLORS[i % SECTION_COLORS.length]
        // Events within this section
        const sectionEvents = audioEvents.filter(
          (ev) => ev.time >= sec.startTime && ev.time <= sec.endTime
        )

        return (
          <div
            key={sec.sectionIndex}
            className={`absolute top-0 h-10 rounded-sm cursor-pointer transition-colors border-r border-gray-700/30 ${colorClass}`}
            style={{ left: x, width: Math.max(w, 2) }}
            onClick={() => onSectionClick(sec)}
            title={sec.label}
          >
            {/* Section label */}
            {w > 60 && (
              <div className="absolute top-0.5 left-1 text-[9px] text-white/80 font-medium truncate" style={{ maxWidth: w - 8 }}>
                {sec.label}
              </div>
            )}

            {/* Audio event dots */}
            <div className="absolute bottom-1 left-0 right-0 h-3 flex items-center">
              {sectionEvents.map((ev, j) => {
                const dotX = (ev.time - sec.startTime) * pxPerSec
                if (dotX < 0 || dotX > w) return null
                const size = 3 + ev.intensity * 4 // 3-7px based on intensity
                return (
                  <div
                    key={j}
                    className={`absolute rounded-full ${stemColor(ev.stem_source)} opacity-80 hover:opacity-100 cursor-pointer transition-opacity`}
                    style={{
                      left: dotX - size / 2,
                      width: size,
                      height: size,
                    }}
                    onMouseEnter={(e) => {
                      setHoveredEvent(ev)
                      setTooltipPos({ x: e.clientX, y: e.clientY })
                    }}
                    onMouseLeave={() => {
                      setHoveredEvent(null)
                      setTooltipPos(null)
                    }}
                  />
                )
              })}
            </div>
          </div>
        )
      })}

      {/* Tooltip for hovered event */}
      {hoveredEvent && tooltipPos && (
        <div
          className="fixed z-50 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 pointer-events-none shadow-lg"
          style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 30 }}
        >
          <div className="font-medium">{hoveredEvent.stem_source} / {hoveredEvent.effect}</div>
          <div className="text-gray-400">
            {hoveredEvent.time.toFixed(2)}s | intensity: {(hoveredEvent.intensity * 100).toFixed(0)}%
            {hoveredEvent.rationale && <span className="block mt-0.5">{hoveredEvent.rationale}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
