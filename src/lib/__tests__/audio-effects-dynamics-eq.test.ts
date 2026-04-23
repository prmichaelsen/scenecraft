import { describe, it, expect } from 'vitest'
import {
  buildCompressor,
  buildGate,
  buildLimiter,
} from '../audio-effects/dynamics'
import {
  buildEQBand,
  buildHighpass,
  buildLowpass,
} from '../audio-effects/eq'
import type { EffectNode } from '../audio-effect-types'

// ── Minimal WebAudio mocks (happy-dom has no AudioContext) ─────────────

class MockAudioParam {
  value = 0
  events: Array<{ kind: string; value: number; time: number }> = []
  setValueAtTime(v: number, t: number): void {
    this.value = v
    this.events.push({ kind: 'setValueAtTime', value: v, time: t })
  }
}

class MockDynamicsCompressorNode {
  threshold = new MockAudioParam()
  ratio = new MockAudioParam()
  attack = new MockAudioParam()
  release = new MockAudioParam()
  knee = new MockAudioParam()
  disconnectCalls = 0
  disconnect(): void { this.disconnectCalls++ }
}

class MockBiquadFilterNode {
  type: BiquadFilterType = 'peaking'
  frequency = new MockAudioParam()
  gain = new MockAudioParam()
  Q = new MockAudioParam()
  disconnectCalls = 0
  disconnect(): void { this.disconnectCalls++ }
}

interface MockCtxState {
  lastCompressor?: MockDynamicsCompressorNode
  lastBiquad?: MockBiquadFilterNode
}

type MockCtx = AudioContext & MockCtxState

function makeCtx(): MockCtx {
  const state: MockCtxState = {}
  const ctx = {
    currentTime: 10,
    get lastCompressor() { return state.lastCompressor },
    get lastBiquad() { return state.lastBiquad },
    createDynamicsCompressor(): MockDynamicsCompressorNode {
      const n = new MockDynamicsCompressorNode()
      state.lastCompressor = n
      return n
    },
    createBiquadFilter(): MockBiquadFilterNode {
      const n = new MockBiquadFilterNode()
      state.lastBiquad = n
      return n
    },
  }
  return ctx as unknown as MockCtx
}

function expectValidEffectNode(node: EffectNode): void {
  expect(node).toBeDefined()
  expect(node.input).toBeDefined()
  expect(node.output).toBeDefined()
  expect(typeof node.setParam).toBe('function')
  expect(typeof node.scheduleCurve).toBe('function')
  expect(typeof node.dispose).toBe('function')
}

// ── Dynamics ───────────────────────────────────────────────────────────

describe('buildCompressor', () => {
  it('returns a valid EffectNode', () => {
    const ctx = makeCtx()
    const node = buildCompressor(ctx, {})
    expectValidEffectNode(node)
    expect(ctx.lastCompressor).toBeDefined()
    expect(node.input).toBe(ctx.lastCompressor)
    expect(node.output).toBe(ctx.lastCompressor)
  })

  it('setParam on each animatable param writes to the correct AudioParam', () => {
    const ctx = makeCtx()
    const node = buildCompressor(ctx, {})
    const comp = ctx.lastCompressor!

    node.setParam('threshold', -12)
    expect(comp.threshold.value).toBe(-12)

    node.setParam('ratio', 8)
    expect(comp.ratio.value).toBe(8)

    node.setParam('attack', 0.01)
    expect(comp.attack.value).toBe(0.01)

    node.setParam('release', 0.4)
    expect(comp.release.value).toBe(0.4)

    node.setParam('knee', 12)
    expect(comp.knee.value).toBe(12)
  })

  it('setParam on unknown param throws', () => {
    const ctx = makeCtx()
    const node = buildCompressor(ctx, {})
    expect(() => node.setParam('bogus', 1)).toThrow(/unknown animatable param: bogus/)
  })

  it('dispose disconnects the underlying node', () => {
    const ctx = makeCtx()
    const node = buildCompressor(ctx, {})
    const comp = ctx.lastCompressor!
    node.dispose()
    expect(comp.disconnectCalls).toBe(1)
  })

  it('dispose swallows errors from double-disconnect', () => {
    const ctx = makeCtx()
    const node = buildCompressor(ctx, {})
    const comp = ctx.lastCompressor!
    comp.disconnect = () => { throw new Error('already disconnected') }
    expect(() => node.dispose()).not.toThrow()
  })
})

