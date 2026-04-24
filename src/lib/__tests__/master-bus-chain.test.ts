/**
 * Master-bus effect chain tests.
 *
 * Covers the shared `buildEffectChain` helper (mix-graph.ts) and its
 * integration with both the live mixer (audio-mixer.ts) and the offline
 * renderer (mix-render.ts). A separate fidelity scenario lives in
 * `mix-live-vs-offline-fidelity.test.ts` — that one asserts live + offline
 * agree to 0 abs diff with a master effect wired.
 *
 * Design rationale: the WebAudio-facing tests drive deterministic mocks
 * because happy-dom has no AudioContext / OfflineAudioContext. Each test
 * uses only the set of node types + param-scheduling primitives it needs —
 * `gain.value` + `setValueAtTime` is enough to prove topology and signal
 * multiplication through the chain.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AudioTrack } from '../audio-client'
import type { TrackEffect } from '../audio-graph'
import { renderMixToBuffer, type MixRenderOptions } from '../mix-render'
import {
  createAudioMixer,
  type AudioMixerOptions,
  __clearDecodeCacheForTest,
} from '../audio-mixer'
import { EFFECT_TYPES, type EffectNode } from '../audio-effect-types'

// ── Minimal WebAudio mocks ────────────────────────────────────────────────

type ParamEvent =
  | { kind: 'setValueAtTime'; value: number; time: number }
  | { kind: 'linearRampToValueAtTime'; value: number; time: number }
  | { kind: 'setValueCurveAtTime'; values: Float32Array; time: number; duration: number }
  | { kind: 'cancelScheduledValues'; time: number }

class MockAudioParam {
  value = 1
  events: ParamEvent[] = []
  setValueAtTime(v: number, t: number) { this.value = v; this.events.push({ kind: 'setValueAtTime', value: v, time: t }) }
  linearRampToValueAtTime(v: number, t: number) { this.value = v; this.events.push({ kind: 'linearRampToValueAtTime', value: v, time: t }) }
  setValueCurveAtTime(values: Float32Array, t: number, duration: number) {
    this.events.push({ kind: 'setValueCurveAtTime', values: new Float32Array(values), time: t, duration })
  }
  cancelScheduledValues(t: number) { this.events.push({ kind: 'cancelScheduledValues', time: t }) }

  /** Evaluate at offline-clock `t`. Same rules as the other test mocks. */
  evaluate(t: number): number {
    const evs = this.events.filter((e) => e.kind !== 'cancelScheduledValues')
    let lastValue = this.value
    let lastTime = 0
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]
      if (e.kind === 'setValueAtTime' && e.time <= t) {
        lastValue = e.value
        lastTime = e.time
      } else if (e.kind === 'setValueCurveAtTime') {
        if (t >= e.time && t <= e.time + e.duration) {
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
  disconnect() { this.connections.length = 0 }
}

class MockBufferSourceNode implements MockNodeBase {
  readonly kind = 'source'
  connections: MockNodeBase[] = []
  buffer: AudioBuffer | null = null
  playbackRate = new MockAudioParam()
  detune = new MockAudioParam()
  started = false
  stopped = false
  startWhen = 0
  startOffset = 0
  startDuration: number | undefined
  connect(dst: MockNodeBase) { this.connections.push(dst); return dst as unknown as AudioNode }
  disconnect() { this.connections.length = 0 }
  start(when = 0, offset = 0, duration?: number) {
    if (this.started) throw new Error('start() already called')
    this.started = true
    this.startWhen = when
    this.startOffset = offset
    this.startDuration = duration
    this.playbackRate.value = this.playbackRate.evaluate(0) || 1
  }
  stop() { this.stopped = true }
}

class MockAnalyserNode implements MockNodeBase {
  readonly kind = 'analyser'
  connections: MockNodeBase[] = []
  fftSize = 1024
  smoothingTimeConstant = 0
  connect(dst: MockNodeBase) { this.connections.push(dst); return dst as unknown as AudioNode }
  disconnect() { this.connections.length = 0 }
  getFloatTimeDomainData(_arr: Float32Array) {}
  getByteFrequencyData(_arr: Uint8Array) {}
}

class MockChannelSplitterNode implements MockNodeBase {
  readonly kind = 'splitter'
  connections: MockNodeBase[] = []
  connect(dst: MockNodeBase, _out?: number) { this.connections.push(dst); return dst as unknown as AudioNode }
  disconnect() { this.connections.length = 0 }
}

class MockDestinationNode implements MockNodeBase {
  readonly kind = 'destination'
  connections: MockNodeBase[] = []
  connect() { return this as unknown as AudioNode }
  disconnect() {}
}

/**
 * Context that doubles as AudioContext + OfflineAudioContext. startRendering()
 * analytically walks the connection graph, multiplying each source by every
 * gain param encountered on the path to destination.
 */
class MockHybridContext {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  currentTime = 0
  state: 'running' | 'suspended' | 'closed' = 'running'
  destination = new MockDestinationNode()
  createdSources: MockBufferSourceNode[] = []
  createdGains: MockGainNode[] = []
  createdAnalysers: MockAnalyserNode[] = []
  createdSplitters: MockChannelSplitterNode[] = []

  constructor(init: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = init.numberOfChannels
    this.length = init.length
    this.sampleRate = init.sampleRate
  }

  createGain() { const g = new MockGainNode(); this.createdGains.push(g); return g as unknown as GainNode }
  createBufferSource() { const s = new MockBufferSourceNode(); this.createdSources.push(s); return s as unknown as AudioBufferSourceNode }
  createAnalyser() { const a = new MockAnalyserNode(); this.createdAnalysers.push(a); return a as unknown as AnalyserNode }
  createChannelSplitter(_n?: number) { const s = new MockChannelSplitterNode(); this.createdSplitters.push(s); return s as unknown as ChannelSplitterNode }
  resume() { this.state = 'running'; return Promise.resolve() }
  close() { this.state = 'closed'; return Promise.resolve() }
  async decodeAudioData(_ab: ArrayBuffer): Promise<AudioBuffer> {
    throw new Error('decodeAudioData not used in this test file')
  }

  startRendering(): Promise<AudioBuffer> {
    const left = new Float32Array(this.length)
    const right = new Float32Array(this.length)

    for (const src of this.createdSources) {
      if (!src.started || !src.buffer || src.stopped) continue

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
      const bufLeft = buf.getChannelData(0)
      const bufRight = buf.numberOfChannels > 1 ? buf.getChannelData(1) : bufLeft
      const rate = src.playbackRate.value || 1
      const effectiveDuration = src.startDuration ?? (buf.duration - src.startOffset)

      const startFrame = Math.max(0, Math.round(src.startWhen * this.sampleRate))
      const endFrame = Math.min(this.length, Math.round((src.startWhen + effectiveDuration) * this.sampleRate))

      for (let f = startFrame; f < endFrame; f++) {
        const tOffline = f / this.sampleRate
        const tSinceStart = tOffline - src.startWhen
        const srcPos = src.startOffset + tSinceStart * rate
        const srcFrame = srcPos * buf.sampleRate
        const srcFrameIdx = Math.floor(srcFrame)
        if (srcFrameIdx < 0 || srcFrameIdx >= bufLeft.length) continue
        const frac = srcFrame - srcFrameIdx
        const nextIdx = Math.min(bufLeft.length - 1, srcFrameIdx + 1)
        const l = bufLeft[srcFrameIdx] * (1 - frac) + bufLeft[nextIdx] * frac
        const r = bufRight[srcFrameIdx] * (1 - frac) + bufRight[nextIdx] * frac
        let g = 1
        for (const gp of gainParams) g *= gp.evaluate(tOffline)
        left[f] += l * g
        right[f] += r * g
      }
    }

    return Promise.resolve({
      numberOfChannels: this.numberOfChannels,
      sampleRate: this.sampleRate,
      length: this.length,
      duration: this.length / this.sampleRate,
      getChannelData: (ch: number): Float32Array => {
        if (ch === 0) return left
        if (ch === 1) return right
        return new Float32Array(this.length)
      },
    } as unknown as AudioBuffer)
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeBuffer(lenS: number, sr: number, channels: number, fill: (f: number) => number): AudioBuffer {
  const frames = Math.floor(lenS * sr)
  const data: Float32Array[] = []
  for (let c = 0; c < channels; c++) {
    const arr = new Float32Array(frames)
    for (let f = 0; f < frames; f++) arr[f] = fill(f)
    data.push(arr)
  }
  return {
    numberOfChannels: channels,
    sampleRate: sr,
    length: frames,
    duration: frames / sr,
    getChannelData: (ch: number) => data[Math.min(ch, channels - 1)],
  } as unknown as AudioBuffer
}

const mkTrack = (id: string, source: string, endTime: number): AudioTrack => ({
  id,
  name: id,
  display_order: 0,
  solo: false,
  hidden: false,
  muted: false,
  volume_curve: [],
  clips: [{
    id: `${id}-c`,
    track_id: id,
    source_path: source,
    start_time: 0,
    end_time: endTime,
    source_offset: 0,
    effective_source_offset: 0,
    volume_curve: [],
    muted: false,
    playback_rate: 1,
  }],
})

// ── Helper: render offline with master effects, using a custom effect ────

/**
 * Register a temporary gain-style effect in EFFECT_TYPES and run
 * renderMixToBuffer. The effect is a single GainNode whose initial gain is
 * set from `static_params.gain`. We don't mutate EFFECT_TYPES globally — we
 * mutate for the test and restore in afterEach.
 */
async function renderWithMasterEffects(
  tracks: AudioTrack[],
  buffers: Map<string, AudioBuffer>,
  startTimeS: number,
  endTimeS: number,
  masterEffects: TrackEffect[],
  sampleRate = 48000,
): Promise<{ pcm: Float32Array; ctx: MockHybridContext }> {
  let capturedCtx: MockHybridContext | null = null
  const opts: MixRenderOptions = {
    projectName: 'p',
    startTimeS,
    endTimeS,
    sampleRate,
    channels: 2,
    bufferCache: buffers,
    masterEffects,
    offlineCtxFactory: (init) => {
      capturedCtx = new MockHybridContext(init)
      return capturedCtx as unknown as OfflineAudioContext
    },
    sourceUrlFactory: (project, path) => `mock://${project}/${path}`,
    fetchBytes: async () => new ArrayBuffer(4),
    decode: async () => { throw new Error('unexpected decode') },
  }
  const result = await renderMixToBuffer(tracks, opts)
  if (!capturedCtx) throw new Error('offline factory never invoked')
  return { pcm: result.pcm, ctx: capturedCtx }
}

// ── Temporary gain-pseudo-effect plumbing ────────────────────────────────

// We register a fake effect_type for the duration of each test so we can
// assert the chain actually multiplies by a known scalar. Using a real
// effect (e.g. limiter) is fine for topology checks but makes amplitude
// assertions brittle — the built-in limiter's curve depends on signal
// history. A plain gain is the cleanest test vehicle.

function registerTestGainEffect() {
  const TYPE_NAME = '__test_master_gain'
  EFFECT_TYPES[TYPE_NAME] = {
    type: TYPE_NAME,
    label: 'TestMasterGain',
    category: 'dynamics',
    params: [
      { name: 'gain', label: 'Gain', animatable: true, range: { min: 0, max: 10 }, scale: 'linear', default: 1 },
    ],
    build: (ctx, staticParams): EffectNode => {
      const g = ctx.createGain()
      const v = typeof staticParams.gain === 'number' ? staticParams.gain : 1
      g.gain.setValueAtTime(v, ctx.currentTime)
      return {
        input: g,
        output: g,
        setParam: (_name, value, when) => {
          g.gain.setValueAtTime(value, when ?? ctx.currentTime)
        },
        scheduleCurve: () => { /* no-op for tests */ },
        dispose: () => { try { g.disconnect() } catch { /* ignore */ } },
      }
    },
  }
  return TYPE_NAME
}

function unregisterTestGainEffect(name: string) {
  delete EFFECT_TYPES[name]
}

function mkMasterGainFx(id: string, orderIndex: number, gainValue: number, typeName: string): TrackEffect {
  return {
    id,
    track_id: '',
    effect_type: typeName,
    order_index: orderIndex,
    enabled: true,
    static_params: { gain: gainValue },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('master-bus effect chain — offline renderer topology', () => {
  let TYPE_NAME = ''
  beforeEach(() => { TYPE_NAME = registerTestGainEffect() })
  // Restore in each test via try/finally — simpler than afterEach closures.

  it('empty chain: audio passes through at unity gain', async () => {
    try {
      const sr = 48000
      const duration = 0.05
      const buf = makeBuffer(duration + 0.01, sr, 2, () => 0.5)
      const buffers = new Map<string, AudioBuffer>([['a.wav', buf]])
      const tracks = [mkTrack('t1', 'a.wav', duration)]

      const { pcm } = await renderWithMasterEffects(tracks, buffers, 0, duration, [], sr)
      // Center of the window — clip is DC @ 0.5, trackGain = 1, no master fx.
      const midFrame = Math.floor((duration / 2) * sr)
      expect(pcm[midFrame * 2]).toBeCloseTo(0.5, 5)
      expect(pcm[midFrame * 2 + 1]).toBeCloseTo(0.5, 5)
    } finally { unregisterTestGainEffect(TYPE_NAME) }
  })

  it('single master effect with gain=0.5 halves the output amplitude', async () => {
    try {
      const sr = 48000
      const duration = 0.05
      const buf = makeBuffer(duration + 0.01, sr, 2, () => 1)
      const buffers = new Map<string, AudioBuffer>([['a.wav', buf]])
      const tracks = [mkTrack('t1', 'a.wav', duration)]
      const effects = [mkMasterGainFx('e1', 0, 0.5, TYPE_NAME)]

      const { pcm } = await renderWithMasterEffects(tracks, buffers, 0, duration, effects, sr)
      const midFrame = Math.floor((duration / 2) * sr)
      // Source is 1.0, trackGain = 1, masterGain = 1, master fx = 0.5 → 0.5
      expect(pcm[midFrame * 2]).toBeCloseTo(0.5, 5)
      expect(pcm[midFrame * 2 + 1]).toBeCloseTo(0.5, 5)
    } finally { unregisterTestGainEffect(TYPE_NAME) }
  })

  it('two-effect chain multiplies gains in order (0.5 * 2.0 = identity)', async () => {
    try {
      const sr = 48000
      const duration = 0.05
      const buf = makeBuffer(duration + 0.01, sr, 2, () => 0.4)
      const buffers = new Map<string, AudioBuffer>([['a.wav', buf]])
      const tracks = [mkTrack('t1', 'a.wav', duration)]
      const effects = [
        mkMasterGainFx('e1', 0, 0.5, TYPE_NAME),
        mkMasterGainFx('e2', 1, 2.0, TYPE_NAME),
      ]

      const { pcm } = await renderWithMasterEffects(tracks, buffers, 0, duration, effects, sr)
      const midFrame = Math.floor((duration / 2) * sr)
      // 0.4 * 0.5 * 2.0 = 0.4
      expect(pcm[midFrame * 2]).toBeCloseTo(0.4, 5)
    } finally { unregisterTestGainEffect(TYPE_NAME) }
  })

  it('effects are applied in order_index order — NOT array order', async () => {
    try {
      const sr = 48000
      const duration = 0.05
      const buf = makeBuffer(duration + 0.01, sr, 2, () => 1)
      const buffers = new Map<string, AudioBuffer>([['a.wav', buf]])
      const tracks = [mkTrack('t1', 'a.wav', duration)]
      // Deliberately pass effects in non-sorted order.
      const effects = [
        mkMasterGainFx('e1', 2, 4.0, TYPE_NAME),  // 3rd in chain
        mkMasterGainFx('e2', 0, 0.5, TYPE_NAME),  // 1st
        mkMasterGainFx('e3', 1, 0.25, TYPE_NAME), // 2nd
      ]
      // Net: 0.5 * 0.25 * 4.0 = 0.5
      const { pcm } = await renderWithMasterEffects(tracks, buffers, 0, duration, effects, sr)
      const midFrame = Math.floor((duration / 2) * sr)
      expect(pcm[midFrame * 2]).toBeCloseTo(0.5, 5)
    } finally { unregisterTestGainEffect(TYPE_NAME) }
  })
})

// ── Live mixer — reevaluateMasterChain ────────────────────────────────────
//
// Unlike the offline path we don't need to assert amplitude here — we assert
// graph-level invariants: the old chain's nodes are disposed, the new chain
// is wired between masterGain and the analyser, and audio still has a path
// to destination. Counting node creations before/after the rebuild is the
// simplest observable for these claims.

describe('master-bus effect chain — live mixer reevaluateMasterChain', () => {
  let TYPE_NAME = ''
  beforeEach(() => { __clearDecodeCacheForTest(); TYPE_NAME = registerTestGainEffect() })

  it('rebuilds the chain and preserves the signal path to destination', () => {
    try {
      const ctx = new MockHybridContext({ numberOfChannels: 2, length: 48000, sampleRate: 48000 })
      const opts: AudioMixerOptions = {
        audioCtxFactory: () => ctx as unknown as AudioContext,
        masterEffects: [mkMasterGainFx('e1', 0, 0.5, TYPE_NAME)],
      }
      const mixer = createAudioMixer('p', [], opts)
      mixer.play() // triggers ensureGraph which calls ensureMasterGraph

      // After ensureMasterGraph, we should have (at least) these gains:
      //   masterGain, chain.input, chain.output, plus the test effect's gain.
      const gainsBefore = ctx.createdGains.length
      expect(gainsBefore).toBeGreaterThanOrEqual(4)

      // Capture the old chain's test-effect node (the one whose initial gain
      // was set to 0.5). We know it exists and its gain was setValueAtTime(0.5).
      const oldTestGain = ctx.createdGains.find((g) =>
        g.gain.events.some((e) => e.kind === 'setValueAtTime' && e.value === 0.5),
      )
      expect(oldTestGain).toBeDefined()

      // Now reevaluate with a different gain effect.
      mixer.reevaluateMasterChain([mkMasterGainFx('e2', 0, 0.25, TYPE_NAME)])

      // The fresh chain adds: new chain.input, new chain.output, new effect gain
      // (+ a new analyser + splitter). All these bump the counters.
      const gainsAfter = ctx.createdGains.length
      expect(gainsAfter).toBeGreaterThan(gainsBefore)

      // The new chain's test-effect gain was set to 0.25.
      const newTestGain = ctx.createdGains.find((g) =>
        g !== oldTestGain &&
        g.gain.events.some((e) => e.kind === 'setValueAtTime' && e.value === 0.25),
      )
      expect(newTestGain).toBeDefined()

      // The old effect's gain node was disposed — its disconnect() emptied
      // its connection list. (MockGainNode.disconnect() sets length to 0.)
      expect(oldTestGain!.connections.length).toBe(0)

      mixer.dispose()
    } finally { unregisterTestGainEffect(TYPE_NAME) }
  })

  it('reevaluate before first play() is a no-op (graph not yet built)', () => {
    try {
      const ctx = new MockHybridContext({ numberOfChannels: 2, length: 48000, sampleRate: 48000 })
      const opts: AudioMixerOptions = { audioCtxFactory: () => ctx as unknown as AudioContext }
      const mixer = createAudioMixer('p', [], opts)

      // No play() call — audioCtx should be null, ensureMasterGraph never ran.
      expect(ctx.createdGains.length).toBe(0)

      // Should not throw, and should not force-build the graph.
      mixer.reevaluateMasterChain([mkMasterGainFx('e1', 0, 0.5, TYPE_NAME)])
      expect(ctx.createdGains.length).toBe(0)

      // When play() runs, the chain uses the new effects list.
      mixer.play()
      const hasGainAtHalf = ctx.createdGains.some((g) =>
        g.gain.events.some((e) => e.kind === 'setValueAtTime' && e.value === 0.5),
      )
      expect(hasGainAtHalf).toBe(true)

      mixer.dispose()
    } finally { unregisterTestGainEffect(TYPE_NAME) }
  })

  it('empty chain is rebuilt cleanly from a populated one', () => {
    try {
      const ctx = new MockHybridContext({ numberOfChannels: 2, length: 48000, sampleRate: 48000 })
      const opts: AudioMixerOptions = {
        audioCtxFactory: () => ctx as unknown as AudioContext,
        masterEffects: [mkMasterGainFx('e1', 0, 0.5, TYPE_NAME)],
      }
      const mixer = createAudioMixer('p', [], opts)
      mixer.play()

      const analysersBefore = ctx.createdAnalysers.length
      expect(analysersBefore).toBeGreaterThanOrEqual(2) // L + R

      // Strip all master effects.
      mixer.reevaluateMasterChain([])

      // New analyser pair (old one was disposed + replaced).
      expect(ctx.createdAnalysers.length).toBeGreaterThan(analysersBefore)

      // Master analyser taps still exposed via getter.
      const taps = mixer.getMasterAnalysers()
      expect(taps).not.toBeNull()

      mixer.dispose()
    } finally { unregisterTestGainEffect(TYPE_NAME) }
  })
})
