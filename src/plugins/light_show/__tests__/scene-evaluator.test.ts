/**
 * Vitest coverage for the layered scene evaluator (R39-R48).
 *
 * No backend fetch — _setCatalogForTest installs a stub catalog; placements
 * and scenes are constructed directly from spec types.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import type { FixtureState } from '../fixtures'
import type { SceneContext } from '../scene-types'
import type { SceneRow, PlacementRow, LiveOverrideRow } from '../light-show-client'
import {
  evaluateLayeredScene,
  type FallbackSceneAdapter,
  _resetEvaluatorState,
} from '../scene-evaluator'
import { _setCatalogForTest } from '../primitives'

// Mock deactivateLive to avoid network in fade-completion path
vi.mock('../light-show-client', async (orig) => {
  const actual = await orig<typeof import('../light-show-client')>()
  return {
    ...actual,
    deactivateLive: vi.fn(async () => ({ active: false }) as LiveOverrideRow),
  }
})

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
          pan_amplitude_rad: { type: 'number', default: 1.0 },
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
  micLevel: 0,
  micLowLevel: 0,
}

function mkStates(): FixtureState[] {
  return [
    { id: 'mh1', role: 'moving_head', intensity: 0, color: [0, 0, 0], pan: 0, tilt: 0 },
    { id: 'par1', role: 'par',         intensity: 0, color: [0, 0, 0], pan: 0, tilt: 0 },
  ]
}

function mkScene(id: string, type: string, params: Record<string, unknown> = {}): SceneRow {
  return {
    id,
    label: `Scene ${id}`,
    type,
    params,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
  }
}

function mkPlacement(
  id: string,
  scene_id: string,
  start: number,
  end: number,
  extra: Partial<PlacementRow> = {},
): PlacementRow {
  return {
    id,
    scene_id,
    start_time: start,
    end_time: end,
    display_order: 0,
    fade_in_sec: 0,
    fade_out_sec: 0,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...extra,
  }
}

const FALLBACK: FallbackSceneAdapter = {
  id: 'fallback',
  label: 'fallback test scene',
  apply: vi.fn((_t, states) => {
    for (const s of states) {
      s.intensity = 0.42
    }
  }),
}

beforeEach(() => {
  _setCatalogForTest(STUB_CATALOG)
  _resetEvaluatorState()
  vi.mocked(FALLBACK.apply).mockClear()
})

const baseArgs = (over: Partial<Parameters<typeof evaluateLayeredScene>[0]> = {}) => ({
  playheadTime: 0,
  wallClockMs: 0,
  scenesById: new Map<string, SceneRow>(),
  placements: [] as PlacementRow[],
  liveOverride: { active: false } as LiveOverrideRow,
  states: mkStates(),
  context: ctx,
  fallbackScene: FALLBACK,
  projectName: 'test',
  ...over,
})

// ── R39: live override wins ──────────────────────────────────────────────

describe('R39 — evaluator-live-wins', () => {
  it('live precedence — placement and fallback ignored', () => {
    const scene = mkScene('s1', 'static_color', { intensity: 0.5, color: [1, 0, 0] })
    const args = baseArgs({
      scenesById: new Map([['s1', scene]]),
      placements: [mkPlacement('p1', 's1', 0, 100)],
      liveOverride: {
        active: true,
        scene_id: 's1',
        inline_type: null,
        inline_params: null,
        label: 'Live!',
        fade_in_sec: 0,
        fade_out_sec: 0,
        activated_at: new Date(0).toISOString().replace('T', ' ').split('.')[0],
        deactivation_started_at: null,
      },
      wallClockMs: 1000,
    })
    const r = evaluateLayeredScene(args)
    expect(r.activeLayer).toBe('live')
    expect(r.label).toBe('Scene s1')
    expect(args.states[0].intensity).toBe(0.5)
    expect(FALLBACK.apply).not.toHaveBeenCalled()
  })
})

// ── R40 + edge: timeline wins among placements; display_order + tie-break ─

describe('R40 — evaluator-timeline-wins', () => {
  it('timeline wins when no live; placement covering playhead applies', () => {
    const scene = mkScene('s1', 'static_color', { intensity: 0.7, color: [0, 1, 0] })
    const args = baseArgs({
      playheadTime: 5,
      scenesById: new Map([['s1', scene]]),
      placements: [mkPlacement('p1', 's1', 0, 10)],
    })
    const r = evaluateLayeredScene(args)
    expect(r.activeLayer).toBe('timeline')
    expect(args.states[0].intensity).toBe(0.7)
    expect(FALLBACK.apply).not.toHaveBeenCalled()
  })

  it('higher display_order wins on overlap', () => {
    const a = mkScene('a', 'static_color', { intensity: 0.3 })
    const b = mkScene('b', 'static_color', { intensity: 0.9 })
    const args = baseArgs({
      playheadTime: 5,
      scenesById: new Map([['a', a], ['b', b]]),
      placements: [
        mkPlacement('pa', 'a', 0, 10, { display_order: 1 }),
        mkPlacement('pb', 'b', 0, 10, { display_order: 5 }),
      ],
    })
    const r = evaluateLayeredScene(args)
    expect(r.activeLayer).toBe('timeline')
    expect(args.states[0].intensity).toBe(0.9)
  })

  it('tie on display_order broken by oldest created_at', () => {
    const a = mkScene('a', 'static_color', { intensity: 0.3 })
    const b = mkScene('b', 'static_color', { intensity: 0.9 })
    const args = baseArgs({
      playheadTime: 5,
      scenesById: new Map([['a', a], ['b', b]]),
      placements: [
        mkPlacement('pa', 'a', 0, 10, { display_order: 1, created_at: '2026-01-02 00:00:00' }),
        mkPlacement('pb', 'b', 0, 10, { display_order: 1, created_at: '2026-01-01 00:00:00' }),
      ],
    })
    evaluateLayeredScene(args)
    // pb is older → wins
    expect(args.states[0].intensity).toBe(0.9)
  })
})

// ── R41: fallback ────────────────────────────────────────────────────────

describe('R41 — evaluator-fallback-when-neither', () => {
  it('falls back to dropdown scene when no live and no covering placement', () => {
    const args = baseArgs({ playheadTime: 100 })  // no placements
    const r = evaluateLayeredScene(args)
    expect(r.activeLayer).toBe('fallback')
    expect(FALLBACK.apply).toHaveBeenCalledTimes(1)
    expect(args.states[0].intensity).toBe(0.42)
  })

  it('returns activeLayer=none when fallback is null', () => {
    const args = baseArgs({ fallbackScene: null })
    const r = evaluateLayeredScene(args)
    expect(r.activeLayer).toBe('none')
  })
})

// ── R42: fade envelope is intensity-only ─────────────────────────────────

describe('R42 — fade-envelope-only-intensity', () => {
  it('fade-in halves intensity but leaves color/pan/tilt alone', () => {
    const scene = mkScene('s1', 'static_color', { intensity: 1.0, color: [0.5, 0.5, 0.5] })
    const args = baseArgs({
      playheadTime: 1,  // sceneTime = 1
      scenesById: new Map([['s1', scene]]),
      placements: [mkPlacement('p1', 's1', 0, 10, { fade_in_sec: 2 })],  // fade-in 2s
    })
    const r = evaluateLayeredScene(args)
    expect(r.activeLayer).toBe('timeline')
    // sceneTime=1 / fade_in_sec=2 → multiplier 0.5
    expect(args.states[0].intensity).toBeCloseTo(0.5, 6)
    // color preserved (the apply set it to 0.5; fade did not multiply it)
    expect(args.states[0].color).toEqual([0.5, 0.5, 0.5])
    expect(args.states[0].pan).toBe(0)
    expect(args.states[0].tilt).toBe(0)
  })
})

// ── R39, R40, R40a: param resolution ─────────────────────────────────────

describe('evaluator merges sparse params with catalog defaults', () => {
  it('stored period_sec wins, color comes from catalog default', () => {
    const scene = mkScene('s1', 'rotating_head', { period_sec: 8 })  // sparse: only period
    const args = baseArgs({
      playheadTime: 0,
      scenesById: new Map([['s1', scene]]),
      placements: [mkPlacement('p1', 's1', 0, 100)],
    })
    evaluateLayeredScene(args)
    // intensity from catalog default = 1
    expect(args.states[0].intensity).toBe(1)
    // color from catalog default = [1, 1, 1]
    expect(args.states[0].color).toEqual([1, 1, 1])
  })
})

// ── R43: fade-in ─────────────────────────────────────────────────────────

describe('R43 — fade-in', () => {
  it('fade-in at boundary sceneTime=0: intensity multiplier = 0', () => {
    const scene = mkScene('s1', 'static_color', { intensity: 1.0 })
    const args = baseArgs({
      playheadTime: 0,
      scenesById: new Map([['s1', scene]]),
      placements: [mkPlacement('p1', 's1', 0, 10, { fade_in_sec: 2 })],
    })
    evaluateLayeredScene(args)
    expect(args.states[0].intensity).toBe(0)
  })

  it('fade-in midway: intensity = 0.5 at sceneTime=1, fade_in_sec=2', () => {
    const scene = mkScene('s1', 'static_color', { intensity: 1.0 })
    const args = baseArgs({
      playheadTime: 1,
      scenesById: new Map([['s1', scene]]),
      placements: [mkPlacement('p1', 's1', 0, 10, { fade_in_sec: 2 })],
    })
    evaluateLayeredScene(args)
    expect(args.states[0].intensity).toBeCloseTo(0.5, 6)
  })

  it('fade-in after window: full intensity', () => {
    const scene = mkScene('s1', 'static_color', { intensity: 1.0 })
    const args = baseArgs({
      playheadTime: 5,
      scenesById: new Map([['s1', scene]]),
      placements: [mkPlacement('p1', 's1', 0, 10, { fade_in_sec: 2 })],
    })
    evaluateLayeredScene(args)
    expect(args.states[0].intensity).toBe(1)
  })
})

// ── R44: fade-out ────────────────────────────────────────────────────────

describe('R44 — fade-out', () => {
  it('at end-fade boundary, intensity = 0', () => {
    const scene = mkScene('s1', 'static_color', { intensity: 1.0 })
    const args = baseArgs({
      playheadTime: 10,  // exactly at end
      scenesById: new Map([['s1', scene]]),
      placements: [mkPlacement('p1', 's1', 0, 10, { fade_out_sec: 2 })],
    })
    evaluateLayeredScene(args)
    expect(args.states[0].intensity).toBeCloseTo(0, 6)
  })
})

// ── R45: short placement with overlapping fade windows ───────────────────

describe('R45 — fade-in + fade-out overlap', () => {
  it('short placement: midpoint multiplies both factors', () => {
    const scene = mkScene('s1', 'static_color', { intensity: 1.0 })
    // 4-second placement with fade_in=4 and fade_out=4 (windows fully overlap)
    const args = baseArgs({
      playheadTime: 2,  // midpoint
      scenesById: new Map([['s1', scene]]),
      placements: [mkPlacement('p1', 's1', 0, 4, { fade_in_sec: 4, fade_out_sec: 4 })],
    })
    evaluateLayeredScene(args)
    // sceneTime=2, fade_in=4 → 0.5; timeToEnd=2, fade_out=4 → 0.5; product = 0.25
    expect(args.states[0].intensity).toBeCloseTo(0.25, 6)
  })
})

// ── R47: live override fade-out ──────────────────────────────────────────

describe('R47 — live override fade-out', () => {
  it('mid-fade: intensity scales by (1 - sinceDeact / fadeOut)', () => {
    const scene = mkScene('s1', 'static_color', { intensity: 1.0 })
    const activated = new Date(1_000_000).toISOString().replace('T', ' ').split('.')[0]
    const deactivated = new Date(2_000_000).toISOString().replace('T', ' ').split('.')[0]
    const args = baseArgs({
      wallClockMs: 2_001_000,  // 1s after deactivation (real-time scale: 1000ms = 1s)
      scenesById: new Map([['s1', scene]]),
      liveOverride: {
        active: true,
        scene_id: 's1',
        inline_type: null,
        inline_params: null,
        label: 'Live!',
        fade_in_sec: 0,
        fade_out_sec: 4,  // 1s elapsed of 4s fade → multiplier 0.75
        activated_at: activated,
        deactivation_started_at: deactivated,
      },
    })
    evaluateLayeredScene(args)
    expect(args.states[0].intensity).toBeCloseTo(0.75, 1)
  })

  it('fade complete: intensity 0 + DELETE /live fired', async () => {
    const { deactivateLive } = await import('../light-show-client')
    const mockedDeactivate = vi.mocked(deactivateLive)
    mockedDeactivate.mockClear()

    const scene = mkScene('s1', 'static_color', { intensity: 1.0 })
    const activated = new Date(1_000_000).toISOString().replace('T', ' ').split('.')[0]
    const deactivated = new Date(2_000_000).toISOString().replace('T', ' ').split('.')[0]
    const args = baseArgs({
      wallClockMs: 2_010_000,  // 10s after deactivation, way past 2s fade
      scenesById: new Map([['s1', scene]]),
      liveOverride: {
        active: true,
        scene_id: 's1',
        inline_type: null,
        inline_params: null,
        label: 'Live!',
        fade_in_sec: 0,
        fade_out_sec: 2,
        activated_at: activated,
        deactivation_started_at: deactivated,
      },
    })
    evaluateLayeredScene(args)
    expect(args.states[0].intensity).toBe(0)
    expect(mockedDeactivate).toHaveBeenCalledTimes(1)
    expect(mockedDeactivate).toHaveBeenCalledWith('test')
  })
})

// ── M21: composite + bindings end-to-end ─────────────────────────────────

describe('M21 — composite scene with audio-reactive bindings', () => {
  /**
   * The diagonal-flip use case: 4 pars in an xz rectangle. Two diagonals
   * alternate red/blue every beat. One scene, one composite primitive,
   * two static_color sub-layers with opposite-phase color tables driven
   * by beat.toggle.
   */
  function mkRectStates(): FixtureState[] {
    return [
      // diagonal A: nw + se
      { id: 'par_nw', role: 'par', intensity: 0, color: [0, 0, 0], pan: 0, tilt: 0 },
      { id: 'par_se', role: 'par', intensity: 0, color: [0, 0, 0], pan: 0, tilt: 0 },
      // diagonal B: ne + sw
      { id: 'par_ne', role: 'par', intensity: 0, color: [0, 0, 0], pan: 0, tilt: 0 },
      { id: 'par_sw', role: 'par', intensity: 0, color: [0, 0, 0], pan: 0, tilt: 0 },
    ]
  }

  function mkDiagonalFlipScene(): SceneRow {
    return mkScene('diagonal_flip', 'composite', {
      layers: [
        {
          type: 'static_color',
          params: {
            fixtures: ['par_nw', 'par_se'],
            color: { source: 'beat.toggle', mode: 'values', values: [[1, 0, 0], [0, 0, 1]] },
            intensity: 1,
          },
        },
        {
          type: 'static_color',
          params: {
            fixtures: ['par_ne', 'par_sw'],
            color: { source: 'beat.toggle', mode: 'values', values: [[0, 0, 1], [1, 0, 0]] },
            intensity: 1,
          },
        },
      ],
    })
  }

  it('beat 0: diagonal A is red, diagonal B is blue', () => {
    const scene = mkDiagonalFlipScene()
    const args = baseArgs({
      playheadTime: 5,
      scenesById: new Map([['diagonal_flip', scene]]),
      placements: [mkPlacement('p1', 'diagonal_flip', 0, 100)],
      states: mkRectStates(),
      context: { ...ctx, beatIndex: 0 },
    })
    const result = evaluateLayeredScene(args)
    expect(result.activeLayer).toBe('timeline')
    expect(args.states.find((s) => s.id === 'par_nw')!.color).toEqual([1, 0, 0])
    expect(args.states.find((s) => s.id === 'par_se')!.color).toEqual([1, 0, 0])
    expect(args.states.find((s) => s.id === 'par_ne')!.color).toEqual([0, 0, 1])
    expect(args.states.find((s) => s.id === 'par_sw')!.color).toEqual([0, 0, 1])
  })

  it('beat 1: colors swap — diagonal A blue, diagonal B red', () => {
    const scene = mkDiagonalFlipScene()
    const args = baseArgs({
      playheadTime: 5,
      scenesById: new Map([['diagonal_flip', scene]]),
      placements: [mkPlacement('p1', 'diagonal_flip', 0, 100)],
      states: mkRectStates(),
      context: { ...ctx, beatIndex: 1 },
    })
    evaluateLayeredScene(args)
    expect(args.states.find((s) => s.id === 'par_nw')!.color).toEqual([0, 0, 1])
    expect(args.states.find((s) => s.id === 'par_se')!.color).toEqual([0, 0, 1])
    expect(args.states.find((s) => s.id === 'par_ne')!.color).toEqual([1, 0, 0])
    expect(args.states.find((s) => s.id === 'par_sw')!.color).toEqual([1, 0, 0])
  })

  it('continuous binding: master.level drives intensity per frame', () => {
    const scene = mkScene('audio_pulse', 'static_color', {
      intensity: { source: 'master.level', scale: 1, offset: 0 },
      color: [1, 1, 1],
    })
    const args = baseArgs({
      playheadTime: 1,
      scenesById: new Map([['audio_pulse', scene]]),
      placements: [mkPlacement('p1', 'audio_pulse', 0, 10)],
      states: mkRectStates(),
      context: { ...ctx, masterLevel: 0.65 },
    })
    evaluateLayeredScene(args)
    for (const s of args.states) {
      expect(s.intensity).toBeCloseTo(0.65, 6)
    }
  })
})

// ── R48: determinism ──────────────────────────────────────────────────────

describe('R48 — determinism', () => {
  it('same playheadTime + inputs → identical state outputs', () => {
    const scene = mkScene('s1', 'rotating_head', { period_sec: 4 })
    const a = baseArgs({
      playheadTime: 2.7,
      scenesById: new Map([['s1', scene]]),
      placements: [mkPlacement('p1', 's1', 0, 100)],
    })
    evaluateLayeredScene(a)
    const snapA = a.states.map((s) => ({ ...s, color: [...s.color] as [number, number, number] }))

    const b = baseArgs({
      playheadTime: 2.7,
      scenesById: new Map([['s1', scene]]),
      placements: [mkPlacement('p1', 's1', 0, 100)],
    })
    evaluateLayeredScene(b)
    expect(b.states).toEqual(snapA)
  })
})
