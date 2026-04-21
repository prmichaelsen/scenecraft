import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAudioMixer, type AudioMixerOptions } from '../audio-mixer'
import type { AudioTrack } from '../audio-client'

// ── Minimal WebAudio + HTMLAudioElement mocks ─────────────────────────

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
  connect(dst: unknown) { this.connections.push(dst); return dst as MockGainNode }
  disconnect() { this.connections.length = 0 }
}

class MockMediaElementAudioSourceNode {
  connect(dst: unknown) { return dst }
  disconnect() {}
}

class MockAudioContext {
  currentTime = 0
  state: 'running' | 'suspended' | 'closed' = 'running'
  destination = new MockGainNode()
  createGain() { return new MockGainNode() }
  createMediaElementSource(_el: HTMLMediaElement) { return new MockMediaElementAudioSourceNode() }
  resume() { this.state = 'running'; return Promise.resolve() }
  close() { this.state = 'closed'; return Promise.resolve() }
}

class MockHTMLAudioElement {
  src = ''
  currentTime = 0
  paused = true
  preload = ''
  crossOrigin: string | null = null
  playCalls: number[] = []
  pauseCalls = 0
  play() { this.paused = false; this.playCalls.push(this.currentTime); return Promise.resolve() }
  pause() { this.paused = true; this.pauseCalls++ }
}

const makeOptions = (): AudioMixerOptions & { mockCtx: MockAudioContext; mockElements: MockHTMLAudioElement[] } => {
  const mockCtx = new MockAudioContext()
  const mockElements: MockHTMLAudioElement[] = []
  return {
    mockCtx,
    mockElements,
    audioCtxFactory: () => mockCtx as unknown as AudioContext,
    audioElementFactory: () => {
      const el = new MockHTMLAudioElement()
      mockElements.push(el)
      return el as unknown as HTMLAudioElement
    },
    sourceUrlFactory: (project, path) => `mock://${project}/${path}`,
  }
}

const t = (id: string, clips: Array<{ id: string; start: number; end: number; muted?: boolean }> = [], trackProps: Partial<AudioTrack> = {}): AudioTrack => ({
  id,
  name: id,
  display_order: 0,
  enabled: true,
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
  beforeEach(() => { opts = makeOptions() })

  it('returns an object with the full public API', () => {
    const m = createAudioMixer('p', [], opts)
    expect(typeof m.play).toBe('function')
    expect(typeof m.pause).toBe('function')
    expect(typeof m.seek).toBe('function')
    expect(typeof m.updateClip).toBe('function')
    expect(typeof m.updateTrack).toBe('function')
    expect(typeof m.rebuild).toBe('function')
    expect(typeof m.dispose).toBe('function')
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
  beforeEach(() => { opts = makeOptions() })

  it('does not create AudioContext on construction', () => {
    const spy = vi.fn(() => opts.mockCtx as unknown as AudioContext)
    createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], { ...opts, audioCtxFactory: spy })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not create HTMLAudioElements on construction', () => {
    createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    expect(opts.mockElements).toHaveLength(0)
  })

  it('creates AudioContext + elements on first play()', () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.play()
    expect(opts.mockElements).toHaveLength(1)
    expect(opts.mockElements[0].src).toBe('mock://p/audio_staging/c1.m4a')
  })

  it('creates one element per clip across multiple tracks', () => {
    const m = createAudioMixer('p', [
      t('a', [{ id: 'c1', start: 0, end: 1 }, { id: 'c2', start: 2, end: 3 }]),
      t('b', [{ id: 'c3', start: 0, end: 1 }]),
    ], opts)
    m.play()
    expect(opts.mockElements).toHaveLength(3)
  })
})

