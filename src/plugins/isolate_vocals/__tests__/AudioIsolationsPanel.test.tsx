/**
 * Tests for AudioIsolationsPanel — primary UX for the isolate_vocals plugin.
 *
 * Fakes the network (fetchIsolations, subscribeIsolationJob) + the mini-
 * waveform's peaks fetch. Asserts empty state, run-list rendering,
 * in-flight progress updates, completion refetch, and stem-row drag payload.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react'

import type {
  IsolateKickoff,
  IsolateResult,
  IsolationRun,
} from '../isolate-vocals-client'

const fetchIsolationsMock = vi.fn()
const fetchPoolPeaksMock = vi.fn()
const callIsolateVocalsMock = vi.fn()
const subscribeCallbacks: Array<{
  jobId: string
  onProgress?: (pct: number, detail: string) => void
  onCompleted?: (result: IsolateResult) => void
  onFailed?: (error: string) => void
}> = []

vi.mock('../isolate-vocals-client', () => ({
  fetchIsolations: (...args: unknown[]) => fetchIsolationsMock(...args),
  fetchPoolPeaks: (...args: unknown[]) => fetchPoolPeaksMock(...args),
  callIsolateVocals: (...args: unknown[]) => callIsolateVocalsMock(...args),
  subscribeIsolationJob: (
    jobId: string,
    cbs: {
      onProgress?: (pct: number, detail: string) => void
      onCompleted?: (result: IsolateResult) => void
      onFailed?: (error: string) => void
    },
  ) => {
    subscribeCallbacks.push({ jobId, ...cbs })
    return () => {}
  },
}))

import { AudioIsolationsPanel } from '../AudioIsolationsPanel'

beforeEach(() => {
  fetchIsolationsMock.mockReset()
  fetchPoolPeaksMock.mockReset()
  callIsolateVocalsMock.mockReset()
  subscribeCallbacks.length = 0
  // peaks resolves to a small Float32Array so the canvas draw doesn't error.
  fetchPoolPeaksMock.mockResolvedValue(new Float32Array([-0.3, 0.3, -0.4, 0.4]))
})

afterEach(() => {
  cleanup()
})


const completedRun = (id: string): IsolationRun => ({
  id,
  status: 'completed',
  model: 'deepfilternet3',
  range_mode: 'full',
  trim_in: null,
  trim_out: null,
  created_at: '2026-04-23T00:00:00Z',
  error: null,
  stems: [
    {
      stem_type: 'vocal',
      pool_segment_id: 'seg_vocal',
      pool_path: 'pool/segments/seg_vocal.wav',
      duration_seconds: 30,
    },
    {
      stem_type: 'background',
      pool_segment_id: 'seg_bg',
      pool_path: 'pool/segments/seg_bg.wav',
      duration_seconds: 30,
    },
  ],
})


describe('AudioIsolationsPanel', () => {
  it('shows the empty-selection state when no entity is selected', () => {
    render(<AudioIsolationsPanel entity={null} projectName="proj" />)
    expect(
      screen.getByText(/Select an audio clip or transition/i),
    ).toBeTruthy()
  })

  it('shows "No isolations yet" when an entity has no runs', async () => {
    fetchIsolationsMock.mockResolvedValue([])
    render(
      <AudioIsolationsPanel
        entity={{ type: 'audio_clip', id: 'ac_1', durationSeconds: 30 }}
        projectName="proj"
      />,
    )
    await waitFor(() =>
      expect(screen.getByText(/No isolations yet/i)).toBeTruthy(),
    )
    expect(fetchIsolationsMock).toHaveBeenCalledWith('proj', 'audio_clip', 'ac_1')
  })

  it('renders one RunCard per run, and 2 StemRows for a completed run', async () => {
    fetchIsolationsMock.mockResolvedValue([
      completedRun('iso_1'),
      completedRun('iso_2'),
    ])

    render(
      <AudioIsolationsPanel
        entity={{ type: 'audio_clip', id: 'ac_1', durationSeconds: 30 }}
        projectName="proj"
      />,
    )

    await waitFor(() =>
      expect(screen.getAllByTestId('run-card')).toHaveLength(2),
    )
    expect(screen.getAllByTestId('stem-row')).toHaveLength(4) // 2 stems × 2 runs
  })

  it('writes a StemDragPayload to dataTransfer on drag start', async () => {
    fetchIsolationsMock.mockResolvedValue([completedRun('iso_1')])

    render(
      <AudioIsolationsPanel
        entity={{ type: 'audio_clip', id: 'ac_1', durationSeconds: 30 }}
        projectName="proj"
      />,
    )

    const stemRows = await waitFor(() => screen.getAllByTestId('stem-row'))
    const first = stemRows[0]

    const setData = vi.fn()
    fireEvent.dragStart(first, {
      dataTransfer: {
        setData,
        types: [],
      },
    })

    expect(setData).toHaveBeenCalled()
    const [mime, body] = setData.mock.calls[0]
    expect(mime).toBe('application/x-scenecraft-stem')
    const payload = JSON.parse(body)
    expect(payload.pool_segment_id).toBe('seg_vocal')
    expect(payload.stem_type).toBe('vocal')
    expect(payload.duration_seconds).toBe(30)
  })

  it('starts a run via the form, shows in-flight progress, and refetches on completion', async () => {
    fetchIsolationsMock.mockResolvedValueOnce([]) // initial
    fetchIsolationsMock.mockResolvedValueOnce([completedRun('iso_new')]) // after completion
    callIsolateVocalsMock.mockResolvedValue({
      isolation_id: 'iso_new',
      job_id: 'job_new',
    } satisfies IsolateKickoff)

    render(
      <AudioIsolationsPanel
        entity={{ type: 'audio_clip', id: 'ac_1', durationSeconds: 30 }}
        projectName="proj"
      />,
    )

    // Wait for initial fetch (no runs).
    await waitFor(() =>
      expect(screen.getByText(/No isolations yet/i)).toBeTruthy(),
    )

    // Click Run — optimistic running card appears, and subscribe is registered.
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(subscribeCallbacks).toHaveLength(1))

    // Emit a progress event → progress bar updates.
    subscribeCallbacks[0].onProgress?.(0.5, 'halfway')
    await waitFor(() => {
      const bar = screen.getByRole('progressbar') as HTMLElement
      expect(bar.getAttribute('aria-valuenow')).toBe('50')
    })

    // Emit completion → panel refetches. The new completed run replaces the
    // optimistic running one.
    subscribeCallbacks[0].onCompleted?.({
      isolation_id: 'iso_new',
      stems: [],
    })
    await waitFor(() => {
      const cards = screen.getAllByTestId('run-card')
      expect(cards).toHaveLength(1)
    })
    expect(fetchIsolationsMock).toHaveBeenCalledTimes(2)
  })
})
