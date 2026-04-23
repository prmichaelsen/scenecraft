/**
 * Tests for useAutomationClipboard + copy/paste UX (M13 task-56).
 *
 * Covers:
 *   - Spec test `copy-paste-across-tracks-uses-trackdelta`:
 *       multi-select → Ctrl+C → Ctrl+V at new playhead on a different
 *       track → target curve gains shifted keyframes, trackDelta applied.
 *   - The hook dispatches exactly ONE batch call per paste (underlies
 *       `simultaneous-copy-paste-across-10-tracks`: one request = one
 *       undo unit, guaranteed by the backend's batch handler which calls
 *       undo_begin once).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { useAutomationClipboard } from '../useAutomationClipboard'
import {
  clearClipboardMemory,
  type AutomationClipboard,
  type CurveRef,
  type SelectedKeyframe,
} from '@/lib/automation-clipboard'

function curve(
  overrides: Partial<CurveRef> & Pick<CurveRef, 'curve_id' | 'track_id' | 'effect_type' | 'param_name'>,
): CurveRef {
  return {
    interpolation: 'bezier',
    points: [],
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  clearClipboardMemory()
})

describe('useAutomationClipboard — copy + paste', () => {
  it('copy-paste across tracks uses trackDelta (spec test)', async () => {
    // Setup: 3 audio tracks, each with a compressor.threshold curve.
    const curveT1 = curve({ curve_id: 'ct1', track_id: 't1', effect_type: 'compressor', param_name: 'threshold' })
    const curveT2 = curve({ curve_id: 'ct2', track_id: 't2', effect_type: 'compressor', param_name: 'threshold' })
    const curveT3 = curve({ curve_id: 'ct3', track_id: 't3', effect_type: 'compressor', param_name: 'threshold' })
    const allCurves = [curveT1, curveT2, curveT3]
    const curvesById = new Map(allCurves.map((c) => [c.curve_id, c]))

    // User multi-selects 2 keyframes on track t1's compressor.threshold.
    const selection: SelectedKeyframe[] = [
      { curve_id: 'ct1', time: 10, value: 0.25, interpolation: 'bezier' },
      { curve_id: 'ct1', time: 13, value: 0.75, interpolation: 'bezier' },
    ]

    const batchSpy = vi.fn(async (_project: string, _updates: unknown[]) => ({
      success: true, updated: ['ct2'],
    }))
    // In-memory clipboard swap — avoids requiring navigator.clipboard in happy-dom.
    let stored: AutomationClipboard | null = null
    const writeClipboard = vi.fn(async (c: AutomationClipboard) => { stored = c })
    const readClipboard = vi.fn(async () => stored)

    // Render the hook with paste anchor = t2 (delta = +1).
    const { result, rerender } = renderHook(
      (props: {
        destinationPrimaryTrackId: string | null
        playheadTime: number
      }) => useAutomationClipboard({
        projectName: 'proj',
        selection,
        curvesById,
        allCurves,
        trackOrdering: ['t1', 't2', 't3'],
        destinationPrimaryTrackId: props.destinationPrimaryTrackId,
        playheadTime: props.playheadTime,
        postBatchUpdate: batchSpy,
        writeClipboard,
        readClipboard,
      }),
      { initialProps: { destinationPrimaryTrackId: 't1', playheadTime: 0 } },
    )

    // --- COPY (from t1 context) ---
    const clip = await result.current.copy()
    expect(clip).not.toBeNull()
    expect(clip!.primary_source_track_id).toBe('t1')
    expect(clip!.gesture_start_t).toBe(10)
    expect(clip!.items).toHaveLength(1)
    expect(clip!.items[0].relative_t_offsets).toEqual([0, 3])
    expect(writeClipboard).toHaveBeenCalledTimes(1)

    // --- PASTE on t2 at t=30 ---
    rerender({ destinationPrimaryTrackId: 't2', playheadTime: 30 })
    const pasted = await result.current.paste()
    expect(pasted).not.toBeNull()
    expect(pasted!.updates).toHaveLength(1)

    // The target curve is ct2 (t2 same (compressor, threshold)).
    expect(pasted!.updates[0].curve_id).toBe('ct2')
    // trackDelta=+1: source (t1) → t2, matches dest primary track.
    expect(pasted!.updates[0].track_id).toBe('t2')
    // Times: playhead 30 + [0, 3] = [30, 33].
    expect(pasted!.updates[0].newly_pasted_points).toEqual([[30, 0.25], [33, 0.75]])

    // Exactly ONE batch HTTP call — one undo unit.
    expect(batchSpy).toHaveBeenCalledTimes(1)
    const [projectArg, updatesArg] = batchSpy.mock.calls[0]
    expect(projectArg).toBe('proj')
    expect(updatesArg).toHaveLength(1)
    expect((updatesArg as Array<{ curve_id: string }>)[0].curve_id).toBe('ct2')
  })

  it('paste across 10 tracks issues a single batch call (one undo unit)', async () => {
    // Build 10 tracks each carrying compressor.threshold.
    const trackIds = Array.from({ length: 10 }, (_, i) => `tk${i}`)
    const allCurves: CurveRef[] = trackIds.map((tid, i) => curve({
      curve_id: `cv${i}`,
      track_id: tid,
      effect_type: 'compressor',
      param_name: 'threshold',
    }))
    const curvesById = new Map(allCurves.map((c) => [c.curve_id, c]))

    // Selection spans all 10 tracks × 4 kfs.
    const selection: SelectedKeyframe[] = []
    for (let i = 0; i < 10; i++) {
      for (let k = 0; k < 4; k++) {
        selection.push({
          curve_id: `cv${i}`, time: 5 + k, value: 0.5, interpolation: 'bezier',
        })
      }
    }

    const batchSpy = vi.fn(async (_project: string, updates: unknown[]) => ({
      success: true, updated: (updates as Array<{ curve_id: string }>).map((u) => u.curve_id),
    }))
    let stored: AutomationClipboard | null = null
    const writeClipboard = vi.fn(async (c: AutomationClipboard) => { stored = c })
    const readClipboard = vi.fn(async () => stored)

    const { result } = renderHook(() => useAutomationClipboard({
      projectName: 'proj',
      selection,
      curvesById,
      allCurves,
      trackOrdering: trackIds,
      destinationPrimaryTrackId: 'tk0', // delta=0 — paste stays on same tracks
      playheadTime: 50,
      postBatchUpdate: batchSpy,
      writeClipboard,
      readClipboard,
    }))

    await result.current.copy()
    const res = await result.current.paste()

    expect(res!.updates).toHaveLength(10)
    // ONE call total, containing 10 curve updates → ONE undo unit.
    expect(batchSpy).toHaveBeenCalledTimes(1)
    const [, updatesArg] = batchSpy.mock.calls[0]
    expect(updatesArg).toHaveLength(10)
    // Each update carries 4 newly pasted points.
    for (const u of res!.updates) {
      expect(u.newly_pasted_points).toHaveLength(4)
    }
  })

  it('paste with no matching destination curve skips silently (R46)', async () => {
    // Source: compressor.threshold on t1. Destination t2 has only eq_band.gain.
    const sourceCurve = curve({ curve_id: 'c_src', track_id: 't1', effect_type: 'compressor', param_name: 'threshold' })
    const destCurve = curve({ curve_id: 'c_dst', track_id: 't2', effect_type: 'eq_band', param_name: 'gain' })
    // allCurves represents the project's destination-side curves only — the source
    // curve happens to live on t1 too, but the user has paste-anchored t2 which has
    // no matching (effect_type, param_name).
    const allCurves = [destCurve]
    const curvesById = new Map([[sourceCurve.curve_id, sourceCurve]])

    const batchSpy = vi.fn(async () => ({ success: true, updated: [] }))
    let stored: AutomationClipboard | null = null
    const writeClipboard = vi.fn(async (c: AutomationClipboard) => { stored = c })
    const readClipboard = vi.fn(async () => stored)

    const selection: SelectedKeyframe[] = [
      { curve_id: 'c_src', time: 1, value: 0.5, interpolation: 'bezier' },
    ]

    const { result } = renderHook(() => useAutomationClipboard({
      projectName: 'proj',
      selection,
      curvesById,
      allCurves,
      trackOrdering: ['t1', 't2'],
      destinationPrimaryTrackId: 't2',
      playheadTime: 0,
      postBatchUpdate: batchSpy,
      writeClipboard,
      readClipboard,
    }))

    await result.current.copy()
    const res = await result.current.paste()

    expect(res!.updates).toHaveLength(0)
    expect(res!.skipped).toBe(1)
    // No batch call fires when there's nothing to write.
    expect(batchSpy).not.toHaveBeenCalled()
  })

  it('copy with empty selection returns null and does not touch the clipboard', async () => {
    const batchSpy = vi.fn(async () => ({ success: true, updated: [] }))
    const writeClipboard = vi.fn(async () => {})
    const readClipboard = vi.fn(async () => null)

    const { result } = renderHook(() => useAutomationClipboard({
      projectName: 'proj',
      selection: [],
      curvesById: new Map(),
      allCurves: [],
      trackOrdering: ['t1'],
      destinationPrimaryTrackId: 't1',
      playheadTime: 0,
      postBatchUpdate: batchSpy,
      writeClipboard,
      readClipboard,
    }))

    const clip = await result.current.copy()
    expect(clip).toBeNull()
    expect(writeClipboard).not.toHaveBeenCalled()
  })
})