describe('buildGate', () => {
  it('returns a valid EffectNode', () => {
    const ctx = makeCtx()
    const node = buildGate(ctx, {})
    expectValidEffectNode(node)
  })

  it('exposes threshold, attack, release as animatable', () => {
    const ctx = makeCtx()
    const node = buildGate(ctx, {})
    const comp = ctx.lastCompressor!

    node.setParam('threshold', -20)
    expect(comp.threshold.value).toBe(-20)

    node.setParam('attack', 0.02)
    expect(comp.attack.value).toBe(0.02)

    node.setParam('release', 0.2)
    expect(comp.release.value).toBe(0.2)
  })

  it('does NOT expose ratio or knee as animatable', () => {
    const ctx = makeCtx()
    const node = buildGate(ctx, {})
    expect(() => node.setParam('ratio', 10)).toThrow(/unknown animatable param: ratio/)
    expect(() => node.setParam('knee', 5)).toThrow(/unknown animatable param: knee/)
  })

  it('dispose disconnects cleanly', () => {
    const ctx = makeCtx()
    const node = buildGate(ctx, {})
    const comp = ctx.lastCompressor!
    node.dispose()
    expect(comp.disconnectCalls).toBe(1)
  })
})

describe('buildLimiter', () => {
  it('returns a valid EffectNode with ratio >= 20 and fast attack', () => {
    const ctx = makeCtx()
    const node = buildLimiter(ctx, {})
    expectValidEffectNode(node)
    const comp = ctx.lastCompressor!
    expect(comp.ratio.value).toBeGreaterThanOrEqual(20)
    expect(comp.attack.value).toBeLessThanOrEqual(0.01)
  })

  it('exposes only ceiling and release as animatable (ceiling maps to threshold)', () => {
    const ctx = makeCtx()
    const node = buildLimiter(ctx, {})
    const comp = ctx.lastCompressor!

    // `ceiling` on a limiter is the underlying compressor threshold.
    node.setParam('ceiling', -1)
    expect(comp.threshold.value).toBe(-1)

    node.setParam('release', 0.08)
    expect(comp.release.value).toBe(0.08)

    expect(() => node.setParam('threshold', -1)).toThrow(/unknown animatable param: threshold/)
    expect(() => node.setParam('ratio', 15)).toThrow(/unknown animatable param: ratio/)
    expect(() => node.setParam('attack', 0.005)).toThrow(/unknown animatable param: attack/)
  })

  it('dispose disconnects cleanly', () => {
    const ctx = makeCtx()
    const node = buildLimiter(ctx, {})
    const comp = ctx.lastCompressor!
    node.dispose()
    expect(comp.disconnectCalls).toBe(1)
  })
})

// ── EQ ─────────────────────────────────────────────────────────────────

describe('buildEQBand', () => {
  it('returns a valid EffectNode backed by a peaking BiquadFilter', () => {
    const ctx = makeCtx()
    const node = buildEQBand(ctx, {})
    expectValidEffectNode(node)
    expect(ctx.lastBiquad).toBeDefined()
    expect(ctx.lastBiquad!.type).toBe('peaking')
    expect(node.input).toBe(ctx.lastBiquad)
  })

  it('freq=1000 + gain=+6 writes to BiquadFilter.frequency + gain', () => {
    const ctx = makeCtx()
    const node = buildEQBand(ctx, {})
    const biq = ctx.lastBiquad!

    node.setParam('freq', 1000)
    expect(biq.frequency.value).toBe(1000)

    node.setParam('gain', 6)
    expect(biq.gain.value).toBe(6)

    node.setParam('q', 2.5)
    expect(biq.Q.value).toBe(2.5)
  })

  it('unknown param throws', () => {
    const ctx = makeCtx()
    const node = buildEQBand(ctx, {})
    expect(() => node.setParam('cutoff', 100)).toThrow(/unknown animatable param: cutoff/)
  })

  it('dispose disconnects cleanly', () => {
    const ctx = makeCtx()
    const node = buildEQBand(ctx, {})
    const biq = ctx.lastBiquad!
    node.dispose()
    expect(biq.disconnectCalls).toBe(1)
  })
})

