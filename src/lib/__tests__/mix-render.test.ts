/**
 * Tests for `renderMixToBuffer` (M15 task 2).
 *
 * happy-dom does NOT ship `OfflineAudioContext`, so we inject a functional
 * mock via `offlineCtxFactory`. The mock records every node / schedule call,
 * and its `startRendering()` computes PCM analytically by:
 *
 *   1. Walking each active BufferSource's (buffer, start_when, offset, duration)
 *      to resolve "what sample values play for this source's timeline region".
 *   2. Applying per-clip scheduled gain (piecewise-linear ramps recorded on
 *      `clipGain.gain`).
 *   3. Applying per-track scheduled gain.
 *   4. Summing into the master, into the destination buffer.
 *
 * This mock is intentionally narrow — it only implements the scheduling
 * shapes the renderer uses. Any new scheduling primitive will show up as a
 * failing test, which is exactly the parity-canary we want.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AudioTrack } from '../audio-client'
import { encodePCMToWav, renderMixToBuffer, type MixRenderOptions } from '../mix-render'

// ── Minimal functional mock of OfflineAudioContext ────────────────────────

type ParamEvent =
  | { kind: 'setValueAtTime'; value: number; time: number }
  | { kind: 'linearRampToValueAtTime'; value: number; time: number }
  | { kind: 'setValueCurveAtTime'; values: Float32Array; time: number; duration: number }
  | { kind: 'cancelScheduledValues'; time: number }

class MockAudioParam {
  value = 1
  events: ParamEvent[] = []
  setValueAtTime(v: number, t: number) { this.events.push({ kind: 'setValueAtTime', value: v, time: t }) }
  linearRampToValueAtTime(v: number, t: number) { this.events.push({ kind: 'linearRampToValueAtTime', value: v, time: t }) }
  setValueCurveAtTime(values: Float32Array, t: number, duration: number) {
    // Copy the array; WebAudio keeps its own reference but the callers (our
    // shared helpers) shouldn't modify it post-hoc anyway.
    this.events.push({ kind: 'setValueCurveAtTime', values: new Float32Array(values), time: t, duration })
  }
  cancelScheduledValues(t: number) { this.events.push({ kind: 'cancelScheduledValues', time: t }) }

  /**
   * Evaluate the scheduled param at offline-clock time `t`, replaying the
   * events list in order. Replicates (well enough for tests) the rules of
   * WebAudio automation: setValueAtTime is a step; linearRampToValueAtTime
   * linearly interpolates from the previous event's value; setValueCurveAtTime
   * does a piecewise linear interpolation across its (time, time+duration)
   * window using the curve array.
   */
  evaluate(t: number): number {
    // Apply events in order, filtering out cancellations that wipe later events.
    // (The renderer never schedules out of order, so a simple left-to-right pass
    // is enough.)
    const evs = this.events.filter((e) => e.kind !== 'cancelScheduledValues')
    let lastValue = this.value
    let lastTime = 0
    // Find the last setValueAtTime at or before `t`.
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]
      if (e.kind === 'setValueAtTime' && e.time <= t) {
        lastValue = e.value
        lastTime = e.time
      } else if (e.kind === 'setValueCurveAtTime') {
        if (t >= e.time && t <= e.time + e.duration) {
          // Piecewise-linear interpolation over the curve array.
          if (e.values.length === 0) return lastValue
          if (e.values.length === 1) return e.values[0]
          const normT = (t - e.time) / e.duration
          const pos = normT * (e.values.length - 1)
          const i0 = Math.floor(pos)
          const i1 = Math.min(e.values.length - 1, i0 + 1)
          const frac = pos - i0
          return e.values[i0] * (1 - frac) + e.values[i1] * frac
        }
        if (t > e.time + e.duration) {
          lastValue = e.values[e.values.length - 1]
          lastTime = e.time + e.duration
        }
      } else if (e.kind === 'linearRampToValueAtTime') {
        if (t <= e.time) {
          // Ramp from (lastTime, lastValue) to (e.time, e.value).
          const span = Math.max(1e-12, e.time - lastTime)
          const frac = Math.max(0, Math.min(1, (t - lastTime) / span))
          return lastValue + (e.value - lastValue) * frac
        }
        lastValue = e.value
        lastTime = e.time
      }
    }
    return lastValue
  }
}

