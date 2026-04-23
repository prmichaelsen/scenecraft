/**
 * M13 task-51 test suite for modulation + drive effects.
 *
 * happy-dom does not ship a WebAudio implementation, so every test builds
 * against a hand-rolled MockAudioContext that records every AudioParam event
 * and exposes node instances (OscillatorNode mock, WaveShaperNode mock, …)
 * so we can assert on internal graph composition.
 *
 * Test goals:
 *   - Each builder produces a valid EffectNode (input/output + 4 hooks).
 *   - Static params (rate on LFO effects, character on drive) warn when
 *     mutated at runtime (setParam / scheduleCurve).
 *   - Tremolo at rate=5 + depth=0.5 lands an OscillatorNode.frequency.value
 *     of 5 and a depth-gain AudioParam value of 0.5.
 *   - Chorus/flanger/phaser internal node counts match the documented
 *     topology.
 *   - Drive produces distinct curves per character.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildTremolo,
  buildAutoPan,
  buildChorus,
  buildFlanger,
  buildPhaser,
  __internals as modInternals,
} from '../audio-effects/modulation'
import { buildDrive, getDriveCurve, type DriveCharacter } from '../audio-effects/drive'

// ── Mocks ────────────────────────────────────────────────────────────────

type ParamEvent =
  | { kind: 'setValueAtTime'; value: number; time: number }
  | { kind: 'setValueCurveAtTime'; values: Float32Array; time: number; duration: number }
  | { kind: 'linearRampToValueAtTime'; value: number; time: number }
  | { kind: 'cancelScheduledValues'; time: number }

class MockAudioParam {
  value: number
  events: ParamEvent[] = []
  constructor(initial = 0) { this.value = initial }
  setValueAtTime(v: number, t: number) { this.value = v; this.events.push({ kind: 'setValueAtTime', value: v, time: t }) }
  setValueCurveAtTime(values: Float32Array, t: number, duration: number) {
    this.events.push({ kind: 'setValueCurveAtTime', values, time: t, duration })
    this.value = values[values.length - 1]
  }
  linearRampToValueAtTime(v: number, t: number) { this.value = v; this.events.push({ kind: 'linearRampToValueAtTime', value: v, time: t }) }
  cancelScheduledValues(t: number) { this.events.push({ kind: 'cancelScheduledValues', time: t }) }
}

interface MockNodeLike {
  __kind: string
  connections: unknown[]
  connect(dst: unknown): unknown
  disconnect(): void
}

function baseNode(kind: string): Pick<MockNodeLike, '__kind' | 'connections'> & {
  connect(dst: unknown): unknown
  disconnect(): void
} {
  const connections: unknown[] = []
  return {
    __kind: kind,
    connections,
    connect(dst: unknown) {
      connections.push(dst)
      return dst
    },
    disconnect() {
      connections.length = 0
    },
  }
}

class MockGainNode {
  gain = new MockAudioParam(1)
  __kind = 'GainNode'
  connections: unknown[] = []
  connect(dst: unknown) { this.connections.push(dst); return dst }
  disconnect() { this.connections.length = 0 }
}

class MockOscillatorNode {
  type: OscillatorType = 'sine'
  frequency = new MockAudioParam(440)
  __kind = 'OscillatorNode'
  started = false
  stopped = false
  connections: unknown[] = []
  connect(dst: unknown) { this.connections.push(dst); return dst }
  disconnect() { this.connections.length = 0 }
  start() { this.started = true }
  stop() {
    if (this.stopped) throw new Error('already stopped')
    this.stopped = true
  }
}

class MockStereoPannerNode {
  pan = new MockAudioParam(0)
  __kind = 'StereoPannerNode'
  connections: unknown[] = []
  connect(dst: unknown) { this.connections.push(dst); return dst }
  disconnect() { this.connections.length = 0 }
}

class MockDelayNode {
  delayTime = new MockAudioParam(0)
  __kind = 'DelayNode'
  connections: unknown[] = []
  maxDelayTime: number
  constructor(maxDelay = 1) { this.maxDelayTime = maxDelay }
  connect(dst: unknown) { this.connections.push(dst); return dst }
  disconnect() { this.connections.length = 0 }
}

class MockBiquadFilterNode {
  type: BiquadFilterType = 'allpass'
  frequency = new MockAudioParam(350)
  Q = new MockAudioParam(1)
  gain = new MockAudioParam(0)
  __kind = 'BiquadFilterNode'
  connections: unknown[] = []
  connect(dst: unknown) { this.connections.push(dst); return dst }
  disconnect() { this.connections.length = 0 }
}

class MockWaveShaperNode {
  curve: Float32Array | null = null
  oversample: OverSampleType = 'none'
  __kind = 'WaveShaperNode'
  connections: unknown[] = []
  connect(dst: unknown) { this.connections.push(dst); return dst }
  disconnect() { this.connections.length = 0 }
}

class MockAudioContext {
  currentTime = 0
  state: 'running' | 'suspended' | 'closed' = 'running'
  created: MockNodeLike[] = []
  createGain() { const n = new MockGainNode(); this.created.push(n); return n }
  createOscillator() { const n = new MockOscillatorNode(); this.created.push(n); return n }
  createStereoPanner() { const n = new MockStereoPannerNode(); this.created.push(n); return n }
  createDelay(max?: number) { const n = new MockDelayNode(max); this.created.push(n); return n }
  createBiquadFilter() { const n = new MockBiquadFilterNode(); this.created.push(n); return n }
  createWaveShaper() { const n = new MockWaveShaperNode(); this.created.push(n); return n }
  nodesOfKind<T extends MockNodeLike>(kind: string): T[] {
    return this.created.filter((n) => n.__kind === kind) as T[]
  }
  baseNodeHelper() { return baseNode('Unknown') }
}

/** Cast helper — our mock matches the ambient AudioContext shape closely
 * enough for the factories' purposes. */
