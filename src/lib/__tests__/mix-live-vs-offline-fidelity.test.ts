/**
 * M15 task 9 — live-vs-offline fidelity validation.
 *
 * Mechanically enforces the M15 "single source of truth" principle:
 *   the live mixer (`audio-mixer.ts`) and the offline renderer
 *   (`mix-render.ts`) MUST produce bit-identical PCM for any given project
 *   state + render window, because they share `mix-graph.ts` as their
 *   scheduling primitive and the same module-level decode cache.
 *
 * ── Environment constraint ───────────────────────────────────────────────
 * vitest runs under happy-dom, which ships no `AudioContext` nor
 * `OfflineAudioContext`. A real browser is the natural home for this test
 * (Playwright would capture the live mixer's master-analyser tap during
 * wall-clock playback and compare it sample-for-sample with a WAV produced
 * by `renderMixToBuffer`). That end-to-end variant is the follow-up
 * Playwright test called out in M15's e2e task — NOT this file.
 *
 * ── What this file does instead ──────────────────────────────────────────
 * Strategy (option b+c from the task brief): drive BOTH paths through the
 * same mock `OfflineAudioContext` implementation, analytically render the
 * resulting scheduled graph, and compare PCM. Because the two paths build
 * their graphs from the shared helpers in `mix-graph.ts`, any drift between
 * them would manifest as a PCM difference. The mock's rendering loop is
 * deterministic, so a passing test is strong evidence that the two graphs
 * are structurally identical (same sources, same gain schedules, same
 * timing). This is WEAKER than a real-device sample-capture comparison
 * (it can't catch, say, differences in hardware resampling) but STRONGER
 * than per-function unit tests — it proves the entire pipelines agree.
 *
 * ── Trick: make the live mixer render deterministically ──────────────────
 * The live mixer takes an `audioCtxFactory`. We hand it a "live-equivalent"
 * mock that's actually an OfflineAudioContext surrogate with
 * `currentTime = 0`. The mixer's curve anchoring then coincides with the
 * offline renderer's (both use `paramAnchorTime = 0`), so scheduled events
 * land on a comparable timeline. We seek to `startTimeS`, call `play()` so
 * all clips inside the window get activated, then analytically render both
 * graphs through the same loop.
 *
 * Note: the live mixer only activates clips whose start_time is at or before
 * the current playhead (via `reevaluateClips`). Clips that begin LATER in
 * the render window would ordinarily be activated by a subsequent `seek()`
 * as wall-clock time advanced. For the simpler scenarios below the live
 * path activates each clip via a sequence of `seek()` calls that mimic
 * playhead progression. Scenarios where this mimicry can't match the
 * offline path's one-shot "schedule everything up-front" are explicitly
 * documented and skipped — see the final `describe.skip` block.
 */

import { describe, expect, it } from 'vitest'
import type { AudioClip, AudioTrack } from '../audio-client'
import type { TrackEffect } from '../audio-graph'
import { renderMixToBuffer, type MixRenderOptions } from '../mix-render'
import {
  createAudioMixer,
  __clearDecodeCacheForTest,
  type AudioMixerOptions,
} from '../audio-mixer'
import { EFFECT_TYPES, type EffectNode } from '../audio-effect-types'

// ── Shared mock OfflineAudioContext (serves both live + offline paths) ────

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
    this.events.push({ kind: 'setValueCurveAtTime', values: new Float32Array(values), time: t, duration })
  }
  cancelScheduledValues(t: number) { this.events.push({ kind: 'cancelScheduledValues', time: t }) }

  /** Evaluate scheduled events at offline-clock time `t`. Mirrors the mock
   *  in `mix-render.test.ts` — replicates WebAudio automation rules well
   *  enough for our scheduling primitives (step, linear ramp, value curve). */
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
  disconnect() { this.connections = [] }
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
  disconnect() { this.connections = [] }
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

/** Analyser and splitter exist so the live mixer's master-bus construction
 *  doesn't throw. They're passive in our renderer (signal passes through). */
