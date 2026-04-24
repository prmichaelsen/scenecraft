/**
 * Tests for the bounce-audio WS round-trip handler (M-bounce-audio).
 *
 * Covers two surfaces:
 *   1. Extended `encodePCMToWav` — 16 / 24 / 32-float paths produce well-formed
 *      WAV headers, the correct `wFormatTag`, the correct bytes-per-sample,
 *      and round-trip samples within each path's quantization tolerance.
 *   2. `handleBounceAudioRequest` — filters tracks per `mode`, uploads the
 *      right multipart form, and fails silently on fetch errors.
 *
 * Render / encode / fetch are all dep-injected, so happy-dom's lack of
 * `OfflineAudioContext` doesn't matter here.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AudioClip, AudioTrack } from '../audio-client'
import { encodePCMToWav, renderMixToBuffer } from '../mix-render'
import type { MixRenderResult } from '../mix-render'
import {
  filterTracksForBounce,
  handleBounceAudioRequest,
  type BounceAudioRequest,
} from '../chat-client'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: 'clip-1',
    track_id: 'track-1',
    source_path: 'sample.wav',
    start_time: 0,
    end_time: 1,
    source_offset: 0,
    volume_curve: [],
    muted: false,
    ...overrides,
  }
}

function makeTrack(overrides: Partial<AudioTrack> = {}): AudioTrack {
  return {
    id: 'track-1',
    name: 'Track 1',
    display_order: 0,
    hidden: false,
    muted: false,
    solo: false,
    volume_curve: [],
    clips: [],
    ...overrides,
  }
}

function makeMsg(overrides: Partial<BounceAudioRequest> = {}): BounceAudioRequest {
  return {
    type: 'bounce_audio_request',
    request_id: 'req-bounce-001',
    bounce_id: 'b-001',
    composite_hash: 'a'.repeat(64),
    start_time_s: 0,
    end_time_s: 2,
    mode: 'full',
    sample_rate: 48000,
    bit_depth: 24,
    channels: 2,
    ...overrides,
  }
}

function makeMockRenderer(pcm = new Float32Array([0.1, -0.1, 0.2, -0.2])) {
  const impl: typeof renderMixToBuffer = async (): Promise<MixRenderResult> => ({
    pcm,
    channels: 2,
    sampleRate: 48000,
    durationSeconds: pcm.length / 48000,
  })
  return vi.fn(impl)
}

function makeMockEncoder(bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46])) {
  const impl: typeof encodePCMToWav = () => bytes.buffer as ArrayBuffer
  return vi.fn(impl)
}

function makeMockFetch(status = 201, body: unknown = { stored: true }) {
  const impl: typeof fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response)
  return vi.fn(impl)
}

/** Parse the WAV header we produced. Enough to validate the fmt chunk. */
function parseWavHeader(buf: ArrayBuffer): {
  riff: string
  wave: string
  fmt: string
  formatTag: number
  channels: number
  sampleRate: number
  byteRate: number
  blockAlign: number
  bitsPerSample: number
  data: string
  dataSize: number
} {
  const v = new DataView(buf)
  const readStr = (o: number, n: number): string => {
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(o + i))
    return s
  }
  return {
    riff: readStr(0, 4),
    wave: readStr(8, 4),
    fmt: readStr(12, 4),
    formatTag: v.getUint16(20, true),
    channels: v.getUint16(22, true),
    sampleRate: v.getUint32(24, true),
    byteRate: v.getUint32(28, true),
    blockAlign: v.getUint16(32, true),
    bitsPerSample: v.getUint16(34, true),
    data: readStr(36, 4),
    dataSize: v.getUint32(40, true),
  }
}

// ── encodePCMToWav — bit-depth variants ────────────────────────────────────

