/**
 * Vitest coverage for the M19 primitives module.
 *
 * Spec R31-R38 + edge cases. No backend fetch — _setCatalogForTest installs
 * a stub catalog so tests are hermetic.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import type { FixtureState } from '../fixtures'
import type { SceneContext } from '../scene-types'
import {
  PRIMITIVE_REGISTRY,
  applyRotatingHead,
  applyStaticColor,
  resolveParams,
  assertCatalogRegistryParity,
  _setCatalogForTest,
} from '../primitives'

const STUB_CATALOG = {
  primitives: [
    {
      id: 'rotating_head',
      label: 'Rotating Head',
      description: '',
      params_schema: {
        properties: {
          role: { type: 'string', default: 'moving_head' },
          period_sec: { type: 'number', default: 4.0 },
          pan_amplitude_rad: { type: 'number', default: Math.PI / 4 },
          tilt_center_rad: { type: 'number', default: -0.3 },
          tilt_amplitude_rad: { type: 'number', default: 0.2 },
          tilt_period_sec: { type: 'number', default: 4.0 },
          intensity: { type: 'number', default: 1.0 },
          color: { type: 'array', default: [1, 1, 1] },
        },
      },
    },
    {
      id: 'static_color',
      label: 'Static Color',
      description: '',
      params_schema: {
        properties: {
          role: { type: 'string' },
          intensity: { type: 'number', default: 1.0 },
          color: { type: 'array', default: [1, 1, 1] },
        },
      },
    },
  ],
}

const ctx: SceneContext = {
  playheadTime: 0,
  beatAge: Infinity,
  lastBeatIntensity: 0,
  beatIndex: 0,
  isPlaying: false,
  masterLevel: 0,
  masterLowLevel: 0,
}

function mkStates(): FixtureState[] {
  return [
    { id: 'mh1', role: 'moving_head', intensity: 0, color: [0, 0, 0], pan: 0, tilt: 0 },
    { id: 'mh2', role: 'moving_head', intensity: 0, color: [0, 0, 0], pan: 0, tilt: 0 },
    { id: 'par1', role: 'par',         intensity: 0, color: [0, 0, 0], pan: 0, tilt: 0 },
  ]
}

beforeEach(() => {
  _setCatalogForTest(STUB_CATALOG)
})

describe('applyRotatingHead', () => {
  const PARAMS = {
    role: 'moving_head',
    period_sec: 4.0,
    pan_amplitude_rad: 1.0,
    tilt_center_rad: -0.3,
    tilt_amplitude_rad: 0.2,
    tilt_period_sec: 4.0,
    intensity: 1.0,
    color: [1, 1, 1] as [number, number, number],
  }

  it('R32: at sceneTime=0, pan=0 / tilt=tilt_center', () => {
    const s = mkStates()
    applyRotatingHead(0, s, PARAMS, ctx)
    expect(s[0].pan).toBe(0)
    expect(s[0].tilt).toBeCloseTo(-0.3, 6)
    expect(s[0].intensity).toBe(1)
    expect(s[0].color).toEqual([1, 1, 1])
  })

  it('R33: at quarter-period, pan = +pan_amplitude', () => {
    const s = mkStates()
    applyRotatingHead(PARAMS.period_sec / 4, s, PARAMS, ctx)
    expect(s[0].pan).toBeCloseTo(PARAMS.pan_amplitude_rad, 6)
  })

  it('R34: at half-period, pan back to 0', () => {
    const s = mkStates()
    applyRotatingHead(PARAMS.period_sec / 2, s, PARAMS, ctx)
    expect(s[0].pan).toBeCloseTo(0, 6)
  })

  it('R35: at three-quarter-period, pan = -pan_amplitude', () => {
    const s = mkStates()
    applyRotatingHead((3 * PARAMS.period_sec) / 4, s, PARAMS, ctx)
    expect(s[0].pan).toBeCloseTo(-PARAMS.pan_amplitude_rad, 6)
  })

  it('R36: respects role filter — par fixtures untouched', () => {
    const s = mkStates()
    applyRotatingHead(1.0, s, PARAMS, ctx)
    const par = s.find((x) => x.id === 'par1')!
    expect(par.intensity).toBe(0)
    expect(par.color).toEqual([0, 0, 0])
    expect(par.pan).toBe(0)
    const mh1 = s.find((x) => x.id === 'mh1')!
    expect(mh1.intensity).toBe(1)
  })

  it('R37: when role undefined, all fixtures get intensity/color', () => {
    const s = mkStates()
    const noRoleParams = { ...PARAMS, role: undefined }
    applyRotatingHead(0, s, noRoleParams, ctx)
    for (const f of s) {
      expect(f.intensity).toBe(1)
      expect(f.color).toEqual([1, 1, 1])
    }
  })
})

describe('applyStaticColor', () => {
  const PARAMS = {
    role: 'par',
    intensity: 0.5,
    color: [1, 0, 0] as [number, number, number],
  }

  it('R38: does NOT touch pan/tilt', () => {
    const s = mkStates()
    s[2].pan = 1.5
    s[2].tilt = -0.7
    applyStaticColor(0, s, PARAMS, ctx)
    const par = s[2]
    expect(par.intensity).toBe(0.5)
    expect(par.color).toEqual([1, 0, 0])
    expect(par.pan).toBe(1.5)
    expect(par.tilt).toBe(-0.7)
  })

  it('respects role filter', () => {
    const s = mkStates()
    applyStaticColor(0, s, PARAMS, ctx)
    expect(s[0].intensity).toBe(0)
    expect(s[2].intensity).toBe(0.5)
  })
})

describe('resolveParams', () => {
  it('merges catalog defaults under stored values', () => {
    const merged = resolveParams({ period_sec: 6 }, 'rotating_head')
    expect(merged.period_sec).toBe(6)
    expect(merged.color).toEqual([1, 1, 1])
    expect(merged.role).toBe('moving_head')
  })

  it('returns undefined for keys missing from both', () => {
    const merged = resolveParams({}, 'static_color')
    expect(merged.role).toBeUndefined()
    expect(merged.intensity).toBe(1.0)
  })

  it('throws on unknown primitive type', () => {
    expect(() => resolveParams({}, 'bogus')).toThrow(/unknown primitive type/)
  })
})

describe('PRIMITIVE_REGISTRY', () => {
  it('contains rotating_head and static_color', () => {
    expect(PRIMITIVE_REGISTRY.rotating_head).toBe(applyRotatingHead)
    expect(PRIMITIVE_REGISTRY.static_color).toBe(applyStaticColor)
  })
})

describe('assertCatalogRegistryParity (R31)', () => {
  it('passes when catalog matches registry', () => {
    expect(() => assertCatalogRegistryParity(STUB_CATALOG)).not.toThrow()
  })

  it('throws when catalog has primitive not in registry', () => {
    const drift = {
      primitives: [
        ...STUB_CATALOG.primitives,
        {
          id: 'fake_primitive',
          label: 'Fake',
          description: '',
          params_schema: { properties: {} },
        },
      ],
    }
    expect(() => assertCatalogRegistryParity(drift)).toThrow(/no apply.*fake_primitive/)
  })

  it('throws when registry has primitive not in catalog', () => {
    const drift = {
      primitives: STUB_CATALOG.primitives.filter((p) => p.id !== 'static_color'),
    }
    expect(() => assertCatalogRegistryParity(drift)).toThrow(/no catalog entry.*static_color/)
  })
})
