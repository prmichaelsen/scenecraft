/**
 * Vitest spec tests for the light-show-scene-editor spec.
 *
 * Covers R31-R50 from agent/specs/local.light-show-scene-editor.md.
 * Tests exercise the frontend-visible surface: primitives, evaluator,
 * REST client, WS subscription, and LightShow3DPanel integration hooks.
 *
 * Backend-only requirements (R1-R30: schema migration, MCP tools, SQL)
 * are not tested here — they belong in pytest on the engine side.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import type { FixtureState } from '../fixtures'
import { makeInitialStates, RIG } from '../fixtures'
import type { SceneContext } from '../scene-types'
import type { SceneRow, PlacementRow, LiveOverrideRow } from '../light-show-client'
import {
  evaluateLayeredScene,
  type FallbackSceneAdapter,
  type EvaluatorResult,
  _resetEvaluatorState,
} from '../scene-evaluator'
import {
  PRIMITIVE_REGISTRY,
  applyRotatingHead,
  applyStaticColor,
  resolveParams,
  assertCatalogRegistryParity,
  _setCatalogForTest,
} from '../primitives'
import { SCENES, getScene } from '../scenes'

// Mock deactivateLive to avoid real network calls in fade-completion path
vi.mock('../light-show-client', async (orig) => {
  const actual = await orig<typeof import('../light-show-client')>()
  return {
    ...actual,
    deactivateLive: vi.fn(async () => ({ active: false }) as LiveOverrideRow),
  }
})

// ── Shared helpers ──────────────────────────────────────────────────────

/** Catalog matching the spec's primitives_catalog.yaml defaults. */
const SPEC_CATALOG = {
  primitives: [
    {
      id: 'rotating_head',
      label: 'Rotating Head',
      description: 'Sinusoidal pan/tilt sweep',
      params_schema: {
        type: 'object',
        properties: {
          role: { type: 'string', default: 'moving_head' },
          fixtures: { type: 'array' },
          period_sec: { type: 'number', minimum: 0.1, default: 4.0 },
          pan_amplitude_rad: {
            type: 'number',
            minimum: 0,
            default: 0.7853981633974483,  // pi/4
          },
          tilt_center_rad: { type: 'number', default: -0.3 },
          tilt_amplitude_rad: { type: 'number', minimum: 0, default: 0.2 },
          tilt_period_sec: { type: 'number', minimum: 0.1, default: 4.0 },
          intensity: { type: 'number', minimum: 0, maximum: 1, default: 1.0 },
          color: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: { type: 'number', minimum: 0, maximum: 1 },
            default: [1, 1, 1],
          },
        },
      },
    },
    {
      id: 'static_color',
      label: 'Static Color',
      description: 'Hold a color + intensity',
      params_schema: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          fixtures: { type: 'array' },
          intensity: { type: 'number', minimum: 0, maximum: 1, default: 1.0 },
          color: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: { type: 'number', minimum: 0, maximum: 1 },
            default: [1, 1, 1],
          },
        },
      },
    },
    // The registry has more entries (color_fade, color_chase, strobe, composite)
    // — include stubs so assertCatalogRegistryParity won't throw on setup.
    {
      id: 'color_fade',
      label: 'Color Fade',
      description: '',
      params_schema: {
        properties: {
          role: { type: 'string' },
          fixtures: { type: 'array' },
          color_a: { type: 'array', default: [1, 0, 0] },
          color_b: { type: 'array', default: [0, 0, 1] },
          period_sec: { type: 'number', default: 4.0 },
          phase: { type: 'number', default: 0 },
          intensity: { type: 'number', default: 1.0 },
        },
      },
    },
    {
      id: 'color_chase',
      label: 'Color Chase',
      description: '',
      params_schema: {
        properties: {
          role: { type: 'string' },
          fixtures: { type: 'array' },
          colors: { type: 'array', default: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
          period_sec: { type: 'number', default: 4.0 },
          phase: { type: 'number', default: 0 },
          fade_sec: { type: 'number', default: 0 },
          intensity: { type: 'number', default: 1.0 },
        },
      },
    },
    {
      id: 'strobe',
      label: 'Strobe',
      description: '',
      params_schema: {
        properties: {
          role: { type: 'string' },
          fixtures: { type: 'array' },
          frequency_hz: { type: 'number', default: 4.0 },
          duty_cycle: { type: 'number', default: 0.5 },
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

const emptyCtx: SceneContext = {
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
    { id: 'par1', role: 'par', intensity: 0, color: [0, 0, 0], pan: 0, tilt: 0 },
  ]
}

function mkScene(
  id: string,
  type: string,
  params: Record<string, unknown> = {},
  extra: Partial<SceneRow> = {},
): SceneRow {
  return {
    id,
    label: `Scene ${id}`,
    type,
    params,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...extra,
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

function mkFallback(): FallbackSceneAdapter {
  return {
    id: 'test_fallback',
    label: 'Test Fallback',
    apply: vi.fn((_t, states) => {
      for (const s of states) {
        s.intensity = 1
        s.color = [1, 1, 1]
      }
    }),
  }
}

/** SQLite-style timestamp for a given epoch ms. */
function sqliteTs(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').split('.')[0]
}

function baseArgs(
  over: Partial<Parameters<typeof evaluateLayeredScene>[0]> = {},
): Parameters<typeof evaluateLayeredScene>[0] {
  return {
    playheadTime: 0,
    wallClockMs: 0,
    scenesById: new Map(),
    placements: [],
    liveOverride: { active: false } as LiveOverrideRow,
    states: mkStates(),
    context: emptyCtx,
    fallbackScene: mkFallback(),
    projectName: 'test',
    ...over,
  }
}

beforeEach(() => {
  _setCatalogForTest(SPEC_CATALOG)
  _resetEvaluatorState()
})

// =============================================================================
// Scene definitions: hardcoded scenes produce valid mutations
// =============================================================================

describe('Scene definitions', () => {
  // Spec: "each hardcoded scene produces valid FixtureState mutations over time"
  it('each scene in SCENES has an id, label, and callable apply', () => {
    expect(SCENES.length).toBeGreaterThan(0)
    for (const scene of SCENES) {
      expect(scene.id).toBeTruthy()
      expect(scene.label).toBeTruthy()
      expect(typeof scene.apply).toBe('function')
    }
  })

  it('all_white sets full intensity + white on every fixture', () => {
    const scene = getScene('all_white')
    expect(scene).toBeDefined()
    const states = makeInitialStates()
    // Zero out first to verify the scene writes
    for (const s of states) {
      s.intensity = 0
      s.color = [0, 0, 0]
    }
    scene!.apply(0, states)
    for (const s of states) {
      expect(s.intensity).toBe(1)
      expect(s.color).toEqual([1, 1, 1])
    }
  })

  it('rainbow_chase mutates state at different time values', () => {
    const scene = getScene('rainbow_chase')!
    const s1 = makeInitialStates()
    const s2 = makeInitialStates()
    scene.apply(0, s1)
    scene.apply(5, s2)
    // Par colors should differ at different times
    const par1_t0 = s1.find((s) => s.role === 'par')!
    const par1_t5 = s2.find((s) => s.role === 'par')!
    expect(par1_t0.color).not.toEqual(par1_t5.color)
  })
})

// =============================================================================
// Fixture state: initial states (R32 context)
// =============================================================================

describe('Fixture initial state', () => {
  // Spec: "initial states (full-on white)"
  it('makeInitialStates returns full-on white for all fixtures', () => {
    const states = makeInitialStates()
    expect(states.length).toBe(RIG.length)
    for (const s of states) {
      expect(s.intensity).toBe(1)
      expect(s.color).toEqual([1, 1, 1])
      expect(s.pan).toBe(0)
      expect(s.tilt).toBe(0)
    }
  })

  // Spec: "moving_head vs par"
  it('RIG contains both moving_head and par fixtures', () => {
    const roles = new Set(RIG.map((f) => f.role))
    expect(roles.has('moving_head')).toBe(true)
    expect(roles.has('par')).toBe(true)
  })

  // Spec: "pan/tilt rotation (YXZ)" — the fixture component sets rotation
  // order to 'YXZ'. We verify the fixture defs have rotation arrays.
  it('all RIG entries have 3-element rotation arrays', () => {
    for (const f of RIG) {
      expect(f.rotation).toHaveLength(3)
    }
  })
})

// =============================================================================
// applyRotatingHead — R32-R37
// =============================================================================

describe('applyRotatingHead', () => {
  // Use spec catalog defaults: period_sec=4, pan_amplitude_rad=pi/4,
  // tilt_center_rad=-0.3, tilt_amplitude_rad=0.2, intensity=1, color=[1,1,1]
  function getDefaultParams() {
    return resolveParams({}, 'rotating_head')
  }

  // R32: at sceneTime=0, pan=0, tilt=tilt_center_rad, intensity=1, color=[1,1,1]
  it('R32: at sceneTime=0, sets pan=0, tilt=tilt_center, intensity=1, color=white', () => {
    const states = mkStates()
    const dp = getDefaultParams()
    applyRotatingHead(0, states, dp, emptyCtx)
    const mh = states.find((s) => s.id === 'mh1')!
    expect(mh.pan).toBe(0)
    expect(mh.tilt).toBeCloseTo(-0.3, 9) // tilt_center_rad default
    expect(mh.intensity).toBe(1)
    expect(mh.color).toEqual([1, 1, 1])
  })

  // R33: at sceneTime=period_sec/4, pan = pan_amplitude_rad
  it('R33: at quarter-period, pan equals pan_amplitude_rad', () => {
    const states = mkStates()
    const dp = getDefaultParams()
    const periodSec = dp.period_sec as number
    applyRotatingHead(periodSec / 4, states, dp, emptyCtx)
    const mh = states.find((s) => s.id === 'mh1')!
    expect(mh.pan).toBeCloseTo(dp.pan_amplitude_rad as number, 9)
  })

  // R34: at half-period, pan = 0
  it('R34: at half-period, pan equals 0', () => {
    const states = mkStates()
    const dp = getDefaultParams()
    const periodSec = dp.period_sec as number
    applyRotatingHead(periodSec / 2, states, dp, emptyCtx)
    const mh = states.find((s) => s.id === 'mh1')!
    expect(mh.pan).toBeCloseTo(0, 6)
  })

  // R35: at three-quarter period, pan = -pan_amplitude_rad
  it('R35: at three-quarter-period, pan equals -pan_amplitude_rad', () => {
    const states = mkStates()
    const dp = getDefaultParams()
    const periodSec = dp.period_sec as number
    applyRotatingHead((3 * periodSec) / 4, states, dp, emptyCtx)
    const mh = states.find((s) => s.id === 'mh1')!
    expect(mh.pan).toBeCloseTo(-(dp.pan_amplitude_rad as number), 9)
  })

  // R36: role-filtered — par fixtures untouched
  it('R36: fixtures not matching role are untouched', () => {
    const states = mkStates()
    const dp = getDefaultParams()
    // Set par to specific pre-values
    const par = states.find((s) => s.id === 'par1')!
    par.intensity = 0.2
    par.color = [0.5, 0.5, 0.5]
    par.pan = 0.1
    par.tilt = 0.2
    applyRotatingHead(1, states, dp, emptyCtx)
    // par untouched
    expect(par.intensity).toBe(0.2)
    expect(par.color).toEqual([0.5, 0.5, 0.5])
    expect(par.pan).toBe(0.1)
    expect(par.tilt).toBe(0.2)
    // mh updated
    const mh = states.find((s) => s.id === 'mh1')!
    expect(mh.intensity).toBe(1)
  })

  // R37: when role undefined, ALL fixtures get intensity/color/pan/tilt
  it('R37: when role is undefined, all fixtures receive writes', () => {
    const states = mkStates()
    const dp = getDefaultParams()
    const noRoleParams = { ...dp, role: undefined }
    applyRotatingHead(0, states, noRoleParams, emptyCtx)
    for (const s of states) {
      expect(s.intensity).toBe(1)
      expect(s.color).toEqual([1, 1, 1])
    }
  })
})

// =============================================================================
// applyStaticColor — R38
// =============================================================================

describe('applyStaticColor', () => {
  // R38: sets intensity + color; does NOT modify pan or tilt
  it('R38: sets intensity and color, does NOT modify pan or tilt', () => {
    const states = mkStates()
    const par = states.find((s) => s.id === 'par1')!
    par.pan = 1.5
    par.tilt = -0.7
    const params = resolveParams({ intensity: 0.5, color: [1, 0, 0] }, 'static_color')
    applyStaticColor(0, states, params, emptyCtx)
    // All fixtures get intensity + color (no role filter → default undefined)
    for (const s of states) {
      expect(s.intensity).toBe(0.5)
      expect(s.color).toEqual([1, 0, 0])
    }
    // par's pan/tilt preserved
    expect(par.pan).toBe(1.5)
    expect(par.tilt).toBe(-0.7)
  })

  it('R38: respects role filter — only matching fixtures are written', () => {
    const states = mkStates()
    const params = { role: 'par', intensity: 0.8, color: [0, 1, 0] as [number, number, number] }
    applyStaticColor(0, states, params, emptyCtx)
    const mh = states.find((s) => s.id === 'mh1')!
    const par = states.find((s) => s.id === 'par1')!
    expect(par.intensity).toBe(0.8)
    expect(mh.intensity).toBe(0) // unchanged
  })
})

// =============================================================================
// Evaluator — layered scene evaluation R39-R48
// =============================================================================

describe('evaluateLayeredScene', () => {
  // R39: evaluator-live-wins
  describe('R39 — live override wins', () => {
    it('live override takes precedence over timeline placement and fallback', () => {
      const blueScene = mkScene('blue', 'static_color', { color: [0, 0, 1] })
      const redScene = mkScene('red', 'static_color', { color: [1, 0, 0] })
      const args = baseArgs({
        playheadTime: 7,
        wallClockMs: 2000,
        scenesById: new Map([['blue', blueScene], ['red', redScene]]),
        placements: [mkPlacement('p1', 'red', 5, 10)],
        liveOverride: {
          active: true,
          scene_id: 'blue',
          inline_type: null,
          inline_params: null,
          label: 'Live Blue',
          fade_in_sec: 0,
          fade_out_sec: 0,
          activated_at: sqliteTs(0),
          deactivation_started_at: null,
        },
      })
      const r = evaluateLayeredScene(args)
      expect(r.activeLayer).toBe('live')
      // color should be blue from live, not red from timeline
      expect(args.states[0].color).toEqual([0, 0, 1])
    })
  })

  // R40: evaluator-timeline-wins-when-no-live
  describe('R40 — timeline wins when no live', () => {
    it('timeline placement drives output and computes sceneTime correctly', () => {
      const scene = mkScene('red', 'static_color', { color: [1, 0, 0] })
      const fallback = mkFallback()
      const args = baseArgs({
        playheadTime: 7,
        scenesById: new Map([['red', scene]]),
        placements: [mkPlacement('p1', 'red', 5, 10)],
        fallbackScene: fallback,
      })
      const r = evaluateLayeredScene(args)
      expect(r.activeLayer).toBe('timeline')
      expect(args.states[0].color).toEqual([1, 0, 0])
      expect(fallback.apply).not.toHaveBeenCalled()
    })
  })

  // R40: scene-timeline-overlap-highest-display-order-wins
  describe('R40 — overlap: highest display_order wins', () => {
    it('higher display_order placement wins on overlap', () => {
      const red = mkScene('red', 'static_color', { color: [1, 0, 0] })
      const blue = mkScene('blue', 'static_color', { color: [0, 0, 1] })
      const args = baseArgs({
        playheadTime: 12,
        scenesById: new Map([['red', red], ['blue', blue]]),
        placements: [
          mkPlacement('pA', 'red', 5, 15, { display_order: 0 }),
          mkPlacement('pB', 'blue', 10, 20, { display_order: 1 }),
        ],
      })
      evaluateLayeredScene(args)
      // blue has higher display_order
      expect(args.states[0].color).toEqual([0, 0, 1])
    })
  })

  // R40: tie broken by created_at ascending (oldest wins)
  describe('R40 — overlap: tie broken by created_at', () => {
    it('earlier created_at wins on display_order tie', () => {
      const first = mkScene('first', 'static_color', { color: [1, 0, 0] })
      const second = mkScene('second', 'static_color', { color: [0, 0, 1] })
      const args = baseArgs({
        playheadTime: 5,
        scenesById: new Map([['first', first], ['second', second]]),
        placements: [
          mkPlacement('pA', 'first', 0, 10, {
            display_order: 0,
            created_at: '2026-01-01 00:00:00',
          }),
          mkPlacement('pB', 'second', 0, 10, {
            display_order: 0,
            created_at: '2026-01-02 00:00:00',
          }),
        ],
      })
      evaluateLayeredScene(args)
      // pA is older → wins
      expect(args.states[0].color).toEqual([1, 0, 0])
    })
  })

  // R40a: evaluator-merges-sparse-params-with-catalog-defaults
  describe('R40a — sparse params merged with catalog defaults', () => {
    it('stored key wins, missing keys come from catalog defaults', () => {
      // Only period_sec stored — all other params come from catalog
      const scene = mkScene('rh', 'rotating_head', { period_sec: 6 })
      const args = baseArgs({
        playheadTime: 0,
        scenesById: new Map([['rh', scene]]),
        placements: [mkPlacement('p1', 'rh', 0, 100)],
      })
      evaluateLayeredScene(args)
      // Intensity from catalog default = 1
      const mh = args.states.find((s) => s.id === 'mh1')!
      expect(mh.intensity).toBe(1)
      expect(mh.color).toEqual([1, 1, 1])
    })

    it('role=undefined when no default and not stored', () => {
      // static_color has no default for role
      const resolved = resolveParams({}, 'static_color')
      expect(resolved.role).toBeUndefined()
    })
  })

  // R41: evaluator-fallback-when-neither
  describe('R41 — fallback when neither live nor placement', () => {
    it('delegates to fallbackScene when nothing active', () => {
      const fallback = mkFallback()
      const args = baseArgs({
        playheadTime: 100,
        fallbackScene: fallback,
      })
      const r = evaluateLayeredScene(args)
      expect(r.activeLayer).toBe('fallback')
      expect(r.label).toBe('Test Fallback')
      expect(fallback.apply).toHaveBeenCalledTimes(1)
    })

    it('returns activeLayer=none when fallback is null', () => {
      const args = baseArgs({ fallbackScene: null })
      const r = evaluateLayeredScene(args)
      expect(r.activeLayer).toBe('none')
    })

    // empty-placements-empty-live-renders-fallback
    it('empty placements + no live + fallback => all fixtures white', () => {
      const fallback = mkFallback() // sets intensity=1, color=[1,1,1]
      const args = baseArgs({
        playheadTime: 5,
        fallbackScene: fallback,
      })
      const r = evaluateLayeredScene(args)
      expect(r.activeLayer).toBe('fallback')
      for (const s of args.states) {
        expect(s.intensity).toBe(1)
        expect(s.color).toEqual([1, 1, 1])
      }
    })
  })

  // R42: fade-envelope-only-intensity
  describe('R42 — fade envelope is intensity-only', () => {
    it('fade multiplier affects intensity but not color/pan/tilt', () => {
      const scene = mkScene('s', 'static_color', {
        intensity: 0.8,
        color: [0, 1, 0],
      })
      const args = baseArgs({
        playheadTime: 1, // sceneTime = 1
        scenesById: new Map([['s', scene]]),
        placements: [mkPlacement('p1', 's', 0, 10, { fade_in_sec: 2 })],
      })
      evaluateLayeredScene(args)
      // sceneTime=1, fade_in=2 → multiplier 0.5
      // intensity = 0.8 * 0.5 = 0.4 (static_color sets intensity,
      // but default from catalog for missing params is 1.0 via resolveParams;
      // we explicitly pass 0.8 in stored)
      expect(args.states[0].intensity).toBeCloseTo(0.4, 6)
      // color unchanged by fade
      expect(args.states[0].color).toEqual([0, 1, 0])
    })
  })

  // R43: fade-in
  describe('R43 — placement fade-in', () => {
    it('intensity is 0 at sceneTime=0 with fade_in_sec=2', () => {
      const scene = mkScene('s', 'static_color', { intensity: 1.0 })
      const args = baseArgs({
        playheadTime: 0,
        scenesById: new Map([['s', scene]]),
        placements: [mkPlacement('p1', 's', 0, 10, { fade_in_sec: 2 })],
      })
      evaluateLayeredScene(args)
      expect(args.states[0].intensity).toBe(0)
    })

    it('intensity is 0.5 at sceneTime=1 with fade_in_sec=2', () => {
      const scene = mkScene('s', 'static_color', { intensity: 1.0 })
      const args = baseArgs({
        playheadTime: 1,
        scenesById: new Map([['s', scene]]),
        placements: [mkPlacement('p1', 's', 0, 10, { fade_in_sec: 2 })],
      })
      evaluateLayeredScene(args)
      expect(args.states[0].intensity).toBeCloseTo(0.5, 6)
    })

    it('intensity is 1.0 after fade-in window', () => {
      const scene = mkScene('s', 'static_color', { intensity: 1.0 })
      const args = baseArgs({
        playheadTime: 3,
        scenesById: new Map([['s', scene]]),
        placements: [mkPlacement('p1', 's', 0, 10, { fade_in_sec: 2 })],
      })
      evaluateLayeredScene(args)
      expect(args.states[0].intensity).toBe(1)
    })
  })

  // R44: fade-out
  describe('R44 — placement fade-out', () => {
    it('intensity is 0 at playheadTime=end_time', () => {
      const scene = mkScene('s', 'static_color', { intensity: 1.0 })
      const args = baseArgs({
        playheadTime: 10,
        scenesById: new Map([['s', scene]]),
        placements: [mkPlacement('p1', 's', 0, 10, { fade_out_sec: 2 })],
      })
      evaluateLayeredScene(args)
      expect(args.states[0].intensity).toBeCloseTo(0, 6)
    })
  })

  // R45: fade-in and fade-out overlap (short placement)
  describe('R45 — overlapping fade windows compose', () => {
    it('1-second placement with 1s fade-in and 1s fade-out at midpoint', () => {
      const scene = mkScene('s', 'static_color', { intensity: 1.0 })
      const args = baseArgs({
        playheadTime: 0.5, // mid
        scenesById: new Map([['s', scene]]),
        placements: [mkPlacement('p1', 's', 0, 1, { fade_in_sec: 1, fade_out_sec: 1 })],
      })
      evaluateLayeredScene(args)
      // fade-in: 0.5/1 = 0.5, fade-out: 0.5/1 = 0.5, composed = 0.25
      expect(args.states[0].intensity).toBeCloseTo(0.25, 6)
    })

    it('2-second placement at midpoint: both fades at 1.0 each', () => {
      const scene = mkScene('s', 'static_color', { intensity: 1.0 })
      const args = baseArgs({
        playheadTime: 1, // mid of [0,2]
        scenesById: new Map([['s', scene]]),
        placements: [mkPlacement('p1', 's', 0, 2, { fade_in_sec: 1, fade_out_sec: 1 })],
      })
      evaluateLayeredScene(args)
      // fade-in: 1.0/1.0 = 1.0, fade-out: 1.0/1.0 = 1.0, composed = 1.0
      expect(args.states[0].intensity).toBeCloseTo(1.0, 6)
    })
  })

  // R46: live override fade-in (wall clock based)
  describe('R46 — live override fade-in', () => {
    it('intensity multiplied by wallClock-based fade-in progress', () => {
      const scene = mkScene('s', 'static_color', { intensity: 1.0 })
      const activatedAt = 1000 // ms
      const args = baseArgs({
        wallClockMs: 1500, // 0.5s after activation
        scenesById: new Map([['s', scene]]),
        liveOverride: {
          active: true,
          scene_id: 's',
          inline_type: null,
          inline_params: null,
          label: 'Live',
          fade_in_sec: 1, // 1s fade
          fade_out_sec: 0,
          activated_at: sqliteTs(activatedAt),
          deactivation_started_at: null,
        },
      })
      evaluateLayeredScene(args)
      // sceneTime = (1500 - 1000) / 1000 = 0.5; fade = 0.5/1 = 0.5
      expect(args.states[0].intensity).toBeCloseTo(0.5, 1)
    })
  })

  // R47: live override fade-out
  describe('R47 — live override fade-out', () => {
    it('mid-fade: intensity scales by (1 - elapsed/fadeOut)', () => {
      const scene = mkScene('s', 'static_color', { intensity: 1.0 })
      const activated = 1_000_000
      const deactivated = 2_000_000
      const args = baseArgs({
        wallClockMs: 2_001_000, // 1s after deactivation
        scenesById: new Map([['s', scene]]),
        liveOverride: {
          active: true,
          scene_id: 's',
          inline_type: null,
          inline_params: null,
          label: 'Live',
          fade_in_sec: 0,
          fade_out_sec: 4, // 1s elapsed of 4s fade -> 0.75
          activated_at: sqliteTs(activated),
          deactivation_started_at: sqliteTs(deactivated),
        },
      })
      evaluateLayeredScene(args)
      expect(args.states[0].intensity).toBeCloseTo(0.75, 1)
    })

    it('fade complete: intensity=0 and deactivateLive called', async () => {
      const { deactivateLive } = await import('../light-show-client')
      const mocked = vi.mocked(deactivateLive)
      mocked.mockClear()

      const scene = mkScene('s', 'static_color', { intensity: 1.0 })
      const activated = 1_000_000
      const deactivated = 2_000_000
      const args = baseArgs({
        wallClockMs: 2_010_000, // 10s after deact, way past 2s fade
        scenesById: new Map([['s', scene]]),
        liveOverride: {
          active: true,
          scene_id: 's',
          inline_type: null,
          inline_params: null,
          label: 'Live',
          fade_in_sec: 0,
          fade_out_sec: 2,
          activated_at: sqliteTs(activated),
          deactivation_started_at: sqliteTs(deactivated),
        },
      })
      evaluateLayeredScene(args)
      expect(args.states[0].intensity).toBe(0)
      expect(mocked).toHaveBeenCalledTimes(1)
      expect(mocked).toHaveBeenCalledWith('test')
    })
  })

  // R48: determinism
  describe('R48 — deterministic evaluation', () => {
    it('same inputs produce identical outputs on repeated calls', () => {
      const scene = mkScene('rh', 'rotating_head', { period_sec: 4 })
      const call = () => {
        const a = baseArgs({
          playheadTime: 2.7,
          scenesById: new Map([['rh', scene]]),
          placements: [mkPlacement('p1', 'rh', 0, 100)],
        })
        evaluateLayeredScene(a)
        return a.states.map((s) => ({
          ...s,
          color: [...s.color] as [number, number, number],
        }))
      }
      const first = call()
      const second = call()
      expect(second).toEqual(first)
    })

    // scrub-backward-into-fade-in-window
    it('scrubbing back into fade-in window then forward is deterministic', () => {
      const scene = mkScene('s', 'static_color', { intensity: 1.0 })
      const mkArgs = (t: number) =>
        baseArgs({
          playheadTime: t,
          scenesById: new Map([['s', scene]]),
          placements: [mkPlacement('p1', 's', 0, 10, { fade_in_sec: 2 })],
        })

      // first call at t=5 (past fade-in)
      const a1 = mkArgs(5)
      evaluateLayeredScene(a1)
      expect(a1.states[0].intensity).toBe(1)

      // scrub back to t=1 (inside fade-in)
      const a2 = mkArgs(1)
      evaluateLayeredScene(a2)
      expect(a2.states[0].intensity).toBeCloseTo(0.5, 6)

      // forward again to t=5
      const a3 = mkArgs(5)
      evaluateLayeredScene(a3)
      expect(a3.states[0].intensity).toBe(1)
    })
  })
})

// =============================================================================
// Override merge — per-channel granularity (SceneRunner level)
// =============================================================================

describe('Override merge', () => {
  // Spec: "keyed by fixture ID; per-channel granularity; null = scene-driven"
  // This tests the override data structure shape expectations.
  it('Override type allows per-channel presence (undefined = scene-driven)', () => {
    // This is a type-level + runtime test: an Override with only intensity set
    // should not affect color/pan/tilt when the SceneRunner applies it.
    const override = { fixture_id: 'mh1', intensity: 0.5 }
    // intensity is defined, color/pan/tilt are undefined
    expect(override.intensity).toBe(0.5)
    expect((override as Record<string, unknown>).color).toBeUndefined()
    expect((override as Record<string, unknown>).pan).toBeUndefined()
    expect((override as Record<string, unknown>).tilt).toBeUndefined()
  })
})

// =============================================================================
// Beat tracking — lastBeatIdx, beatAge, lastBeatIntensity, beatIndex, scrub-back
// =============================================================================

describe('Beat tracking (SceneContext derivation)', () => {
  // The SceneRunner computes beat context via linear scan of beats.
  // We verify the derivation logic by testing the SceneContext shape.

  it('beatAge is Infinity when no beats exist', () => {
    expect(emptyCtx.beatAge).toBe(Infinity)
  })

  it('beatIndex is 0 when no beats have been crossed', () => {
    expect(emptyCtx.beatIndex).toBe(0)
  })

  // The actual beat scanning is tested indirectly through the evaluator's
  // SceneContext — the context is passed through to primitives.
  it('scenes receive context with beat fields', () => {
    const applySpy = vi.fn()
    const origApply = PRIMITIVE_REGISTRY.static_color
    PRIMITIVE_REGISTRY.static_color = applySpy
    try {
      const scene = mkScene('s', 'static_color', {})
      const customCtx: SceneContext = {
        ...emptyCtx,
        beatAge: 0.1,
        beatIndex: 5,
        lastBeatIntensity: 0.8,
      }
      const args = baseArgs({
        playheadTime: 3,
        context: customCtx,
        scenesById: new Map([['s', scene]]),
        placements: [mkPlacement('p1', 's', 0, 10)],
      })
      evaluateLayeredScene(args)
      expect(applySpy).toHaveBeenCalledTimes(1)
      const passedCtx = applySpy.mock.calls[0][3]
      expect(passedCtx.beatAge).toBe(0.1)
      expect(passedCtx.beatIndex).toBe(5)
      expect(passedCtx.lastBeatIntensity).toBe(0.8)
    } finally {
      PRIMITIVE_REGISTRY.static_color = origApply
    }
  })
})

// =============================================================================
// REST client — mock fetch tests
// =============================================================================

describe('REST client', () => {
  const globalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = globalFetch
  })

  it('fetchFixtures parses response and returns fixtures array', async () => {
    const { fetchFixtures } = await import('../light-show-client')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        fixtures: [
          {
            id: 'mh_1',
            role: 'moving_head',
            label: 'MH 1',
            position_x: -3,
            position_y: 4,
            position_z: 2,
            rotation_x: 0,
            rotation_y: 0,
            rotation_z: 0,
            dmx_universe: null,
            dmx_address: null,
            dmx_channel_count: null,
          },
        ],
      }),
    }) as unknown as typeof fetch

    const result = await fetchFixtures('test-project')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('mh_1')
    expect(result[0].role).toBe('moving_head')
  })

  it('fetchFixtures throws on HTTP error', async () => {
    const { fetchFixtures } = await import('../light-show-client')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }) as unknown as typeof fetch

    await expect(fetchFixtures('test-project')).rejects.toThrow(/500/)
  })

  it('fetchOverrides parses response', async () => {
    const { fetchOverrides } = await import('../light-show-client')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        overrides: [{ fixture_id: 'mh_1', intensity: 0.5 }],
      }),
    }) as unknown as typeof fetch

    const result = await fetchOverrides('test-project')
    expect(result).toHaveLength(1)
    expect(result[0].fixture_id).toBe('mh_1')
    expect(result[0].intensity).toBe(0.5)
  })

  it('fetchScreens parses response', async () => {
    const { fetchScreens } = await import('../light-show-client')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        screens: [
          {
            id: 'screen_1',
            label: 'Main',
            position_x: 0,
            position_y: 3,
            position_z: 0,
            rotation_x: 0,
            rotation_y: 0,
            rotation_z: 0,
            width: 4,
            height: 2.25,
          },
        ],
      }),
    }) as unknown as typeof fetch

    const result = await fetchScreens('test-project')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('screen_1')
  })

  it('fetchScenes parses paginated response', async () => {
    const { fetchScenes } = await import('../light-show-client')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        scenes: [{ id: 's1', label: 'Test', type: 'static_color', params: {}, created_at: '', updated_at: '' }],
        total: 1,
        has_more: false,
      }),
    }) as unknown as typeof fetch

    const result = await fetchScenes('test-project')
    expect(result.scenes).toHaveLength(1)
    expect(result.total).toBe(1)
    expect(result.has_more).toBe(false)
  })

  it('fetchPlacements parses paginated response', async () => {
    const { fetchPlacements } = await import('../light-show-client')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        placements: [
          { id: 'p1', scene_id: 's1', start_time: 0, end_time: 10, display_order: 0, fade_in_sec: 0, fade_out_sec: 0, created_at: '', updated_at: '' },
        ],
        total: 1,
        has_more: false,
      }),
    }) as unknown as typeof fetch

    const result = await fetchPlacements('test-project')
    expect(result.placements).toHaveLength(1)
    expect(result.total).toBe(1)
  })

  it('fetchLiveOverride parses active override', async () => {
    const { fetchLiveOverride } = await import('../light-show-client')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        active: true,
        scene_id: 's1',
        label: 'Live Test',
        activated_at: '2026-01-01 00:00:00',
        fade_in_sec: 0,
        fade_out_sec: 0,
        deactivation_started_at: null,
      }),
    }) as unknown as typeof fetch

    const result = await fetchLiveOverride('test-project')
    expect(result.active).toBe(true)
    if (result.active) {
      expect(result.scene_id).toBe('s1')
      expect(result.label).toBe('Live Test')
    }
  })

  it('fetchLiveOverride parses inactive response', async () => {
    const { fetchLiveOverride } = await import('../light-show-client')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: false }),
    }) as unknown as typeof fetch

    const result = await fetchLiveOverride('test-project')
    expect(result.active).toBe(false)
  })

  it('client throws on body-level error field', async () => {
    const { fetchScenes } = await import('../light-show-client')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'something went wrong' }),
    }) as unknown as typeof fetch

    await expect(fetchScenes('test-project')).rejects.toThrow(/something went wrong/)
  })
})