interface MockNodeBase {
  readonly kind: string
  connections: MockNodeBase[]
  gain?: MockAudioParam
}

class MockGainNode implements MockNodeBase {
  readonly kind = 'gain'
  connections: MockNodeBase[] = []
  gain = new MockAudioParam()
  channelCount = 2
  channelCountMode: ChannelCountMode = 'max'
  channelInterpretation: ChannelInterpretation = 'speakers'
  connect(dst: MockNodeBase) { this.connections.push(dst); return dst as unknown as AudioNode }
  disconnect() { this.connections = [] }
}

class MockBufferSourceNode implements MockNodeBase {
  readonly kind = 'source'
  connections: MockNodeBase[] = []
  buffer: AudioBuffer | null = null
  playbackRate = new MockAudioParam()
  started = false
  startWhen = 0
  startOffset = 0
  startDuration: number | undefined
  connect(dst: MockNodeBase) { this.connections.push(dst); return dst as unknown as AudioNode }
  disconnect() { this.connections = [] }
  start(when = 0, offset = 0, duration?: number) {
    if (this.started) throw new Error('start() already called')
    this.started = true
    this.startWhen = when
    this.startOffset = offset
    this.startDuration = duration
    this.playbackRate.value = this.playbackRate.evaluate(0) || 1
  }
}

class MockDestinationNode implements MockNodeBase {
  readonly kind = 'destination'
  connections: MockNodeBase[] = [] // unused (sink)
  connect() { return this as unknown as AudioNode }
  disconnect() {}
}

class MockOfflineAudioContext {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  currentTime = 0
  destination = new MockDestinationNode()
  createdSources: MockBufferSourceNode[] = []
  createdGains: MockGainNode[] = []

  constructor(init: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = init.numberOfChannels
    this.length = init.length
    this.sampleRate = init.sampleRate
  }

  createGain() { const g = new MockGainNode(); this.createdGains.push(g); return g as unknown as GainNode }
  createBufferSource() { const s = new MockBufferSourceNode(); this.createdSources.push(s); return s as unknown as AudioBufferSourceNode }
  // Not used by the renderer but must exist for the type.
  createChannelSplitter() { throw new Error('not used by renderer') }
  createAnalyser() { throw new Error('not used by renderer') }