describe('buildHighpass', () => {
  it('returns a valid EffectNode backed by a highpass BiquadFilter', () => {
    const ctx = makeCtx()
    const node = buildHighpass(ctx, {})
    expectValidEffectNode(node)
    expect(ctx.lastBiquad!.type).toBe('highpass')
  })

  it('cutoff maps to BiquadFilter.frequency; q maps to Q', () => {
    const ctx = makeCtx()
    const node = buildHighpass(ctx, {})
    const biq = ctx.lastBiquad!

    node.setParam('cutoff', 250)
    expect(biq.frequency.value).toBe(250)

    node.setParam('q', 1.5)
    expect(biq.Q.value).toBe(1.5)
  })

  it('rejects non-filter params (no freq, no gain exposed)', () => {
    const ctx = makeCtx()
    const node = buildHighpass(ctx, {})
    expect(() => node.setParam('freq', 200)).toThrow(/unknown animatable param: freq/)
    expect(() => node.setParam('gain', 3)).toThrow(/unknown animatable param: gain/)
  })

  it('dispose disconnects cleanly', () => {
    const ctx = makeCtx()
    const node = buildHighpass(ctx, {})
    const biq = ctx.lastBiquad!
    node.dispose()
    expect(biq.disconnectCalls).toBe(1)
  })
})

describe('buildLowpass', () => {
  it('returns a valid EffectNode backed by a lowpass BiquadFilter', () => {
    const ctx = makeCtx()
    const node = buildLowpass(ctx, {})
    expectValidEffectNode(node)
    expect(ctx.lastBiquad!.type).toBe('lowpass')
  })

  it('cutoff + q are animatable, nothing else', () => {
    const ctx = makeCtx()
    const node = buildLowpass(ctx, {})
    const biq = ctx.lastBiquad!

    node.setParam('cutoff', 4000)
    expect(biq.frequency.value).toBe(4000)

    node.setParam('q', 0.8)
    expect(biq.Q.value).toBe(0.8)

    expect(() => node.setParam('gain', 3)).toThrow(/unknown animatable param: gain/)
  })

  it('dispose disconnects cleanly', () => {
    const ctx = makeCtx()
    const node = buildLowpass(ctx, {})
    const biq = ctx.lastBiquad!
    node.dispose()
    expect(biq.disconnectCalls).toBe(1)
  })
})

// ── Curve scheduling (passthrough) ─────────────────────────────────────

describe('scheduleCurve (passthrough)', () => {
  it('schedules one setValueAtTime per curve point at startTime + x*duration', () => {
    const ctx = makeCtx()
    const node = buildEQBand(ctx, {})
    const biq = ctx.lastBiquad!

    node.scheduleCurve(
      'gain',
      [[0, -6], [0.5, 0], [1, 6]],
      100, // startTime
      4, // duration
    )

    const events = biq.gain.events
    // The build() itself wrote one setValueAtTime(0, ctx.currentTime); ignore that.
    const scheduled = events.filter(e => e.time >= 100)
    expect(scheduled).toHaveLength(3)
    expect(scheduled[0]).toMatchObject({ value: -6, time: 100 })
    expect(scheduled[1]).toMatchObject({ value: 0, time: 102 })
    expect(scheduled[2]).toMatchObject({ value: 6, time: 104 })
  })

  it('scheduleCurve on unknown param throws', () => {
    const ctx = makeCtx()
    const node = buildCompressor(ctx, {})
    expect(() =>
      node.scheduleCurve('bogus', [[0, 0]], 0, 1),
    ).toThrow(/unknown animatable param: bogus/)
  })
})

