/**
 * Vitest coverage for the M21 audio-reactive parameter bindings.
 *
 * Bindings let scene params consume SceneContext signals declaratively
 * (no new primitives required for audio reactivity). Two modes today:
 *
 *   - linear: out = source * scale + offset
 *   - values: out = values[ floor(source) mod values.length ]
 */

import { describe, it, expect } from 'vitest'

import type { SceneContext } from '../scene-types'
import {
  isBinding,
  resolveBinding,
  resolveBindings,
  listBindingSources,
} from '../bindings'

const baseCtx: SceneContext = {
  playheadTime: 0,
  beatAge: Infinity,
  lastBeatIntensity: 0,
  beatIndex: 0,
  isPlaying: false,
  masterLevel: 0,
  masterLowLevel: 0,
}

describe('isBinding', () => {
  it('rejects literals and arrays', () => {
    expect(isBinding(0)).toBe(false)
    expect(isBinding('foo')).toBe(false)
    expect(isBinding(null)).toBe(false)
    expect(isBinding(undefined)).toBe(false)
    expect(isBinding([1, 2, 3])).toBe(false)
    expect(isBinding([[1, 0, 0], [0, 0, 1]])).toBe(false)
  })

  it('accepts objects with a string source field', () => {
    expect(isBinding({ source: 'master.level' })).toBe(true)
    expect(isBinding({ source: 'beat.toggle', mode: 'values', values: [1, 2] })).toBe(true)
  })

  it('rejects objects without a string source', () => {
    expect(isBinding({ source: 42 })).toBe(false)
    expect(isBinding({ scale: 1 })).toBe(false)
    expect(isBinding({})).toBe(false)
  })
})

describe('resolveBinding — linear mode (default)', () => {
  it('maps master.level through scale + offset', () => {
    const ctx = { ...baseCtx, masterLevel: 0.5 }
    const v = resolveBinding({ source: 'master.level', scale: 0.8, offset: 0.2 }, ctx)
    expect(v).toBeCloseTo(0.6, 6)
  })

  it('defaults scale=1, offset=0', () => {
    const ctx = { ...baseCtx, masterLowLevel: 0.7 }
    expect(resolveBinding({ source: 'master.low_level' }, ctx)).toBeCloseTo(0.7, 6)
  })

  it('coerces beat.age=Infinity to 0', () => {
    const v = resolveBinding({ source: 'beat.age' }, baseCtx)
    expect(v).toBe(0)
  })

  it('returns 0 for unknown source (warns, never throws)', () => {
    const v = resolveBinding({ source: 'never.heard.of.this' }, baseCtx)
    expect(v).toBe(0)
  })
})

describe('resolveBinding — values mode', () => {
  it('beat.toggle picks values[beatIndex % length]', () => {
    const palette = [[1, 0, 0], [0, 0, 1]]
    expect(
      resolveBinding(
        { source: 'beat.toggle', mode: 'values', values: palette },
        { ...baseCtx, beatIndex: 0 },
      ),
    ).toEqual([1, 0, 0])
    expect(
      resolveBinding(
        { source: 'beat.toggle', mode: 'values', values: palette },
        { ...baseCtx, beatIndex: 1 },
      ),
    ).toEqual([0, 0, 1])
    expect(
      resolveBinding(
        { source: 'beat.toggle', mode: 'values', values: palette },
        { ...baseCtx, beatIndex: 2 },
      ),
    ).toEqual([1, 0, 0])
  })

  it('floors continuous source before indexing', () => {
    // master.level=0.7 → floor=0 → values[0]
    const v = resolveBinding(
      { source: 'master.level', mode: 'values', values: ['a', 'b'] },
      { ...baseCtx, masterLevel: 0.7 },
    )
    expect(v).toBe('a')
  })

  it('handles negative-mod indexing safely', () => {
    // Force a negative beatIndex (defensive — shouldn't happen in production)
    const v = resolveBinding(
      { source: 'beat.toggle', mode: 'values', values: ['a', 'b', 'c'] },
      { ...baseCtx, beatIndex: -1 },
    )
    expect(['a', 'b', 'c']).toContain(v)
  })

  it('returns undefined for empty values array', () => {
    expect(
      resolveBinding(
        { source: 'beat.toggle', mode: 'values', values: [] },
        baseCtx,
      ),
    ).toBeUndefined()
  })
})

describe('resolveBindings (params walker)', () => {
  it('passes literals through unchanged', () => {
    const out = resolveBindings({ a: 1, b: 'x', c: [1, 2, 3] }, baseCtx)
    expect(out).toEqual({ a: 1, b: 'x', c: [1, 2, 3] })
  })

  it('rewrites bound entries to resolved values', () => {
    const out = resolveBindings(
      {
        intensity: { source: 'master.level', scale: 0.8, offset: 0.2 },
        color: { source: 'beat.toggle', mode: 'values', values: [[1, 0, 0], [0, 0, 1]] },
        period_sec: 4.0, // literal
      },
      { ...baseCtx, masterLevel: 0.5, beatIndex: 1 },
    )
    expect(out.intensity).toBeCloseTo(0.6, 6)
    expect(out.color).toEqual([0, 0, 1])
    expect(out.period_sec).toBe(4.0)
  })

  it('does not mutate the input params', () => {
    const input = { intensity: { source: 'master.level' as const } }
    const ctx = { ...baseCtx, masterLevel: 0.42 }
    const out = resolveBindings(input as Record<string, unknown>, ctx)
    expect(input.intensity).toEqual({ source: 'master.level' })
    expect(out.intensity).toBeCloseTo(0.42, 6)
  })

  it('does not recurse into composite layers (composite handles those)', () => {
    // The walker is shallow; an inner array of layer-objects passes through
    // untouched. The composite primitive's apply re-runs resolution per
    // sub-layer.
    const layers = [
      { type: 'static_color', params: { color: { source: 'beat.toggle', mode: 'values', values: [[1, 0, 0]] } } },
    ]
    const out = resolveBindings({ layers }, baseCtx)
    expect(out.layers).toBe(layers)
  })
})

describe('listBindingSources', () => {
  it('exposes all known sources', () => {
    const sources = listBindingSources()
    for (const s of [
      'master.level',
      'master.low_level',
      'beat.age',
      'beat.intensity',
      'beat.index',
      'beat.toggle',
      'playhead.time',
    ]) {
      expect(sources).toContain(s)
    }
  })
})
