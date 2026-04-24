import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAudioMixer, type AudioMixerOptions, __clearDecodeCacheForTest } from '../audio-mixer'
import type { AudioTrack } from '../audio-client'

// ── Minimal WebAudio mocks for the AudioBufferSourceNode path (M15 task 1) ──

type MockParamEvent = { kind: 'setValueAtTime' | 'linearRampToValueAtTime' | 'setValueCurveAtTime' | 'cancelScheduledValues'; value?: number; time: number; values?: Float32Array; duration?: number }

class MockAudioParam {
  value = 1
  events: MockParamEvent[] = []
  setValueAtTime(v: number, t: number) { this.value = v; this.events.push({ kind: 'setValueAtTime', value: v, time: t }) }
  linearRampToValueAtTime(v: number, t: number) { this.value = v; this.events.push({ kind: 'linearRampToValueAtTime', value: v, time: t }) }
  setValueCurveAtTime(values: Float32Array, t: number, duration: number) { this.events.push({ kind: 'setValueCurveAtTime', time: t, values, duration }) }
  cancelScheduledValues(t: number) { this.events.push({ kind: 'cancelScheduledValues', time: t }) }
}

class MockGainNode {
  gain = new MockAudioParam()
  connections: unknown[] = []
  channelCount = 2
  channelCountMode = 'max'
  channelInterpretation = 'speakers'
  connect(dst: unknown) { this.connections.push(dst); return dst as MockGainNode }
  disconnect() { this.connections.length = 0 }
}

class MockAudioBuffer {
  duration: number
  numberOfChannels = 2
  sampleRate = 48000
  constructor(duration = 600) { this.duration = duration }
}

class MockAudioBufferSourceNode {
  buffer: MockAudioBuffer | null = null
  playbackRate = new MockAudioParam()
  detune = new MockAudioParam()
  startCalls: Array<{ when: number; offset?: number; duration?: number }> = []
  stopCalls: number[] = []
  connections: unknown[] = []
  started = false
  stopped = false
  start(when = 0, offset?: number, duration?: number) {
    if (this.started) throw new Error('start already called')
    this.started = true
    this.startCalls.push({ when, offset, duration })
  }
  stop(when?: number) {
    if (!this.started) throw new Error('cannot stop before start')
    this.stopped = true
    this.stopCalls.push(when ?? 0)
  }
  connect(dst: unknown) { this.connections.push(dst); return dst as MockAudioBufferSourceNode }
  disconnect() { this.connections.length = 0 }
}

class MockAnalyserNode {
  fftSize = 2048
  smoothingTimeConstant = 0
  connections: unknown[] = []
  connect(dst: unknown) { this.connections.push(dst); return dst as MockAnalyserNode }
  disconnect() { this.connections.length = 0 }
  getFloatTimeDomainData(_arr: Float32Array) { /* no-op */ }
}

class MockChannelSplitterNode {
  connections: unknown[] = []
  connect(dst: unknown, _output?: number) { this.connections.push(dst); return dst as MockChannelSplitterNode }
  disconnect() { this.connections.length = 0 }
}

class MockAudioContext {
  currentTime = 0
  state: 'running' | 'suspended' | 'closed' = 'running'
  destination = new MockGainNode()
  createdBufferSources: MockAudioBufferSourceNode[] = []
  createGain() { return new MockGainNode() }
  createAnalyser() { return new MockAnalyserNode() }
  createChannelSplitter(_n?: number) { return new MockChannelSplitterNode() }
  createBufferSource() {
    const s = new MockAudioBufferSourceNode()
    this.createdBufferSources.push(s)
    return s
  }
  async decodeAudioData(_ab: ArrayBuffer): Promise<AudioBuffer> {
    return new MockAudioBuffer(600) as unknown as AudioBuffer
  }
  resume() { this.state = 'running'; return Promise.resolve() }
  close() { this.state = 'closed'; return Promise.resolve() }
}