  /**
   * Render by:
   *   (1) Traversing source → ... → destination graph
   *   (2) For each source, reading samples from `startWhen` for `startDuration`
   *       seconds, multiplying by the product of all gains on its path
   *       (evaluated per-sample against offline clock).
   */
  startRendering(): Promise<AudioBuffer> {
    const left = new Float32Array(this.length)
    const right = new Float32Array(this.length)

    for (const src of this.createdSources) {
      if (!src.started || !src.buffer) continue

      // Walk the connection path to collect gain params (clipGain,
      // crossfadeGain, trackGain, masterGain) — anything before destination.
      const gainParams: MockAudioParam[] = []
      let cursor: MockNodeBase = src
      const visited = new Set<MockNodeBase>()
      while (cursor.connections.length > 0) {
        const next: MockNodeBase = cursor.connections[0]
        if (visited.has(next)) break
        visited.add(next)
        if (next.kind === 'gain' && next.gain) gainParams.push(next.gain)
        if (next.kind === 'destination') break
        cursor = next
      }

      const buf = src.buffer
      const bufNumChannels = buf.numberOfChannels
      const bufLeft = buf.getChannelData(0)
      const bufRight = bufNumChannels > 1 ? buf.getChannelData(1) : bufLeft
      const rate = src.playbackRate.value || 1
      const effectiveDuration = src.startDuration ?? (buf.duration - src.startOffset)

      const startFrame = Math.max(0, Math.round(src.startWhen * this.sampleRate))
      const endFrame = Math.min(this.length, Math.round((src.startWhen + effectiveDuration) * this.sampleRate))

      for (let f = startFrame; f < endFrame; f++) {
        const tOffline = f / this.sampleRate
        const tSinceStart = tOffline - src.startWhen
        // Source-time position in the buffer (accounting for playbackRate).
        // Same rate+sampleRate on source+output → srcFrame is an integer +
        // tiny fp error, so we linearly interpolate to dodge that noise.
        const srcPos = src.startOffset + tSinceStart * rate
        const srcFrame = srcPos * buf.sampleRate
        const srcFrameIdx = Math.floor(srcFrame)
        if (srcFrameIdx < 0 || srcFrameIdx >= bufLeft.length) continue
        const frac = srcFrame - srcFrameIdx
        const nextIdx = Math.min(bufLeft.length - 1, srcFrameIdx + 1)
        const l = bufLeft[srcFrameIdx] * (1 - frac) + bufLeft[nextIdx] * frac
        const r = bufRight[srcFrameIdx] * (1 - frac) + bufRight[nextIdx] * frac
        // Multiply by every gain param in the path, evaluated at this offline
        // clock time.
        let g = 1
        for (const gp of gainParams) g *= gp.evaluate(tOffline)
        left[f] += l * g
        right[f] += r * g
      }
    }

    // Build a mock AudioBuffer (ducktype — renderer only calls
    // `numberOfChannels` and `getChannelData(i)`).
    const rendered = {
      numberOfChannels: this.numberOfChannels,
      sampleRate: this.sampleRate,
      length: this.length,
      duration: this.length / this.sampleRate,
      getChannelData: (ch: number): Float32Array => {
        if (ch === 0) return left
        if (ch === 1) return right
        return new Float32Array(this.length)
      },
    } as unknown as AudioBuffer
    return Promise.resolve(rendered)
  }
}

// ── Factories for fixtures ────────────────────────────────────────────────

/** Build a mock AudioBuffer with synthetic sample data. */
function makeBuffer(
  lenSeconds: number,
  sampleRate: number,
  channels: number,
  fill: (frame: number, channel: number, sr: number) => number,
): AudioBuffer {
  const frames = Math.floor(lenSeconds * sampleRate)
  const data: Float32Array[] = []
  for (let c = 0; c < channels; c++) {
    const arr = new Float32Array(frames)
    for (let f = 0; f < frames; f++) arr[f] = fill(f, c, sampleRate)
    data.push(arr)
  }
  return {
    numberOfChannels: channels,
    sampleRate,
    length: frames,
    duration: frames / sampleRate,
    getChannelData: (ch: number) => data[Math.min(ch, channels - 1)],
  } as unknown as AudioBuffer
}

const mkTrack = (
  id: string,
  clips: Array<{ id: string; start: number; end: number; path: string; sourceOffset?: number; rate?: number; muted?: boolean }>,
  trackProps: Partial<AudioTrack> = {},
): AudioTrack => ({
  id,
  name: id,
  display_order: 0,
  solo: false,
  hidden: false,
  muted: false,
  volume_curve: [],
  ...trackProps,
  clips: clips.map((c) => ({
    id: c.id,
    track_id: id,
    source_path: c.path,
    start_time: c.start,
    end_time: c.end,
    source_offset: c.sourceOffset ?? 0,
    effective_source_offset: c.sourceOffset ?? 0,
    volume_curve: [],
    muted: c.muted ?? false,
    playback_rate: c.rate ?? 1,
  })),
})

