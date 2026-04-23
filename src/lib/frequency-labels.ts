/**
 * M13 task-46: Built-in frequency labels shipped with the EQ band knob.
 *
 * Two preset sets:
 *   - SPECTRUM_BANDS (8 entries) — subjective descriptors of the audio
 *     spectrum (spec R48).
 *   - INSTRUMENT_PRESETS (11 entries) — common instrument-specific bands
 *     (spec R49).
 *
 * Each entry's `value` is the geometric mean of its `range`, giving a single
 * representative Hz the knob can snap to.
 *
 * Users may also define project-scoped custom labels; those live in the
 * SQLite `project_frequency_labels` table and are merged with these two
 * sets at render time (spec R50).
 */

/** One selectable preset for a frequency param (e.g. `eq_band.freq`). */
export interface FrequencyLabelPreset {
  label: string
  value: number
  hzRange?: [number, number]
}

/** Geometric mean of two positives, rounded to the nearest integer. */
function gmean(min: number, max: number): number {
  return Math.round(Math.sqrt(min * max))
}

/**
 * 8 spectrum bands per spec R48. Ordered low → high.
 */
export const SPECTRUM_BANDS: FrequencyLabelPreset[] = [
  { label: 'sub bass',           value: gmean(20, 60),        hzRange: [20, 60] },
  { label: 'bass',               value: gmean(60, 250),       hzRange: [60, 250] },
  { label: 'low-mids / mud',     value: gmean(250, 500),      hzRange: [250, 500] },
  { label: 'mids',               value: gmean(500, 2000),     hzRange: [500, 2000] },
  { label: 'presence',           value: gmean(2000, 4000),    hzRange: [2000, 4000] },
  { label: 'attack / upper-mids', value: gmean(4000, 8000),   hzRange: [4000, 8000] },
  { label: 'sibilance',          value: gmean(6000, 9000),    hzRange: [6000, 9000] },
  { label: 'air',                value: gmean(10000, 20000),  hzRange: [10000, 20000] },
]

/**
 * 11 instrument-specific presets per spec R49. Useful defaults surfaced
 * alongside the spectrum bands.
 */
export const INSTRUMENT_PRESETS: FrequencyLabelPreset[] = [
  { label: 'Kick body',         value: gmean(50, 80),     hzRange: [50, 80] },
  { label: 'Kick click',        value: gmean(3000, 5000), hzRange: [3000, 5000] },
  { label: 'Bass fundamental',  value: gmean(80, 200),    hzRange: [80, 200] },
  { label: 'Snare body',        value: gmean(150, 250),   hzRange: [150, 250] },
  { label: 'Snare crack',       value: gmean(3000, 5000), hzRange: [3000, 5000] },
  { label: 'Vocal warmth',      value: gmean(200, 300),   hzRange: [200, 300] },
  { label: 'Vocal presence',    value: gmean(2000, 5000), hzRange: [2000, 5000] },
  { label: 'Vocal sibilance',   value: gmean(6000, 9000), hzRange: [6000, 9000] },
  { label: 'Guitar body',       value: gmean(100, 300),   hzRange: [100, 300] },
  { label: 'Guitar bite',       value: gmean(700, 2000),  hzRange: [700, 2000] },
  { label: 'Hi-hat / cymbals',  value: gmean(8000, 12000), hzRange: [8000, 12000] },
]

/**
 * Format a Hz value for display.
 *   120       → "120 Hz"
 *   1200      → "1.2 kHz"
 *   20000     → "20 kHz"
 *   999.6     → "1000 Hz"
 *   15500     → "15.5 kHz"
 *
 * Values < 1000 Hz render as integer Hz; values ≥ 1000 Hz render as kHz
 * with at most one decimal place (dropping a trailing ".0").
 */
export function formatHz(hz: number): string {
  const rounded = Math.round(hz)
  if (rounded < 1000) return `${rounded} Hz`
  const kHz = hz / 1000
  // One decimal, but strip trailing ".0" for whole-kHz values.
  const oneDecimal = Math.round(kHz * 10) / 10
  const str = Number.isInteger(oneDecimal) ? oneDecimal.toFixed(0) : oneDecimal.toFixed(1)
  return `${str} kHz`
}

/**
 * Return the spectrum-band label whose range contains `hz`, else null.
 *
 * Spectrum bands overlap slightly near the upper end (e.g. sibilance
 * 6000-9000 overlaps air's start), so we pick the FIRST matching band
 * (they are ordered low → high, preferring the more specific label when
 * ranges overlap).
 */
export function labelForFreq(hz: number): string | null {
  for (const band of SPECTRUM_BANDS) {
    if (!band.hzRange) continue
    const [min, max] = band.hzRange
    if (hz >= min && hz <= max) return band.label
  }
  return null
}