class MockAnalyserNode implements MockNodeBase {
  readonly kind = 'analyser'
  connections: MockNodeBase[] = []
  fftSize = 1024
  smoothingTimeConstant = 0
  connect(dst: MockNodeBase) { this.connections.push(dst); return dst as unknown as AudioNode }
  disconnect() { this.connections = [] }
  getFloatTimeDomainData(_arr: Float32Array) {}
  getByteFrequencyData(_arr: Uint8Array) {}
}

class MockChannelSplitterNode implements MockNodeBase {
  readonly kind = 'splitter'
  connections: MockNodeBase[] = []
  connect(dst: MockNodeBase, _out?: number) { this.connections.push(dst); return dst as unknown as AudioNode }
  disconnect() { this.connections = [] }
}

class MockDestinationNode implements MockNodeBase {
  readonly kind = 'destination'
  connections: MockNodeBase[] = []
  connect() { return this as unknown as AudioNode }
  disconnect() {}
}

/**
 * Hybrid context: presents itself as either AudioContext (with `.state`,
 * `.resume`, `.close`) OR OfflineAudioContext (with `.startRendering`) — the
 * same object satisfies both live-mixer and offline-renderer code paths.
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
    // Never invoked in these tests — we always pre-seed the bufferCache and
    // inject a `decode` override that returns the pre-built buffer.
    throw new Error('decodeAudioData not used in fidelity tests')
  }

  /**
   * Analytically render every scheduled source → destination chain. Uses
   * DFS over outbound edges to find a path that reaches the destination,
   * multiplying by every gain encountered on that path. Analyser / splitter
   * taps (dead-end branches that never reach destination) are correctly
   * ignored — the search picks the branch that terminates at destination.
   *
   * This matters for the live-mixer graph, where `trackGain` fans out to
   * BOTH a splitter-based analyser tap AND onward to `masterGain`. Greedy
   * `connections[0]`-only walks would stop at the analyser and miss the
   * remainder of the chain.
   */
  startRendering(): Promise<AudioBuffer> {
    const left = new Float32Array(this.length)
    const right = new Float32Array(this.length)

    // Finds a simple path from `src` to a destination node, collecting the
    // gain params of every gain node along the way. Returns null if no path
    // reaches destination (in which case the source is audible through only
    // analyser taps and doesn't contribute to PCM).
    const findDestinationPath = (src: MockNodeBase): MockAudioParam[] | null => {
      const path: MockAudioParam[] = []
      const visited = new Set<MockNodeBase>()
      const dfs = (node: MockNodeBase): boolean => {
        if (node.kind === 'destination') return true
        if (visited.has(node)) return false
        visited.add(node)
        for (const next of node.connections) {
          if (next.kind === 'gain' && next.gain) {
            path.push(next.gain)
            if (dfs(next)) return true
            path.pop()
          } else if (dfs(next)) {
            return true
          }
        }
        return false
      }
      return dfs(src) ? path : null
    }

    for (const src of this.createdSources) {
      if (!src.started || !src.buffer || src.stopped) continue

      const gainParams = findDestinationPath(src)
      if (!gainParams) continue

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

// ── Fixture factories ─────────────────────────────────────────────────────

/** Synthesise an AudioBuffer purely in memory (no file I/O, no decode). */
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

const mkClip = (overrides: Partial<AudioClip> & Pick<AudioClip, 'id' | 'start_time' | 'end_time' | 'source_path'>): AudioClip => ({
  track_id: 't',
  source_offset: 0,
  effective_source_offset: overrides.source_offset ?? 0,
  volume_curve: [],
  muted: false,
  playback_rate: 1,
  ...overrides,
})

const mkTrack = (id: string, clips: AudioClip[], overrides: Partial<AudioTrack> = {}): AudioTrack => ({
  id,
  name: id,
  display_order: 0,
  hidden: false,
  muted: false,
  solo: false,
  volume_curve: [],
  clips,
  ...overrides,
})

// ── Render helpers ────────────────────────────────────────────────────────

/**
 * Render via the offline renderer (`mix-render.ts`) onto our hybrid mock.
 * Returns PCM (interleaved stereo) + the context for introspection.
 */
async function renderOffline(
  tracks: AudioTrack[],
  buffers: Map<string, AudioBuffer>,
  startTimeS: number,
  endTimeS: number,
  sampleRate = 48000,
  masterEffects: readonly TrackEffect[] = [],
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
    decode: async () => {
      // Fallback — should never be reached if the bufferCache is fully primed.
      throw new Error('unexpected decode in offline test path')
    },
  }
  const result = await renderMixToBuffer(tracks, opts)
  if (!capturedCtx) throw new Error('offline factory was never invoked')
  return { pcm: result.pcm, ctx: capturedCtx }
}

/**
 * Render via the live mixer (`audio-mixer.ts`), by driving it through the
 * same hybrid mock context and a sequence of `seek()` + `play()` calls that
 * activate every clip in the render window. The final step calls
 * `ctx.startRendering()` directly to produce PCM.
 *
 * For clips that start mid-window (not overlapping the initial playhead),
 * we nudge the playhead past their start_time via a `seek()` to trigger
 * activation. Because `currentTime = 0` and we never advance it, all
 * activations schedule at `when = 0 + max(0, start - playhead)` — exactly
 * what the offline renderer computes.
 */
async function renderLive(
  tracks: AudioTrack[],
  buffers: Map<string, AudioBuffer>,
  startTimeS: number,
  endTimeS: number,
  sampleRate = 48000,
  masterEffects: readonly TrackEffect[] = [],
): Promise<{ pcm: Float32Array; ctx: MockHybridContext }> {
  const frames = Math.ceil((endTimeS - startTimeS) * sampleRate)
  const ctx = new MockHybridContext({ numberOfChannels: 2, length: frames, sampleRate })

  // Wire a decode override onto the mixer that consults our pre-seeded
  // bufferCache by source_path. The live mixer doesn't expose a
  // bufferCache injection, but we can short-circuit via the `decode`
  // override — it receives the ArrayBuffer but is keyed by URL via
  // fetchBytes. We track which URL was fetched so decode can look up the
  // correct AudioBuffer.
  let lastUrl = ''
  const opts: AudioMixerOptions = {
    audioCtxFactory: () => ctx as unknown as AudioContext,
    sourceUrlFactory: (project, path) => {
      const url = `mock://${project}/${path}`
      lastUrl = url
      return url
    },
    fetchBytes: async (url) => { lastUrl = url; return new ArrayBuffer(4) },
    decode: async () => {
      // Parse the source_path out of the URL and return the pre-seeded buffer.
      const path = lastUrl.replace(/^mock:\/\/[^/]+\//, '')
      const buf = buffers.get(path)
      if (!buf) throw new Error(`live-decode: no pre-seeded buffer for path ${path}`)
      return buf
    },
    masterEffects,
  }

  __clearDecodeCacheForTest()
  const mixer = createAudioMixer('p', tracks, opts)

  // Seek to the window start THEN play so every clip that opens at the
  // initial playhead gets activated.
  mixer.seek(startTimeS)
  mixer.play()
  // Flush async decodes (the mixer fires a fetch+decode in the background
  // when a clip is first encountered inside the window).
  for (let i = 0; i < 10; i++) await Promise.resolve()

  // Activate any clips that start AFTER startTimeS by seeking just past
  // each one. Use a large gap so the mixer treats each as a hardSeek.
  const allStarts = tracks
    .flatMap((t) => (t.clips ?? []).filter((c) => c.start_time > startTimeS && c.start_time < endTimeS))
    .map((c) => c.start_time)
    .sort((a, b) => a - b)

  for (const s of allStarts) {
    // Seek just past the clip start to trigger activation. Important:
    // advance only ε past start so subsequent clips aren't skipped over.
    mixer.seek(s + 1e-6)
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  // Now render the scheduled graph analytically.
  const rendered = await ctx.startRendering()
  const left = rendered.getChannelData(0)
  const right = rendered.getChannelData(1)
  const pcm = new Float32Array(left.length * 2)
  for (let i = 0; i < left.length; i++) {
    pcm[i * 2] = left[i]
    pcm[i * 2 + 1] = right[i]
  }

  mixer.dispose()
  return { pcm, ctx }
}

/** max(|a - b|) over two equal-length Float32Arrays. */
function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`length mismatch: ${a.length} vs ${b.length}`)
  let m = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > m) m = d
  }
  return m
}