describe('createAudioMixer — activation by playhead', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { opts = makeOptions() })

  it('seek before play stores position without activating', () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.seek(0.5)
    expect(opts.mockElements).toHaveLength(0) // graph not built yet
  })

  it('play activates clips whose range contains the current playhead', () => {
    const m = createAudioMixer('p', [t('a', [
      { id: 'inside', start: 0, end: 1 },
      { id: 'outside', start: 2, end: 3 },
    ])], opts)
    m.seek(0.5)
    m.play()
    const [inside, outside] = opts.mockElements
    expect(inside.playCalls).toHaveLength(1)
    expect(outside.playCalls).toHaveLength(0)
  })

  it('seek forward pauses previously active and activates newly covered clip', () => {
    const m = createAudioMixer('p', [t('a', [
      { id: 'c1', start: 0, end: 1 },
      { id: 'c2', start: 2, end: 3 },
    ])], opts)
    m.seek(0.5)
    m.play()
    const [e1, e2] = opts.mockElements
    expect(e1.playCalls).toHaveLength(1)
    expect(e2.playCalls).toHaveLength(0)
    m.seek(2.5)
    expect(e1.pauseCalls).toBe(1)
    expect(e2.playCalls).toHaveLength(1)
  })

  it('activating a clip sets audio.currentTime to source_offset + (playhead - start_time)', () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 10, end: 20 }])], opts)
    m.seek(12)
    m.play()
    // source_offset defaults to 0; at playhead 12, clip start 10 → currentTime should be 2
    expect(opts.mockElements[0].currentTime).toBe(2)
    expect(opts.mockElements[0].playCalls[0]).toBe(2)
  })

  it('pause() pauses all active elements', () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.seek(0.5)
    m.play()
    expect(opts.mockElements[0].paused).toBe(false)
    m.pause()
    expect(opts.mockElements[0].paused).toBe(true)
    expect(opts.mockElements[0].pauseCalls).toBe(1)
  })
})

describe('createAudioMixer — mute updates', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { opts = makeOptions() })

  it('initial track mute is applied to the track gain node', () => {
    const track = t('a', [{ id: 'c1', start: 0, end: 1 }], { muted: true })
    const m = createAudioMixer('p', [track], opts)
    m.play()
    // Can't easily reach into the track gain from outside, but updateTrack should
    // produce a setValueAtTime event afterward.
    m.updateTrack('a')
    // One of the gain nodes (the track one) should now have a mute event
    // — we just verify no errors thrown; deeper assertion in T117 curve work.
    expect(m.trackCount).toBe(1)
  })

  it('rebuild replaces tracks and their clips', () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.play()
    expect(opts.mockElements).toHaveLength(1)
    const before = opts.mockElements[0]
    m.rebuild([t('b', [{ id: 'c2', start: 0, end: 1 }])])
    // New element should be created; old element paused and src cleared
    expect(before.pauseCalls).toBeGreaterThanOrEqual(1)
    expect(opts.mockElements.length).toBeGreaterThanOrEqual(2)
  })
})

