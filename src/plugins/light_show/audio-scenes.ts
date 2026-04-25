/**
 * Audio-reactive scene implementations.
 *
 * Drives off the live master-bus envelope sampled from the AudioMixer's
 * master AnalyserNode:
 *   - ``masterLevel``: smoothed full-spectrum RMS, 0..1
 *   - ``masterLowLevel``: smoothed sub-bass / low-band RMS, 0..1 (kicks &
 *     bass dominate this band)
 *
 * Both are fed through an asymmetric envelope (fast attack / slow release)
 * so a kick snaps to full instantly and decays naturally over ~180ms.
 * Scenes can treat them as "instant" signals without additional smoothing.
 *
 * We DO still expose ``beatIndex`` / ``beatAge`` for scenes that want
 * rhythmic step-on-beat behavior, but they're supplemental — live energy
 * is the primary signal so scenes react to whatever is actually playing
 * (generated music, imported clips, master-bus effects, silence, etc.).
 */

import type { FixtureState } from './fixtures'
import type { SceneDef } from './scene-types'

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0: return [v, t, p]
    case 1: return [q, v, p]
    case 2: return [p, v, t]
    case 3: return [p, q, v]
    case 4: return [t, p, v]
    case 5: return [v, p, q]
    default: return [v, v, v]
  }
}

/** Pars flash on each transient (proxied by master level), pulling a
 *  cool-blue wash up toward white; movers ride a gentler amber pulse so
 *  they don't visually compete. Reads as "backlight wash with accented
 *  hits on the music". */
const beatStrobe: SceneDef = {
  id: 'beat_strobe',
  label: 'Beat Strobe (audio-reactive)',
  apply: (_t, states, context) => {
    // Bias toward low-band so kicks punch harder than hats.
    const energy = Math.min(1, (context?.masterLowLevel ?? 0) * 1.4 + (context?.masterLevel ?? 0) * 0.4)

    for (const s of states) {
      s.pan = 0
      s.tilt = 0
      if (s.role === 'par') {
        const baseline: [number, number, number] = [0.05, 0.1, 0.3]
        const flashColor: [number, number, number] = [1, 1, 1]
        s.intensity = 0.25 + 0.75 * energy
        s.color = [
          baseline[0] + (flashColor[0] - baseline[0]) * energy,
          baseline[1] + (flashColor[1] - baseline[1]) * energy,
          baseline[2] + (flashColor[2] - baseline[2]) * energy,
        ]
      } else {
        s.intensity = 0.2 + 0.5 * energy
        s.color = [1, 0.65, 0.35]
      }
    }
  },
}

/** Hue advances with overall master energy over time — loud sections cycle
 *  faster, quiet sections hold color longer. Intensity tracks the envelope
 *  so the scene breathes with the mix. */
const beatColorChase: SceneDef = {
  id: 'beat_color_chase',
  label: 'Beat Color Chase (audio-reactive)',
  apply: (t, states, context) => {
    const level = context?.masterLevel ?? 0
    // Hue drifts on scene time but faster when loud. Wraps via `% 1`.
    const hue = ((t * 0.05) + level * 0.6) % 1
    const color = hsvToRgb(hue, 0.9, 1)

    for (const s of states) {
      s.color = color
      s.intensity = 0.5 + 0.5 * level
      s.pan = 0
      s.tilt = 0
    }
  },
}

/**
 * Kick pulse — dedicated to the low band. Pars hold dim red between kicks
 * and slam to bright red on each hit; movers ride a parallel pulse and
 * slowly sweep so there's motion even in quiet passages.
 */
const kickPulse: SceneDef = {
  id: 'kick_pulse',
  label: 'Kick Pulse (audio-reactive)',
  apply: (t, states, context) => {
    const low = context?.masterLowLevel ?? 0
    // Gentle compression curve so small taps still register visibly.
    const punch = Math.pow(low, 0.6)

    for (const s of states) {
      if (s.role === 'par') {
        s.color = [0.8, 0.1, 0.2]
        s.intensity = 0.15 + 0.85 * punch
        s.pan = 0
        s.tilt = 0
      } else {
        s.color = [1, 0.2, 0.2]
        s.intensity = 0.3 + 0.7 * punch
        // Slow mover sweep keeps motion between kicks.
        s.pan = Math.sin(t * 0.5) * (Math.PI / 8)
        s.tilt = Math.sin(t * 0.3) * (Math.PI / 16)
      }
    }
  },
}

export const AUDIO_SCENES: SceneDef[] = [beatStrobe, beatColorChase, kickPulse]

// Satisfy the import so lint doesn't complain about the unused FixtureState
// re-export if this file is imported in isolation.
export type { FixtureState }
