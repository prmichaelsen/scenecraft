/**
 * Tests for automation-clipboard (M13 task-56).
 *
 * Covers:
 *   - Serialize N selected keyframes across M curves into the clipboard shape
 *   - `computeTrackDelta` returns index-based delta
 *   - Paste filter: mismatched (effect_type, param_name) skips silently
 *   - Paste time offset math: playhead_t + relative_offset → absolute_t
 *   - simultaneous-copy-paste-across-10-tracks spec test
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md R43-R47.
 */

import { describe, it, expect } from 'vitest'
import {
  serializeAutomationSelection,
  computeTrackDelta,
  applyTrackDelta,
  resolvePasteTargets,
  writeClipboardToMemory,
  readClipboardFromMemory,
  clearClipboardMemory,
  type CurveRef,
  type SelectedKeyframe,
} from '../automation-clipboard'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function curve(
  overrides: Partial<CurveRef> & Pick<CurveRef, 'curve_id' | 'track_id' | 'effect_type' | 'param_name'>,
): CurveRef {
  return {
    interpolation: 'bezier',
    points: [],
    ...overrides,
  }
}

function makeCurvesMap(...curves: CurveRef[]): Map<string, CurveRef> {
  return new Map(curves.map((c) => [c.curve_id, c]))
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

describe('serializeAutomationSelection', () => {
  it('returns null for empty selection', () => {
    expect(serializeAutomationSelection([], new Map())).toBeNull()
  })

  it('buckets selected keyframes by curve and emits relative offsets', () => {
    const curveA = curve({ curve_id: 'c1', track_id: 't1', effect_type: 'compressor', param_name: 'threshold' })
    const curveB = curve({ curve_id: 'c2', track_id: 't1', effect_type: 'eq_band', param_name: 'gain' })
    const curves = makeCurvesMap(curveA, curveB)

    const selection: SelectedKeyframe[] = [
      { curve_id: 'c1', time: 10, value: 0.2, interpolation: 'bezier' },
      { curve_id: 'c1', time: 12, value: 0.4, interpolation: 'bezier' },
      { curve_id: 'c2', time: 14, value: 0.8, interpolation: 'bezier' },
    ]

    const clip = serializeAutomationSelection(selection, curves)
    expect(clip).not.toBeNull()
    expect(clip!.version).toBe(1)
    expect(clip!.kind).toBe('automation-keyframes')
    expect(clip!.gesture_start_t).toBe(10)
    expect(clip!.primary_source_track_id).toBe('t1')
    expect(clip!.items).toHaveLength(2)

    const c1 = clip!.items.find((i) => i.effect_type === 'compressor')!
    expect(c1.relative_t_offsets).toEqual([0, 2])
    expect(c1.values).toEqual([0.2, 0.4])

    const c2 = clip!.items.find((i) => i.effect_type === 'eq_band')!
    expect(c2.relative_t_offsets).toEqual([4])
    expect(c2.values).toEqual([0.8])
  })

  it('records every unique source track id in sourceTrackIds', () => {
    const curves = makeCurvesMap(
      curve({ curve_id: 'c1', track_id: 't1', effect_type: 'compressor', param_name: 'threshold' }),
      curve({ curve_id: 'c2', track_id: 't2', effect_type: 'compressor', param_name: 'threshold' }),
      curve({ curve_id: 'c3', track_id: 't3', effect_type: 'eq_band', param_name: 'gain' }),
    )
    const selection: SelectedKeyframe[] = [
      { curve_id: 'c1', time: 5, value: 0.1, interpolation: 'bezier' },
      { curve_id: 'c2', time: 6, value: 0.2, interpolation: 'bezier' },
      { curve_id: 'c3', time: 7, value: 0.3, interpolation: 'bezier' },
    ]

    const clip = serializeAutomationSelection(selection, curves)!
    expect(clip.sourceTrackIds).toEqual(['t1', 't2', 't3'])
    expect(clip.primary_source_track_id).toBe('t1')
  })

  it('drops keyframes whose curve_id is not in the curves map', () => {
    const curves = makeCurvesMap(curve({
      curve_id: 'c1', track_id: 't1', effect_type: 'compressor', param_name: 'threshold',
    }))
    const selection: SelectedKeyframe[] = [
      { curve_id: 'c1', time: 10, value: 0.5, interpolation: 'bezier' },
      { curve_id: 'c_nonexistent', time: 11, value: 0.9, interpolation: 'bezier' },
    ]

    const clip = serializeAutomationSelection(selection, curves)!
    expect(clip.items).toHaveLength(1)
    expect(clip.items[0].values).toEqual([0.5])
  })
})

// ---------------------------------------------------------------------------
// trackDelta
// ---------------------------------------------------------------------------

describe('computeTrackDelta', () => {
  it('returns index-based delta, not string arithmetic', () => {
    const ordering = ['audio-alpha', 'audio-beta', 'audio-gamma', 'audio-delta']
    expect(computeTrackDelta('audio-alpha', 'audio-beta', ordering)).toBe(1)
    expect(computeTrackDelta('audio-alpha', 'audio-delta', ordering)).toBe(3)
    expect(computeTrackDelta('audio-delta', 'audio-alpha', ordering)).toBe(-3)
    expect(computeTrackDelta('audio-beta', 'audio-beta', ordering)).toBe(0)
  })

  it('returns null if a track id is missing from the ordering', () => {
    expect(computeTrackDelta('missing', 'audio-beta', ['audio-alpha', 'audio-beta'])).toBeNull()
    expect(computeTrackDelta('audio-alpha', 'missing', ['audio-alpha', 'audio-beta'])).toBeNull()
  })
})

describe('applyTrackDelta', () => {
  it('returns the destination track id at source + delta', () => {
    const ordering = ['t0', 't1', 't2', 't3']
    expect(applyTrackDelta('t0', 2, ordering)).toBe('t2')
    expect(applyTrackDelta('t2', -2, ordering)).toBe('t0')
  })

  it('returns null when the destination is out of bounds', () => {
    const ordering = ['t0', 't1', 't2']
    expect(applyTrackDelta('t0', -1, ordering)).toBeNull()
    expect(applyTrackDelta('t2', 1, ordering)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Paste resolution
// ---------------------------------------------------------------------------

describe('resolvePasteTargets', () => {
  it('maps playhead + relative_offsets → absolute times', () => {
    // Clipboard: one compressor.threshold curve with 3 kfs at offsets [0, 2, 4]
    const curves = makeCurvesMap(
      curve({ curve_id: 'c1', track_id: 't1', effect_type: 'compressor', param_name: 'threshold' }),
    )
    const selection: SelectedKeyframe[] = [
      { curve_id: 'c1', time: 10, value: 0.1, interpolation: 'bezier' },
      { curve_id: 'c1', time: 12, value: 0.2, interpolation: 'bezier' },
      { curve_id: 'c1', time: 14, value: 0.3, interpolation: 'bezier' },
    ]
    const clip = serializeAutomationSelection(selection, curves)!

    const destCurve = curve({
      curve_id: 'c1b', track_id: 't2',
      effect_type: 'compressor', param_name: 'threshold',
      points: [],
    })

    const res = resolvePasteTargets({
      clipboard: clip,
      destination_primary_track_id: 't2',
      playhead_time: 20,
      track_ordering: ['t1', 't2'],
      destination_curves: [destCurve],
    })

    expect(res.updates).toHaveLength(1)
    expect(res.updates[0].curve_id).toBe('c1b')
    expect(res.updates[0].newly_pasted_points).toEqual([[20, 0.1], [22, 0.2], [24, 0.3]])
    expect(res.updates[0].points).toEqual([[20, 0.1], [22, 0.2], [24, 0.3]])
    expect(res.skipped_items).toHaveLength(0)
  })

  it('filters mismatched (effect_type, param_name) — zero pastes, no error', () => {
    // Source: compressor.threshold. Destination track only has compressor.ratio.
    const sourceCurves = makeCurvesMap(
      curve({ curve_id: 'c1', track_id: 't1', effect_type: 'compressor', param_name: 'threshold' }),
    )
    const selection: SelectedKeyframe[] = [
      { curve_id: 'c1', time: 1, value: 0.5, interpolation: 'bezier' },
    ]
    const clip = serializeAutomationSelection(selection, sourceCurves)!

    const destCurve = curve({
      curve_id: 'c2', track_id: 't2',
      effect_type: 'compressor', param_name: 'ratio',
    })

    const res = resolvePasteTargets({
      clipboard: clip,
      destination_primary_track_id: 't2',
      playhead_time: 5,
      track_ordering: ['t1', 't2'],
      destination_curves: [destCurve],
    })

    expect(res.updates).toHaveLength(0)
    expect(res.skipped_items).toHaveLength(1)
    expect(res.skipped_items[0].effect_type).toBe('compressor')
    expect(res.skipped_items[0].param_name).toBe('threshold')
  })

  it('merges pasted points with existing ones — pasted value wins on time collision', () => {
    const clip = {
      version: 1 as const,
      kind: 'automation-keyframes' as const,
      sourceTrackIds: ['t1'],
      primary_source_track_id: 't1',
      gesture_start_t: 0,
      items: [{
        effect_type: 'compressor',
        param_name: 'threshold',
        source_track_id: 't1',
        relative_t_offsets: [0, 1],
        values: [0.9, 0.9],
        interpolation: 'bezier' as const,
      }],
    }

    const destCurve = curve({
      curve_id: 'c1', track_id: 't1',
      effect_type: 'compressor', param_name: 'threshold',
      // existing keyframe at time=5 with a different value
      points: [[5, 0.1] as [number, number], [100, 0.2] as [number, number]],
    })

    const res = resolvePasteTargets({
      clipboard: clip,
      destination_primary_track_id: 't1',
      playhead_time: 5,           // offset 0 → collides with existing kf at t=5
      track_ordering: ['t1'],
      destination_curves: [destCurve],
    })

    expect(res.updates).toHaveLength(1)
    const u = res.updates[0]
    // Collision at t=5 is resolved in favor of the pasted value (0.9, not 0.1).
    expect(u.points).toEqual([[5, 0.9], [6, 0.9], [100, 0.2]])
  })

  it('skips items whose target track is out of range', () => {
    const clip = {
      version: 1 as const,
      kind: 'automation-keyframes' as const,
      sourceTrackIds: ['t0', 't1'],
      primary_source_track_id: 't0',
      gesture_start_t: 0,
      items: [
        {
          effect_type: 'compressor',
          param_name: 'threshold',
          source_track_id: 't0',
          relative_t_offsets: [0],
          values: [0.5],
          interpolation: 'bezier' as const,
        },
        {
          effect_type: 'compressor',
          param_name: 'threshold',
          source_track_id: 't1',
          relative_t_offsets: [0],
          values: [0.6],
          interpolation: 'bezier' as const,
        },
      ],
    }

    // Paste anchor shifts from t0 → t1 (delta=+1). Source t1 then resolves to
    // target (1 + 1) = index 2 = out of range (we only have t0, t1).
    const destCurve = curve({
      curve_id: 'c1', track_id: 't1',
      effect_type: 'compressor', param_name: 'threshold',
    })

    const res = resolvePasteTargets({
      clipboard: clip,
      destination_primary_track_id: 't1',
      playhead_time: 0,
      track_ordering: ['t0', 't1'],
      destination_curves: [destCurve],
    })

    expect(res.updates).toHaveLength(1)
    expect(res.updates[0].curve_id).toBe('c1')
    expect(res.out_of_range).toBe(1)
  })

  it('copy-paste across 10 tracks — all 10 receive new keyframes, source untouched (spec test)', () => {
    // Build 10 tracks each with ONE compressor.threshold curve.
    const trackOrdering = Array.from({ length: 10 }, (_, i) => `t${i}`)
    const allCurves: CurveRef[] = trackOrdering.map((tid, i) =>
      curve({
        curve_id: `c${i}`,
        track_id: tid,
        effect_type: 'compressor',
        param_name: 'threshold',
        points: [],
      }),
    )
    const curvesMap = makeCurvesMap(...allCurves)

    // Selection: pick 4 keyframes on the FIRST track's curve (c0) at times 10/11/12/13.
    // We then conceptually "replicate" them across all 10 by pasting with a
    // trackDelta=0 — but the test here mirrors the spec's intent: a single
    // source per curve, resolved into 10 targets is the "across 10 tracks"
    // scenario where each destination track has its own same-typed curve.
    //
    // To model that cleanly, we build the clipboard with 10 items — one per
    // source track, each with 4 kfs — which is exactly what a Shift-click
    // across all 10 curves produces in the UI.
    const selection: SelectedKeyframe[] = []
    for (let i = 0; i < 10; i++) {
      for (let k = 0; k < 4; k++) {
        selection.push({
          curve_id: `c${i}`,
          time: 10 + k, // shared schedule so gesture_start_t = 10
          value: 0.5,
          interpolation: 'bezier',
        })
      }
    }
    const clip = serializeAutomationSelection(selection, curvesMap)!
    expect(clip.items).toHaveLength(10)

    const res = resolvePasteTargets({
      clipboard: clip,
      destination_primary_track_id: 't0', // delta=0
      playhead_time: 100,
      track_ordering: trackOrdering,
      destination_curves: allCurves,
    })

    // 10 updates, each with 4 newly pasted keyframes.
    expect(res.updates).toHaveLength(10)
    for (const u of res.updates) {
      expect(u.newly_pasted_points).toHaveLength(4)
      expect(u.newly_pasted_points.map(([t]) => t)).toEqual([100, 101, 102, 103])
    }

    // The source curve objects in `allCurves` have empty `points`; resolver
    // must NOT mutate them.
    for (const c of allCurves) {
      expect(c.points).toEqual([])
    }

    // The batch call will send exactly 10 updates — representing ONE undo unit.
    expect(res.skipped_items).toHaveLength(0)
    expect(res.out_of_range).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// In-memory clipboard
// ---------------------------------------------------------------------------

describe('in-memory clipboard helpers', () => {
  it('round-trips a clipboard blob via window global', () => {
    clearClipboardMemory()
    const clip = {
      version: 1 as const,
      kind: 'automation-keyframes' as const,
      sourceTrackIds: ['t0'],
      primary_source_track_id: 't0',
      gesture_start_t: 0,
      items: [],
    }
    writeClipboardToMemory(clip)
    expect(readClipboardFromMemory()).toEqual(clip)
    clearClipboardMemory()
    expect(readClipboardFromMemory()).toBeNull()
  })

  it('returns null for malformed global entries', () => {
    ;(globalThis as Record<string, unknown>)['__scenecraftAutomationClipboard'] = {
      version: 99,
      kind: 'bogus',
    }
    expect(readClipboardFromMemory()).toBeNull()
    clearClipboardMemory()
  })
})
