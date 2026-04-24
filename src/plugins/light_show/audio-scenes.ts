/**
 * Audio-reactive scene implementations. These read the scenecraft audio
 * playhead + pre-analyzed beat list (from ``EditorData.beats``) via the
 * ``SceneContext`` passed into ``SceneDef.apply``. Scenes here respond to
 * beats in the underlying timeline — press play on the main transport and
 * the lighting fires with the music.
 *
 * For MVP: beat list comes from the existing scenecraft audio intelligence
 * (already loaded at editor mount). No live FFT / real-time detection;
 * beats are pre-computed and we just consult them against the playhead.
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

/** Intensity flash on each beat, decaying over ~120ms. Pars stay cool blue
 *  between flashes, movers stay dim amber. Reads as 'backlight wash with
 *  beat-synced hit accents'. */
const beatStrobe: SceneDef = {
  id: 'beat_strobe',
  label: 'Beat Strobe (audio-reactive)',
  apply: (_t, states, context) => {
    const beatAge = context?.beatAge ?? Infinity
    // 120ms decay envelope — quick punch then off.
    const flashEnvelope = beatAge < 0.12
      ? Math.max(0, 1 - beatAge / 0.12)
      : 0

    for (const s of states) {
      s.pan = 0
      s.tilt = 0
      if (s.role === 'par') {
        // Pars flash hard on beats, otherwise cool-blue wash.
        const baseline: [number, number, number] = [0.05, 0.1, 0.3]
        const flashColor: [number, number, number] = [1, 1, 1]
        s.intensity = 0.25 + 0.75 * flashEnvelope
        s.color = [
          baseline[0] + (flashColor[0] - baseline[0]) * flashEnvelope,
          baseline[1] + (flashColor[1] - baseline[1]) * flashEnvelope,
          baseline[2] + (flashColor[2] - baseline[2]) * flashEnvelope,
        ]
      } else {
        // Movers low and warm; small beat-synced intensity bump.
        s.intensity = 0.2 + 0.3 * flashEnvelope
        s.color = [1, 0.65, 0.35]
      }
    }
  },
}

/** Hue advances one step per beat — counter tracks which beat we're on
 *  so hue steps deterministically even if playhead scrubs. Movers and pars
 *  both take the current hue; no strobe flash — just rhythmic color cycling. */
const beatColorChase: SceneDef = {
  id: 'beat_color_chase',
  label: 'Beat Color Chase (audio-reactive)',
  apply: (_t, states, context) => {
    const beatIndex = context?.beatIndex ?? 0
    // Hue advances by ~144° per beat so the cycle doesn't repeat too fast.
    const hue = (beatIndex * 0.4) % 1
    const color = hsvToRgb(hue, 0.9, 1)
    const beatAge = context?.beatAge ?? Infinity
    const punch = beatAge < 0.08 ? 1 - beatAge / 0.08 : 0

    for (const s of states) {
      s.color = color
      s.intensity = 0.75 + 0.25 * punch
      s.pan = 0
      s.tilt = 0
    }
  },
}

/**
 * Kick pulse — uses the beat's pre-analyzed ``intensity`` field to scale
 * the punch. Louder hits flash harder; quieter beats barely register.
 * Pars hold dim red between pulses; movers sweep slowly in sync with
 * scene time (so there's still motion between beats).
 */
const kickPulse: SceneDef = {
  id: 'kick_pulse',
  label: 'Kick Pulse (audio-reactive)',
  apply: (t, states, context) => {
    const beatAge = context?.beatAge ?? Infinity
    const beatIntensity = context?.lastBeatIntensity ?? 0
    // Slightly longer envelope (~200ms) to make the pulse readable.
    const env = beatAge < 0.2 ? (1 - beatAge / 0.2) * beatIntensity : 0

    for (const s of states) {
      if (s.role === 'par') {
        s.color = [0.8, 0.1, 0.2]
        s.intensity = 0.15 + 0.85 * env
        s.pan = 0
        s.tilt = 0
      } else {
        s.color = [1, 0.2, 0.2]
        s.intensity = 0.3 + 0.7 * env
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