function asCtx(c: MockAudioContext): AudioContext {
  return c as unknown as AudioContext
}

// ── Shared setup ─────────────────────────────────────────────────────────

let ctx: MockAudioContext
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  ctx = new MockAudioContext()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  vi.restoreAllMocks()
})

// ── Builder-level: every factory yields an EffectNode ───────────────────

describe('each modulation builder produces a valid EffectNode', () => {
  const cases: Array<[string, (c: AudioContext, p: Record<string, unknown>) => unknown]> = [
    ['tremolo', buildTremolo],
    ['auto_pan', buildAutoPan],
    ['chorus', buildChorus],
    ['flanger', buildFlanger],
    ['phaser', buildPhaser],
  ]

  for (const [name, builder] of cases) {
    it(`${name}`, () => {
      const node = builder(asCtx(ctx), {}) as {
        input: unknown
        output: unknown
        setParam: unknown
        scheduleCurve: unknown
        dispose: unknown
      }
      expect(node.input).toBeDefined()
      expect(node.output).toBeDefined()
      expect(typeof node.setParam).toBe('function')
      expect(typeof node.scheduleCurve).toBe('function')
      expect(typeof node.dispose).toBe('function')
      // dispose is idempotent-safe (no throw on second call).
      ;(node.dispose as () => void)()
      ;(node.dispose as () => void)()
    })
  }
})

// ── Tremolo: specific rate + depth assertions ───────────────────────────

