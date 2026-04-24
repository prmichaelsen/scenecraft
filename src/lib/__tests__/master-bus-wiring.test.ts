/**
 * Tests for the master-bus frontend wiring:
 *   1. `fetchMasterBusEffects` — real HTTP fetch, URL shape + parse + errors.
 *   2. `handleMasterBusEffectsChanged` — the WS invalidation handler that
 *      refetches + calls `mixer.reevaluateMasterChain`.
 *
 * happy-dom supplies `fetch`, `Response`, and `CustomEvent`. No real network
 * calls happen — the fetch is overridden via `vi.stubGlobal`. The handler
 * accepts an injected `fetchEffectsImpl` hook so we can assert the exact
 * refetch → reevaluate wiring without touching the module-scoped
 * `fetchMasterBusEffects` symbol.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchMasterBusEffects, type TrackEffectRowJSON } from '../scenecraft-client'
import {
  handleMasterBusEffectsChanged,
  type MasterChainMixer,
} from '../chat-client'


function mkEffect(overrides: Partial<TrackEffectRowJSON> = {}): TrackEffectRowJSON {
  return {
    id: 'fx-1',
    // Master-bus rows come back with track_id === null on the wire; we use
    // the JSON row type which declares it as string, matching the sibling
    // track-effects endpoint's existing shape. The mixer's buildEffectChain
    // never reads track_id, so null-vs-string is functionally irrelevant.
    track_id: '',
    effect_type: 'gain',
    order_index: 0,
    enabled: true,
    static_params: {},
    curves: [],
    ...overrides,
  }
}


function makeMockFetch(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response)
}


// ── fetchMasterBusEffects ───────────────────────────────────────────────────

describe('fetchMasterBusEffects', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GETs /api/projects/:name/master-bus-effects and parses `effects`', async () => {
    const effects = [mkEffect({ id: 'a' }), mkEffect({ id: 'b', order_index: 1 })]
    const fetchSpy = makeMockFetch(200, { effects })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await fetchMasterBusEffects('proj-1')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls[0]!
    const url = call[0] as string
    expect(url).toContain('/api/projects/proj-1/master-bus-effects')
    expect(result).toEqual(effects)
  })

  it('URL-encodes the project name', async () => {
    const fetchSpy = makeMockFetch(200, { effects: [] })
    vi.stubGlobal('fetch', fetchSpy)

    await fetchMasterBusEffects('my project/with slashes')

    const call = fetchSpy.mock.calls[0]!
    const url = call[0] as string
    expect(url).toContain('/api/projects/my%20project%2Fwith%20slashes/master-bus-effects')
  })

  it('returns [] when the body omits the `effects` key', async () => {
    const fetchSpy = makeMockFetch(200, {})
    vi.stubGlobal('fetch', fetchSpy)

    const result = await fetchMasterBusEffects('p')
    expect(result).toEqual([])
  })

  it('throws on non-2xx response (contract: callers wrap in try/catch)', async () => {
    const fetchSpy = makeMockFetch(500, { error: 'boom' })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(fetchMasterBusEffects('p')).rejects.toThrow(/500/)
  })

  it('propagates network errors (contract: throws)', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(fetchMasterBusEffects('p')).rejects.toThrow(/ECONNREFUSED/)
  })
})


// ── handleMasterBusEffectsChanged ───────────────────────────────────────────

describe('handleMasterBusEffectsChanged', () => {
  it('refetches effects and calls mixer.reevaluateMasterChain with the list', async () => {
    const effects = [mkEffect({ id: 'm1' }), mkEffect({ id: 'm2', order_index: 1 })]
    const fetchEffectsImpl = vi.fn(async () => effects)
    const reevaluate = vi.fn()
    const mixer: MasterChainMixer = { reevaluateMasterChain: reevaluate }

    await handleMasterBusEffectsChanged({
      projectName: 'proj-1',
      mixer,
      fetchEffectsImpl,
    })

    expect(fetchEffectsImpl).toHaveBeenCalledWith('proj-1')
    expect(reevaluate).toHaveBeenCalledTimes(1)
    expect(reevaluate.mock.calls[0][0]).toEqual(effects)
  })

  it('skips reevaluate when mixer is null (still refetches)', async () => {
    const fetchEffectsImpl = vi.fn(async () => [mkEffect()])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await handleMasterBusEffectsChanged({
      projectName: 'p',
      mixer: null,
      fetchEffectsImpl,
    })

    expect(fetchEffectsImpl).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('swallows fetch errors so the chat stream keeps flowing', async () => {
    const fetchEffectsImpl = vi.fn(async () => { throw new Error('boom') })
    const reevaluate = vi.fn()
    const mixer: MasterChainMixer = { reevaluateMasterChain: reevaluate }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(handleMasterBusEffectsChanged({
      projectName: 'p',
      mixer,
      fetchEffectsImpl,
    })).resolves.toBeUndefined()

    expect(reevaluate).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('uses the default fetchMasterBusEffects when no override is provided', async () => {
    // Stub global fetch so the default `fetchMasterBusEffects` import can run.
    const body = { effects: [mkEffect({ id: 'default-path' })] }
    const fetchSpy = vi.fn(async (_i: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    }) as Response)
    vi.stubGlobal('fetch', fetchSpy)

    const reevaluate = vi.fn()
    const mixer: MasterChainMixer = { reevaluateMasterChain: reevaluate }

    await handleMasterBusEffectsChanged({ projectName: 'p', mixer })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(reevaluate).toHaveBeenCalledWith(body.effects)

    vi.unstubAllGlobals()
  })
})
