import { useLevelMeter } from '@/hooks/useLevelMeter'

/**
 * LevelMeter — stereo DAW-style amplitude meter. Renders two bars (L + R)
 * with a green→yellow→red gradient and per-channel peak-hold markers.
 * Mono sources show matching L/R bars because the mixer upmixes mono to
 * stereo at the analyser tap (speaker upmix).
 *
 * Two orientations:
 *   - `horizontal` — two stacked horizontal bars (L on top, R on bottom).
 *     Good for the transport bar's master meter and compact in-row meters.
 *   - `vertical` — two side-by-side vertical bars (L on left, R on right).
 *     For per-track meters when stacked in a column.
 *
 * Sizing is driven by the caller via `widthPx` / `heightPx`.
 */
export interface LevelMeterProps {
  analysers: { left: AnalyserNode; right: AnalyserNode } | null
  /** Disable the rAF loop when the meter is off-screen or audio is paused
   *  with no motion expected — saves a handful of percent CPU per meter. */
  active: boolean
  orientation?: 'horizontal' | 'vertical'
  /** Pixel width of the bar's container. Defaults depend on orientation. */
  widthPx?: number
  /** Pixel height of the bar's container. Defaults depend on orientation. */
  heightPx?: number
  /** Optional aria-label for accessibility. */
  label?: string
}

// Mild perceptual curve — makes quiet sounds register visibly without losing
// headroom up top. `sqrt` is cheap and looks right.
const shape = (v: number): number => Math.min(1, Math.sqrt(v))

const GRADIENT_H = 'linear-gradient(to right, #22c55e 0%, #22c55e 60%, #eab308 70%, #eab308 85%, #ef4444 95%, #ef4444 100%)'
const GRADIENT_V = 'linear-gradient(to top, #22c55e 0%, #22c55e 60%, #eab308 70%, #eab308 85%, #ef4444 95%, #ef4444 100%)'

export function LevelMeter({
  analysers,
  active,
  orientation = 'horizontal',
  widthPx,
  heightPx,
  label,
}: LevelMeterProps) {
  const { levelLeft, peakLeft, levelRight, peakRight } = useLevelMeter(analysers, active)

  const isHorizontal = orientation === 'horizontal'
  const w = widthPx ?? (isHorizontal ? 120 : 10)
  const h = heightPx ?? (isHorizontal ? 12 : 32)

  return (
    <div
      className={`inline-flex rounded-sm bg-black/60 border border-gray-700 overflow-hidden ${isHorizontal ? 'flex-col' : 'flex-row'}`}
      style={{ width: w, height: h, gap: 1 }}
      role="meter"
      aria-label={label ?? 'Audio level'}
    >
      <Bar level={levelLeft} peak={peakLeft} orientation={orientation} channel="L" />
      <Bar level={levelRight} peak={peakRight} orientation={orientation} channel="R" />
    </div>
  )
}

function Bar({
  level,
  peak,
  orientation,
  channel,
}: {
  level: number
  peak: number
  orientation: 'horizontal' | 'vertical'
  channel: 'L' | 'R'
}) {
  const pct = shape(level) * 100
  const peakPct = shape(peak) * 100
  const isHorizontal = orientation === 'horizontal'
  return (
    <div
      className="relative flex-1 bg-black/70"
      aria-label={`${channel} channel level`}
    >
      <div
        className="absolute"
        style={
          isHorizontal
            ? { left: 0, top: 0, bottom: 0, width: `${pct}%`, background: GRADIENT_H }
            : { left: 0, right: 0, bottom: 0, height: `${pct}%`, background: GRADIENT_V }
        }
      />
      {peakPct > 0 && (
        <div
          className="absolute bg-white/80 pointer-events-none"
          style={
            isHorizontal
              ? { left: `calc(${peakPct}% - 1px)`, top: 0, bottom: 0, width: 1 }
              : { left: 0, right: 0, bottom: `calc(${peakPct}% - 1px)`, height: 1 }
          }
        />
      )}
    </div>
  )
}
