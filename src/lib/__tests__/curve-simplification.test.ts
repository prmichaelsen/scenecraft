/**
 * Tests for M13 task-55 curve simplification (Douglas-Peucker).
 *
 * Covers spec R24 — bezier-fit-simplification-drops-redundant-points — and
 * boundary cases called out in the task doc:
 *   - Empty / single-sample / two-sample input returns unchanged
 *   - 66-sample linear ramp collapses to 2 points within 2% error
 *   - A bent (two-segment) ramp collapses to 3 points (bend preserved)
 *   - Noisy ramp with 2% tolerance drops most intermediates
 *
 * `tolerance` is in normalized-value units (0..1), matching the hook's
 * 0.02 (= 2%) threshold.
 */

import { describe, it, expect } from 'vitest'
import { simplifyCurve, type RawSample } from '../curve-simplification'

function linearRamp(n: number, start: number, end: number, duration: number): RawSample[] {
  const out: RawSample[] = []
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : i / (n - 1)
    out.push([u * duration, start + u * (end - start)])
  }
  return out
}

/** Evaluate the simplified polyline at time `t` (clamped to its range). */
function evalPolyline(points: { time: number; value: number }[], t: number): number {
  if (points.length === 0) return 0
  if (t <= points[0].time) return points[0].value
  const last = points[points.length - 1]
  if (t >= last.time) return last.value
  for (let i = 1; i < points.length; i++) {
    if (t < points[i].time) {
      const a = points[i - 1]
      const b = points[i]
      const u = (t - a.time) / (b.time - a.time)
      return a.value + u * (b.value - a.value)
    }
  }
  return last.value
}

describe('simplifyCurve — Douglas-Peucker (M13 task-55, R24)', () => {
  it('empty input returns []', () => {
    expect(simplifyCurve([], 0.02)).toEqual([])
  })

  it('single-sample input returns one point unchanged', () => {
    const result = simplifyCurve([[1.5, 0.42]], 0.02)
    expect(result).toEqual([{ time: 1.5, value: 0.42 }])
  })

  it('two-sample input returns both endpoints unchanged', () => {
    const result = simplifyCurve([[0, 0.1], [2, 0.9]], 0.02)
    expect(result).toEqual([
      { time: 0, value: 0.1 },
      { time: 2, value: 0.9 },
    ])
  })

  it('bezier-fit-simplification-drops-redundant-points: 66-sample linear ramp → ≤4 points within 2% error', () => {
    // Spec R24 test: 66-sample 0→1 ramp at 33Hz over 2s.
    const raw = linearRamp(66, 0, 1, 2)
    const simplified = simplifyCurve(raw, 0.02)

    // Assert ≤4 points (endpoints + minimal control points).
    expect(simplified.length).toBeLessThanOrEqual(4)
    expect(simplified.length).toBeGreaterThanOrEqual(2)

    // Assert endpoints are preserved.
    expect(simplified[0].time).toBe(0)
    expect(simplified[0].value).toBe(0)
    expect(simplified[simplified.length - 1].time).toBeCloseTo(2, 6)
    expect(simplified[simplified.length - 1].value).toBeCloseTo(1, 6)

    // Assert shape is preserved within 2% tolerance at every raw sample's time.
    for (const [t, v] of raw) {
      const interp = evalPolyline(simplified, t)
      expect(Math.abs(interp - v)).toBeLessThanOrEqual(0.02 + 1e-9)
    }
  })

  it('pure linear ramp collapses to exactly 2 points (endpoints)', () => {
    const raw = linearRamp(100, 0, 1, 5)
    const simplified = simplifyCurve(raw, 0.02)
    expect(simplified.length).toBe(2)
    expect(simplified[0]).toEqual({ time: 0, value: 0 })
    expect(simplified[1].time).toBeCloseTo(5, 6)
    expect(simplified[1].value).toBeCloseTo(1, 6)
  })

  it('bent ramp (up then down) preserves the apex as a 3rd point', () => {
    // Up 0→1 over [0, 1], down 1→0 over [1, 2]; apex at (1, 1).
    const raw: RawSample[] = []
    for (let i = 0; i <= 20; i++) raw.push([i / 20, i / 20])
    for (let i = 1; i <= 20; i++) raw.push([1 + i / 20, 1 - i / 20])
    const simplified = simplifyCurve(raw, 0.02)
    expect(simplified.length).toBeGreaterThanOrEqual(3)
    expect(simplified.length).toBeLessThanOrEqual(5)

    // The apex sample must be one of the kept points (within a sample neighbourhood).
    const apexLike = simplified.find((p) => p.value > 0.95 && Math.abs(p.time - 1) < 0.1)
    expect(apexLike).toBeDefined()
  })

  it('noisy ramp with 2% tolerance drops most intermediates', () => {
    // 100-sample 0→1 ramp with ±1% deterministic noise → should drop ~most
    // noise samples (they fit inside tolerance).
    const n = 100
    const raw: RawSample[] = []
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * 3
      const v = i / (n - 1) + 0.01 * Math.sin(i * 0.9)
      raw.push([t, v])
    }
    const simplified = simplifyCurve(raw, 0.02)
    // Expect a meaningful drop. Exact count depends on noise frequency;
    // assert a loose-but-meaningful upper bound.
    expect(simplified.length).toBeLessThan(n / 2)
    expect(simplified.length).toBeGreaterThanOrEqual(2)
  })

  it('flat signal returns two endpoints (no interior kept)', () => {
    const raw: RawSample[] = Array.from({ length: 50 }, (_, i) => [i * 0.01, 0.5] as RawSample)
    const simplified = simplifyCurve(raw, 0.02)
    expect(simplified.length).toBe(2)
    expect(simplified[0].value).toBe(0.5)
    expect(simplified[1].value).toBe(0.5)
  })

  it('tolerance 0 preserves every input point', () => {
    const raw: RawSample[] = [
      [0, 0], [1, 0.1], [2, 0.3], [3, 0.2], [4, 0.5],
    ]
    const simplified = simplifyCurve(raw, 0)
    expect(simplified.length).toBe(raw.length)
  })
})
