import { useState } from 'react'
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
}

function effectColor(effect: string): string {
  return EFFECT_COLORS[effect] || 'bg-gray-500/60'
}

type RuleSection = {
  start: number
  end: number
  rules: AudioRule[]
}

function groupRulesBySections(rules: AudioRule[]): RuleSection[] {
  const map = new Map<string, RuleSection>()
  for (const r of rules) {
    const start = r._start ?? 0
    const end = r._end ?? 0
    const key = `${start}-${end}`
    if (!map.has(key)) {
      map.set(key, { start, end, rules: [] })
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
}

export function RulesTrack({ rules, pxPerSec, scrollLeft, viewportWidth }: RulesTrackProps) {
  const [expandedSection, setExpandedSection] = useState<string | null>(null)
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

        const key = `${sec.start}-${sec.end}`
        const isExpanded = expandedSection === key

        return (
          <div key={key}>
            <div
              className="absolute top-0 h-7 flex items-center gap-0.5 px-1 overflow-hidden cursor-pointer pointer-events-auto hover:bg-gray-700/30 rounded-sm transition-colors border-r border-gray-700/30"
              style={{ left: x, width: w }}
              onClick={() => setExpandedSection(isExpanded ? null : key)}
              title={`${sec.rules.length} rules (${sec.start.toFixed(0)}s-${sec.end.toFixed(0)}s)`}
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

            {/* Expanded detail popover */}
            {isExpanded && (
              <div
                className="absolute top-8 z-40 bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-3 pointer-events-auto max-h-64 overflow-y-auto"
                style={{ left: Math.max(0, x), width: Math.min(360, w), minWidth: 260 }}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] text-gray-400">
                    {sec.start.toFixed(0)}s — {sec.end.toFixed(0)}s ({sec.rules.length} rules)
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setExpandedSection(null) }}
                    className="text-gray-500 hover:text-gray-300 text-sm leading-none"
                  >&times;</button>
                </div>
                <table className="w-full text-[9px]">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-1 pr-2">Stem/Band</th>
                      <th className="text-left py-1 pr-2">Effect</th>
                      <th className="text-right py-1 pr-2">Scale</th>
                      <th className="text-right py-1 pr-2">Dur</th>
                      <th className="text-left py-1">Layers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sec.rules.map((r, i) => (
                      <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                        <td className="py-1 pr-2 text-gray-300 font-mono">{r.stem}/{r.band}</td>
                        <td className="py-1 pr-2">
                          <span className={`px-1 py-0.5 rounded-sm text-white ${effectColor(r.effect)}`}>
                            {r.effect}
                          </span>
                        </td>
                        <td className="py-1 pr-2 text-right text-gray-400">×{r.intensity_scale}</td>
                        <td className="py-1 pr-2 text-right text-gray-400">{r.duration}s</td>
                        <td className="py-1 text-gray-500">{r.layer_with?.length > 0 ? r.layer_with.join(', ') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
