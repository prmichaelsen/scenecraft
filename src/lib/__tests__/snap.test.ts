import { describe, it, expect } from 'vitest'
import { snapDelta } from '../snap'

const PX_PER_SEC = 100 // 8 px threshold = 0.08s

describe('snapDelta', () => {
  it('returns raw delta when alt is held (snap disabled)', () => {
    const res = snapDelta(0.03, 10, [10.0], PX_PER_SEC, true, false)
    expect(res.dt).toBe(0.03)
    expect(res.snappedTo).toBeNull()
  })

  it('snaps to closest anchor within 8 px threshold', () => {
    // currentPosition = 5.0, rawDt = 0.95 → cursor = 5.95
    // anchor at 6.0 → delta 0.05s = 5 px (within 8 px) → snap
    const res = snapDelta(0.95, 5.0, [6.0], PX_PER_SEC, false, false)
    expect(res.snappedTo).toBe(6.0)
    // dt should bring cursor exactly to anchor: 6.0 - 5.0 = 1.0
    expect(res.dt).toBeCloseTo(1.0, 10)
  })

  it('picks the closest anchor when multiple in range', () => {
    // currentPosition = 0, rawDt = 0.97 → cursor = 0.97
    // anchors at 0.95 (2 px), 1.00 (3 px), 1.04 (7 px) — 0.95 wins
    const res = snapDelta(0.97, 0, [0.95, 1.0, 1.04], PX_PER_SEC, false, false)
    expect(res.snappedTo).toBe(0.95)
    expect(res.dt).toBeCloseTo(0.95, 10)
  })

  it('ignores anchors outside the pixel threshold', () => {
    // currentPosition = 0, rawDt = 1.5 → cursor = 1.5, anchor at 2.0 → 50 px → out
    const res = snapDelta(1.5, 0, [2.0], PX_PER_SEC, false, false)
    expect(res.snappedTo).toBeNull()
    // Falls through to grid — rawDt=1.5 rounds to 2.0 on 1s grid, 50px away, so no grid snap either
    expect(res.dt).toBe(1.5)
  })

  it('falls back to 1-second grid when no anchor and close to grid', () => {
    // rawDt = 1.05 → 1s grid rounds to 1.0, dist = 5 px → grid snap
    const res = snapDelta(1.05, 0, [], PX_PER_SEC, false, false)
    expect(res.dt).toBeCloseTo(1.0, 10)
    expect(res.snappedTo).toBeNull()
  })

  it('falls back to 0.1-second grid when shift is held', () => {
    // rawDt = 0.32 → 0.1 grid rounds to 0.3, dist = 2 px → fine grid snap
    const res = snapDelta(0.32, 0, [], PX_PER_SEC, false, true)
    expect(res.dt).toBeCloseTo(0.3, 10)
    expect(res.snappedTo).toBeNull()
  })

  it('no snap when grid distance exceeds threshold', () => {
    // rawDt = 0.5 → 1s grid rounds to 0.0 or 1.0, both 50 px away → no snap
    const res = snapDelta(0.5, 0, [], PX_PER_SEC, false, false)
    expect(res.dt).toBe(0.5)
    expect(res.snappedTo).toBeNull()
  })

  it('anchor snap takes priority over grid', () => {
    // cursor = 1.02, anchor at 1.03 (1 px), 1s grid would pull to 1.0 (2 px)
    // anchor wins by being closer
    const res = snapDelta(1.02, 0, [1.03], PX_PER_SEC, false, false)
    expect(res.snappedTo).toBe(1.03)
    expect(res.dt).toBeCloseTo(1.03, 10)
  })

  it('respects custom pixel threshold', () => {
    // Same as before but tighter threshold (2 px)
    // cursor = 5.05, anchor at 5.0 → 5 px away, exceeds 2 px threshold
    const res = snapDelta(5.05, 0, [5.0], PX_PER_SEC, false, false, 2)
    expect(res.snappedTo).toBeNull()
  })

  it('returns raw delta when pxPerSec is zero or negative', () => {
    const res = snapDelta(0.5, 0, [1.0], 0, false, false)
    expect(res.dt).toBe(0.5)
    expect(res.snappedTo).toBeNull()
  })
})
