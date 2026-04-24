/**
 * Tests for the chat client's mix-render WS round-trip handler (M15 task-7).
 *
 * Exercises ``handleMixRenderRequest`` end-to-end:
 *   1. Server emits a ``mix_render_request``.
 *   2. Handler calls ``renderMixToBuffer`` → ``encodePCMToWav`` → POST.
 *   3. The multipart form must include every field the backend expects,
 *      especially ``request_id`` so the chat tool can unblock.
 *
 * happy-dom provides ``FormData`` and ``Blob``; ``OfflineAudioContext`` is
 * bypassed entirely because we inject a mock renderer.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AudioTrack } from '../audio-client'
import {
  handleMixRenderRequest,
  type MixRenderRequest,
  type PausableMixer,
} from '../chat-client'
import type { MixRenderResult } from '../mix-render'


function makeMsg(overrides: Partial<MixRenderRequest> = {}): MixRenderRequest {
  return {
    type: 'mix_render_request',
    request_id: 'req-abc123',
    mix_graph_hash: 'f'.repeat(64),
    start_time_s: 0,
    end_time_s: 2,
    sample_rate: 48000,
    ...overrides,
  }
}


function makeMockRenderer(pcm = new Float32Array([0.1, -0.1, 0.2, -0.2])) {
  const impl = vi.fn(async (): Promise<MixRenderResult> => ({
    pcm,
    channels: 2,
    sampleRate: 48000,
    durationSeconds: pcm.length / 48000,
  }))
  return impl
}


function makeMockEncoder(bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46])) {
  return vi.fn(() => bytes.buffer as ArrayBuffer)
}


function makeMockFetch(status = 201, body: unknown = { rendered_path: 'pool/mixes/x.wav' }) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response)
}


// ── Happy path ──────────────────────────────────────────────────────────────

describe('handleMixRenderRequest', () => {
  it('renders the mix, encodes a WAV, and posts to /mix-render-upload with request_id', async () => {
    const msg = makeMsg()
    const tracks: AudioTrack[] = []
    const renderImpl = makeMockRenderer()
    const encodeImpl = makeMockEncoder()
    const fetchImpl = makeMockFetch(201)

    await handleMixRenderRequest(msg, {
      projectName: 'test-proj',
      tracks,
      renderImpl,
      encodeImpl,
      fetchImpl,
      apiBase: 'http://api.test',
    })

    // Renderer called with the window from the WS message
    expect(renderImpl).toHaveBeenCalledTimes(1)
    const [renderTracks, renderOpts] = renderImpl.mock.calls[0]
    expect(renderTracks).toBe(tracks)
    expect(renderOpts.projectName).toBe('test-proj')
    expect(renderOpts.startTimeS).toBe(0)
    expect(renderOpts.endTimeS).toBe(2)
    expect(renderOpts.sampleRate).toBe(48000)
    expect(renderOpts.channels).toBe(2)

    // Encoder called with the renderer's PCM + format
    expect(encodeImpl).toHaveBeenCalledTimes(1)
    const encodeArgs = encodeImpl.mock.calls[0]
    expect(encodeArgs[1]).toBe(48000) // sampleRate
    expect(encodeArgs[2]).toBe(2)     // channels

    // HTTP POST: URL + method
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://api.test/api/projects/test-proj/mix-render-upload')
    expect(init?.method).toBe('POST')

    // HTTP POST: form body shape — must include every field the backend parses
    const body = init?.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('mix_graph_hash')).toBe(msg.mix_graph_hash)
    expect(body.get('start_time_s')).toBe(String(msg.start_time_s))
    expect(body.get('end_time_s')).toBe(String(msg.end_time_s))
    expect(body.get('sample_rate')).toBe('48000')
    expect(body.get('channels')).toBe('2')
    expect(body.get('request_id')).toBe(msg.request_id) // critical — release key
    const audio = body.get('audio')
    expect(audio).toBeInstanceOf(Blob)
  })

  it('URL-encodes the project name', async () => {
    const fetchImpl = makeMockFetch()
    await handleMixRenderRequest(makeMsg(), {
      projectName: 'my project/with slashes',
      tracks: [],
      renderImpl: makeMockRenderer(),
      encodeImpl: makeMockEncoder(),
      fetchImpl,
      apiBase: 'http://api.test',
    })
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://api.test/api/projects/my%20project%2Fwith%20slashes/mix-render-upload')
  })

  it('fetches tracks via fetchTracksImpl when `tracks` is not supplied', async () => {
    const fetchTracksImpl = vi.fn(async () => [] as AudioTrack[])
    await handleMixRenderRequest(makeMsg(), {
      projectName: 'p',
      renderImpl: makeMockRenderer(),
      encodeImpl: makeMockEncoder(),
      fetchImpl: makeMockFetch(),
      fetchTracksImpl,
    })
    expect(fetchTracksImpl).toHaveBeenCalledWith('p')
  })

  // ── Pause/resume ─────────────────────────────────────────────────────────

  it('pauses the mixer before render and resumes after upload when isPlaying=true', async () => {
    const calls: string[] = []
    const mixer: PausableMixer = {
      pause: () => { calls.push('pause') },
      play: () => { calls.push('play') },
    }
    // Record render/upload ordering too so we can assert the sandwich.
    const renderImpl = vi.fn(async (): Promise<MixRenderResult> => {
      calls.push('render')
      return {
        pcm: new Float32Array(0),
        channels: 2,
        sampleRate: 48000,
        durationSeconds: 0,
      }
    })
    const encodeImpl = vi.fn(() => { calls.push('encode'); return new ArrayBuffer(0) })
    const fetchImpl = vi.fn(async () => {
      calls.push('fetch')
      return { ok: true, status: 201, text: async () => '', json: async () => ({}) } as Response
    })

    await handleMixRenderRequest(makeMsg(), {
      projectName: 'p',
      tracks: [],
      mixer,
      isPlaying: true,
      renderImpl,
      encodeImpl,
      fetchImpl,
    })

    expect(calls).toEqual(['pause', 'render', 'encode', 'fetch', 'play'])
  })

  it('does NOT touch the mixer when isPlaying=false', async () => {
    const pause = vi.fn()
    const play = vi.fn()
    const mixer: PausableMixer = { pause, play }

    await handleMixRenderRequest(makeMsg(), {
      projectName: 'p',
      tracks: [],
      mixer,
      isPlaying: false,
      renderImpl: makeMockRenderer(),
      encodeImpl: makeMockEncoder(),
      fetchImpl: makeMockFetch(),
    })

    expect(pause).not.toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()
  })

  it('still resumes playback when the render throws', async () => {
    const pause = vi.fn()
    const play = vi.fn()
    const mixer: PausableMixer = { pause, play }
    const renderImpl = vi.fn(async () => { throw new Error('render boom') })

    await handleMixRenderRequest(makeMsg(), {
      projectName: 'p',
      tracks: [],
      mixer,
      isPlaying: true,
      renderImpl,
      encodeImpl: makeMockEncoder(),
      fetchImpl: makeMockFetch(),
    })

    expect(pause).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledTimes(1)
  })

  // ── Error paths ──────────────────────────────────────────────────────────

  it('swallows upload errors so the backend can time out cleanly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = makeMockFetch(500, { error: 'boom' })
    await handleMixRenderRequest(makeMsg(), {
      projectName: 'p',
      tracks: [],
      renderImpl: makeMockRenderer(),
      encodeImpl: makeMockEncoder(),
      fetchImpl,
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('swallows render errors without bubbling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const renderImpl = vi.fn(async () => { throw new Error('boom') })
    await expect(handleMixRenderRequest(makeMsg(), {
      projectName: 'p',
      tracks: [],
      renderImpl,
      encodeImpl: makeMockEncoder(),
      fetchImpl: makeMockFetch(),
    })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
