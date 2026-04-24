/**
 * Scene implementations for the light_show MVP. Each scene is a plain
 * function that mutates the per-frame ``FixtureState[]`` based on
 * scene-relative time (seconds).
 *
 * Real scenes will be data-driven (parameterized primitives stored in SQL,
 * interpreted by a DSL evaluator) in a later milestone. These hardcoded
 * scenes exist to validate the render pipeline and let the user see the
 * aesthetic direction without backend coupling.
 */

import type { FixtureState } from './fixtures'

export interface SceneDef {
  id: string
  label: string
  /** Mutates ``states`` in place to reflect the scene at time ``t`` (seconds). */
  apply: (t: number, states: FixtureState[]) => void
}

/** Utility: HSV → RGB conversion, all components in [0, 1]. */
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

/** Full-on wash — all fixtures warm white at full intensity. */
const fullWash: SceneDef = {
  id: 'full_wash',
  label: 'Full Wash',
  apply: (_t, states) => {
    for (const s of states) {
      s.intensity = 1
      s.color = [1, 0.95, 0.85]
      s.pan = 0
      s.tilt = 0
    }
  },
}

/**
 * Rainbow chase — pars cycle through hues with a phase offset per fixture;
 * moving heads hold a slow pan sweep and stay at a soft warm accent.
 */
const rainbowChase: SceneDef = {
  id: 'rainbow_chase',
  label: 'Rainbow Chase',
  apply: (t, states) => {
    const pars = states.filter((s) => s.role === 'par')
    pars.forEach((s, i) => {
      const hue = ((t * 0.25) + i * 0.12) % 1
      s.color = hsvToRgb(hue, 1, 1)
      s.intensity = 1
    })
    const movers = states.filter((s) => s.role === 'moving_head')
    movers.forEach((s, i) => {
      s.color = [1, 0.7, 0.4]
      s.intensity = 0.6
      // Slow sinusoidal pan, offset per fixture so they sweep in unison-ish
      s.pan = Math.sin(t * 0.4 + i * 0.3) * (Math.PI / 6)
      s.tilt = Math.sin(t * 0.2 + i * 0.1) * (Math.PI / 12)
    })
  },
}

/**
 * Pan sweep — moving heads sweep left↔right across the stage in wide arc;
 * pars stay at a cool blue wash so the movers' beams read against them.
 */
const panSweep: SceneDef = {
  id: 'pan_sweep',
  label: 'Pan Sweep',
  apply: (t, states) => {
    for (const s of states) {
      if (s.role === 'moving_head') {
        s.color = [1, 1, 1]
        s.intensity = 1
        // All movers sweep in phase, wide arc
        s.pan = Math.sin(t * 0.8) * (Math.PI / 3)
        s.tilt = -0.2 + Math.sin(t * 0.4) * 0.15
      } else {
        // Cool blue par wash — intensity pulses slowly
        s.color = [0.2, 0.4, 1]
        s.intensity = 0.5 + 0.2 * Math.sin(t * 0.6)
        s.pan = 0
        s.tilt = 0
      }
    }
  },
}

export const SCENES: SceneDef[] = [fullWash, rainbowChase, panSweep]

export function getScene(id: string): SceneDef | undefined {
  return SCENES.find((s) => s.id === id)
}