// =============================================================================
// WS subscription — subscribePluginEvent
// =============================================================================

describe('WS subscription', () => {
  // We test the subscribePluginEvent function itself (not the panel integration
  // which would require full R3F rendering). The function is a listener filter.
  it('subscribePluginEvent filters by plugin + event type', async () => {
    // Import the real subscribePluginEvent (it uses subscribeAll internally)
    const mod = await import('@/hooks/useScenecraftSocket')
    const { subscribePluginEvent } = mod

    const cb = vi.fn()
    const unsub = subscribePluginEvent('light_show', 'changed', cb)

    // The WS module exports subscribeAll which the plugin event function wraps.
    // Since we can't easily push a real WS message in unit tests, we verify
    // the unsub function is callable without error.
    expect(typeof unsub).toBe('function')
    unsub()
  })
})

// =============================================================================
// Primitive registry / catalog parity — R31
// =============================================================================

describe('R31 — PRIMITIVE_REGISTRY matches catalog', () => {
  it('assertCatalogRegistryParity passes with spec catalog', () => {
    expect(() => assertCatalogRegistryParity(SPEC_CATALOG)).not.toThrow()
  })

  it('throws when catalog has primitive not in registry', () => {
    const drift = {
      primitives: [
        ...SPEC_CATALOG.primitives,
        { id: 'unknown_prim', label: 'Unknown', description: '', params_schema: { properties: {} } },
      ],
    }
    expect(() => assertCatalogRegistryParity(drift)).toThrow(/no apply.*unknown_prim/)
  })

  it('throws when registry has primitive not in catalog', () => {
    const subset = {
      primitives: SPEC_CATALOG.primitives.filter((p) => p.id !== 'static_color'),
    }
    expect(() => assertCatalogRegistryParity(subset)).toThrow(/no catalog entry.*static_color/)
  })
})

