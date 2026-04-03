/**
 * Client-side rule application for instant preview.
 * Simplified version of the backend apply_rules — no bleed suppression.
 */

import type { AudioRule, AudioEvent } from './beatlab-client'

export type OnsetData = Record<string, Record<string, { time: number; strength: number }[]>>

export function applyRulesClient(onsets: OnsetData, rules: AudioRule[]): AudioEvent[] {
  const events: AudioEvent[] = []

  for (const rule of rules) {
    if ((rule as Record<string, unknown>)._disabled) continue

    const stem = rule.stem
    const band = rule.band
    const minStr = rule.min_strength
    const maxStr = rule.max_strength
    const effect = rule.effect
    const intensityScale = rule.intensity_scale
    const duration = rule.duration
    const groupStart = rule._group_start
    const groupEnd = rule._group_end

    const stemOnsets = onsets[stem]?.[band]
    if (!stemOnsets) continue

    // Binary search for group start
    let lo = 0
    let hi = stemOnsets.length
    if (groupStart != null) {
      let a = 0, b = stemOnsets.length
      while (a < b) { const m = (a + b) >> 1; if (stemOnsets[m].time < groupStart) a = m + 1; else b = m }
      lo = a
    }
    if (groupEnd != null) {
      let a = lo, b = stemOnsets.length
      while (a < b) { const m = (a + b) >> 1; if (stemOnsets[m].time <= groupEnd) a = m + 1; else b = m }
      hi = a
    }

    for (let i = lo; i < hi; i++) {
      const onset = stemOnsets[i]
      if (onset.strength < minStr || onset.strength > maxStr) continue

      const intensity = Math.min(1.0, onset.strength * intensityScale)
      events.push({
        time: onset.time,
        duration,
        effect,
        intensity,
        sustain: 0,
        stem_source: `${stem}/${band}`,
        rationale: '',
      })

      // Layered effects on strong hits
      const layerWith = rule.layer_with || []
      const layerThreshold = rule.layer_threshold || 0.7
      if (layerWith.length > 0 && onset.strength >= layerThreshold) {
        for (const layerEffect of layerWith) {
          events.push({
            time: onset.time,
            duration,
            effect: layerEffect,
            intensity: Math.min(1.0, intensity * 0.8),
            sustain: 0,
            stem_source: `${stem}/${band}`,
            rationale: '',
            isLayered: true,
          })
        }
      }
    }
  }

  events.sort((a, b) => a.time - b.time)
  return events
}