describe('encodePCMToWav — bit depth variants', () => {
  it('16-bit PCM: produces a WAV with wBitsPerSample=16 and format=0x0001', () => {
    const pcm = new Float32Array([0.5, -0.5, 0.25, -0.25])
    const buf = encodePCMToWav(pcm, 48000, 2, 16)
    const h = parseWavHeader(buf)

    expect(h.riff).toBe('RIFF')
    expect(h.wave).toBe('WAVE')
    expect(h.fmt).toBe('fmt ')
    expect(h.data).toBe('data')
    expect(h.formatTag).toBe(0x0001)
    expect(h.bitsPerSample).toBe(16)
    expect(h.byteRate).toBe(48000 * 2 * 2)
    expect(h.blockAlign).toBe(2 * 2)
    expect(h.dataSize).toBe(pcm.length * 2)

    // Round-trip: read back int16 samples, verify within 1/2^15 tolerance.
    const v = new DataView(buf)
    for (let i = 0; i < pcm.length; i++) {
      const q = v.getInt16(44 + i * 2, true)
      const back = q / 32767
      expect(Math.abs(back - pcm[i])).toBeLessThanOrEqual(1 / 32768)
    }
  })

  it('24-bit PCM: produces a WAV with 3 bytes/sample and format=0x0001', () => {
    const pcm = new Float32Array([0.5, -0.5, 0.25, -0.25])
    const buf = encodePCMToWav(pcm, 48000, 2, 24)
    const h = parseWavHeader(buf)

    expect(h.formatTag).toBe(0x0001)
    expect(h.bitsPerSample).toBe(24)
    expect(h.byteRate).toBe(48000 * 2 * 3)
    expect(h.blockAlign).toBe(2 * 3)
    expect(h.dataSize).toBe(pcm.length * 3)
    expect(buf.byteLength).toBe(44 + pcm.length * 3)

    // Byte-level spot check: sample 0 (0.5) should encode to ~0x400000 (4194303.5).
    // Two's-complement 24 LE: lo lo lo hi. For 0.5 → round(0.5 * 8388607) = 4194304 = 0x400000.
    const v = new DataView(buf)
    const b0 = v.getUint8(44)
    const b1 = v.getUint8(45)
    const b2 = v.getUint8(46)
    // 0x400000 packed LE: 00 00 40
    expect(b0).toBe(0x00)
    expect(b1).toBe(0x00)
    expect(b2).toBe(0x40)

    // Sample 1 (-0.5) → Math.round(-0.5 * 8388607) = Math.round(-4194303.5).
    // JS Math.round rounds half-to-+inf, so the result is -4194303 = 0xC00001
    // in two's-complement 24-bit. Packed LE: 01 00 C0.
    const b3 = v.getUint8(47)
    const b4 = v.getUint8(48)
    const b5 = v.getUint8(49)
    expect(b3).toBe(0x01)
    expect(b4).toBe(0x00)
    expect(b5).toBe(0xc0)

    // Round-trip: decode 24-bit int back to float, check within ±1/2^23.
    for (let i = 0; i < pcm.length; i++) {
      const o = 44 + i * 3
      const lo = v.getUint8(o)
      const mid = v.getUint8(o + 1)
      const hi = v.getUint8(o + 2)
      let q = lo | (mid << 8) | (hi << 16)
      if (q & 0x800000) q -= 0x1000000 // sign extend
      const back = q / 8388607
      expect(Math.abs(back - pcm[i])).toBeLessThanOrEqual(1 / 8388608)
    }
  })

  it('32-bit IEEE-float: produces a WAV with format=0x0003 and raw floats', () => {
    const pcm = new Float32Array([0.12345, -0.6789, 0.5, -0.001])
    const buf = encodePCMToWav(pcm, 48000, 2, 32)
    const h = parseWavHeader(buf)

    expect(h.formatTag).toBe(0x0003) // WAVE_FORMAT_IEEE_FLOAT
    expect(h.bitsPerSample).toBe(32)
    expect(h.byteRate).toBe(48000 * 2 * 4)
    expect(h.blockAlign).toBe(2 * 4)
    expect(h.dataSize).toBe(pcm.length * 4)
    expect(buf.byteLength).toBe(44 + pcm.length * 4)

    // Round-trip: exact for float32 (the Float32Array values are already in
    // float32 precision, so no quantization occurs).
    const v = new DataView(buf)
    for (let i = 0; i < pcm.length; i++) {
      const back = v.getFloat32(44 + i * 4, true)
      expect(back).toBe(pcm[i])
    }
  })

  it('mono variants produce half the data size', () => {
    const pcm = new Float32Array([0.1, 0.2, 0.3])
    expect(encodePCMToWav(pcm, 44100, 1, 16).byteLength).toBe(44 + pcm.length * 2)
    expect(encodePCMToWav(pcm, 44100, 1, 24).byteLength).toBe(44 + pcm.length * 3)
    expect(encodePCMToWav(pcm, 44100, 1, 32).byteLength).toBe(44 + pcm.length * 4)
  })

  it('defaults to 16-bit when bitDepth is omitted (backward-compat)', () => {
    const buf = encodePCMToWav(new Float32Array([0.1]), 48000, 1)
    expect(parseWavHeader(buf).bitsPerSample).toBe(16)
  })

  it('rejects unsupported bit depths', () => {
    expect(() => encodePCMToWav(new Float32Array([0]), 48000, 2, 8 as unknown as 16))
      .toThrow(/bitDepth/)
  })

  it('clamps 24-bit PCM at ±full-scale for out-of-range input', () => {
    const pcm = new Float32Array([1.5, -1.5])
    const buf = encodePCMToWav(pcm, 48000, 1, 24)
    const v = new DataView(buf)
    // +1.5 clamps to +1.0 → 0x7FFFFF (8388607) packed LE: FF FF 7F
    expect(v.getUint8(44)).toBe(0xff)
    expect(v.getUint8(45)).toBe(0xff)
    expect(v.getUint8(46)).toBe(0x7f)
    // -1.5 clamps to -1.0 → 0x800001 (-8388607) packed LE: 01 00 80.
    // (Math.round(-1 * 8388607) = -8388607, not -8388608, because we multiply
    // by MAX_INT24 not |MIN_INT24|. This is fine — one LSB off the negative
    // rail, inaudible; matches common libsndfile behavior.)
    expect(v.getUint8(47)).toBe(0x01)
    expect(v.getUint8(48)).toBe(0x00)
    expect(v.getUint8(49)).toBe(0x80)
  })
})