// ── Tests ─────────────────────────────────────────────────────────────────

// Parity tolerance: both paths schedule onto the same deterministic mock,
// using identical helpers from mix-graph.ts — measured drift is EXACTLY 0
// (all six scenarios below hit maxAbsDiff === 0). 1e-6 leaves comfortable
// headroom and would still catch any real scheduling divergence. If a
// future refactor bumps the diff above zero but under the epsilon, that's
// still a signal worth investigating.
const EPSILON = 1e-6

describe('live vs offline PCM parity — single clip, no automation', () => {
  it('produces identical PCM for a 440 Hz sine clip that spans the render window', async () => {
    const sr = 48000
    const duration = 0.1
    const buf = makeBuffer(duration + 0.01, sr, 2, (f) => 0.5 * Math.sin((2 * Math.PI * 440 * f) / sr))
    const buffers = new Map<string, AudioBuffer>([['sine.wav', buf]])
    const tracks: AudioTrack[] = [
      mkTrack('t1', [mkClip({ id: 'c1', start_time: 0, end_time: duration, source_path: 'sine.wav' })]),
    ]

    const offline = await renderOffline(tracks, buffers, 0, duration, sr)
    const live = await renderLive(tracks, buffers, 0, duration, sr)

    const diff = maxAbsDiff(live.pcm, offline.pcm)
    expect(diff).toBeLessThan(EPSILON)
  })
})