const makeOptions = (): AudioMixerOptions & { mockCtx: MockAudioContext } => {
  const mockCtx = new MockAudioContext()
  return {
    mockCtx,
    audioCtxFactory: () => mockCtx as unknown as AudioContext,
    sourceUrlFactory: (project, path) => `mock://${project}/${path}`,
    fetchBytes: async () => new ArrayBuffer(4),
    // Resolve synchronously to the same mock buffer per path — keeps tests
    // ordered and deterministic (avoids microtask interleaving).
    decode: async () => new MockAudioBuffer(600) as unknown as AudioBuffer,
  }
}

/** Wait for all pending microtasks so decode promises have a chance to
 *  resolve and activation callbacks can fire. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const t = (id: string, clips: Array<{ id: string; start: number; end: number; muted?: boolean }> = [], trackProps: Partial<AudioTrack> = {}): AudioTrack => ({
  id,
  name: id,
  display_order: 0,
  solo: false,
  hidden: false,
  muted: false,
  volume_curve: [[0, 0], [1, 0]],
  ...trackProps,
  clips: clips.map((c) => ({
    id: c.id,
    track_id: id,
    source_path: `audio_staging/${c.id}.m4a`,
    start_time: c.start,
    end_time: c.end,
    source_offset: 0,
    volume_curve: [[0, 0], [1, 0]],
    muted: c.muted ?? false,
    remap: { method: 'linear', target_duration: 0 },
  })),
})

// ── Tests ─────────────────────────────────────────────────────────────

describe('createAudioMixer — API surface', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { __clearDecodeCacheForTest(); opts = makeOptions() })

  it('returns an object with the full public API', () => {
    const m = createAudioMixer('p', [], opts)
    expect(typeof m.play).toBe('function')
    expect(typeof m.pause).toBe('function')
    expect(typeof m.seek).toBe('function')
    expect(typeof m.updateClip).toBe('function')
    expect(typeof m.updateTrack).toBe('function')
    expect(typeof m.rebuild).toBe('function')
    expect(typeof m.dispose).toBe('function')
    expect(typeof m.getTrackAnalysers).toBe('function')
    expect(typeof m.getMasterAnalysers).toBe('function')
  })

  it('trackCount reflects input', () => {
    expect(createAudioMixer('p', [], opts).trackCount).toBe(0)
    expect(createAudioMixer('p', [t('a')], opts).trackCount).toBe(1)
    expect(createAudioMixer('p', [t('a'), t('b')], opts).trackCount).toBe(2)
  })

  it('rebuild updates trackCount', () => {
    const m = createAudioMixer('p', [t('a')], opts)
    expect(m.trackCount).toBe(1)
    m.rebuild([t('a'), t('b'), t('c')])
    expect(m.trackCount).toBe(3)
  })
})

describe('createAudioMixer — lazy graph construction', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { __clearDecodeCacheForTest(); opts = makeOptions() })

  it('does not create AudioContext on construction', () => {
    const spy = vi.fn(() => opts.mockCtx as unknown as AudioContext)
    createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], { ...opts, audioCtxFactory: spy })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not create BufferSources on construction', () => {
    createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    expect(opts.mockCtx.createdBufferSources).toHaveLength(0)
  })

  it('creates AudioContext + buffer sources on first play() after decode resolves', async () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.seek(0.5)
    m.play()
    await flush()
    expect(opts.mockCtx.createdBufferSources).toHaveLength(1)
  })
})

describe('createAudioMixer — decode cache', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { __clearDecodeCacheForTest(); opts = makeOptions() })

  it('adding a clip resolves to a decoded buffer and assigns it to the source', async () => {
    const decodeSpy = vi.fn(async () => new MockAudioBuffer(600) as unknown as AudioBuffer)
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], { ...opts, decode: decodeSpy })
    m.seek(0.5)
    m.play()
    await flush()
    expect(decodeSpy).toHaveBeenCalledTimes(1)
    const src = opts.mockCtx.createdBufferSources[0]
    expect(src.buffer).not.toBeNull()
  })

  it('re-using the same source_path does not re-decode (cache hit)', async () => {
    const decodeSpy = vi.fn(async () => new MockAudioBuffer(600) as unknown as AudioBuffer)
    // Two clips on the same source file → first decodes, second hits cache.
    const track: AudioTrack = {
      id: 'a', name: 'a', display_order: 0, solo: false, hidden: false, muted: false,
      volume_curve: [[0, 0], [1, 0]],
      clips: [
        { id: 'c1', track_id: 'a', source_path: 'shared.m4a', start_time: 0, end_time: 1, source_offset: 0, volume_curve: [[0, 0], [1, 0]], muted: false },
        { id: 'c2', track_id: 'a', source_path: 'shared.m4a', start_time: 2, end_time: 3, source_offset: 0, volume_curve: [[0, 0], [1, 0]], muted: false },
      ],
    }
    const m = createAudioMixer('p', [track], { ...opts, decode: decodeSpy })
    m.play()
    await flush()
    expect(decodeSpy).toHaveBeenCalledTimes(1)
    // Force activation of c2 by seeking — still shouldn't decode twice.
    m.seek(2.5)
    await flush()
    expect(decodeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('createAudioMixer — scheduling at AudioContext time', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { __clearDecodeCacheForTest(); opts = makeOptions() })

  it('start() schedules at the computed AudioContext time (playhead at clip start → when=currentTime)', async () => {
    opts.mockCtx.currentTime = 10 // arbitrary non-zero
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 5, end: 10 }])], opts)
    m.seek(5)
    m.play()
    await flush()
    const src = opts.mockCtx.createdBufferSources[0]
    expect(src.startCalls).toHaveLength(1)
    // playhead is at clip start → when = currentTime + 0
    expect(src.startCalls[0].when).toBeCloseTo(10, 3)
    // offset = source_offset + (playhead - start) * rate = 0
    expect(src.startCalls[0].offset).toBeCloseTo(0, 3)
  })

  it('start() offset reflects mid-clip seek (source_offset + (playhead - start) * rate)', async () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 10, end: 20 }])], opts)
    m.seek(12)
    m.play()
    await flush()
    const src = opts.mockCtx.createdBufferSources[0]
    expect(src.startCalls[0].offset).toBeCloseTo(2, 3)
  })

  it('linked clip at 2× rate sets playbackRate and scales offset', async () => {
    const track: AudioTrack = {
      id: 'a', name: 'a', display_order: 0, hidden: false, muted: false, solo: false,
      volume_curve: [[0, 0], [1, 0]],
      clips: [{
        id: 'c1', track_id: 'a',
        source_path: 'audio_staging/c1.m4a',
        start_time: 10, end_time: 15, source_offset: 0,
        volume_curve: [[0, 0], [1, 0]], muted: false,
        playback_rate: 2, effective_source_offset: 2,
      }],
    }
    const m = createAudioMixer('p', [track], opts)
    m.seek(12.5)
    m.play()
    await flush()
    const src = opts.mockCtx.createdBufferSources[0]
    expect(src.playbackRate.value).toBe(2)
    // offset = effOffset(2) + (12.5 - 10) * 2 = 7
    expect(src.startCalls[0].offset).toBeCloseTo(7, 3)
  })
})

describe('createAudioMixer — activation by playhead', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { __clearDecodeCacheForTest(); opts = makeOptions() })

  it('seek before play stores position without activating', () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.seek(0.5)
    expect(opts.mockCtx.createdBufferSources).toHaveLength(0)
  })

  it('play activates clips whose range contains the current playhead', async () => {
    const m = createAudioMixer('p', [t('a', [
      { id: 'inside', start: 0, end: 1 },
      { id: 'outside', start: 2, end: 3 },
    ])], opts)
    m.seek(0.5)
    m.play()
    await flush()
    // Only the "inside" clip should have a source node started.
    const started = opts.mockCtx.createdBufferSources.filter((s) => s.started)
    expect(started).toHaveLength(1)
  })

  it('seek forward tears down previous source and builds a new one for newly-covered clip', async () => {
    const m = createAudioMixer('p', [t('a', [
      { id: 'c1', start: 0, end: 1 },
      { id: 'c2', start: 2, end: 3 },
    ])], opts)
    m.seek(0.5)
    m.play()
    await flush()
    const [s1] = opts.mockCtx.createdBufferSources
    expect(s1.started).toBe(true)
    m.seek(2.5)
    await flush()
    // s1 should have been stopped
    expect(s1.stopped).toBe(true)
    // A new source for c2
    const c2Sources = opts.mockCtx.createdBufferSources.filter((s) => s !== s1)
    expect(c2Sources.some((s) => s.started)).toBe(true)
  })

  it('seek within active clip rebuilds the source at the new offset (hard seek)', async () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 10 }])], opts)
    m.seek(1)
    m.play()
    await flush()
    const first = opts.mockCtx.createdBufferSources[0]
    expect(first.startCalls[0].offset).toBeCloseTo(1, 3)
    // Jump to 5 — large gap triggers hardSeek → new source with offset 5
    m.seek(5)
    await flush()
    expect(first.stopped).toBe(true)
    const second = opts.mockCtx.createdBufferSources[opts.mockCtx.createdBufferSources.length - 1]
    expect(second).not.toBe(first)
    expect(second.startCalls[0].offset).toBeCloseTo(5, 3)
  })

  it('pause() stops active sources', async () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.seek(0.5)
    m.play()
    await flush()
    const src = opts.mockCtx.createdBufferSources[0]
    expect(src.started).toBe(true)
    m.pause()
    expect(src.stopped).toBe(true)
  })

  it('play → pause → play rebuilds a fresh source (BufferSource is single-use)', async () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.seek(0.5)
    m.play()
    await flush()
    const first = opts.mockCtx.createdBufferSources[0]
    expect(first.started).toBe(true)
    m.pause()
    m.play()
    await flush()
    // A different, second source should have been constructed.
    const sources = opts.mockCtx.createdBufferSources
    expect(sources.length).toBeGreaterThanOrEqual(2)
    const last = sources[sources.length - 1]
    expect(last).not.toBe(first)
    expect(last.started).toBe(true)
  })
})

describe('createAudioMixer — mute updates', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { __clearDecodeCacheForTest(); opts = makeOptions() })

  it('initial track mute flagged; updateTrack reschedules without error', async () => {
    const track = t('a', [{ id: 'c1', start: 0, end: 1 }], { muted: true })
    const m = createAudioMixer('p', [track], opts)
    m.play()
    await flush()
    m.updateTrack('a')
    expect(m.trackCount).toBe(1)
  })

  it('rebuild replaces tracks and their clips', async () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.seek(0.5)
    m.play()
    await flush()
    const before = opts.mockCtx.createdBufferSources[0]
    expect(before.started).toBe(true)
    m.rebuild([t('b', [{ id: 'c2', start: 0, end: 1 }])])
    await flush()
    // Old source stopped; new one created for c2
    expect(before.stopped).toBe(true)
  })
})

describe('createAudioMixer — curve automation (T117)', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { __clearDecodeCacheForTest(); opts = makeOptions() })

  // The mixer creates, in order, before the first track gain is built:
  //   1. masterGain
  //   2. master fx-chain passthrough input
  //   3. master fx-chain passthrough output
  // (The empty master chain always wires input→output passthroughs so the
  // audio topology is identical whether or not a master effect is present.)
  // We skip those 3 so tests can index `_allGains[0]` as the first trackGain.
  const MASTER_GAIN_COUNT = 3
  const instrumentCtx = (ctx: MockAudioContext): void => {
    const origCreateGain = ctx.createGain.bind(ctx)
    const gains: MockGainNode[] = []
    ;(ctx as unknown as { _allGains: MockGainNode[] })._allGains = gains
    let skipped = 0
    ctx.createGain = () => {
      const g = origCreateGain()
      if (skipped < MASTER_GAIN_COUNT) {
        skipped++
        return g
      }
      gains.push(g)
      return g
    }
  }

  it('track curve [[0, 0], [10, -6]] schedules anchor + ramp on play', async () => {
    instrumentCtx(opts.mockCtx)
    const track: AudioTrack = {
      id: 'a', name: 'a', display_order: 0, hidden: false, muted: false, solo: false,
      volume_curve: [[0, 0], [10, -6]],
      clips: [],
    }
    const m = createAudioMixer('p', [track], opts)
    m.play()
    await flush()
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    const trackGain = allGains[0]
    const events = trackGain.gain.events
    expect(events.some((e) => e.kind === 'cancelScheduledValues')).toBe(true)
    const setValue = events.find((e) => e.kind === 'setValueAtTime')
    expect(setValue?.value).toBeCloseTo(1, 3)
    const ramp = events.find((e) => e.kind === 'linearRampToValueAtTime')
    expect(ramp?.value).toBeCloseTo(0.5012, 3)
  })

  it('clip curve [[0, 0], [1, -6]] anchors at clip start and ramps to end', async () => {
    instrumentCtx(opts.mockCtx)
    const track = t('a', [{ id: 'c1', start: 10, end: 20 }])
    track.clips![0].volume_curve = [[0, 0], [1, -6]]
    const m = createAudioMixer('p', [track], opts)
    m.seek(10)
    m.play()
    await flush()
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    // Order: trackGain(0), clipGain(1), crossfadeGain(2)
    const clipGain = allGains[1]
    const events = clipGain.gain.events
    expect(events.some((e) => e.kind === 'cancelScheduledValues')).toBe(true)
    const setValue = events.find((e) => e.kind === 'setValueAtTime')
    expect(setValue?.value).toBeCloseTo(1, 3)
    const ramp = events.find((e) => e.kind === 'linearRampToValueAtTime')
    expect(ramp?.value).toBeCloseTo(0.5012, 3)
  })

  it('muted clip gets setValueAtTime(0) instead of curve', async () => {
    instrumentCtx(opts.mockCtx)
    const track = t('a', [{ id: 'c1', start: 0, end: 1, muted: true }])
    const m = createAudioMixer('p', [track], opts)
    m.seek(0.5)
    m.play()
    await flush()
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    const clipGain = allGains[1]
    const events = clipGain.gain.events.filter((e) => e.kind === 'setValueAtTime')
    expect(events.some((e) => e.value === 0)).toBe(true)
    expect(clipGain.gain.events.some((e) => e.kind === 'linearRampToValueAtTime')).toBe(false)
  })

  it('muted track schedules setValueAtTime(0) on track gain', async () => {
    instrumentCtx(opts.mockCtx)
    const track = t('a', [{ id: 'c1', start: 0, end: 1 }], { muted: true })
    const m = createAudioMixer('p', [track], opts)
    m.play()
    await flush()
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    const trackGain = allGains[0]
    const events = trackGain.gain.events.filter((e) => e.kind === 'setValueAtTime')
    expect(events.some((e) => e.value === 0)).toBe(true)
  })

  it('updateClip re-schedules curve in place for an active clip', async () => {
    instrumentCtx(opts.mockCtx)
    const track = t('a', [{ id: 'c1', start: 0, end: 10 }])
    const m = createAudioMixer('p', [track], opts)
    m.seek(1)
    m.play()
    await flush()
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    const clipGain = allGains[1]
    const initialCount = clipGain.gain.events.length
    m.updateClip('c1')
    expect(clipGain.gain.events.length).toBeGreaterThan(initialCount)
  })

  it('updateTrack re-schedules track curve', async () => {
    instrumentCtx(opts.mockCtx)
    const track = t('a', [{ id: 'c1', start: 0, end: 10 }])
    const m = createAudioMixer('p', [track], opts)
    m.play()
    await flush()
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    const trackGain = allGains[0]
    const initialCount = trackGain.gain.events.length
    m.updateTrack('a')
    expect(trackGain.gain.events.length).toBeGreaterThan(initialCount)
  })
})

describe('createAudioMixer — equal-power crossfade (T117)', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { __clearDecodeCacheForTest(); opts = makeOptions() })

  // Same skip logic as curve-automation describe: masterGain + 2 passthroughs.
  const MASTER_GAIN_COUNT = 3
  const instrumentCtx = (ctx: MockAudioContext): void => {
    const orig = ctx.createGain.bind(ctx)
    const gains: MockGainNode[] = []
    ;(ctx as unknown as { _allGains: MockGainNode[] })._allGains = gains
    let skipped = 0
    ctx.createGain = () => {
      const g = orig()
      if (skipped < MASTER_GAIN_COUNT) { skipped++; return g }
      gains.push(g)
      return g
    }
  }

  it('overlapping same-track clips receive cos + sin curve schedules', async () => {
    instrumentCtx(opts.mockCtx)
    const m = createAudioMixer('p', [
      t('a', [
        { id: 'c1', start: 0, end: 5 },
        { id: 'c2', start: 3, end: 8 },
      ]),
    ], opts)
    m.seek(0)
    m.play()
    await flush()
    m.seek(3) // c2 activates inside c1's window → crossfade triggered
    await flush()

    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    // Graph: trackGain(0), c1_clipGain(1), c1_crossfadeGain(2), c2_clipGain(3), c2_crossfadeGain(4)
    const c1Crossfade = allGains[2]
    const c2Crossfade = allGains[4]

    const cos = c1Crossfade.gain.events.find((e) => e.kind === 'setValueCurveAtTime')
    const sin = c2Crossfade.gain.events.find((e) => e.kind === 'setValueCurveAtTime')
    expect(cos).toBeDefined()
    expect(sin).toBeDefined()
    expect(cos?.duration).toBeCloseTo(2, 3)
    expect(sin?.duration).toBeCloseTo(2, 3)
    expect(cos?.values?.[0]).toBeCloseTo(1, 3)
    expect(sin?.values?.[0]).toBeCloseTo(0, 3)
    expect(cos?.values?.[cos!.values!.length - 1]).toBeCloseTo(0, 3)
    expect(sin?.values?.[sin!.values!.length - 1]).toBeCloseTo(1, 3)
  })

  it('cos² + sin² ≈ 1 at every curve sample (equal-power invariant)', () => {
    const n = 128
    const cos = new Float32Array(n)
    const sin = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1)
      cos[i] = Math.cos(t * Math.PI / 2)
      sin[i] = Math.sin(t * Math.PI / 2)
    }
    for (let i = 0; i < n; i++) {
      const power = cos[i] * cos[i] + sin[i] * sin[i]
      expect(power).toBeCloseTo(1, 5)
    }
  })
})

describe('createAudioMixer — dispose', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { __clearDecodeCacheForTest(); opts = makeOptions() })

  it('dispose is idempotent', () => {
    const m = createAudioMixer('p', [t('a')], opts)
    m.dispose()
    expect(() => m.dispose()).not.toThrow()
  })

  it('dispose stops any active sources', async () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.seek(0.5)
    m.play()
    await flush()
    const src = opts.mockCtx.createdBufferSources[0]
    expect(src.started).toBe(true)
    m.dispose()
    expect(src.stopped).toBe(true)
  })

  it('dispose closes the AudioContext', async () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.play()
    await flush()
    expect(opts.mockCtx.state).toBe('running')
    m.dispose()
    expect(opts.mockCtx.state).toBe('closed')
  })

  it('post-dispose method calls are no-ops', () => {
    const m = createAudioMixer('p', [t('a')], opts)
    m.dispose()
    expect(() => m.play()).not.toThrow()
    expect(() => m.rebuild([t('b')])).not.toThrow()
    expect(m.trackCount).toBe(0)
  })
})
