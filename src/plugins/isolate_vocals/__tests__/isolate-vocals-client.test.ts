/**
 * Tests for isolate-vocals-client — REST + WS helpers.
 *
 * Uses mocked fetch + mocked subscribeJobExternal (via the plugin-api
 * layer). No real network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock plugin-api's getSubscribeJob so we can intercept callback registration
// without needing a real WebSocket.
const _listeners: Array<(msg: Record<string, unknown>) => void> = []
vi.mock('@/lib/plugin-api', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    getSubscribeJob: () => {
      return (_jobId: string, cbs: {
        onProgress?: (p: { completed: number; total: number; detail: string }) => void
        onCompleted?: (result: unknown) => void
        onFailed?: (error: string) => void
      }) => {
        const listener = (msg: Record<string, unknown>) => {
          if (msg.type === 'job_progress') {
            cbs.onProgress?.({
              completed: msg.completed as number,
              total: msg.total as number,
              detail: (msg.detail as string) || '',
            })
          } else if (msg.type === 'job_completed') {
            cbs.onCompleted?.(msg.result)
          } else if (msg.type === 'job_failed') {
            cbs.onFailed?.(msg.error as string)
          }
        }
        _listeners.push(listener)
        return () => {
          const i = _listeners.indexOf(listener)
          if (i >= 0) _listeners.splice(i, 1)
        }
      }
    },
  }
})

import {
  callIsolateVocals,
  fetchIsolations,
  subscribeIsolationJob,
} from '../isolate-vocals-client'

beforeEach(() => {
  _listeners.length = 0
  vi.restoreAllMocks()
})

describe('callIsolateVocals', () => {
  it('POSTs the kickoff body to the plugin REST route', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
        json: async () => ({ isolation_id: 'iso_123', job_id: 'job_abc' }),
      } as Response)

    const result = await callIsolateVocals('proj', {
      entity_type: 'audio_clip',
      entity_id: 'ac_1',
      range_mode: 'full',
    })

    expect(result).toEqual({ isolation_id: 'iso_123', job_id: 'job_abc' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/projects\/proj\/plugins\/isolate_vocals\/run$/)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      entity_type: 'audio_clip',
      entity_id: 'ac_1',
      range_mode: 'full',
    })
  })

  it('throws when the backend returns {error}', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ error: 'source not found' }),
    } as Response)

    await expect(
      callIsolateVocals('proj', { entity_type: 'audio_clip', entity_id: 'ac_1' }),
    ).rejects.toThrow('source not found')
  })
})

describe('fetchIsolations', () => {
  it('GETs with entityType + entityId params', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({
        isolations: [
          {
            id: 'iso_1',
            status: 'completed',
            model: 'deepfilternet3',
            range_mode: 'full',
            trim_in: null,
            trim_out: null,
            created_at: '2026-04-22T00:00:00Z',
            stems: [],
          },
        ],
      }),
    } as Response)

    const runs = await fetchIsolations('proj', 'audio_clip', 'ac_1')
    expect(runs).toHaveLength(1)
    expect(runs[0].id).toBe('iso_1')

    const url = fetchSpy.mock.calls[0][0] as string
    expect(url).toMatch(/entityType=audio_clip/)
    expect(url).toMatch(/entityId=ac_1/)
  })

  it('returns [] when backend omits the key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({}),
    } as Response)

    const runs = await fetchIsolations('proj', 'audio_clip', 'ac_1')
    expect(runs).toEqual([])
  })
})

describe('subscribeIsolationJob', () => {
  it('maps job_progress → onProgress(pct, detail)', () => {
    const progress = vi.fn()
    subscribeIsolationJob('job_1', { onProgress: progress })

    _listeners[0]({ type: 'job_progress', completed: 50, total: 100, detail: 'working' })
    expect(progress).toHaveBeenCalledWith(0.5, 'working')
  })

  it('maps job_completed → onCompleted(result)', () => {
    const completed = vi.fn()
    subscribeIsolationJob('job_1', { onCompleted: completed })

    _listeners[0]({
      type: 'job_completed',
      result: {
        isolation_id: 'iso_1',
        stems: [
          { stem_type: 'vocal', pool_segment_id: 'p1', pool_path: 'pool/segments/p1.wav' },
          { stem_type: 'background', pool_segment_id: 'p2', pool_path: 'pool/segments/p2.wav' },
        ],
      },
    })
    expect(completed).toHaveBeenCalledTimes(1)
    const arg = completed.mock.calls[0][0]
    expect(arg.isolation_id).toBe('iso_1')
    expect(arg.stems).toHaveLength(2)
  })

  it('maps job_failed → onFailed(error)', () => {
    const failed = vi.fn()
    subscribeIsolationJob('job_1', { onFailed: failed })

    _listeners[0]({ type: 'job_failed', error: 'oops' })
    expect(failed).toHaveBeenCalledWith('oops')
  })

  it('returned unsubscribe stops further callbacks', () => {
    const progress = vi.fn()
    const unsub = subscribeIsolationJob('job_1', { onProgress: progress })
    unsub()
    // listener removed; nothing to dispatch to. Just verify no throws.
    expect(_listeners).toHaveLength(0)
    expect(progress).not.toHaveBeenCalled()
  })
})