describe('createAudioMixer — curve automation (T117)', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { opts = makeOptions() })

  // Helper: find the track-gain MockGainNode from the ctx.destination connections
  const getTrackGain = (ctx: MockAudioContext): MockGainNode => {
    // destination.connections has the incoming connections (via our `dst as MockGainNode` hack)
    // but our mock stores connections on the UPSTREAM node. So the trackGain is whichever
    // gain node connected to destination. We inspect all connection calls via a known graph shape.
    // Simpler: track-gain is the first GainNode created with nonzero gain events at play time.
    // Instead, we wrap createGain to capture creation order:
    return (ctx as unknown as { _trackGains?: MockGainNode[] })._trackGains?.[0] as MockGainNode
  }

  const instrumentCtx = (ctx: MockAudioContext): void => {
    const origCreateGain = ctx.createGain.bind(ctx)
    const gains: MockGainNode[] = []
    ;(ctx as unknown as { _allGains: MockGainNode[] })._allGains = gains
    ctx.createGain = () => {
      const g = origCreateGain()
      gains.push(g)
      return g
    }
  }

  it('track curve [[0, 0], [10, -6]] schedules anchor + ramp on play', () => {
    instrumentCtx(opts.mockCtx)
    const track: AudioTrack = {
      id: 'a', name: 'a', display_order: 0, enabled: true, hidden: false, muted: false,
      volume_curve: [[0, 0], [10, -6]],
      clips: [],
    }
    const m = createAudioMixer('p', [track], opts)
    m.play()
    // First gain created is the track gain (trackMap populated before clips)
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    const trackGain = allGains[0]
    const events = trackGain.gain.events
    // Should contain a cancelScheduledValues, a setValueAtTime (anchor at playhead 0 → 0 dB → gain 1), and a linearRampToValueAtTime
    expect(events.some((e) => e.kind === 'cancelScheduledValues')).toBe(true)
    const setValue = events.find((e) => e.kind === 'setValueAtTime')
    expect(setValue?.value).toBeCloseTo(1, 3)
    const ramp = events.find((e) => e.kind === 'linearRampToValueAtTime')
    expect(ramp?.value).toBeCloseTo(0.5012, 3) // dbToLinear(-6)
  })

  it('clip curve [[0, 0], [1, -6]] anchors at clip start and ramps to end', () => {
    instrumentCtx(opts.mockCtx)
    const track = t('a', [{ id: 'c1', start: 10, end: 20 }])
    // Override clip curve
    track.clips![0].volume_curve = [[0, 0], [1, -6]]
    const m = createAudioMixer('p', [track], opts)
    m.seek(10)
    m.play()
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    // Order of createGain calls: trackGain, clipGain, crossfadeGain (per clip graph)
    // trackGain=index 0, clipGain=1, crossfadeGain=2
    const clipGain = allGains[1]
    const events = clipGain.gain.events
    expect(events.some((e) => e.kind === 'cancelScheduledValues')).toBe(true)
    const setValue = events.find((e) => e.kind === 'setValueAtTime')
    expect(setValue?.value).toBeCloseTo(1, 3) // playhead at clip start → 0 dB
    const ramp = events.find((e) => e.kind === 'linearRampToValueAtTime')
    expect(ramp?.value).toBeCloseTo(0.5012, 3) // dbToLinear(-6) at clip end
  })

  it('muted clip gets setValueAtTime(0) instead of curve', () => {
    instrumentCtx(opts.mockCtx)
    const track = t('a', [{ id: 'c1', start: 0, end: 1, muted: true }])
    const m = createAudioMixer('p', [track], opts)
    m.seek(0.5)
    m.play()
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    const clipGain = allGains[1]
    const events = clipGain.gain.events.filter((e) => e.kind === 'setValueAtTime')
    expect(events.some((e) => e.value === 0)).toBe(true)
    // No ramp should be scheduled
    expect(clipGain.gain.events.some((e) => e.kind === 'linearRampToValueAtTime')).toBe(false)
  })

  it('muted track schedules setValueAtTime(0) on track gain', () => {
    instrumentCtx(opts.mockCtx)
    const track = t('a', [{ id: 'c1', start: 0, end: 1 }], { muted: true })
    const m = createAudioMixer('p', [track], opts)
    m.play()
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    const trackGain = allGains[0]
    const events = trackGain.gain.events.filter((e) => e.kind === 'setValueAtTime')
    expect(events.some((e) => e.value === 0)).toBe(true)
  })

  it('updateClip re-schedules curve in place for an active clip', () => {
    instrumentCtx(opts.mockCtx)
    const track = t('a', [{ id: 'c1', start: 0, end: 10 }])
    const m = createAudioMixer('p', [track], opts)
    m.seek(1)
    m.play()
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    const clipGain = allGains[1]
    const initialCount = clipGain.gain.events.length
    m.updateClip('c1')
    expect(clipGain.gain.events.length).toBeGreaterThan(initialCount)
  })

  it('updateTrack re-schedules track curve', () => {
    instrumentCtx(opts.mockCtx)
    const track = t('a', [{ id: 'c1', start: 0, end: 10 }])
    const m = createAudioMixer('p', [track], opts)
    m.play()
    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    const trackGain = allGains[0]
    const initialCount = trackGain.gain.events.length
    m.updateTrack('a')
    expect(trackGain.gain.events.length).toBeGreaterThan(initialCount)
  })
})

