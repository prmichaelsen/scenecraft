import { describe, it, expect } from 'vitest'

import {
  resolveOverlapsWithSplit,
  type BatchOp,
  type ClipRow,
} from '../audio-overlap'

const baseClip = (
  id: string,
  start: number,
  end: number,
  sourceOffset = 0,
): ClipRow => ({
  id,
  track_id: 'at_1',
  start_time: start,
  end_time: end,
  source_offset: sourceOffset,
  source_path: 'pool/segments/src.wav',
})

const genIdCounter = () => {
  let i = 0
  return () => `new_${++i}`
}

describe('resolveOverlapsWithSplit — no-op', () => {
  it('empty existing list → no ops', () => {
    expect(resolveOverlapsWithSplit({ start: 0, end: 5 }, [], genIdCounter())).toEqual([])
  })

  it('no overlap (dropped entirely before existing) → no ops', () => {
    const ops = resolveOverlapsWithSplit(
      { start: 0, end: 5 },
      [baseClip('c1', 10, 20)],
      genIdCounter(),
    )
    expect(ops).toEqual([])
  })

  it('no overlap (dropped entirely after existing) → no ops', () => {
    const ops = resolveOverlapsWithSplit(
      { start: 30, end: 40 },
      [baseClip('c1', 10, 20)],
      genIdCounter(),
    )
    expect(ops).toEqual([])
  })

  it('touches at endpoint (no interior overlap) → no ops', () => {
    // dropped.end === existing.start_time → no overlap.
    const ops = resolveOverlapsWithSplit(
      { start: 0, end: 10 },
      [baseClip('c1', 10, 20)],
      genIdCounter(),
    )
    expect(ops).toEqual([])
  })
})

describe('resolveOverlapsWithSplit — full-cover', () => {
  it('dropped fully covers existing → delete existing', () => {
    const ops = resolveOverlapsWithSplit(
      { start: 0, end: 30 },
      [baseClip('c1', 5, 15)],
      genIdCounter(),
    )
    expect(ops).toEqual([{ op: 'delete', id: 'c1' }])
  })

  it('dropped exactly equals existing → delete existing', () => {
    const ops = resolveOverlapsWithSplit(
      { start: 10, end: 20 },
      [baseClip('c1', 10, 20)],
      genIdCounter(),
    )
    expect(ops).toEqual([{ op: 'delete', id: 'c1' }])
  })
})

describe('resolveOverlapsWithSplit — left-edge', () => {
  it('dropped covers existing left edge → trim start_time + advance source_offset', () => {
    const ops = resolveOverlapsWithSplit(
      { start: 0, end: 12 },
      [baseClip('c1', 10, 20, 3)],
      genIdCounter(),
    )
    expect(ops).toEqual([
      {
        op: 'trim',
        id: 'c1',
        start_time: 12,
        // source_offset was 3, existing started at 10, dropped ended at 12.
        // new source_offset = 3 + (12 - 10) = 5
        source_offset: 5,
      },
    ])
  })

  it('dropped covers existing left edge, existing source_offset = 0 → new offset = width consumed', () => {
    const ops = resolveOverlapsWithSplit(
      { start: 0, end: 7 },
      [baseClip('c1', 5, 20, 0)],
      genIdCounter(),
    )
    expect(ops).toEqual([
      { op: 'trim', id: 'c1', start_time: 7, source_offset: 2 },
    ])
  })
})

describe('resolveOverlapsWithSplit — right-edge', () => {
  it('dropped covers existing right edge → trim end_time only (no source_offset change)', () => {
    const ops = resolveOverlapsWithSplit(
      { start: 15, end: 30 },
      [baseClip('c1', 10, 20, 4)],
      genIdCounter(),
    )
    expect(ops).toEqual([{ op: 'trim', id: 'c1', end_time: 15 }])
  })

  it('dropped covers existing right edge, non-zero source_offset stays untouched', () => {
    const ops = resolveOverlapsWithSplit(
      { start: 18, end: 30 },
      [baseClip('c1', 10, 20, 10)],
      genIdCounter(),
    )
    expect(ops.length).toBe(1)
    expect(ops[0]).toMatchObject({ op: 'trim', id: 'c1', end_time: 18 })
    expect('source_offset' in ops[0]).toBe(false)
  })
})

describe('resolveOverlapsWithSplit — interior split', () => {
  it('dropped fits inside existing → trim left + insert right', () => {
    const ops = resolveOverlapsWithSplit(
      { start: 12, end: 15 },
      [baseClip('c1', 10, 20, 2)],
      genIdCounter(),
    )
    expect(ops).toHaveLength(2)
    expect(ops[0]).toEqual({ op: 'trim', id: 'c1', end_time: 12 })
    const insert = ops[1] as Extract<BatchOp, { op: 'insert' }>
    expect(insert.op).toBe('insert')
    expect(insert.clip.track_id).toBe('at_1')
    expect(insert.clip.start_time).toBe(15)
    expect(insert.clip.end_time).toBe(20)
    // source_offset = existing.source_offset + (dropped.end - existing.start_time)
    //               = 2 + (15 - 10) = 7
    expect(insert.clip.source_offset).toBe(7)
    // Identity must be a new id (not c1).
    expect(insert.clip.id).not.toBe('c1')
  })

  it('the new right-half id is generated via genId', () => {
    const ids: string[] = []
    const gen = () => {
      const id = `G${ids.length + 1}`
      ids.push(id)
      return id
    }
    const ops = resolveOverlapsWithSplit(
      { start: 12, end: 15 },
      [baseClip('c1', 10, 20)],
      gen,
    )
    const insert = ops.find((o) => o.op === 'insert') as Extract<BatchOp, { op: 'insert' }>
    expect(insert.clip.id).toBe('G1')
  })
})

describe('resolveOverlapsWithSplit — multi-clip', () => {
  it('emits ops per overlapping clip; skips non-overlapping ones', () => {
    const ops = resolveOverlapsWithSplit(
      { start: 0, end: 25 },
      [
        baseClip('c_left_edge', 20, 30, 0), // left-edge overlap
        baseClip('c_covered', 5, 15, 0),    // fully covered
        baseClip('c_faraway', 50, 60, 0),   // no overlap
      ],
      genIdCounter(),
    )
    expect(ops).toHaveLength(2)
    expect(ops.find((o) => 'id' in o && o.id === 'c_covered')).toMatchObject({
      op: 'delete',
    })
    expect(ops.find((o) => 'id' in o && o.id === 'c_left_edge')).toMatchObject({
      op: 'trim',
      start_time: 25,
      source_offset: 5,
    })
  })
})
