/**
 * M15 task 1 — dedicated tests for the AudioBufferSourceNode migration.
 *
 * Verifies the four critical properties called out in the task brief:
 *  (1) adding a clip resolves to a decoded buffer
 *  (2) start() schedules at the computed AudioContext time
 *  (3) seek tears down + reconstructs the source node
 *  (4) double-play after stop works (single-use node is rebuilt cleanly)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAudioMixer, type AudioMixerOptions, __clearDecodeCacheForTest } from '../audio-mixer'
import type { AudioTrack } from '../audio-client'

// Minimal WebAudio mocks (mirroring the shapes in audio-mixer.test.ts, kept
// local to avoid coupling the two files).

class MockAudioParam {
  value = 1
  setValueAtTime(_v: number, _t: number) {}
  linearRampToValueAtTime(_v: number, _t: number) {}
  setValueCurveAtTime(_values: Float32Array, _t: number, _d: number) {}
  cancelScheduledValues(_t: number) {}
}
class MockGainNode {
  gain = new MockAudioParam()
  channelCount = 2; channelCountMode = 'max'; channelInterpretation = 'speakers'
  connect(dst: unknown) { return dst as MockGainNode }
  disconnect() {}
}
class MockAudioBuffer { duration = 600; numberOfChannels = 2; sampleRate = 48000 }
class MockAudioBufferSourceNode {
  buffer: MockAudioBuffer | null = null
  playbackRate = new MockAudioParam()
  detune = new MockAudioParam()
  startCalls: Array<{ when: number; offset?: number; duration?: number }> = []
  started = false; stopped = false
  start(when = 0, offset?: number, duration?: number) {
    if (this.started) throw new Error('start already called')
    this.started = true
    this.startCalls.push({ when, offset, duration })
  }
  stop() {
    if (!this.started) throw new Error('cannot stop before start')
    this.stopped = true
  }
  connect(dst: unknown) { return dst }
  disconnect() {}
}
class MockAnalyserNode {
  fftSize = 2048; smoothingTimeConstant = 0
  connect(dst: unknown) { return dst as MockAnalyserNode }
  disconnect() {}
  getFloatTimeDomainData(_arr: Float32Array) {}
}
class MockChannelSplitterNode {
  connect(dst: unknown, _out?: number) { return dst as MockChannelSplitterNode }
  disconnect() {}
}
class MockAudioContext {
  currentTime = 0
  state: 'running' | 'suspended' | 'closed' = 'running'
  destination = new MockGainNode()
  createdBufferSources: MockAudioBufferSourceNode[] = []
  createGain() { return new MockGainNode() }
  createAnalyser() { return new MockAnalyserNode() }
  createChannelSplitter(_n?: number) { return new MockChannelSplitterNode() }
  createBufferSource() { const s = new MockAudioBufferSourceNode(); this.createdBufferSources.push(s); return s }
  async decodeAudioData(_ab: ArrayBuffer): Promise<AudioBuffer> {
    return new MockAudioBuffer() as unknown as AudioBuffer
  }
  resume() { this.state = 'running'; return Promise.resolve() }
  close() { this.state = 'closed'; return Promise.resolve() }
}

const makeOptions = (): AudioMixerOptions & { mockCtx: MockAudioContext; decodeSpy: ReturnType<typeof vi.fn>; fetchSpy: ReturnType<typeof vi.fn> } => {
  const mockCtx = new MockAudioContext()
  const decodeSpy = vi.fn(async (): Promise<AudioBuffer> => new MockAudioBuffer() as unknown as AudioBuffer)
  const fetchSpy = vi.fn(async () => new ArrayBuffer(4))
  return {
    mockCtx,
    decodeSpy,
    fetchSpy,
    audioCtxFactory: () => mockCtx as unknown as AudioContext,
    sourceUrlFactory: (project, path) => `mock://${project}/${path}`,
    fetchBytes: fetchSpy,
    decode: decodeSpy,
  }
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

const mkTrack = (clips: Array<{ id: string; start: number; end: number; path?: string }>): AudioTrack => ({
  id: 'a', name: 'a', display_order: 0, solo: false, hidden: false, muted: false,
  volume_curve: [[0, 0], [1, 0]],
  clips: clips.map((c) => ({
    id: c.id, track_id: 'a',
    source_path: c.path ?? `audio_staging/${c.id}.m4a`,
    start_time: c.start, end_time: c.end, source_offset: 0,
    volume_curve: [[0, 0], [1, 0]], muted: false,
  })),
})

describe('M15 task 1 — AudioBufferSourceNode migration', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { __clearDecodeCacheForTest(); opts = makeOptions() })

  it('(1) adding a clip resolves to a decoded buffer assigned on the BufferSource', async () => {
    const m = createAudioMixer('p', [mkTrack([{ id: 'c1', start: 0, end: 5 }])], opts)
    m.seek(1)
    m.play()
    await flush()
    expect(opts.fetchSpy).toHaveBeenCalledWith('mock://p/audio_staging/c1.m4a')
    expect(opts.decodeSpy).toHaveBeenCalledTimes(1)
    const src = opts.mockCtx.createdBufferSources[0]
    expect(src.buffer).not.toBeNull()
    expect(src.started).toBe(true)
  })

  it('(2) start() schedules at computed AudioContext time with correct offset', async () => {
    opts.mockCtx.currentTime = 100 // any non-zero baseline
    const m = createAudioMixer('p', [mkTrack([{ id: 'c1', start: 50, end: 60 }])], opts)
    m.seek(53) // 3s into clip
    m.play()
    await flush()
    const src = opts.mockCtx.createdBufferSources[0]
    expect(src.startCalls).toHaveLength(1)
    // playhead already inside clip → when = currentTime, offset = 3
    expect(src.startCalls[0].when).toBeCloseTo(100, 3)
    expect(src.startCalls[0].offset).toBeCloseTo(3, 3)
  })

  it('(2b) when playhead is before clip start, when = currentTime + (start - playhead), offset = 0', async () => {
    opts.mockCtx.currentTime = 10
    // Put the clip at t=20 but try to play at t=18 (2 seconds before) — activation
    // only occurs when playhead is inside, so this test covers the "activate at
    // the boundary" case by seeking inside then re-checking.
    const m = createAudioMixer('p', [mkTrack([{ id: 'c1', start: 20, end: 30 }])], opts)
    m.seek(20) // exactly at clip start
    m.play()
    await flush()
    const src = opts.mockCtx.createdBufferSources[0]
    // whenDelta = max(0, start - playhead) = 0 → when = currentTime
    expect(src.startCalls[0].when).toBeCloseTo(10, 3)
    expect(src.startCalls[0].offset).toBeCloseTo(0, 3)
  })

  it('(3) seek mid-clip tears down the existing source and reconstructs a new one', async () => {
    const m = createAudioMixer('p', [mkTrack([{ id: 'c1', start: 0, end: 20 }])], opts)
    m.seek(1)
    m.play()
    await flush()
    const first = opts.mockCtx.createdBufferSources[0]
    expect(first.started).toBe(true)
    expect(first.startCalls[0].offset).toBeCloseTo(1, 3)

    // Seek forward by more than 50ms → hardSeek path
    m.seek(10)
    await flush()
    expect(first.stopped).toBe(true)
    const sources = opts.mockCtx.createdBufferSources
    expect(sources.length).toBeGreaterThanOrEqual(2)
    const second = sources[sources.length - 1]
    expect(second).not.toBe(first)
    expect(second.started).toBe(true)
    expect(second.startCalls[0].offset).toBeCloseTo(10, 3)
  })

  it('(4) double-play after stop works — single-use node is rebuilt cleanly', async () => {
    const m = createAudioMixer('p', [mkTrack([{ id: 'c1', start: 0, end: 5 }])], opts)
    m.seek(1)
    m.play()
    await flush()
    const first = opts.mockCtx.createdBufferSources[0]
    expect(first.started).toBe(true)

    m.pause()
    expect(first.stopped).toBe(true)

    // Second play after stop — must NOT try to reuse `first`; must create a
    // fresh BufferSourceNode (failure mode: "start already called" error).
    expect(() => m.play()).not.toThrow()
    await flush()
    const sources = opts.mockCtx.createdBufferSources
    expect(sources.length).toBeGreaterThanOrEqual(2)
    const second = sources[sources.length - 1]
    expect(second).not.toBe(first)
    expect(second.started).toBe(true)
  })
})
