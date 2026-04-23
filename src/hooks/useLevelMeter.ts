import { useEffect, useRef, useState } from 'react'

/**
 * useLevelMeter — sample peak + short-term smoothed amplitude from one or
 * two AnalyserNodes (L + R) at rAF cadence. Returns normalized [0, 1]
 * values suitable for bar visualization, plus a slowly-decaying peak-hold
 * marker per channel.
 *
 * Ballistics (per channel):
 *   - Peak: instantaneous peak of the time-domain buffer (no smoothing from
 *     the analyser — we set smoothingTimeConstant=0 on the mixer side).
 *   - Smoothed display: one-pole low-pass — attack ≈ 10ms, release ≈ 250ms.
 *     Keeps the bar from flickering while staying responsive.
 *   - Peak-hold: rises instantly to any new peak, falls at ~20 dB/s
 *     (~10× per second in linear units).
 *
 * Caller passes `enabled` to pause the rAF loop when the meter is
 * off-screen or the timeline is paused with no audio routed.
 */
export type LevelMeterReading = {
  /** Smoothed amplitude in [0, 1] — suitable for bar-fill visualization. */
  levelLeft: number
  /** Peak-hold marker in [0, 1] — shows the recent max with slow fall. */
  peakLeft: number
  levelRight: number
  peakRight: number
}

const ZERO: LevelMeterReading = { levelLeft: 0, peakLeft: 0, levelRight: 0, peakRight: 0 }

export function useLevelMeter(
  analysers: { left: AnalyserNode; right: AnalyserNode } | null,
  enabled: boolean,
): LevelMeterReading {
  const [reading, setReading] = useState<LevelMeterReading>(ZERO)
  const smoothedLRef = useRef(0)
  const smoothedRRef = useRef(0)
  const peakLRef = useRef(0)
  const peakRRef = useRef(0)

  useEffect(() => {
    if (!analysers || !enabled) {
      smoothedLRef.current = 0
      smoothedRRef.current = 0
      peakLRef.current = 0
      peakRRef.current = 0
      setReading(ZERO)
      return
    }
    const bufL = new Float32Array(analysers.left.fftSize)
    const bufR = new Float32Array(analysers.right.fftSize)
    let raf = 0
    let lastTime = performance.now()

    const peakOf = (buf: Float32Array): number => {
      let m = 0
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i])
        if (v > m) m = v
      }
      return Math.min(1, m)
    }

    const tick = (now: number) => {
      const dt = Math.max(0.001, (now - lastTime) / 1000)
      lastTime = now
      analysers.left.getFloatTimeDomainData(bufL)
      analysers.right.getFloatTimeDomainData(bufR)
      const targetL = peakOf(bufL)
      const targetR = peakOf(bufR)

      // One-pole LPF toward the new peak — faster on the way up (attack)
      // than on the way down (release).
      const smooth = (prev: number, target: number): number => {
        const tau = target > prev ? 0.010 : 0.250
        const alpha = 1 - Math.exp(-dt / tau)
        return prev + alpha * (target - prev)
      }
      const nextL = smooth(smoothedLRef.current, targetL)
      const nextR = smooth(smoothedRRef.current, targetR)
      smoothedLRef.current = nextL
      smoothedRRef.current = nextR

      // Peak hold: jump to any new peak, otherwise decay ~10×/s.
      const decay = Math.pow(0.1, dt)
      const heldL = Math.max(nextL, peakLRef.current * decay)
      const heldR = Math.max(nextR, peakRRef.current * decay)
      peakLRef.current = heldL
      peakRRef.current = heldR

      setReading({ levelLeft: nextL, peakLeft: heldL, levelRight: nextR, peakRight: heldR })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [analysers, enabled])

  return reading
}
