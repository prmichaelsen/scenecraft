/**
 * M13 task-50: Send effect implementations (reverb / delay / echo).
 *
 * Sends are unusual: on the main track chain they are passthrough. The
 * real audio tap happens in the mixer (task-47), which reads the
 * `bus_id` property and the `sendGain` node off the EffectNode and wires
 * a parallel `track → bus` path whose gain is this effect's animatable
 * `wet` param.
 *
 * Each builder returns an `EffectNode` extended with:
 *   - `bus_id`   — the static (non-animatable) bus selector (spec R9)
 *   - `sendGain` — the GainNode the mixer should drive on the parallel tap
 *
 * The three builders are structurally identical — only the effect type
 * label differs — so they share a factory.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md (R8, R9, R13).
 */

import type { CurvePoint } from '../audio-client'
import type { EffectNode } from '../audio-effect-types'

/**
 * Extended `EffectNode` contract for send-type effects. The mixer
 * (task-47) narrows to this when it encounters a send-category effect.
 */
export interface SendEffectNode extends EffectNode {
  /** The send-bus this effect routes to. Static for the lifetime of the node. */
  bus_id: string
  /**
   * The GainNode the mixer wires into the parallel `track → bus` tap. Its
   * `gain` AudioParam IS the animatable `wet` param of this effect.
   */
  sendGain: GainNode
}

/** Schedule normalized [x, y] curve points onto an AudioParam via linear ramps. */
function scheduleLinearCurve(
  param: AudioParam,
  points: CurvePoint[],
  startTime: number,
  duration: number,
): void {
  if (points.length === 0) return
  const sorted = [...points].sort((a, b) => a[0] - b[0])
  param.setValueAtTime(sorted[0][1], startTime)
  for (let i = 1; i < sorted.length; i++) {
    const [x, y] = sorted[i]
    const t = startTime + Math.max(0, Math.min(1, x)) * duration
    param.linearRampToValueAtTime(y, t)
  }
}

/**
 * Shared factory for reverb / delay / echo sends.
 *
 * All three have the same shape:
 *   - `input === output`: a unity-gain passthrough on the main chain
 *   - `sendGain`: a parallel GainNode (not connected to input/output on
 *     this node — the mixer pulls it into its own `track → bus` graph)
 *   - `bus_id`: static selector, exposed as a property, NOT animatable
 *   - `wet` param in [0, 1]: animates `sendGain.gain`
 */
function buildSend(
  effectLabel: string,
  ctx: AudioContext,
  staticParams: Record<string, unknown>,
): SendEffectNode {
  const bus_id = typeof staticParams.bus_id === 'string' ? staticParams.bus_id : ''

  // Passthrough on the main chain — signal continues downstream unchanged.
  const passthrough = ctx.createGain()
  passthrough.gain.value = 1

  // Parallel tap gain — animated by the `wet` curve. Default 0 (silent
  // tap) until a user dials in a send amount.
  const sendGain = ctx.createGain()
  sendGain.gain.value = 0

  return {
    bus_id,
    sendGain,
    input: passthrough,
    output: passthrough,
    setParam: (name, value, when) => {
      if (name === 'wet') {
        sendGain.gain.setValueAtTime(value, when ?? ctx.currentTime)
      }
      // bus_id is static (R9), other names are no-ops — see module docstring.
      // Unused `effectLabel` available here if future diagnostics want it.
      void effectLabel
    },
    scheduleCurve: (name, points, startTime, duration) => {
      if (name === 'wet') {
        scheduleLinearCurve(sendGain.gain, points, startTime, duration)
      }
    },
    dispose: () => {
      try {
        passthrough.disconnect()
      } catch {
        // already disconnected
      }
      try {
        sendGain.disconnect()
      } catch {
        // already disconnected
      }
    },
  }
}

/**
 * Reverb send — passthrough on main chain, parallel tap to a reverb bus.
 * `wet` animates the tap gain; `bus_id` selects which reverb bus.
 */
export function buildReverbSend(
  ctx: AudioContext,
  staticParams: Record<string, unknown>,
): SendEffectNode {
  return buildSend('reverb_send', ctx, staticParams)
}

/**
 * Delay send — passthrough on main chain, parallel tap to a delay bus
 * (feedback delay line built on the bus side by task-47).
 */
export function buildDelaySend(
  ctx: AudioContext,
  staticParams: Record<string, unknown>,
): SendEffectNode {
  return buildSend('delay_send', ctx, staticParams)
}

/**
 * Echo send — passthrough on main chain, parallel tap to an echo bus
 * (single-tap analog-style repeat on the bus side).
 */
export function buildEchoSend(
  ctx: AudioContext,
  staticParams: Record<string, unknown>,
): SendEffectNode {
  return buildSend('echo_send', ctx, staticParams)
}