describe('live vs offline PCM parity — clip with volume curve ramp', () => {
  it('matches on a fade-in from -60 dB to 0 dB over the clip', async () => {
    const sr = 48000
    const duration = 0.1
    const buf = makeBuffer(duration + 0.01, sr, 2, () => 0.7)
    const buffers = new Map<string, AudioBuffer>([['dc.wav', buf]])
    const clip = mkClip({
      id: 'c1',
      start_time: 0,
      end_time: duration,
      source_path: 'dc.wav',
      volume_curve: [[0, -60], [1, 0]],
    })
    const tracks: AudioTrack[] = [mkTrack('t1', [clip])]

    const offline = await renderOffline(tracks, buffers, 0, duration, sr)
    const live = await renderLive(tracks, buffers, 0, duration, sr)

    const diff = maxAbsDiff(live.pcm, offline.pcm)
    expect(diff).toBeLessThan(EPSILON)
  })

  it('matches on a track-level curve (absolute-seconds x)', async () => {
    const sr = 48000
    const duration = 0.1
    const buf = makeBuffer(duration + 0.01, sr, 2, () => 0.5)
    const buffers = new Map<string, AudioBuffer>([['dc.wav', buf]])
    const tracks: AudioTrack[] = [
      mkTrack(
        't1',
        [mkClip({ id: 'c1', start_time: 0, end_time: duration, source_path: 'dc.wav' })],
        { volume_curve: [[0, -12], [duration, 0]] },
      ),
    ]

    const offline = await renderOffline(tracks, buffers, 0, duration, sr)
    const live = await renderLive(tracks, buffers, 0, duration, sr)

    const diff = maxAbsDiff(live.pcm, offline.pcm)
    expect(diff).toBeLessThan(EPSILON)
  })
})

