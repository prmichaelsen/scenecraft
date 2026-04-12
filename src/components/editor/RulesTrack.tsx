import { memo } from 'react'
import type { AudioRule } from '@/lib/beatlab-client'

const EFFECT_COLORS: Record<string, string> = {
  zoom_pulse: 'bg-blue-500/60',
  zoom_bounce: 'bg-blue-400/60',
  shake_x: 'bg-red-500/60',
  shake_y: 'bg-red-400/60',
  flash: 'bg-yellow-400/60',
  hard_cut: 'bg-yellow-600/60',
  contrast_pop: 'bg-purple-500/60',
  glow_swell: 'bg-emerald-500/60',
  echo: 'bg-teal-500/60',
  echo_pulse: 'bg-teal-400/60',
}

function effectColor(effect: string): string {
  return EFFECT_COLORS[effect] || 'bg-gray-500/60'
}

export type RuleSection = {
  key: string
  start: number
  end: number
  groupName: string
  rules: AudioRule[]
}

export function groupRulesBySections(rules: AudioRule[]): RuleSection[] {
  const map = new Map<string, RuleSection>()
  for (const r of rules) {
    const start = r._start ?? r._group_start ?? 0
    const end = r._end ?? r._group_end ?? 0
    const key = `${start}-${end}`
    if (!map.has(key)) {
      map.set(key, { key, start, end, groupName: r._group_name || '', rules: [] })
    }
    map.get(key)!.rules.push(r)
  }
  return Array.from(map.values()).sort((a, b) => a.start - b.start)
}

type RulesTrackProps = {
  rules: AudioRule[]
  pxPerSec: number
  scrollLeft: number
  viewportWidth: number
  selectedSectionKey: string | null
  onSectionClick: (section: RuleSection) => void
}

export const RulesTrack = memo(function RulesTrack({ rules, pxPerSec, scrollLeft, viewportWidth, selectedSectionKey, onSectionClick }: RulesTrackProps) {
  const sections = groupRulesBySections(rules)
  const BUFFER_PX = 300

  if (sections.length === 0) return null

  return (
    <div className="relative h-7 pointer-events-none">
      {sections.map((sec) => {
        const x = sec.start * pxPerSec
        const w = (sec.end - sec.start) * pxPerSec
        const endX = x + w
        if (endX < scrollLeft - BUFFER_PX || x > scrollLeft + viewportWidth + BUFFER_PX) return null

        const isSelected = selectedSectionKey === sec.key

        return (
          <div
            key={sec.key}
            className={`absolute top-0 h-7 flex items-center gap-0.5 px-1 overflow-hidden cursor-pointer pointer-events-auto hover:bg-gray-700/30 rounded-sm transition-colors border-r border-gray-700/30 ${isSelected ? 'ring-1 ring-amber-500 bg-amber-900/20' : ''}`}
            style={{ left: x, width: w }}
            onClick={() => onSectionClick(sec)}
            title={`${sec.groupName || 'Rules'} (${sec.rules.length} rules, ${sec.start.toFixed(0)}s-${sec.end.toFixed(0)}s)`}
          >
            {sec.rules.slice(0, Math.max(1, Math.floor(w / 50))).map((r, i) => (
              <span
                key={i}
                className={`text-[8px] text-white px-1 py-0.5 rounded-sm whitespace-nowrap ${effectColor(r.effect)}`}
                title={`${r.stem}/${r.band} → ${r.effect} (×${r.intensity_scale})`}
              >
                {r.stem}→{r.effect.replace(/_/g, '')}
              </span>
            ))}
            {sec.rules.length > Math.floor(w / 50) && (
              <span className="text-[8px] text-gray-500">+{sec.rules.length - Math.floor(w / 50)}</span>
            )}
          </div>
        )
      })}
    </div>
  )
})