// ── filterTracksForBounce ─────────────────────────────────────────────────

describe('filterTracksForBounce', () => {
  const clipA = makeClip({ id: 'c-a', track_id: 't1' })
  const clipB = makeClip({ id: 'c-b', track_id: 't1' })
  const clipC = makeClip({ id: 'c-c', track_id: 't2' })
  const t1 = makeTrack({ id: 't1', clips: [clipA, clipB] })
  const t2 = makeTrack({ id: 't2', clips: [clipC] })
  const t3 = makeTrack({ id: 't3', clips: [] })

  it('mode=full returns all tracks', () => {
    const msg = makeMsg({ mode: 'full' })
    const out = filterTracksForBounce([t1, t2, t3], msg)
    expect(out.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('mode=tracks filters to the named track ids', () => {
    const msg = makeMsg({ mode: 'tracks', track_ids: ['t1', 't2'] })
    const out = filterTracksForBounce([t1, t2, t3], msg)
    expect(out.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('mode=clips keeps only listed clips and drops empty tracks', () => {
    const msg = makeMsg({ mode: 'clips', clip_ids: ['c-a', 'c-c'] })
    const out = filterTracksForBounce([t1, t2, t3], msg)
    expect(out.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(out[0].clips?.map((c) => c.id)).toEqual(['c-a'])
    expect(out[1].clips?.map((c) => c.id)).toEqual(['c-c'])
  })

  it('mode=clips with no matches returns an empty list', () => {
    const msg = makeMsg({ mode: 'clips', clip_ids: ['nope'] })
    const out = filterTracksForBounce([t1, t2], msg)
    expect(out).toEqual([])
  })
})

// ── handleBounceAudioRequest ──────────────────────────────────────────────

describe('handleBounceAudioRequest', () => {
  it('mode=full passes every track to the renderer', async () => {
    const tracks = [makeTrack({ id: 't1' }), makeTrack({ id: 't2' })]
    const renderImpl = makeMockRenderer()

    await handleBounceAudioRequest({
      msg: makeMsg({ mode: 'full' }),
      projectName: 'p',
      tracks,
      renderImpl,
      encodeImpl: makeMockEncoder(),
      fetchImpl: makeMockFetch(),
    })

    const [renderTracks] = renderImpl.mock.calls[0]
    expect(renderTracks.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('mode=tracks filters to the requested track ids', async () => {
    const tracks = [makeTrack({ id: 't1' }), makeTrack({ id: 't2' }), makeTrack({ id: 't3' })]
    const renderImpl = makeMockRenderer()

    await handleBounceAudioRequest({
      msg: makeMsg({ mode: 'tracks', track_ids: ['t1', 't2'] }),
      projectName: 'p',
      tracks,
      renderImpl,
      encodeImpl: makeMockEncoder(),
      fetchImpl: makeMockFetch(),
    })

    const [renderTracks] = renderImpl.mock.calls[0]
    expect(renderTracks.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('mode=clips filters clips per track and drops empty tracks', async () => {
    const tracks = [
      makeTrack({ id: 't1', clips: [makeClip({ id: 'c1' }), makeClip({ id: 'c2' })] }),
      makeTrack({ id: 't2', clips: [makeClip({ id: 'c3' })] }),
      makeTrack({ id: 't3', clips: [makeClip({ id: 'c4' })] }),
    ]
    const renderImpl = makeMockRenderer()

    await handleBounceAudioRequest({
      msg: makeMsg({ mode: 'clips', clip_ids: ['c1', 'c3'] }),
      projectName: 'p',
      tracks,
      renderImpl,
      encodeImpl: makeMockEncoder(),
      fetchImpl: makeMockFetch(),
    })

    const [renderTracks] = renderImpl.mock.calls[0]
    expect(renderTracks.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(renderTracks[0].clips?.map((c) => c.id)).toEqual(['c1'])
    expect(renderTracks[1].clips?.map((c) => c.id)).toEqual(['c3'])
  })

  it('posts the multipart form with every required field', async () => {
    const msg = makeMsg({ bit_depth: 24 })
    const fetchImpl = makeMockFetch(201)

    await handleBounceAudioRequest({
      msg,
      projectName: 'my-proj',
      tracks: [makeTrack()],
      renderImpl: makeMockRenderer(),
      encodeImpl: makeMockEncoder(),
      fetchImpl,
      apiBase: 'http://api.test',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://api.test/api/projects/my-proj/bounce-upload')
    expect(init?.method).toBe('POST')

    const body = init?.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('composite_hash')).toBe(msg.composite_hash)
    expect(body.get('start_time_s')).toBe(String(msg.start_time_s))
    expect(body.get('end_time_s')).toBe(String(msg.end_time_s))
    expect(body.get('sample_rate')).toBe(String(msg.sample_rate))
    expect(body.get('bit_depth')).toBe('24')
    expect(body.get('channels')).toBe('2')
    expect(body.get('request_id')).toBe(msg.request_id)
    expect(body.get('audio')).toBeInstanceOf(Blob)
  })

  it('passes bit_depth through to the encoder', async () => {
    const encodeImpl = makeMockEncoder()
    await handleBounceAudioRequest({
      msg: makeMsg({ bit_depth: 32 }),
      projectName: 'p',
      tracks: [makeTrack()],
      renderImpl: makeMockRenderer(),
      encodeImpl,
      fetchImpl: makeMockFetch(),
    })
    expect(encodeImpl).toHaveBeenCalledTimes(1)
    const args = encodeImpl.mock.calls[0]
    expect(args[3]).toBe(32)
  })

  it('URL-encodes the project name', async () => {
    const fetchImpl = makeMockFetch()
    await handleBounceAudioRequest({
      msg: makeMsg(),
      projectName: 'my project/slashes',
      tracks: [makeTrack()],
      renderImpl: makeMockRenderer(),
      encodeImpl: makeMockEncoder(),
      fetchImpl,
      apiBase: 'http://api.test',
    })
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://api.test/api/projects/my%20project%2Fslashes/bounce-upload')
  })

  it('fetches tracks via fetchTracksImpl when tracks are omitted', async () => {
    const tracksImpl = async (): Promise<AudioTrack[]> => [makeTrack({ id: 'fresh-1' })]
    const fetchTracksImpl = vi.fn(tracksImpl)
    const renderImpl = makeMockRenderer()

    await handleBounceAudioRequest({
      msg: makeMsg({ mode: 'full' }),
      projectName: 'p',
      renderImpl,
      encodeImpl: makeMockEncoder(),
      fetchImpl: makeMockFetch(),
      fetchTracksImpl,
    })

    expect(fetchTracksImpl).toHaveBeenCalledWith('p')
    const [renderTracks] = renderImpl.mock.calls[0]
    expect(renderTracks.map((t) => t.id)).toEqual(['fresh-1'])
  })

  it('pauses the mixer during render and resumes after upload when isPlaying=true', async () => {
    const calls: string[] = []
    const mixer = {
      pause: () => { calls.push('pause') },
      play: () => { calls.push('play') },
    }
    const renderImpl: typeof renderMixToBuffer = async () => {
      calls.push('render')
      return { pcm: new Float32Array(0), channels: 2, sampleRate: 48000, durationSeconds: 0 } as MixRenderResult
    }
    const encodeImpl: typeof encodePCMToWav = () => { calls.push('encode'); return new ArrayBuffer(0) }
    const fetchImpl: typeof fetch = async () => {
      calls.push('fetch')
      return { ok: true, status: 201, text: async () => '', json: async () => ({}) } as Response
    }

    await handleBounceAudioRequest({
      msg: makeMsg(),
      projectName: 'p',
      tracks: [makeTrack()],
      mixer,
      isPlaying: true,
      renderImpl,
      encodeImpl,
      fetchImpl,
    })

    expect(calls).toEqual(['pause', 'render', 'encode', 'fetch', 'play'])
  })

  it('swallows fetch errors (fire-and-forget) and logs a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = makeMockFetch(500, { error: 'boom' })
    await expect(
      handleBounceAudioRequest({
        msg: makeMsg(),
        projectName: 'p',
        tracks: [makeTrack()],
        renderImpl: makeMockRenderer(),
        encodeImpl: makeMockEncoder(),
        fetchImpl,
      }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('swallows render errors without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const renderImpl: typeof renderMixToBuffer = async () => { throw new Error('render boom') }
    await expect(
      handleBounceAudioRequest({
        msg: makeMsg(),
        projectName: 'p',
        tracks: [makeTrack()],
        renderImpl,
        encodeImpl: makeMockEncoder(),
        fetchImpl: makeMockFetch(),
      }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