describe('live vs offline PCM parity — non-zero source_offset', () => {
  it('matches when a clip reads from an interior offset of its buffer', async () => {
    const sr = 48000
    const duration = 0.1
    // Source is a ramp so any offset drift would produce a different waveform.
    const buf = makeBuffer(0.5, sr, 2, (f) => f / (0.5 * sr)) // linear 0 → 1 over 500ms
    const buffers = new Map<string, AudioBuffer>([['ramp.wav', buf]])
    const tracks: AudioTrack[] = [
      mkTrack('t1', [
        mkClip({
          id: 'c1',
          start_time: 0,
          end_time: duration,
          source_path: 'ramp.wav',
          source_offset: 0.2, // start reading 200ms into the buffer
          effective_source_offset: 0.2,
        }),
      ]),
    ]

    const offline = await renderOffline(tracks, buffers, 0, duration, sr)
    const live = await renderLive(tracks, buffers, 0, duration, sr)

    const diff = maxAbsDiff(live.pcm, offline.pcm)
    expect(diff).toBeLessThan(EPSILON)
  })
})

describe('live vs offline PCM parity — playback window starting mid-clip', () => {
  it('matches when render starts inside an existing clip (seek-into-clip)', async () => {
    // Live mixer does seek-into-clip; offline renderer does sourceOffset math.
    // Both should agree on where to read from and how much to play.
    const sr = 48000
    const buf = makeBuffer(1, sr, 2, (f) => Math.sin((2 * Math.PI * 220 * f) / sr))
    const buffers = new Map<string, AudioBuffer>([['tone.wav', buf]])
    const tracks: AudioTrack[] = [
      mkTrack('t1', [
        mkClip({ id: 'c1', start_time: 0, end_time: 0.5, source_path: 'tone.wav' }),
      ]),
    ]

    // Render window [0.1, 0.3] — starts 100ms into the clip, ends 300ms in.
    const offline = await renderOffline(tracks, buffers, 0.1, 0.3, sr)
    const live = await renderLive(tracks, buffers, 0.1, 0.3, sr)

    const diff = maxAbsDiff(live.pcm, offline.pcm)
    expect(diff).toBeLessThan(EPSILON)
  })
})

describe('live vs offline PCM parity — muted track', () => {
  it('produces identical silence from a muted track', async () => {
    const sr = 48000
    const duration = 0.05
    const buf = makeBuffer(duration + 0.01, sr, 2, () => 1)
    const buffers = new Map<string, AudioBuffer>([['dc.wav', buf]])
    const tracks: AudioTrack[] = [
      mkTrack(
        't1',
        [mkClip({ id: 'c1', start_time: 0, end_time: duration, source_path: 'dc.wav' })],
        { muted: true },
      ),
    ]

    const offline = await renderOffline(tracks, buffers, 0, duration, sr)
    const live = await renderLive(tracks, buffers, 0, duration, sr)

    const diff = maxAbsDiff(live.pcm, offline.pcm)
    expect(diff).toBeLessThan(EPSILON)
    // Also assert both are actual silence.
    for (let i = 0; i < live.pcm.length; i++) {
      expect(live.pcm[i]).toBe(0)
      expect(offline.pcm[i]).toBe(0)
    }
  })
})

// ── Master-bus effect chain fidelity ─────────────────────────────────────

// Register a temporary effect_type that wraps a single GainNode. Using a
// plain gain as the "master effect" lets us verify live/offline parity
// without depending on the amplitude behavior of complex dynamics processors
// (which respond to signal history and can drift between paths for reasons
// orthogonal to scheduling parity).
const MASTER_TEST_TYPE = '__fidelity_master_gain'
EFFECT_TYPES[MASTER_TEST_TYPE] = {
  type: MASTER_TEST_TYPE,
  label: 'FidelityMasterGain',
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
      setParam: (_name, value, when) => { g.gain.setValueAtTime(value, when ?? ctx.currentTime) },
      scheduleCurve: () => { /* n/a for this test */ },
      dispose: () => { try { g.disconnect() } catch { /* ignore */ } },
    }
  },
}