describe('tremolo', () => {
  it('rate=5 bakes into OscillatorNode.frequency.value', () => {
    buildTremolo(asCtx(ctx), { rate: 5 })
    const oscs = ctx.nodesOfKind<MockOscillatorNode>('OscillatorNode')
    expect(oscs).toHaveLength(1)
    expect(oscs[0].frequency.value).toBe(5)
    expect(oscs[0].type).toBe('sine')
    expect(oscs[0].started).toBe(true)
  })

  it('setParam depth writes the depth-gain AudioParam', () => {
    const eff = buildTremolo(asCtx(ctx), { rate: 5 })
    // Initial depth for tremolo is 0.5 (per LFO initial).
    const gains = ctx.nodesOfKind<MockGainNode>('GainNode')
    // Two gains: outputGain + depthGain. depthGain carries the LFO amplitude.
    const depthGain = gains.find((g) => g.gain.value === 0.5)
    expect(depthGain).toBeDefined()

    eff.setParam('depth', 0.75)
    expect(depthGain!.gain.value).toBe(0.75)
  })

  it('setParam rate (static) warns and does not mutate frequency', () => {
    const eff = buildTremolo(asCtx(ctx), { rate: 5 })
    const osc = ctx.nodesOfKind<MockOscillatorNode>('OscillatorNode')[0]
    expect(osc.frequency.value).toBe(5)
    eff.setParam('rate', 10)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('rate')
    expect(osc.frequency.value).toBe(5)
  })

  it('scheduleCurve rate (static) warns and is a no-op', () => {
    const eff = buildTremolo(asCtx(ctx), { rate: 5 })
    eff.scheduleCurve('rate', [[0, 1], [1, 10]], 0, 1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('scheduleCurve depth lands a setValueCurveAtTime event', () => {
    const eff = buildTremolo(asCtx(ctx), { rate: 5 })
    eff.scheduleCurve(
      'depth',
      [
        [0, 0.2],
        [1, 0.8],
      ],
      0,
      1,
    )
    const gains = ctx.nodesOfKind<MockGainNode>('GainNode')
    const depthGain = gains.find((g) =>
      g.gain.events.some((e) => e.kind === 'setValueCurveAtTime'),
    )
    expect(depthGain).toBeDefined()
    const curveEvent = depthGain!.gain.events.find((e) => e.kind === 'setValueCurveAtTime')
    expect(curveEvent).toBeDefined()
    if (curveEvent && curveEvent.kind === 'setValueCurveAtTime') {
      const vals = Array.from(curveEvent.values)
      expect(vals).toHaveLength(2)
      expect(vals[0]).toBeCloseTo(0.2, 5)
      expect(vals[1]).toBeCloseTo(0.8, 5)
    }
  })
})

// ── Auto-pan ────────────────────────────────────────────────────────────

describe('auto_pan', () => {
  it('creates a StereoPannerNode and wires the LFO to pan', () => {
    buildAutoPan(asCtx(ctx), { rate: 2 })
    expect(ctx.nodesOfKind<MockStereoPannerNode>('StereoPannerNode')).toHaveLength(1)
    expect(ctx.nodesOfKind<MockOscillatorNode>('OscillatorNode')).toHaveLength(1)
    expect(ctx.nodesOfKind<MockOscillatorNode>('OscillatorNode')[0].frequency.value).toBe(2)
  })

  it('rate mutation warns', () => {
    const eff = buildAutoPan(asCtx(ctx), {})
    eff.setParam('rate', 10)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

// ── Chorus / flanger / phaser: topology sanity ──────────────────────────

describe('chorus graph', () => {
  it('creates exactly one DelayNode and one OscillatorNode', () => {
    buildChorus(asCtx(ctx), { rate: 1.5 })
    expect(ctx.nodesOfKind('DelayNode')).toHaveLength(1)
    expect(ctx.nodesOfKind('OscillatorNode')).toHaveLength(1)
    // GainNodes: input + output + dry + wet + feedback + depth = 6
    expect(ctx.nodesOfKind('GainNode').length).toBeGreaterThanOrEqual(6)
  })

  it('feedback setParam writes the feedback AudioParam', () => {
    const eff = buildChorus(asCtx(ctx), {})
    eff.setParam('feedback', 0.4)
    const gains = ctx.nodesOfKind<MockGainNode>('GainNode')
    const feedback = gains.find((g) =>
      g.gain.events.some((e) => e.kind === 'setValueAtTime' && e.value === 0.4),
    )
    expect(feedback).toBeDefined()
  })

  it('mix setParam sets wet + dry in parallel', () => {
    const eff = buildChorus(asCtx(ctx), {})
    eff.setParam('mix', 0.25)
    const gains = ctx.nodesOfKind<MockGainNode>('GainNode')
    const hasWet = gains.some((g) =>
      g.gain.events.some((e) => e.kind === 'setValueAtTime' && e.value === 0.25),
    )
    const hasDry = gains.some((g) =>
      g.gain.events.some((e) => e.kind === 'setValueAtTime' && e.value === 0.75),
    )
    expect(hasWet).toBe(true)
    expect(hasDry).toBe(true)
  })
})

describe('flanger graph', () => {
  it('matches chorus node counts (same topology, different timings)', () => {
    buildFlanger(asCtx(ctx), { rate: 0.5 })
    expect(ctx.nodesOfKind('DelayNode')).toHaveLength(1)
    expect(ctx.nodesOfKind('OscillatorNode')).toHaveLength(1)
    expect(ctx.nodesOfKind('GainNode').length).toBeGreaterThanOrEqual(6)
  })
})

describe('phaser graph', () => {
  it('creates PHASER_STAGES allpass BiquadFilters', () => {
    buildPhaser(asCtx(ctx), { rate: 0.5 })
    const biquads = ctx.nodesOfKind<MockBiquadFilterNode>('BiquadFilterNode')
    expect(biquads).toHaveLength(modInternals.PHASER_STAGES)
    for (const b of biquads) expect(b.type).toBe('allpass')
  })

  it('stage base frequencies are staggered by octaves', () => {
    buildPhaser(asCtx(ctx), {})
    const biquads = ctx.nodesOfKind<MockBiquadFilterNode>('BiquadFilterNode')
    const freqs = biquads.map((b) => b.frequency.value)
    // Each stage should double the previous.
    for (let i = 1; i < freqs.length; i++) {
      expect(freqs[i] / freqs[i - 1]).toBeCloseTo(2, 6)
    }
  })
})

// ── Drive ───────────────────────────────────────────────────────────────

describe('drive', () => {
  it('builder returns a valid EffectNode with a WaveShaperNode', () => {
    const eff = buildDrive(asCtx(ctx), { character: 'tape' })
    expect(eff.input).toBeDefined()
    expect(eff.output).toBeDefined()
    expect(ctx.nodesOfKind('WaveShaperNode')).toHaveLength(1)
    const shaper = ctx.nodesOfKind<MockWaveShaperNode>('WaveShaperNode')[0]
    expect(shaper.curve).not.toBeNull()
    expect(shaper.curve!.length).toBe(1024)
  })

  it.each([
    ['tape', 'tube'],
    ['tape', 'transistor'],
    ['tape', 'fuzz'],
    ['tube', 'transistor'],
    ['tube', 'fuzz'],
    ['transistor', 'fuzz'],
  ] as Array<[DriveCharacter, DriveCharacter]>)('character %s differs from %s (curve signature)', (a, b) => {
    const curveA = getDriveCurve(a)
    const curveB = getDriveCurve(b)
    // Compare middle and extremes — curves must differ somewhere.
    let differences = 0
    for (let i = 0; i < curveA.length; i++) {
      if (Math.abs(curveA[i] - curveB[i]) > 1e-4) differences++
    }
    expect(differences).toBeGreaterThan(10)
  })

  it('numeric character staticParam maps to a valid curve', () => {
    // Registry stores character as a numeric index (0=tape … 3=fuzz).
    buildDrive(asCtx(ctx), { character: 3 })
    const shaper = ctx.nodesOfKind<MockWaveShaperNode>('WaveShaperNode')[0]
    expect(shaper.curve).toBe(getDriveCurve('fuzz'))
  })

  it('setParam character (static) warns and does NOT replace the curve', () => {
    const eff = buildDrive(asCtx(ctx), { character: 'tape' })
    const shaper = ctx.nodesOfKind<MockWaveShaperNode>('WaveShaperNode')[0]
    const originalCurve = shaper.curve
    eff.setParam('character', 2)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(shaper.curve).toBe(originalCurve)
  })

  it('setParam amount adjusts preGain (amount=0 → 1×, amount=1 → 10×)', () => {
    const eff = buildDrive(asCtx(ctx), { character: 'tape' })
    eff.setParam('amount', 0)
    // Find the gain with a setValueAtTime(1, _) event.
    const gains = ctx.nodesOfKind<MockGainNode>('GainNode')
    const hasUnity = gains.some((g) =>
      g.gain.events.some((e) => e.kind === 'setValueAtTime' && e.value === 1),
    )
    expect(hasUnity).toBe(true)

    eff.setParam('amount', 1)
    const hasTenX = gains.some((g) =>
      g.gain.events.some((e) => e.kind === 'setValueAtTime' && e.value === 10),
    )
    expect(hasTenX).toBe(true)
  })

  it('scheduleCurve mix schedules parallel wet + dry ramps', () => {
    const eff = buildDrive(asCtx(ctx), { character: 'tape' })
    eff.scheduleCurve(
      'mix',
      [
        [0, 0],
        [1, 1],
      ],
      0,
      1,
    )
    const gains = ctx.nodesOfKind<MockGainNode>('GainNode')
    const curveEvents = gains.flatMap((g) =>
      g.gain.events.filter((e) => e.kind === 'setValueCurveAtTime'),
    )
    expect(curveEvents.length).toBeGreaterThanOrEqual(2)
  })

  it('unknown character staticParam falls back to tape', () => {
    buildDrive(asCtx(ctx), { character: 'nonsense' })
    const shaper = ctx.nodesOfKind<MockWaveShaperNode>('WaveShaperNode')[0]
    expect(shaper.curve).toBe(getDriveCurve('tape'))
  })
})
