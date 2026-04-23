/**
 * M13 task-46: Single source of truth for all v1 audio effect types.
 *
 * Contains:
 *   - EffectTypeSpec + EffectParamSpec + EffectNode interfaces (spec R7)
 *   - EFFECT_TYPES registry with all 17 effect types (spec R8)
 *   - Animatability rules (spec R9)
 *   - Reserved synthetic `__send` effect_type constant (spec R8a)
 *
 * The `build()` factories are STUB implementations in this task. The real
 * WebAudio node construction lands in task-47/48. Every stub returns a shape
 * that satisfies EffectNode so TypeScript consumers can compile against the
 * registry today.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md (R7-R10, R48-R49, R19).
 */

import type { CurvePoint } from './audio-client'
import {
  SPECTRUM_BANDS,
  INSTRUMENT_PRESETS,
  type FrequencyLabelPreset,
} from './frequency-labels'
import {
  buildCompressor,
  buildGate,
  buildLimiter,
} from './audio-effects/dynamics'
import {
  buildEQBand,
  buildHighpass,
  buildLowpass,
} from './audio-effects/eq'
import { buildPan, buildStereoWidth } from './audio-effects/spatial'
import { buildReverbSend, buildDelaySend, buildEchoSend } from './audio-effects/send'

export type { FrequencyLabelPreset }

/** Effect category groupings surfaced in the Add-Effect dropdown. */
export type EffectCategory =
  | 'dynamics'
  | 'eq'
  | 'spatial'
  | 'time'
  | 'modulation'
  | 'distortion'
  | 'send'

/** How a param value maps from normalized [0, 1] curve space to its native unit. */
export type ParamScale = 'linear' | 'log' | 'db' | 'hz'

/** Metadata for a single parameter of an effect. */
export interface EffectParamSpec {
  name: string
  label: string
  animatable: boolean
  range: { min: number; max: number }
  scale: ParamScale
  default: number
  labelPresets?: FrequencyLabelPreset[]
}

/** Runtime node produced by an EffectTypeSpec.build() factory. */
export interface EffectNode {
  input: AudioNode
  output: AudioNode
  setParam: (name: string, value: number, when?: number) => void
  scheduleCurve: (
    name: string,
    points: CurvePoint[],
    startTime: number,
    duration: number,
  ) => void
  dispose: () => void
}

/** Full registry entry for one effect type. */
export interface EffectTypeSpec {
  type: string
  label: string
  category: EffectCategory
  params: EffectParamSpec[]
  build: (ctx: AudioContext, staticParams: Record<string, unknown>) => EffectNode
}

/**
 * Reserved synthetic effect_type string used ONLY to animate per-bus send
 * levels via the `effect_curves` table. Intentionally NOT registered in
 * EFFECT_TYPES — it has no build() factory and must be rejected by the
 * POST /track-effects endpoint. See spec R8a.
 */
export const SYNTHETIC_SEND_EFFECT_TYPE = '__send'

/**
 * Placeholder EffectNode returned by every registry stub. Real WebAudio
 * construction lands in task-47/48.
 *
 * TODO(task-47): replace with per-effect-type node graphs.
 */
function makeStubNode(ctx: AudioContext): EffectNode {
  // A GainNode is a convenient audible pass-through that satisfies both
  // `input` and `output` until the real graph is built.
  const node = ctx.createGain()
  return {
    input: node,
    output: node,
    setParam: () => {
      // TODO(task-47): real implementation — will look up the corresponding
      // AudioParam and call setValueAtTime / setTargetAtTime.
    },
    scheduleCurve: () => {
      // TODO(task-47): real implementation — will delegate to
      // audio-mixer.ts's curve scheduler.
    },
    dispose: () => {
      try {
        node.disconnect()
      } catch {
        // GainNode may already be disconnected; ignore.
      }
    },
  }
}

/** Convenience: a build factory that returns a stub node. */
const stubBuild: EffectTypeSpec['build'] = (ctx) => makeStubNode(ctx)

/**
 * The complete registry of v1 effect types. Key = `type` string; value =
 * spec. 17 entries total per spec R8.
 *
 * Animatability follows R9: every param is animatable EXCEPT:
 *   - `drive.character`
 *   - `*_send.bus_id`
 *   - LFO `rate` on tremolo/auto_pan/chorus/flanger/phaser
 *   - `ir` (reverb bus IR selector — that lives on the send-bus itself, not
 *     on the track-side reverb_send effect; the send effect only exposes
 *     `bus_id` + `level`).
 */
