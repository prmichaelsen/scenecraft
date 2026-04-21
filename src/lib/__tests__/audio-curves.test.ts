import { describe, expect, it } from 'vitest'
import {
  dbToLinear,
  sampleClipDbAtPlayhead,
  sampleClipLinearAtPlayhead,
  sampleCurveDb,
  sampleCurveLinear,
  sampleTrackDbAtPlayhead,
} from '../audio-curves'
import type { CurvePoint } from '../audio-client'

describe('dbToLinear', () => {
  it('0 dB is unity gain', () => {
    expect(dbToLinear(0)).toBe(1)
  })

  it('-6 dB is ~0.501', () => {
    expect(dbToLinear(-6)).toBeCloseTo(0.5012, 3)
  })

  it('-60 dB is ~0.001', () => {
    expect(dbToLinear(-60)).toBeCloseTo(0.001, 4)
  })

  it('+6 dB is ~1.995', () => {
    expect(dbToLinear(6)).toBeCloseTo(1.9953, 3)
  })

  it('-12 dB is ~0.251', () => {
    expect(dbToLinear(-12)).toBeCloseTo(0.2512, 3)
  })
})

describe('sampleCurveDb', () => {
  it('returns 0 dB for null curve', () => {
    expect(sampleCurveDb(null, 0.5)).toBe(0)
  })

  it('returns 0 dB for empty curve', () => {
    expect(sampleCurveDb([], 0.5)).toBe(0)
  })

  it('interpolates linearly between two points', () => {
    const curve: CurvePoint[] = [[0, 0], [1, -6]]
    expect(sampleCurveDb(curve, 0)).toBeCloseTo(0, 6)
    expect(sampleCurveDb(curve, 0.5)).toBeCloseTo(-3, 6)
    expect(sampleCurveDb(curve, 1)).toBeCloseTo(-6, 6)
  })

  it('clamps to left endpoint below range', () => {
    const curve: CurvePoint[] = [[2, -12], [4, 0]]
    expect(sampleCurveDb(curve, 0)).toBe(-12)
    expect(sampleCurveDb(curve, 1.9)).toBe(-12)
  })

  it('clamps to right endpoint above range', () => {
    const curve: CurvePoint[] = [[2, -12], [4, 0]]
    expect(sampleCurveDb(curve, 4)).toBe(0)
    expect(sampleCurveDb(curve, 10)).toBe(0)
  })

  it('handles three+ point curves', () => {
    // valley at x=0.5
    const curve: CurvePoint[] = [[0, 0], [0.5, -12], [1, 0]]
    expect(sampleCurveDb(curve, 0.25)).toBeCloseTo(-6, 6)
    expect(sampleCurveDb(curve, 0.5)).toBeCloseTo(-12, 6)
    expect(sampleCurveDb(curve, 0.75)).toBeCloseTo(-6, 6)
  })

  it('sorts unsorted input by x', () => {
    const curve: CurvePoint[] = [[1, -6], [0, 0]]
    expect(sampleCurveDb(curve, 0.5)).toBeCloseTo(-3, 6)
  })

  it('single-point curve is constant', () => {
    const curve: CurvePoint[] = [[0.5, -3]]
    expect(sampleCurveDb(curve, 0)).toBe(-3)
    expect(sampleCurveDb(curve, 0.5)).toBe(-3)
    expect(sampleCurveDb(curve, 1)).toBe(-3)
  })
})

describe('sampleCurveLinear', () => {
  it('composes sampleCurveDb with dbToLinear', () => {
    const curve: CurvePoint[] = [[0, 0], [1, -6]]
    expect(sampleCurveLinear(curve, 0)).toBeCloseTo(1, 3)
    expect(sampleCurveLinear(curve, 0.5)).toBeCloseTo(dbToLinear(-3), 6)
  })

  it('null curve is unity gain', () => {
    expect(sampleCurveLinear(null, 0.5)).toBe(1)
  })
})

describe('sampleClipDbAtPlayhead', () => {
  it('maps absolute playhead to normalized clip-local x', () => {
    const clip = {
      start_time: 10,
      end_time: 20,
      volume_curve: [[0, 0], [1, -6]] as CurvePoint[],
    }
    // Halfway through clip → -3 dB
    expect(sampleClipDbAtPlayhead(clip, 15)).toBeCloseTo(-3, 6)
    // At clip start → 0 dB
    expect(sampleClipDbAtPlayhead(clip, 10)).toBeCloseTo(0, 6)
    // At clip end → -6 dB
    expect(sampleClipDbAtPlayhead(clip, 20)).toBeCloseTo(-6, 6)
  })

  it('sampleClipLinearAtPlayhead composes correctly', () => {
    const clip = {
      start_time: 0,
      end_time: 4,
      volume_curve: [[0, 0], [1, -6]] as CurvePoint[],
    }
    expect(sampleClipLinearAtPlayhead(clip, 2)).toBeCloseTo(dbToLinear(-3), 6)
  })
})

describe('sampleTrackDbAtPlayhead', () => {
  it('samples directly in absolute seconds', () => {
    const track = {
      volume_curve: [[0, 0], [10, -6], [20, 0]] as CurvePoint[],
    }
    expect(sampleTrackDbAtPlayhead(track, 5)).toBeCloseTo(-3, 6)
    expect(sampleTrackDbAtPlayhead(track, 10)).toBeCloseTo(-6, 6)
    expect(sampleTrackDbAtPlayhead(track, 15)).toBeCloseTo(-3, 6)
  })
})
