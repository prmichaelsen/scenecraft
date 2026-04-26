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
  applyComposite,
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
          fixtures: { type: 'array' },
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
          fixtures: { type: 'array' },
          intensity: { type: 'number', default: 1.0 },
          color: { type: 'array', default: [1, 1, 1] },
        },
      },
    },
    {
      id: 'composite',
      label: 'Composite',
      description: '',
      params_schema: { properties: { layers: { type: 'array' } } },
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
  it('contains rotating_head, static_color, and composite', () => {
    expect(PRIMITIVE_REGISTRY.rotating_head).toBe(applyRotatingHead)
    expect(PRIMITIVE_REGISTRY.static_color).toBe(applyStaticColor)
    expect(PRIMITIVE_REGISTRY.composite).toBe(applyComposite)
  })
})

describe('fixtures id filter (M21)', () => {
  it('static_color: only listed ids are touched', () => {
    const s = mkStates()
    applyStaticColor(
      0,
      s,
      { fixtures: ['mh1'], intensity: 0.7, color: [1, 0, 0] },
      ctx,
    )
    expect(s.find((x) => x.id === 'mh1')!.intensity).toBe(0.7)
    expect(s.find((x) => x.id === 'mh2')!.intensity).toBe(0)
    expect(s.find((x) => x.id === 'par1')!.intensity).toBe(0)
  })

  it('static_color: role + fixtures intersect (AND, not OR)', () => {
    const s = mkStates()
    // role=par AND fixtures=[mh1] → empty intersection, nothing changes
    applyStaticColor(
      0,
      s,
      { role: 'par', fixtures: ['mh1'], intensity: 0.5, color: [0, 1, 0] },
      ctx,
    )
    for (const f of s) expect(f.intensity).toBe(0)
  })

  it('rotating_head: fixtures filter overrides default role', () => {
    const s = mkStates()
    applyRotatingHead(
      0,
      s,
      {
        // role left at catalog default 'moving_head'; fixtures narrows further
        role: 'moving_head',
        fixtures: ['mh2'],
        period_sec: 4,
        pan_amplitude_rad: 1,
        tilt_center_rad: -0.3,
        tilt_amplitude_rad: 0.2,
        tilt_period_sec: 4,
        intensity: 1,
        color: [1, 1, 1],
      },
      ctx,
    )
    expect(s.find((x) => x.id === 'mh1')!.intensity).toBe(0)
    expect(s.find((x) => x.id === 'mh2')!.intensity).toBe(1)
  })

  it('empty fixtures array is treated as "no id filter"', () => {
    // Otherwise authors would silently render nothing when removing the
    // last id from the list.
    const s = mkStates()
    applyStaticColor(0, s, { fixtures: [], intensity: 0.4, color: [0, 0, 1] }, ctx)
    // No role, no fixtures → all fixtures touched.
    for (const f of s) expect(f.intensity).toBe(0.4)
  })
})

describe('applyComposite (M21)', () => {
  it('runs each sub-layer in order', () => {
    const s = mkStates()
    applyComposite(
      0,
      s,
      {
        layers: [
          { type: 'static_color', params: { fixtures: ['mh1'], intensity: 0.4, color: [1, 0, 0] } },
          { type: 'static_color', params: { fixtures: ['par1'], intensity: 0.9, color: [0, 1, 0] } },
        ],
      },
      ctx,
    )
    expect(s.find((x) => x.id === 'mh1')!.intensity).toBe(0.4)
    expect(s.find((x) => x.id === 'mh1')!.color).toEqual([1, 0, 0])
    expect(s.find((x) => x.id === 'par1')!.intensity).toBe(0.9)
    expect(s.find((x) => x.id === 'par1')!.color).toEqual([0, 1, 0])
    expect(s.find((x) => x.id === 'mh2')!.intensity).toBe(0) // untouched
  })

  it('later layers overwrite earlier ones for overlapping fixtures', () => {
    const s = mkStates()
    applyComposite(
      0,
      s,
      {
        layers: [
          { type: 'static_color', params: { fixtures: ['mh1'], intensity: 0.4, color: [1, 0, 0] } },
          { type: 'static_color', params: { fixtures: ['mh1'], intensity: 0.9, color: [0, 1, 0] } },
        ],
      },
      ctx,
    )
    expect(s.find((x) => x.id === 'mh1')!.color).toEqual([0, 1, 0])
    expect(s.find((x) => x.id === 'mh1')!.intensity).toBe(0.9)
  })

  it('skips unknown sub-layer types and continues with the rest', () => {
    const s = mkStates()
    applyComposite(
      0,
      s,
      {
        layers: [
          { type: 'bogus_primitive', params: {} },
          { type: 'static_color', params: { fixtures: ['mh1'], intensity: 0.5, color: [1, 1, 0] } },
        ],
      },
      ctx,
    )
    expect(s.find((x) => x.id === 'mh1')!.color).toEqual([1, 1, 0])
  })

  it('resolves bindings inside sub-layer params per-context', () => {
    // beat.toggle + values picks values[beatIndex % len]
    const s = mkStates()
    const layers = [
      {
        type: 'static_color',
        params: {
          fixtures: ['mh1'],
          color: { source: 'beat.toggle', mode: 'values', values: [[1, 0, 0], [0, 0, 1]] },
        },
      },
    ]
    applyComposite(0, s, { layers }, { ...ctx, beatIndex: 0 })
    expect(s.find((x) => x.id === 'mh1')!.color).toEqual([1, 0, 0])
    // Reset and try odd beat
    s[0].color = [0, 0, 0]
    applyComposite(0, s, { layers }, { ...ctx, beatIndex: 1 })
    expect(s.find((x) => x.id === 'mh1')!.color).toEqual([0, 0, 1])
  })

  it('handles missing layers param without crashing', () => {
    const s = mkStates()
    expect(() => applyComposite(0, s, {}, ctx)).not.toThrow()
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