export const EFFECT_TYPES: Record<string, EffectTypeSpec> = {
  // ----- Dynamics ------------------------------------------------------

  compressor: {
    type: 'compressor',
    label: 'Compressor',
    category: 'dynamics',
    params: [
      { name: 'threshold', label: 'Threshold', animatable: true, range: { min: -60, max: 0 }, scale: 'db', default: -24 },
      { name: 'ratio', label: 'Ratio', animatable: true, range: { min: 1, max: 20 }, scale: 'linear', default: 4 },
      { name: 'attack', label: 'Attack', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.003 },
      { name: 'release', label: 'Release', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.25 },
      { name: 'knee', label: 'Knee', animatable: true, range: { min: 0, max: 40 }, scale: 'linear', default: 30 },
    ],
    build: buildCompressor,
  },

  gate: {
    type: 'gate',
    label: 'Gate',
    category: 'dynamics',
    params: [
      { name: 'threshold', label: 'Threshold', animatable: true, range: { min: -80, max: 0 }, scale: 'db', default: -40 },
      { name: 'attack', label: 'Attack', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.005 },
      { name: 'release', label: 'Release', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.1 },
      { name: 'hold', label: 'Hold', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.05 },
    ],
    build: buildGate,
  },

  limiter: {
    type: 'limiter',
    label: 'Limiter',
    category: 'dynamics',
    params: [
      { name: 'ceiling', label: 'Ceiling', animatable: true, range: { min: -20, max: 0 }, scale: 'db', default: -0.3 },
      { name: 'release', label: 'Release', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.05 },
    ],
    build: buildLimiter,
  },

  // ----- EQ ------------------------------------------------------------

  eq_band: {
    type: 'eq_band',
    label: 'EQ Band',
    category: 'eq',
    params: [
      {
        name: 'freq',
        label: 'Frequency',
        animatable: true,
        range: { min: 20, max: 20000 },
        scale: 'hz',
        default: 1000,
        // Spec R10: 8 spectrum bands + 11 instrument presets = 19 built-ins.
        labelPresets: [...SPECTRUM_BANDS, ...INSTRUMENT_PRESETS],
      },
      { name: 'gain', label: 'Gain', animatable: true, range: { min: -24, max: 24 }, scale: 'db', default: 0 },
      { name: 'q', label: 'Q', animatable: true, range: { min: 0.1, max: 18 }, scale: 'linear', default: 1 },
    ],
    build: buildEQBand,
  },

  highpass: {
    type: 'highpass',
    label: 'High-pass',
    category: 'eq',
    params: [
      { name: 'cutoff', label: 'Cutoff', animatable: true, range: { min: 20, max: 20000 }, scale: 'hz', default: 80 },
      { name: 'q', label: 'Q', animatable: true, range: { min: 0.1, max: 18 }, scale: 'linear', default: 0.707 },
    ],
    build: buildHighpass,
  },

  lowpass: {
    type: 'lowpass',
    label: 'Low-pass',
    category: 'eq',
    params: [
      { name: 'cutoff', label: 'Cutoff', animatable: true, range: { min: 20, max: 20000 }, scale: 'hz', default: 8000 },
      { name: 'q', label: 'Q', animatable: true, range: { min: 0.1, max: 18 }, scale: 'linear', default: 0.707 },
    ],
    build: buildLowpass,
  },

  // ----- Spatial -------------------------------------------------------

  pan: {
    type: 'pan',
    label: 'Pan',
    category: 'spatial',
    params: [
      { name: 'pan', label: 'Pan', animatable: true, range: { min: -1, max: 1 }, scale: 'linear', default: 0 },
    ],
    build: (ctx, staticParams) => buildPan(ctx, staticParams),
  },

  stereo_width: {
    type: 'stereo_width',
    label: 'Stereo Width',
    category: 'spatial',
    params: [
      { name: 'width', label: 'Width', animatable: true, range: { min: 0, max: 2 }, scale: 'linear', default: 1 },
    ],
    build: (ctx, staticParams) => buildStereoWidth(ctx, staticParams),
  },

  // ----- Send (per-track send effects) ---------------------------------
  // `bus_id` is non-animatable (it's a selector; spec R9). The animatable
  // tap-gain param is `wet` (0..1) — aligned with task-50's builder contract.

  reverb_send: {
    type: 'reverb_send',
    label: 'Reverb Send',
    category: 'send',
    params: [
      { name: 'bus_id', label: 'Bus', animatable: false, range: { min: 0, max: 0 }, scale: 'linear', default: 0 },
      { name: 'wet', label: 'Wet', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0 },
    ],
    build: (ctx, staticParams) => buildReverbSend(ctx, staticParams),
  },

  delay_send: {
    type: 'delay_send',
    label: 'Delay Send',
    category: 'send',
    params: [
      { name: 'bus_id', label: 'Bus', animatable: false, range: { min: 0, max: 0 }, scale: 'linear', default: 0 },
      { name: 'wet', label: 'Wet', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0 },
    ],
    build: (ctx, staticParams) => buildDelaySend(ctx, staticParams),
  },

  echo_send: {
    type: 'echo_send',
    label: 'Echo Send',
    category: 'send',
    params: [
      { name: 'bus_id', label: 'Bus', animatable: false, range: { min: 0, max: 0 }, scale: 'linear', default: 0 },
      { name: 'wet', label: 'Wet', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0 },
    ],
    build: (ctx, staticParams) => buildEchoSend(ctx, staticParams),
  },

  // ----- Modulation ----------------------------------------------------
  // LFO `rate` is non-animatable per spec R9.

  tremolo: {
    type: 'tremolo',
    label: 'Tremolo',
    category: 'modulation',
    params: [
      { name: 'rate', label: 'Rate', animatable: false, range: { min: 0.1, max: 20 }, scale: 'log', default: 5 },
      { name: 'depth', label: 'Depth', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.5 },
    ],
    build: stubBuild,
  },

  auto_pan: {
    type: 'auto_pan',
    label: 'Auto-Pan',
    category: 'modulation',
    params: [
      { name: 'rate', label: 'Rate', animatable: false, range: { min: 0.1, max: 20 }, scale: 'log', default: 1 },
      { name: 'depth', label: 'Depth', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.75 },
    ],
    build: stubBuild,
  },

  chorus: {
    type: 'chorus',
    label: 'Chorus',
    category: 'modulation',
    params: [
      { name: 'rate', label: 'Rate', animatable: false, range: { min: 0.1, max: 10 }, scale: 'log', default: 1.5 },
      { name: 'depth', label: 'Depth', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.5 },
      { name: 'mix', label: 'Mix', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.5 },
    ],
    build: stubBuild,
  },

  flanger: {
    type: 'flanger',
    label: 'Flanger',
    category: 'modulation',
    params: [
      { name: 'rate', label: 'Rate', animatable: false, range: { min: 0.05, max: 10 }, scale: 'log', default: 0.5 },
      { name: 'depth', label: 'Depth', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.5 },
      { name: 'feedback', label: 'Feedback', animatable: true, range: { min: 0, max: 0.95 }, scale: 'linear', default: 0.5 },
      { name: 'mix', label: 'Mix', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.5 },
    ],
    build: stubBuild,
  },

  phaser: {
    type: 'phaser',
    label: 'Phaser',
    category: 'modulation',
    params: [
      { name: 'rate', label: 'Rate', animatable: false, range: { min: 0.05, max: 10 }, scale: 'log', default: 0.5 },
      { name: 'depth', label: 'Depth', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.7 },
      { name: 'feedback', label: 'Feedback', animatable: true, range: { min: 0, max: 0.95 }, scale: 'linear', default: 0.5 },
      { name: 'mix', label: 'Mix', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.5 },
    ],
    build: stubBuild,
  },

  // ----- Distortion ----------------------------------------------------
  // `character` is a discrete selector — non-animatable per spec R9.

  drive: {
    type: 'drive',
    label: 'Drive',
    category: 'distortion',
    params: [
      { name: 'character', label: 'Character', animatable: false, range: { min: 0, max: 4 }, scale: 'linear', default: 0 },
      { name: 'amount', label: 'Amount', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.3 },
      { name: 'tone', label: 'Tone', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 0.5 },
      { name: 'mix', label: 'Mix', animatable: true, range: { min: 0, max: 1 }, scale: 'linear', default: 1 },
    ],
    build: stubBuild,
  },
}