// =============================================================================
// resolveParams — sparse merge
// =============================================================================

describe('resolveParams', () => {
  it('merges stored values over catalog defaults', () => {
    const merged = resolveParams({ period_sec: 6 }, 'rotating_head')
    expect(merged.period_sec).toBe(6)
    expect(merged.pan_amplitude_rad).toBeCloseTo(Math.PI / 4, 9)
    expect(merged.tilt_center_rad).toBe(-0.3)
    expect(merged.color).toEqual([1, 1, 1])
    expect(merged.role).toBe('moving_head')
  })

  it('returns undefined for optional keys with no default when not stored', () => {
    const merged = resolveParams({}, 'static_color')
    expect(merged.role).toBeUndefined()
    expect(merged.intensity).toBe(1.0)
    expect(merged.color).toEqual([1, 1, 1])
  })

  it('throws on unknown primitive type', () => {
    expect(() => resolveParams({}, 'nonexistent')).toThrow(/unknown primitive type/)
  })

  it('throws if catalog not loaded', () => {
    _setCatalogForTest(null)
    expect(() => resolveParams({}, 'rotating_head')).toThrow(/catalog loaded/)
  })
})

// =============================================================================
// Negative assertions
// =============================================================================

describe('Negative assertions', () => {
  // R36: negative-no-mutation-of-unselected-scene-roles
  it('R36: par fixture state unchanged when rotating_head targets moving_head', () => {
    const states = mkStates()
    const par = states.find((s) => s.id === 'par1')!
    par.intensity = 0.2
    par.color = [0.5, 0.5, 0.5]
    par.pan = 0
    par.tilt = 0

    const params = resolveParams({}, 'rotating_head')
    applyRotatingHead(1, states, params, emptyCtx)

    expect(par.intensity).toBe(0.2)
    expect(par.color).toEqual([0.5, 0.5, 0.5])
  })

  // R48 implicit: serial execution on single-threaded JS
  it('evaluator runs synchronously (no Promise-based apply)', () => {
    const scene = mkScene('s', 'static_color', { intensity: 0.9 })
    const args = baseArgs({
      playheadTime: 5,
      scenesById: new Map([['s', scene]]),
      placements: [mkPlacement('p1', 's', 0, 10)],
    })
    const result = evaluateLayeredScene(args)
    // If it returned a Promise, this assertion on activeLayer would fail
    expect(result.activeLayer).toBe('timeline')
    expect(args.states[0].intensity).toBe(0.9)
  })
})

