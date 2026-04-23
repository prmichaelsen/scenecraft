import { describe, it, expect } from 'vitest'
import {
  EFFECT_TYPES,
  SYNTHETIC_SEND_EFFECT_TYPE,
  type EffectNode,
  type EffectParamSpec,
} from '../audio-effect-types'
import { SPECTRUM_BANDS, INSTRUMENT_PRESETS } from '../frequency-labels'

// Spec R9: these (effect_type, param_name) pairs are the ONLY non-animatable
// params in v1. Every other user-facing param must be animatable.
const NON_ANIMATABLE_PAIRS = new Set<string>([
  'drive.character',
  'reverb_send.bus_id',
  'delay_send.bus_id',
  'echo_send.bus_id',
  'tremolo.rate',
  'auto_pan.rate',
  'chorus.rate',
  'flanger.rate',
  'phaser.rate',
])

describe('EFFECT_TYPES registry', () => {
  it('contains exactly 17 effect types per spec R8', () => {
    expect(Object.keys(EFFECT_TYPES)).toHaveLength(17)
  })

  it('contains every spec-mandated effect type', () => {
    const expected = [
      'compressor', 'gate', 'limiter',
      'eq_band', 'highpass', 'lowpass',
      'pan', 'stereo_width',
      'reverb_send', 'delay_send', 'echo_send',
      'tremolo', 'auto_pan', 'chorus', 'flanger', 'phaser',
      'drive',
    ]
    for (const type of expected) {
      expect(EFFECT_TYPES[type]).toBeDefined()
      expect(EFFECT_TYPES[type].type).toBe(type)
    }
  })

  it('keys match their spec.type field', () => {
    for (const [key, spec] of Object.entries(EFFECT_TYPES)) {
      expect(spec.type).toBe(key)
    }
  })

  it('every param has required fields with sane values', () => {
    for (const spec of Object.values(EFFECT_TYPES)) {
      for (const param of spec.params) {
        expect(param.name, `${spec.type}: missing name`).toBeTruthy()
        expect(param.label, `${spec.type}.${param.name}: missing label`).toBeTruthy()
        expect(param.range, `${spec.type}.${param.name}: missing range`).toBeDefined()
        expect(param.range.max, `${spec.type}.${param.name}: max <= min`).toBeGreaterThanOrEqual(param.range.min)
        expect(param.scale, `${spec.type}.${param.name}: missing scale`).toBeTruthy()
        expect(['linear', 'log', 'db', 'hz']).toContain(param.scale)
        expect(typeof param.default, `${spec.type}.${param.name}: default must be number`).toBe('number')
        expect(typeof param.animatable, `${spec.type}.${param.name}: animatable must be boolean`).toBe('boolean')
      }
    }
  })

  it('every animatable param has a non-empty range', () => {
    for (const spec of Object.values(EFFECT_TYPES)) {
      for (const param of spec.params) {
        if (param.animatable) {
          expect(
            param.range.max,
            `${spec.type}.${param.name} is animatable but has empty range`,
          ).toBeGreaterThan(param.range.min)
        }
      }
    }
  })

  it('exactly the R9 exception list is marked animatable: false', () => {
    const actualNonAnimatable = new Set<string>()
    for (const spec of Object.values(EFFECT_TYPES)) {
      for (const param of spec.params) {
        if (!param.animatable) {
          actualNonAnimatable.add(`${spec.type}.${param.name}`)
        }
      }
    }
    expect(actualNonAnimatable).toEqual(NON_ANIMATABLE_PAIRS)
  })

  it('each R9 exception is indeed present in its effect type', () => {
    for (const pair of NON_ANIMATABLE_PAIRS) {
      const [effectType, paramName] = pair.split('.')
      const spec = EFFECT_TYPES[effectType]
      expect(spec, `missing effect type ${effectType}`).toBeDefined()
      const param = spec.params.find((p: EffectParamSpec) => p.name === paramName)
      expect(param, `missing param ${pair}`).toBeDefined()
      expect(param!.animatable).toBe(false)
    }
  })

  it('eq_band.freq exposes all 19 built-in labelPresets (8 spectrum + 11 instrument)', () => {
    const freqParam = EFFECT_TYPES.eq_band.params.find(p => p.name === 'freq')
    expect(freqParam).toBeDefined()
    expect(freqParam!.labelPresets).toBeDefined()
    expect(freqParam!.labelPresets!.length).toBe(SPECTRUM_BANDS.length + INSTRUMENT_PRESETS.length)
    expect(SPECTRUM_BANDS.length).toBe(8)
    expect(INSTRUMENT_PRESETS.length).toBe(11)

    const presetLabels = new Set(freqParam!.labelPresets!.map(p => p.label))
    for (const b of SPECTRUM_BANDS) expect(presetLabels.has(b.label)).toBe(true)
    for (const i of INSTRUMENT_PRESETS) expect(presetLabels.has(i.label)).toBe(true)
  })

  it('build() returns an object conforming to the EffectNode shape', () => {
    // happy-dom lacks a native AudioContext; provide a mock rich enough for
    // the factories we've implemented so far (stubs only use createGain;
    // task-50 spatial+send also exercise splitter/merger/panner). The mock
    // is shared with audio-effects-spatial-send.test.ts — keep in sync.
    const makeParam = () => ({
      value: 0,
      setValueAtTime: () => {},
      linearRampToValueAtTime: () => {},
    })
    const makeNode = () => ({
      connect: () => {},
      disconnect: () => {},
      gain: makeParam(),
      pan: makeParam(),
    })
    const fakeCtx = {
      currentTime: 0,
      createGain: () => makeNode(),
      createStereoPanner: () => makeNode(),
      createChannelSplitter: () => makeNode(),
      createChannelMerger: () => makeNode(),
    } as unknown as AudioContext

    for (const spec of Object.values(EFFECT_TYPES)) {
      const node: EffectNode = spec.build(fakeCtx, {})
      expect(node, `${spec.type}: build() returned falsy`).toBeDefined()
      expect(node.input).toBeDefined()
      expect(node.output).toBeDefined()
      expect(typeof node.setParam).toBe('function')
      expect(typeof node.scheduleCurve).toBe('function')
      expect(typeof node.dispose).toBe('function')

      // Calling the methods should not throw, even on stubs.
      expect(() => node.setParam('x', 0)).not.toThrow()
      expect(() => node.scheduleCurve('x', [], 0, 1)).not.toThrow()
      expect(() => node.dispose()).not.toThrow()
    }
  })
})

describe('SYNTHETIC_SEND_EFFECT_TYPE', () => {
  it('is exported as the reserved string "__send"', () => {
    expect(SYNTHETIC_SEND_EFFECT_TYPE).toBe('__send')
  })

  it('is NOT present in the EFFECT_TYPES registry per spec R8a', () => {
    expect(EFFECT_TYPES[SYNTHETIC_SEND_EFFECT_TYPE]).toBeUndefined()
    expect('__send' in EFFECT_TYPES).toBe(false)
  })
})
