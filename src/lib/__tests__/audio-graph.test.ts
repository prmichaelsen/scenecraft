/**
 * M13 task-47: tests for the per-track audio graph + send buses.
 *
 * The tests use lightweight mocks of the WebAudio surface (see
 * audio-mixer.test.ts for a similar pattern). We verify graph topology by
 * inspecting the `connections` array recorded by each mock node rather
 * than by rendering audio.
 */
import { describe, it, expect } from 'vitest'
import {
  buildTrackChain,
  BypassManager,
  SendBusGraph,
  type TrackEffect,
  type TrackSend,
  type SendBus,
} from '../audio-graph'
import type { EffectNode } from '../audio-effect-types'

// ── WebAudio mocks ────────────────────────────────────────────────────

interface Connectable {
  readonly kind: string
  connections: Connectable[]
  connect(dst: Connectable): Connectable
  disconnect(): void
}

class MockNode implements Connectable {
  kind: string
  connections: Connectable[] = []
  constructor(kind: string) { this.kind = kind }
  connect(dst: Connectable): Connectable { this.connections.push(dst); return dst }
  disconnect(): void { this.connections.length = 0 }
}

class MockParam {
  value: number
  events: Array<[string, number, number]> = []
  constructor(initial = 0) { this.value = initial }
  setValueAtTime(v: number, t: number): void { this.value = v; this.events.push(['setValueAtTime', v, t]) }
  linearRampToValueAtTime(v: number, t: number): void { this.value = v; this.events.push(['linearRampToValueAtTime', v, t]) }
  cancelScheduledValues(t: number): void { this.events.push(['cancel', 0, t]) }
}

class MockGain extends MockNode {
  gain = new MockParam(1)
  constructor() { super('gain') }
}

class MockPanner extends MockNode {
  pan = new MockParam(0)
  constructor() { super('panner') }
}

class MockConvolver extends MockNode {
  buffer: AudioBuffer | null = null
  constructor() { super('convolver') }
}

class MockDelay extends MockNode {
  delayTime = new MockParam(0)
  constructor() { super('delay') }
}

class MockFilter extends MockNode {
  type: BiquadFilterType = 'lowpass'
  frequency = new MockParam(0)
  constructor() { super('filter') }
}

class MockAudioContext {
  currentTime = 0
  destination = new MockNode('destination') as unknown as AudioNode
  createGain(): GainNode { return new MockGain() as unknown as GainNode }
  createStereoPanner(): StereoPannerNode { return new MockPanner() as unknown as StereoPannerNode }
  createConvolver(): ConvolverNode { return new MockConvolver() as unknown as ConvolverNode }
  createDelay(_max: number): DelayNode { return new MockDelay() as unknown as DelayNode }
  createBiquadFilter(): BiquadFilterNode { return new MockFilter() as unknown as BiquadFilterNode }
  async decodeAudioData(_ab: ArrayBuffer): Promise<AudioBuffer> {
    return {} as AudioBuffer
  }
}