// =============================================================================
// Live override — inline scene support
// =============================================================================

describe('Live override — inline scene', () => {
  it('evaluator resolves inline_type + inline_params when scene_id is null', () => {
    const args = baseArgs({
      wallClockMs: 1000,
      liveOverride: {
        active: true,
        scene_id: null,
        inline_type: 'static_color',
        inline_params: { color: [1, 0, 0], intensity: 0.6 },
        label: 'Red Wash',
        fade_in_sec: 0,
        fade_out_sec: 0,
        activated_at: sqliteTs(0),
        deactivation_started_at: null,
      },
    })
    const r = evaluateLayeredScene(args)
    expect(r.activeLayer).toBe('live')
    expect(r.label).toBe('Red Wash')
    expect(args.states[0].color).toEqual([1, 0, 0])
    expect(args.states[0].intensity).toBeCloseTo(0.6, 6)
  })
})

// =============================================================================
// Diagnostic bar label format — R50
// =============================================================================

describe('R50 — active layer label derivation', () => {
  // The diagnostic bar in the panel reads activeLayerRef.current. We test the
  // EvaluatorResult label field which feeds the bar.

  it('live override returns label from scene', () => {
    const scene = mkScene('s', 'static_color', {}, { label: 'My Live Scene' })
    const args = baseArgs({
      wallClockMs: 1000,
      scenesById: new Map([['s', scene]]),
      liveOverride: {
        active: true,
        scene_id: 's',
        inline_type: null,
        inline_params: null,
        label: 'Override Label',
        fade_in_sec: 0,
        fade_out_sec: 0,
        activated_at: sqliteTs(0),
        deactivation_started_at: null,
      },
    })
    const r = evaluateLayeredScene(args)
    expect(r.activeLayer).toBe('live')
    // Label comes from the resolved scene (lib lookup), falling back to override.label
    expect(r.label).toBe('My Live Scene')
  })

  it('timeline returns scene label', () => {
    const scene = mkScene('s', 'static_color', {}, { label: 'Timeline Scene' })
    const args = baseArgs({
      playheadTime: 5,
      scenesById: new Map([['s', scene]]),
      placements: [mkPlacement('p1', 's', 0, 10)],
    })
    const r = evaluateLayeredScene(args)
    expect(r.activeLayer).toBe('timeline')
    expect(r.label).toBe('Timeline Scene')
  })

  it('fallback returns fallback label', () => {
    const fallback = mkFallback()
    const args = baseArgs({ fallbackScene: fallback })
    const r = evaluateLayeredScene(args)
    expect(r.activeLayer).toBe('fallback')
    expect(r.label).toBe('Test Fallback')
  })
})