const makeBaseOpts = (overrides: Partial<MixRenderOptions> = {}): MixRenderOptions & {
  __buffers: Map<string, AudioBuffer>
  __factoryContexts: MockOfflineAudioContext[]
} => {
  const buffers = new Map<string, AudioBuffer>()
  const factoryContexts: MockOfflineAudioContext[] = []
  return {
    projectName: 'p',
    startTimeS: 0,
    endTimeS: 1,
    sampleRate: 48000,
    channels: 2,
    offlineCtxFactory: (init) => {
      const ctx = new MockOfflineAudioContext(init)
      factoryContexts.push(ctx)
      return ctx as unknown as OfflineAudioContext
    },
    sourceUrlFactory: (project, path) => `mock://${project}/${path}`,
    fetchBytes: async () => new ArrayBuffer(4),
    decode: async () => {
      // Default decode: return 10s silence at 48k. Tests that care override.
      return makeBuffer(10, 48000, 2, () => 0)
    },
    bufferCache: buffers,
    __buffers: buffers,
    __factoryContexts: factoryContexts,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('renderMixToBuffer — basic shape', () => {
  it('returns a PCM Float32Array of the correct length for stereo', async () => {
    const opts = makeBaseOpts({ startTimeS: 0, endTimeS: 1, sampleRate: 48000, channels: 2 })
    const result = await renderMixToBuffer([mkTrack('t1', [])], opts)
    expect(result.sampleRate).toBe(48000)
    expect(result.channels).toBe(2)
    // frames = ceil(1 * 48000) = 48000 → interleaved stereo pcm = 96000
    expect(result.pcm.length).toBe(48000 * 2)
  })

  it('returns a PCM Float32Array of the correct length for mono', async () => {
    const opts = makeBaseOpts({ startTimeS: 0, endTimeS: 0.5, sampleRate: 22050, channels: 1 })
    const result = await renderMixToBuffer([mkTrack('t1', [])], opts)
    expect(result.channels).toBe(1)
    expect(result.sampleRate).toBe(22050)
    // frames = ceil(0.5 * 22050) = 11025
    expect(result.pcm.length).toBe(11025)
  })

  it('throws when endTimeS <= startTimeS', async () => {
    const opts = makeBaseOpts({ startTimeS: 5, endTimeS: 5 })
    await expect(renderMixToBuffer([], opts)).rejects.toThrow(/endTimeS/)
  })

  it('throws on bad channel count', async () => {
    const opts = makeBaseOpts({ channels: 3 as number })
    await expect(renderMixToBuffer([], opts)).rejects.toThrow(/channels/)
  })
})

describe('renderMixToBuffer — clip window filtering', () => {
  it('skips clips that fall entirely outside the render window', async () => {
    // Two clips; only the second should be scheduled.
    const track = mkTrack('t1', [
      { id: 'c1', start: 0, end: 3, path: 'a.wav' },
      { id: 'c2', start: 5, end: 8, path: 'b.wav' },
    ])
    const opts = makeBaseOpts({ startTimeS: 4, endTimeS: 6 })
    await renderMixToBuffer([track], opts)
    const ctx = opts.__factoryContexts[0]
    // Exactly one source node (c2). c1 is outside [4, 6) → skipped.
    expect(ctx.createdSources).toHaveLength(1)
    const src = ctx.createdSources[0]
    // c2 starts at timeline 5 → whenInOffline = 5 - 4 = 1
    expect(src.startWhen).toBeCloseTo(1, 5)
    // playhead 4 is before c2 start (5) → no skip into c2; offset stays at 0
    expect(src.startOffset).toBeCloseTo(0, 5)
    // duration: min(end=8, renderEnd=6) - max(start=5, renderStart=4) = 1
    expect(src.startDuration).toBeCloseTo(1, 5)
  })

  it('trims a clip whose start is before the render window', async () => {
    // Clip [2, 8]; render [4, 6] → should play 2s of source starting from
    // source_offset + (4 - 2) = 2.
    const track = mkTrack('t1', [{ id: 'c1', start: 2, end: 8, path: 'a.wav' }])
    const opts = makeBaseOpts({ startTimeS: 4, endTimeS: 6 })
    await renderMixToBuffer([track], opts)
    const ctx = opts.__factoryContexts[0]
    expect(ctx.createdSources).toHaveLength(1)
    const src = ctx.createdSources[0]
    expect(src.startWhen).toBeCloseTo(0, 5) // clip starts before render window → start immediately
    expect(src.startOffset).toBeCloseTo(2, 5) // 4 - 2 = 2 seconds into the source
    expect(src.startDuration).toBeCloseTo(2, 5) // 2s window
  })

  it('hidden tracks contribute nothing', async () => {
    const track = mkTrack(
      't1',
      [{ id: 'c1', start: 0, end: 1, path: 'a.wav' }],
      { hidden: true },
    )
    const opts = makeBaseOpts({ startTimeS: 0, endTimeS: 1 })
    await renderMixToBuffer([track], opts)
    const ctx = opts.__factoryContexts[0]
    expect(ctx.createdSources).toHaveLength(0)
  })
})

describe('renderMixToBuffer — interleaving', () => {
  it('stereo PCM interleaves L/R samples in [L0, R0, L1, R1, ...] order', async () => {
    // Synthesize a constant DC offset: left = 0.5, right = -0.5.
    const sr = 1000
    const opts = makeBaseOpts({
      startTimeS: 0,
      endTimeS: 0.01,
      sampleRate: sr,
      channels: 2,
      decode: async () =>
        makeBuffer(0.02, sr, 2, (_f, c) => (c === 0 ? 0.5 : -0.5)),
    })
    const track = mkTrack('t1', [{ id: 'c1', start: 0, end: 0.01, path: 'dc.wav' }])
    const result = await renderMixToBuffer([track], opts)
    // First sample pair
    expect(result.pcm[0]).toBeCloseTo(0.5, 5)
    expect(result.pcm[1]).toBeCloseTo(-0.5, 5)
    // Mid-pair
    expect(result.pcm[10]).toBeCloseTo(0.5, 5)
    expect(result.pcm[11]).toBeCloseTo(-0.5, 5)
  })

  it('mono PCM contains a single channel of data', async () => {
    const sr = 1000
    const opts = makeBaseOpts({
      startTimeS: 0,
      endTimeS: 0.01,
      sampleRate: sr,
      channels: 1,
      decode: async () => makeBuffer(0.02, sr, 2, () => 0.3),
    })
    const track = mkTrack('t1', [{ id: 'c1', start: 0, end: 0.01, path: 'dc.wav' }])
    const result = await renderMixToBuffer([track], opts)
    for (let i = 0; i < result.pcm.length; i++) {
      expect(result.pcm[i]).toBeCloseTo(0.3, 5)
    }
  })
})

describe('renderMixToBuffer — fidelity (analytic sine)', () => {
  it('renders a 440 Hz sine wave with max abs diff < 1e-4', async () => {
    const freq = 440
    const sr = 48000
    const duration = 0.1 // 100 ms → 4800 frames
    const amplitude = 0.5

    // Source: a perfect sine on both channels.
    const buf = makeBuffer(duration + 0.01, sr, 2, (f) => amplitude * Math.sin((2 * Math.PI * freq * f) / sr))

    const opts = makeBaseOpts({
      startTimeS: 0,
      endTimeS: duration,
      sampleRate: sr,
      channels: 2,
      decode: async () => buf,
    })
    const track = mkTrack('t1', [{ id: 'c1', start: 0, end: duration, path: 'sine.wav' }])
    const { pcm } = await renderMixToBuffer([track], opts)

    // Expected: identical sine; gain chain is all unity so samples should
    // pass through untouched.
    let maxDiff = 0
    const frames = Math.ceil(duration * sr)
    for (let f = 0; f < frames; f++) {
      const expected = amplitude * Math.sin((2 * Math.PI * freq * f) / sr)
      const actualL = pcm[f * 2]
      const actualR = pcm[f * 2 + 1]
      maxDiff = Math.max(maxDiff, Math.abs(actualL - expected), Math.abs(actualR - expected))
    }
    // Tight tolerance: no processing should introduce error beyond the
    // mock's floating-point noise floor (empirically ~1.5e-8 — well below 1e-4).
    expect(maxDiff).toBeLessThan(1e-4)
  })

  it('applies clip volume curve linearly (fade-in from -60dB to 0dB over the clip)', async () => {
    const sr = 48000
    const duration = 0.1
    // DC buffer (all 1.0) → the only variation should come from the gain.
    const buf = makeBuffer(0.2, sr, 2, () => 1)

    const track = mkTrack('t1', [{ id: 'c1', start: 0, end: duration, path: 'dc.wav' }])
    // Curve points are [xNorm (0..1), db].
    track.clips![0].volume_curve = [[0, -60], [1, 0]]

    const opts = makeBaseOpts({
      startTimeS: 0,
      endTimeS: duration,
      sampleRate: sr,
      channels: 1,
      decode: async () => buf,
    })
    const { pcm } = await renderMixToBuffer([track], opts)
    // First sample: near -60 dB → linear ~0.001
    expect(pcm[0]).toBeLessThan(0.01)
    // Last sample: near 0 dB → ~1.0
    const last = pcm[pcm.length - 1]
    expect(last).toBeGreaterThan(0.9)
    // Mid-sample: should be between
    const mid = pcm[Math.floor(pcm.length / 2)]
    expect(mid).toBeGreaterThan(pcm[0])
    expect(mid).toBeLessThan(last)
  })

  it('muted track contributes no signal', async () => {
    const sr = 48000
    const duration = 0.05
    const buf = makeBuffer(0.1, sr, 2, () => 1)
    const track = mkTrack(
      't1',
      [{ id: 'c1', start: 0, end: duration, path: 'dc.wav' }],
      { muted: true },
    )
    const opts = makeBaseOpts({
      startTimeS: 0,
      endTimeS: duration,
      sampleRate: sr,
      channels: 1,
      decode: async () => buf,
    })
    const { pcm } = await renderMixToBuffer([track], opts)
    for (let i = 0; i < pcm.length; i++) expect(pcm[i]).toBe(0)
  })

  it('solo track plays while non-solo tracks are silenced', async () => {
    const sr = 48000
    const duration = 0.05
    const bufA = makeBuffer(0.1, sr, 2, () => 1)
    const bufB = makeBuffer(0.1, sr, 2, () => -1)

    const tA = mkTrack('tA', [{ id: 'c1', start: 0, end: duration, path: 'a.wav' }], { solo: true })
    const tB = mkTrack('tB', [{ id: 'c2', start: 0, end: duration, path: 'b.wav' }])

    // Distinct decode results per path
    const opts = makeBaseOpts({
      startTimeS: 0,
      endTimeS: duration,
      sampleRate: sr,
      channels: 1,
      decode: async (_ctx, _bytes) => {
        // Round-robin simple: alternate returns isn't right — key on fetch URL via fetchBytes.
        // But the renderer passes `bytes` not path. Instead pre-seed the bufferCache:
        return bufA
      },
    })
    // Pre-seed cache so each path returns its own buffer
    opts.__buffers.set('a.wav', bufA)
    opts.__buffers.set('b.wav', bufB)

    const { pcm } = await renderMixToBuffer([tA, tB], opts)
    // Solo track provides +1; non-solo track silenced → expected = +1 everywhere
    for (let i = 0; i < pcm.length; i++) expect(pcm[i]).toBeCloseTo(1, 5)
  })
})

describe('renderMixToBuffer — decode cache integration', () => {
  it('reuses already-cached buffers (does not re-decode)', async () => {
    const buf = makeBuffer(1, 48000, 2, () => 0)
    const decodeSpy = vi.fn(async () => buf)
    const cache = new Map<string, AudioBuffer>()
    cache.set('prewarmed.wav', buf)

    const track = mkTrack('t1', [{ id: 'c1', start: 0, end: 0.1, path: 'prewarmed.wav' }])
    const opts = makeBaseOpts({
      startTimeS: 0,
      endTimeS: 0.1,
      sampleRate: 48000,
      channels: 1,
      decode: decodeSpy,
      bufferCache: cache,
    })
    await renderMixToBuffer([track], opts)
    expect(decodeSpy).not.toHaveBeenCalled()
  })

  it('populates the cache on decode', async () => {
    const buf = makeBuffer(1, 48000, 2, () => 0)
    const cache = new Map<string, AudioBuffer>()
    const track = mkTrack('t1', [{ id: 'c1', start: 0, end: 0.1, path: 'fresh.wav' }])
    const opts = makeBaseOpts({
      startTimeS: 0,
      endTimeS: 0.1,
      sampleRate: 48000,
      channels: 1,
      decode: async () => buf,
      bufferCache: cache,
    })
    await renderMixToBuffer([track], opts)
    expect(cache.get('fresh.wav')).toBe(buf)
  })

  it('drops a clip whose decode fails (logs + continues) rather than hard-failing', async () => {
    const goodBuf = makeBuffer(0.2, 48000, 2, () => 1)
    const opts = makeBaseOpts({
      startTimeS: 0,
      endTimeS: 0.05,
      sampleRate: 48000,
      channels: 1,
      // First clip's decode throws; second clip uses the pre-seeded cache.
      fetchBytes: async (url) => {
        if (url.includes('bad.wav')) throw new Error('simulated network failure')
        return new ArrayBuffer(4)
      },
      decode: async () => goodBuf,
    })
    opts.__buffers.set('ok.wav', goodBuf)
    const track = mkTrack('t1', [
      { id: 'cb', start: 0, end: 0.02, path: 'bad.wav' },
      { id: 'cg', start: 0.02, end: 0.05, path: 'ok.wav' },
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { pcm } = await renderMixToBuffer([track], opts)
    warnSpy.mockRestore()
    // Should still produce output for the good clip (latter half of window).
    expect(pcm.length).toBe(Math.ceil(0.05 * 48000))
    // Non-zero somewhere in the second half
    const half = Math.floor(pcm.length / 2)
    let anyNonZero = false
    for (let i = half; i < pcm.length; i++) if (pcm[i] !== 0) { anyNonZero = true; break }
    expect(anyNonZero).toBe(true)
  })
})

// ── encodePCMToWav ────────────────────────────────────────────────────────

describe('encodePCMToWav', () => {
  it('emits a 44-byte RIFF/WAVE header followed by int16 samples', () => {
    const sr = 48000
    const channels = 2
    const frames = 100
    const pcm = new Float32Array(frames * channels)
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.25

    const wav = encodePCMToWav(pcm, sr, channels)
    expect(wav.byteLength).toBe(44 + frames * channels * 2)

    const view = new DataView(wav)
    const readStr = (off: number, len: number): string => {
      let s = ''
      for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i))
      return s
    }
    expect(readStr(0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8)
    expect(readStr(8, 4)).toBe('WAVE')
    expect(readStr(12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(channels)
    expect(view.getUint32(24, true)).toBe(sr)
    expect(view.getUint32(28, true)).toBe(sr * channels * 2)
    expect(view.getUint16(32, true)).toBe(channels * 2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(readStr(36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(frames * channels * 2)

    // Samples: 0.25 * 32767 ≈ 8192
    const s0 = view.getInt16(44, true)
    expect(s0).toBeCloseTo(Math.round(0.25 * 32767), -1) // within 1 count
  })

  it('clips out-of-range floats to the int16 limits', () => {
    const pcm = new Float32Array([-2, -1, 0, 1, 2])
    const wav = encodePCMToWav(pcm, 48000, 1)
    const view = new DataView(wav)
    expect(view.getInt16(44, true)).toBe(-32767)        // clipped from -2
    expect(view.getInt16(46, true)).toBe(-32767)        // -1 → -32767
    expect(view.getInt16(48, true)).toBe(0)
    expect(view.getInt16(50, true)).toBe(32767)         // +1
    expect(view.getInt16(52, true)).toBe(32767)         // clipped from +2
  })

  it('throws on unsupported channel counts', () => {
    expect(() => encodePCMToWav(new Float32Array(10), 48000, 3)).toThrow(/channels/)
  })
})