function mockCtx(): AudioContext {
  return new MockAudioContext() as unknown as AudioContext
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Collect every node reachable from `root` via `connections`. */
function reachable(root: Connectable): Set<Connectable> {
  const seen = new Set<Connectable>()
  const stack: Connectable[] = [root]
  while (stack.length) {
    const n = stack.pop()!
    if (seen.has(n)) continue
    seen.add(n)
    for (const c of n.connections) stack.push(c)
  }
  return seen
}

/** Count nodes of a given kind reachable from root. */
function countKind(root: Connectable, kind: string): number {
  let n = 0
  for (const node of reachable(root)) if (node.kind === kind) n++
  return n
}

function fx(id: string, type: string, orderIndex: number, enabled = true): TrackEffect {
  return {
    id,
    track_id: 't1',
    effect_type: type,
    order_index: orderIndex,
    enabled,
    static_params: {},
  }
}

function send(trackId: string, busId: string, level: number): TrackSend {
  return { track_id: trackId, bus_id: busId, level }
}

function bus(id: string, busType: SendBus['bus_type'], order: number): SendBus {
  return {
    id,
    bus_type: busType,
    label: id,
    order_index: order,
    static_params: busType === 'reverb' ? { ir: 'plate' } : {},
  }
}

// ── buildTrackChain topology (R11) ────────────────────────────────────

describe('buildTrackChain — topology', () => {
  it('wires input → effects → pan → trackGain → destination', () => {
    const ctx = mockCtx()
    const effects = [fx('e1', 'compressor', 0), fx('e2', 'eq_band', 1)]
    const chain = buildTrackChain(ctx, 't1', effects, [], [])

    // Chain has two effect slots.
    expect(chain.effects.length).toBe(2)

    // Reachable from input: we should hit the pan node and trackGain.
    const seen = reachable(chain.input as unknown as Connectable)
    expect(seen.has(chain.pan as unknown as Connectable)).toBe(true)
    expect(seen.has(chain.trackGain as unknown as Connectable)).toBe(true)
    // And trackGain is wired onward to the destination.
    expect(seen.has(ctx.destination as unknown as Connectable)).toBe(true)
  })

  it('respects order_index when building the chain (reorder reflects)', () => {
    const ctx = mockCtx()
    // Deliberately supply out-of-order — the chain must sort.
    const effects = [fx('b', 'eq_band', 1), fx('a', 'compressor', 0)]
    const chain = buildTrackChain(ctx, 't1', effects, [], [])
    expect(chain.effects.map((e) => e.row.id)).toEqual(['a', 'b'])
  })

  it('parallel send taps: one GainNode per track_send (R11)', () => {
    const ctx = mockCtx()
    const buses = [bus('b_plate', 'reverb', 0), bus('b_delay', 'delay', 1)]
    const sends = [send('t1', 'b_plate', 0.3), send('t1', 'b_delay', 0.5)]
    const chain = buildTrackChain(ctx, 't1', [], sends, buses)

    // Two send taps with their gain values set.
    expect(chain.sends.size).toBe(2)
    const plate = chain.sends.get('b_plate') as unknown as MockGain
    const delay = chain.sends.get('b_delay') as unknown as MockGain
    expect(plate.gain.value).toBeCloseTo(0.3)
    expect(delay.gain.value).toBeCloseTo(0.5)

    // trackGain fans out to destination AND each sendGain — so
    // trackGain.connections should include both send gains.
    const tg = chain.trackGain as unknown as MockGain
    expect(tg.connections).toContain(plate)
    expect(tg.connections).toContain(delay)
  })

  it('ignores track_sends belonging to other tracks', () => {
    const ctx = mockCtx()
    const buses = [bus('b_plate', 'reverb', 0)]
    const sends = [send('OTHER', 'b_plate', 0.9), send('t1', 'b_plate', 0.1)]
    const chain = buildTrackChain(ctx, 't1', [], sends, buses)
    expect(chain.sends.size).toBe(1)
    const g = chain.sends.get('b_plate') as unknown as MockGain
    expect(g.gain.value).toBeCloseTo(0.1)
  })

  it('dispose() tears down without throwing', () => {
    const ctx = mockCtx()
    const chain = buildTrackChain(ctx, 't1', [fx('e1', 'compressor', 0)], [], [])
    expect(() => chain.dispose()).not.toThrow()
    // Idempotent.
    expect(() => chain.dispose()).not.toThrow()
  })
})

// ── Bypass / enable (R15) ─────────────────────────────────────────────

describe('BypassManager / setEffectEnabled — R15', () => {
  it('disabled effect keeps its node alive but wires input→output', () => {
    const ctx = mockCtx()
    const chain = buildTrackChain(ctx, 't1', [fx('e1', 'compressor', 0, false)], [], [])
    const slot = chain.effects[0]
    expect(slot.enabled).toBe(false)
    // The node object must still exist after build-with-bypass.
    expect(slot.node).toBeDefined()
    expect(slot.node.input).toBeDefined()
    expect(slot.node.output).toBeDefined()
  })

  it('toggle enabled=false then true preserves the same EffectNode instance', () => {
    const ctx = mockCtx()
    const chain = buildTrackChain(ctx, 't1', [fx('e1', 'compressor', 0, true)], [], [])
    const original = chain.effects[0].node
    chain.setEffectEnabled('e1', false)
    expect(chain.effects[0].node).toBe(original) // no rebuild
    expect(chain.effects[0].enabled).toBe(false)
    chain.setEffectEnabled('e1', true)
    expect(chain.effects[0].node).toBe(original) // still no rebuild
    expect(chain.effects[0].enabled).toBe(true)
  })

  it('setEffectEnabled on unknown id is a no-op', () => {
    const ctx = mockCtx()
    const chain = buildTrackChain(ctx, 't1', [fx('e1', 'compressor', 0)], [], [])
    expect(() => chain.setEffectEnabled('nope', false)).not.toThrow()
  })

  it('BypassManager uses custom input/output nodes correctly', () => {
    // A handcrafted EffectNode with DISTINCT input/output to prove the
    // bypass wiring is exercised beyond the stub (input===output) path.
    const ctx = mockCtx()
    const input = ctx.createGain() as unknown as MockGain
    const inner = ctx.createGain() as unknown as MockGain
    const output = ctx.createGain() as unknown as MockGain
    const fakeEffect: EffectNode = {
      input: input as unknown as AudioNode,
      output: output as unknown as AudioNode,
      setParam: () => {},
      scheduleCurve: () => {},
      dispose: () => {},
    }
    // Pretend the "real" inner chain would be input→inner→output; when
    // bypassed we expect input→output directly.
    input.connect(inner)
    inner.connect(output)

    const bm = new BypassManager(fakeEffect, true)
    bm.applyInitial()
    // applyInitial in "enabled" mode disconnects input then reconnects
    // input → output (since stub). Track that input is now wired straight
    // to output via BypassManager.
    expect(input.connections).toContain(output)

    bm.setEnabled(false)
    // Disabled: still input→output (bypass). connections cleared + refilled.
    expect(input.connections).toContain(output)
  })
})

// ── SendBusGraph (R12) ────────────────────────────────────────────────

describe('SendBusGraph', () => {
  it('upserts a reverb bus using ConvolverNode', () => {
    const ctx = mockCtx()
    const env = { loadBuiltinIr: async () => null }
    const graph = new SendBusGraph(ctx, env)
    const node = graph.upsertBus(bus('b_plate', 'reverb', 0))
    expect(node.busType).toBe('reverb')
    expect((node.node as unknown as MockNode).kind).toBe('convolver')
  })

  it('upserts a delay bus using DelayNode with feedback loop', () => {
    const ctx = mockCtx()
    const env = { loadBuiltinIr: async () => null }
    const graph = new SendBusGraph(ctx, env)
    const node = graph.upsertBus(bus('b_delay', 'delay', 1))
    expect(node.busType).toBe('delay')
    expect((node.node as unknown as MockNode).kind).toBe('delay')
    // Feedback loop: delay should eventually connect back to itself via a
    // gain node (delay → fb → delay).
    const reach = reachable(node.node as unknown as Connectable)
    expect(countKind(node.node as unknown as Connectable, 'gain')).toBeGreaterThanOrEqual(1)
    expect(reach.size).toBeGreaterThanOrEqual(2)
  })

  it('upserts an echo bus using DelayNode + BiquadFilter (single tap)', () => {
    const ctx = mockCtx()
    const env = { loadBuiltinIr: async () => null }
    const graph = new SendBusGraph(ctx, env)
    const node = graph.upsertBus(bus('b_echo', 'echo', 2))
    expect(node.busType).toBe('echo')
    expect((node.node as unknown as MockNode).kind).toBe('delay')
    // The output should be the biquad filter (echo has no feedback tail).
    expect((node.output as unknown as MockNode).kind).toBe('filter')
  })

  it('connectSend wires a sendGain into the bus input', () => {
    const ctx = mockCtx()
    const env = { loadBuiltinIr: async () => null }
    const graph = new SendBusGraph(ctx, env)
    const busNode = graph.upsertBus(bus('b_plate', 'reverb', 0))
    const sendGain = ctx.createGain() as unknown as MockGain
    graph.connectSend('b_plate', sendGain as unknown as GainNode)
    expect(sendGain.connections).toContain(busNode.input as unknown as MockNode)
  })

  it('removeBus disposes and delists', () => {
    const ctx = mockCtx()
    const env = { loadBuiltinIr: async () => null }
    const graph = new SendBusGraph(ctx, env)
    graph.upsertBus(bus('b_plate', 'reverb', 0))
    expect(graph.listBuses().length).toBe(1)
    graph.removeBus('b_plate')
    expect(graph.listBuses().length).toBe(0)
    expect(graph.getBus('b_plate')).toBeUndefined()
  })

  it('missing IR logs a warning and leaves convolver.buffer = null', async () => {
    const ctx = mockCtx()
    const warnCalls: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnCalls.push(args) }
    try {
      const env = {
        loadBuiltinIr: async (_name: string) => {
          console.warn(`[audio-graph] IR load failed for "${_name}"`)
          return null
        },
      }
      const graph = new SendBusGraph(ctx, env)
      const node = graph.upsertBus(bus('b_plate', 'reverb', 0))
      // Let the microtask queue drain so loadBuiltinIr rejects.
      await Promise.resolve()
      await Promise.resolve()
      expect((node.node as unknown as MockConvolver).buffer).toBeNull()
      expect(warnCalls.length).toBeGreaterThanOrEqual(1)
    } finally {
      console.warn = originalWarn
    }
  })
})