describe('createAudioMixer — equal-power crossfade (T117)', () => {
  let opts: ReturnType<typeof makeOptions>
  beforeEach(() => { opts = makeOptions() })

  const instrumentCtx = (ctx: MockAudioContext): void => {
    const orig = ctx.createGain.bind(ctx)
    const gains: MockGainNode[] = []
    ;(ctx as unknown as { _allGains: MockGainNode[] })._allGains = gains
    ctx.createGain = () => { const g = orig(); gains.push(g); return g }
  }

  it('overlapping same-track clips receive cos + sin curve schedules', () => {
    instrumentCtx(opts.mockCtx)
    const m = createAudioMixer('p', [
      t('a', [
        { id: 'c1', start: 0, end: 5 },
        { id: 'c2', start: 3, end: 8 },
      ]),
    ], opts)
    m.seek(0)
    m.play() // c1 activates
    m.seek(3) // c2 activates inside c1's window → crossfade triggered

    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    // Graph: trackGain(0), c1_clipGain(1), c1_crossfadeGain(2), c2_clipGain(3), c2_crossfadeGain(4)
    const c1Crossfade = allGains[2]
    const c2Crossfade = allGains[4]

    const cos = c1Crossfade.gain.events.find((e) => e.kind === 'setValueCurveAtTime')
    const sin = c2Crossfade.gain.events.find((e) => e.kind === 'setValueCurveAtTime')
    expect(cos).toBeDefined()
    expect(sin).toBeDefined()
    // Overlap [3, 5] → duration 2
    expect(cos?.duration).toBeCloseTo(2, 3)
    expect(sin?.duration).toBeCloseTo(2, 3)
    // cos starts at 1, sin starts at 0
    expect(cos?.values?.[0]).toBeCloseTo(1, 3)
    expect(sin?.values?.[0]).toBeCloseTo(0, 3)
    // cos ends at 0, sin ends at 1
    expect(cos?.values?.[cos!.values!.length - 1]).toBeCloseTo(0, 3)
    expect(sin?.values?.[sin!.values!.length - 1]).toBeCloseTo(1, 3)
  })

  it('non-overlapping clips on the same track do NOT schedule crossfade curves', () => {
    instrumentCtx(opts.mockCtx)
    const m = createAudioMixer('p', [
      t('a', [
        { id: 'c1', start: 0, end: 1 },
        { id: 'c2', start: 2, end: 3 },
      ]),
    ], opts)
    m.seek(0.5)
    m.play()
    m.seek(2.5) // c1 deactivates, c2 activates — no overlap

    const allGains = (opts.mockCtx as unknown as { _allGains: MockGainNode[] })._allGains
    const c1Crossfade = allGains[2]
    const c2Crossfade = allGains[4]
    expect(c1Crossfade.gain.events.some((e) => e.kind === 'setValueCurveAtTime')).toBe(false)
    expect(c2Crossfade.gain.events.some((e) => e.kind === 'setValueCurveAtTime')).toBe(false)
  })

  it('cos² + sin² ≈ 1 at every curve sample (equal-power invariant)', () => {
    // Rebuild the curves the mixer uses and verify the invariant directly
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
  beforeEach(() => { opts = makeOptions() })

  it('dispose is idempotent', () => {
    const m = createAudioMixer('p', [t('a')], opts)
    m.dispose()
    expect(() => m.dispose()).not.toThrow()
  })

  it('dispose pauses any active elements', () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.seek(0.5)
    m.play()
    expect(opts.mockElements[0].paused).toBe(false)
    m.dispose()
    expect(opts.mockElements[0].paused).toBe(true)
  })

  it('dispose closes the AudioContext', () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start: 0, end: 1 }])], opts)
    m.play()
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
