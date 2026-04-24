/**
 * Client tests — REST wrappers' URL shapes, request bodies, error
 * propagation. WS hook is not exercised here because it depends on a
 * live socket singleton; the plugin's smoke test covers the
 * registration surface.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import {
  getCredits,
  listGenerations,
  retryGeneration,
  runGeneration,
} from '../generate-music-client'

const API_URL = 'http://localhost:8890'

function mockFetch(json: unknown, { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => json,
  }) as unknown as typeof fetch
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch({}))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runGeneration', () => {
  it('POSTs JSON to /run and returns ids', async () => {
    const f = mockFetch({ generation_id: 'g1', task_ids: ['t1', 't2'], job_id: 'j1' })
    vi.stubGlobal('fetch', f)

    const result = await runGeneration('proj', {
      action: 'auto',
      style: 'dark cinematic',
    })

    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe(`${API_URL}/api/projects/proj/plugins/generate-music/run`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ action: 'auto', style: 'dark cinematic' })
    expect(result).toEqual({ generation_id: 'g1', task_ids: ['t1', 't2'], job_id: 'j1' })
  })

  it('throws on error response', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'style is required' }))
    await expect(runGeneration('proj', { action: 'auto', style: '' }))
      .rejects.toThrow('style is required')
  })
})

describe('listGenerations', () => {
  it('omits query params when no filter', async () => {
    const f = mockFetch({ generations: [] })
    vi.stubGlobal('fetch', f)

    await listGenerations('proj')

    const [url] = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0]
    expect(url).toBe(`${API_URL}/api/projects/proj/plugins/generate-music/generations`)
  })

  it('attaches entityType + entityId filter', async () => {
    const f = mockFetch({ generations: [] })
    vi.stubGlobal('fetch', f)

    await listGenerations('proj', { entityType: 'audio_clip', entityId: 'clip_A' })

    const [url] = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0]
    expect(url).toContain('entityType=audio_clip')
    expect(url).toContain('entityId=clip_A')
  })
})

describe('retryGeneration', () => {
  it('POSTs to /generations/:id/retry', async () => {
    const f = mockFetch({ generation_id: 'g2', task_ids: ['t3'], job_id: 'j2' })
    vi.stubGlobal('fetch', f)

    const result = await retryGeneration('proj', 'gen_abc')

    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe(`${API_URL}/api/projects/proj/plugins/generate-music/generations/gen_abc/retry`)
    expect(init.method).toBe('POST')
    expect(result.generation_id).toBe('g2')
  })

  it('throws when backend returns error', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'only failed generations may be retried' }))
    await expect(retryGeneration('proj', 'gen_xyz'))
      .rejects.toThrow(/only failed/)
  })
})

describe('getCredits', () => {
  it('returns {credits, last_checked_at}', async () => {
    vi.stubGlobal('fetch', mockFetch({ credits: 237, last_checked_at: '2026-04-24T06:00:00Z' }))
    const r = await getCredits('proj')
    expect(r.credits).toBe(237)
  })

  it('attaches ?refresh=1 on force', async () => {
    const f = mockFetch({ credits: 42 })
    vi.stubGlobal('fetch', f)
    await getCredits('proj', { refresh: true })

    const [url] = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0]
    expect(url).toContain('refresh=1')
  })

  it('surfaces backend error payload without throwing', async () => {
    vi.stubGlobal('fetch', mockFetch({ credits: null, error: 'key missing' }))
    const r = await getCredits('proj')
    expect(r.credits).toBeNull()
    expect(r.error).toBe('key missing')
  })
})