describe('live vs offline PCM parity — master-bus effect chain', () => {
  it('matches with a single master-bus gain effect wired between masterGain and destination', async () => {
    const sr = 48000
    const duration = 0.1
    const buf = makeBuffer(duration + 0.01, sr, 2, (f) => 0.5 * Math.sin((2 * Math.PI * 440 * f) / sr))
    const buffers = new Map<string, AudioBuffer>([['sine.wav', buf]])
    const tracks: AudioTrack[] = [
      mkTrack('t1', [mkClip({ id: 'c1', start_time: 0, end_time: duration, source_path: 'sine.wav' })]),
    ]
    const masterEffects: TrackEffect[] = [{
      id: 'me1',
      track_id: '',
      effect_type: MASTER_TEST_TYPE,
      order_index: 0,
      enabled: true,
      static_params: { gain: 0.75 },
    }]

    const offline = await renderOffline(tracks, buffers, 0, duration, sr, masterEffects)
    const live = await renderLive(tracks, buffers, 0, duration, sr, masterEffects)

    const diff = maxAbsDiff(live.pcm, offline.pcm)
    // Expect EXACTLY 0 — both paths share buildEffectChain and set the same
    // setValueAtTime(0.75, 0) on the effect's gain param.
    expect(diff).toBe(0)

    // Sanity: the master effect actually attenuated (otherwise the test is
    // a noop and would silently pass even if one path ignored the chain).
    let liveEnergy = 0
    for (let i = 0; i < live.pcm.length; i++) liveEnergy += Math.abs(live.pcm[i])
    expect(liveEnergy).toBeGreaterThan(0)
    // Max PCM in live should be ≤ buffer peak (0.5) * gain (0.75) + ε.
    let liveMax = 0
    for (let i = 0; i < live.pcm.length; i++) {
      const v = Math.abs(live.pcm[i])
      if (v > liveMax) liveMax = v
    }
    expect(liveMax).toBeLessThan(0.5 * 0.75 + 1e-3)
  })
})

// ── Scenarios that require a real browser ─────────────────────────────────

// These are the scenarios where the live mixer's behavior is wall-clock
// dependent in a way that can't be reproduced mechanically on a mock. The
// offline renderer schedules every clip in the window up-front; the live
// mixer schedules them as the playhead crosses their boundaries. Our
// `renderLive()` helper mimics that by pumping sequential `seek()` calls,
// but two-clip same-track overlap (crossfade) can't be reliably mimicked
// without advancing the AudioContext's `currentTime` as each activation
// happens — otherwise the crossfade's anchor drifts.
//
// Follow-up Playwright test (M15 e2e) would capture the live mixer's
// master-analyser stream during wall-clock playback of these scenarios
// and compare against the offline WAV frame-for-frame.
describe.skip('live vs offline PCM parity — crossfade (browser-required)', () => {
  it('[SKIP — needs real AudioContext] two overlapping clips crossfade identically', async () => {
    const sr = 48000
    const bufA = makeBuffer(2, sr, 2, () => 1)
    const bufB = makeBuffer(2, sr, 2, () => -1)
    const buffers = new Map<string, AudioBuffer>([
      ['a.wav', bufA],
      ['b.wav', bufB],
    ])
    const tracks: AudioTrack[] = [
      mkTrack('t1', [
        mkClip({ id: 'cA', start_time: 0, end_time: 0.2, source_path: 'a.wav' }),
        mkClip({ id: 'cB', start_time: 0.1, end_time: 0.3, source_path: 'b.wav' }),
      ]),
    ]
    const offline = await renderOffline(tracks, buffers, 0, 0.3, sr)
    const live = await renderLive(tracks, buffers, 0, 0.3, sr)
    const diff = maxAbsDiff(live.pcm, offline.pcm)
    expect(diff).toBeLessThan(EPSILON)
  })
})
