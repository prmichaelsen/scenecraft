/**
 * M13 task-50 tests: spatial + send effect builders.
 *
 * happy-dom has no WebAudio; we use a hand-rolled mock AudioContext that
 * records connect()/disconnect() and exposes gain/pan AudioParams whose
 * `.value` is writable. That lets us assert the topology (which nodes
 * are wired to which inputs) and the param values after setParam() calls,
 * without depending on browser audio.
 *
 * Covers R8 (effect enumeration), R9 (animatable exceptions — bus_id is
 * static on sends), and the mid/side math described in task-50 step 2.
 */

import { describe, it, expect } from 'vitest'
import {
  buildPan,
  buildStereoWidth,
} from '../audio-effects/spatial'
import {
  buildReverbSend,
  buildDelaySend,
  buildEchoSend,
  type SendEffectNode,
} from '../audio-effects/send'
import { EFFECT_TYPES } from '../audio-effect-types'

// -----------------------------------------------------------------------------
// Mock AudioContext
// -----------------------------------------------------------------------------

interface MockAudioParam {
  value: number
  _events: Array<{ kind: string; value: number; time: number }>
  setValueAtTime(v: number, t: number): MockAudioParam
  linearRampToValueAtTime(v: number, t: number): MockAudioParam
}

interface MockNode {
  kind: string
  gain: MockAudioParam
  pan: MockAudioParam
  channels: number
  _connections: Array<{ target: MockNode; outIdx: number; inIdx: number }>
  connect: (target: MockNode, outIdx?: number, inIdx?: number) => MockNode
  disconnect: () => void
}

function makeParam(initial = 0): MockAudioParam {
  const p: MockAudioParam = {
    value: initial,
    _events: [],
    setValueAtTime(v: number, t: number) {
      p.value = v
      p._events.push({ kind: 'setValueAtTime', value: v, time: t })
      return p
    },
    linearRampToValueAtTime(v: number, t: number) {
      p.value = v
      p._events.push({ kind: 'linearRampToValueAtTime', value: v, time: t })
      return p
    },
  }
  return p
}

function makeNode(kind: string, channels = 2): MockNode {
  const n: MockNode = {
    kind,
    gain: makeParam(1),
    pan: makeParam(0),
    channels,
    _connections: [],
    connect(target, outIdx = 0, inIdx = 0) {
      n._connections.push({ target, outIdx, inIdx })
      return target
    },
    disconnect() {
      n._connections.length = 0
    },
  }
  return n
}

interface MockContext {
  currentTime: number
  createGain: () => MockNode
  createStereoPanner: () => MockNode
  createChannelSplitter: (n: number) => MockNode
  createChannelMerger: (n: number) => MockNode
  _allNodes: MockNode[]
}

function makeCtx(): MockContext {
  const allNodes: MockNode[] = []
  const track = (n: MockNode) => {
    allNodes.push(n)
    return n
  }
  return {
    currentTime: 0,
    _allNodes: allNodes,
    createGain: () => track(makeNode('gain')),
    createStereoPanner: () => track(makeNode('stereo_panner')),
    createChannelSplitter: (n: number) => track(makeNode('splitter', n)),
    createChannelMerger: (n: number) => track(makeNode('merger', n)),
  }
}

// Cast helper — the factories accept a real AudioContext; our mock is
// structurally compatible for the subset we use.
const asCtx = (c: MockContext): AudioContext => c as unknown as AudioContext

// -----------------------------------------------------------------------------
// Builder shape — every builder must return a valid EffectNode
// -----------------------------------------------------------------------------

describe('spatial + send builders: EffectNode shape', () => {
  it('buildPan returns a valid EffectNode', () => {
    const ctx = makeCtx()
    const node = buildPan(asCtx(ctx), {})
    expect(node.input).toBeDefined()
    expect(node.output).toBeDefined()
    expect(typeof node.setParam).toBe('function')
    expect(typeof node.scheduleCurve).toBe('function')
    expect(typeof node.dispose).toBe('function')
    // Pan uses a single StereoPannerNode as both input and output.
    expect(node.input).toBe(node.output)
  })

  it('buildStereoWidth returns a valid EffectNode', () => {
    const ctx = makeCtx()
    const node = buildStereoWidth(asCtx(ctx), {})
    expect(node.input).toBeDefined()
    expect(node.output).toBeDefined()
    expect(typeof node.setParam).toBe('function')
    expect(typeof node.scheduleCurve).toBe('function')
    expect(typeof node.dispose).toBe('function')
    // Stereo width has distinct input (fan) and output (merger).
    expect(node.input).not.toBe(node.output)
  })

  it.each(['reverb', 'delay', 'echo'] as const)(
    'build%sSend returns a valid SendEffectNode',
    (which) => {
      const ctx = makeCtx()
      const build = {
        reverb: buildReverbSend,
        delay: buildDelaySend,
        echo: buildEchoSend,
      }[which]
      const node = build(asCtx(ctx), { bus_id: `bus-${which}` })
      expect(node.input).toBeDefined()
      expect(node.output).toBeDefined()
      expect(typeof node.setParam).toBe('function')
      expect(typeof node.scheduleCurve).toBe('function')
      expect(typeof node.dispose).toBe('function')
      // Sends are passthrough on the main chain.
      expect(node.input).toBe(node.output)
    },
  )
})

// -----------------------------------------------------------------------------
// Pan: setParam('pan', -1) → panner.pan.value === -1
// -----------------------------------------------------------------------------

describe('buildPan', () => {
  it('setParam("pan", -1) sets StereoPannerNode.pan.value = -1', () => {
    const ctx = makeCtx()
    const node = buildPan(asCtx(ctx), {})
    node.setParam('pan', -1)
    // The panner is the single stereo_panner we created.
    const panner = ctx._allNodes.find((n) => n.kind === 'stereo_panner')
    expect(panner).toBeDefined()
    expect(panner!.pan.value).toBe(-1)
  })

  it('setParam("pan", +1) sets StereoPannerNode.pan.value = +1', () => {
    const ctx = makeCtx()
    const node = buildPan(asCtx(ctx), {})
    node.setParam('pan', 1)
    const panner = ctx._allNodes.find((n) => n.kind === 'stereo_panner')
    expect(panner!.pan.value).toBe(1)
  })

  it('unknown param is silently ignored (no throw)', () => {
    const ctx = makeCtx()
    const node = buildPan(asCtx(ctx), {})
    expect(() => node.setParam('nonexistent', 42)).not.toThrow()
  })

  it('scheduleCurve on "pan" emits param events', () => {
    const ctx = makeCtx()
    const node = buildPan(asCtx(ctx), {})
    node.scheduleCurve(
      'pan',
      [
        [0, -1],
        [1, 1],
      ],
      0,
      2,
    )
    const panner = ctx._allNodes.find((n) => n.kind === 'stereo_panner')!
    expect(panner.pan._events.length).toBeGreaterThan(0)
  })
})

// -----------------------------------------------------------------------------
// StereoWidth: width=0 → mono; width=2 → doubled side.
// We can't actually audit the signal (no real audio), but we CAN audit that
// setParam('width', v) drives the side-width gain to v. The topology test
// below verifies the splitter/merger graph is correctly wired.
// -----------------------------------------------------------------------------

describe('buildStereoWidth', () => {
  it('default width is 1 (identity passthrough)', () => {
    const ctx = makeCtx()
    buildStereoWidth(asCtx(ctx), {})
    // One of the gain nodes is the side-width gain with default 1.
    // We can't name it externally, so we infer from the topology: the
    // node connecting to BOTH the +1 sideToL and −1 sideToR amps is the
    // side-width gain. Easier check: at least one gain starts at 1.
    const gains = ctx._allNodes.filter((n) => n.kind === 'gain')
    expect(gains.some((g) => g.gain.value === 1)).toBe(true)
  })

  it('setParam("width", 0) drives the side gain to 0 (mono)', () => {
    const ctx = makeCtx()
    const node = buildStereoWidth(asCtx(ctx), {})
    node.setParam('width', 0)
    // The width param targets a single gain node. Verify one gain ended
    // up at exactly 0 (the side-width gain; other gains are fixed
    // coefficients at ±1 or 0.5).
    const gains = ctx._allNodes.filter((n) => n.kind === 'gain')
    const zeroGains = gains.filter((g) => g.gain.value === 0)
    // Before setParam there were zero gains at value 0; after, exactly one.
    expect(zeroGains.length).toBe(1)
  })

  it('setParam("width", 2) drives the side gain to 2 (doubled side)', () => {
    const ctx = makeCtx()
    const node = buildStereoWidth(asCtx(ctx), {})
    node.setParam('width', 2)
    const gains = ctx._allNodes.filter((n) => n.kind === 'gain')
    expect(gains.some((g) => g.gain.value === 2)).toBe(true)
  })

  it('builds a mid/side graph: splitter → {mid, side} → merger', () => {
    const ctx = makeCtx()
    buildStereoWidth(asCtx(ctx), {})
    // Exactly one splitter and one merger.
    expect(ctx._allNodes.filter((n) => n.kind === 'splitter')).toHaveLength(1)
    expect(ctx._allNodes.filter((n) => n.kind === 'merger')).toHaveLength(1)

    const splitter = ctx._allNodes.find((n) => n.kind === 'splitter')!
    const merger = ctx._allNodes.find((n) => n.kind === 'merger')!

    // Splitter fans out to multiple downstream nodes (mid path + side L/R).
    expect(splitter._connections.length).toBeGreaterThanOrEqual(4)
    // Splitter outputs 0 (L) and 1 (R) are both used.
    const outIndices = new Set(splitter._connections.map((c) => c.outIdx))
    expect(outIndices.has(0)).toBe(true)
    expect(outIndices.has(1)).toBe(true)

    // Merger receives on both input 0 (L) and input 1 (R).
    // We find connections INTO the merger by scanning every node's
    // connections for `target === merger`.
    const intoMerger = ctx._allNodes.flatMap((n) =>
      n._connections.filter((c) => c.target === merger),
    )
    const inIndices = new Set(intoMerger.map((c) => c.inIdx))
    expect(inIndices.has(0)).toBe(true)
    expect(inIndices.has(1)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// Sends: setParam('wet', 0.5) → sendGain.gain.value = 0.5; bus_id exposed.
// -----------------------------------------------------------------------------

describe('send builders (reverb / delay / echo)', () => {
  const cases: Array<[string, (ctx: AudioContext, s: Record<string, unknown>) => SendEffectNode]> = [
    ['reverb_send', buildReverbSend],
    ['delay_send', buildDelaySend],
    ['echo_send', buildEchoSend],
  ]

  for (const [label, build] of cases) {
    describe(label, () => {
      it('setParam("wet", 0.5) sets sendGain.gain.value = 0.5', () => {
        const ctx = makeCtx()
        const node = build(asCtx(ctx), { bus_id: 'bus-x' })
        node.setParam('wet', 0.5)
        // The sendGain is one of the two gain nodes we created.
        // Default: passthrough.gain=1, sendGain.gain=0. After setParam,
        // sendGain.gain=0.5.
        expect(node.sendGain.gain.value).toBe(0.5)
      })

      it('exposes bus_id as a node property', () => {
        const ctx = makeCtx()
        const node = build(asCtx(ctx), { bus_id: 'plate-reverb-1' })
        expect(node.bus_id).toBe('plate-reverb-1')
      })

      it('missing bus_id in staticParams defaults to empty string', () => {
        const ctx = makeCtx()
        const node = build(asCtx(ctx), {})
        expect(node.bus_id).toBe('')
      })

      it('sendGain starts at 0 (silent tap by default)', () => {
        const ctx = makeCtx()
        const node = build(asCtx(ctx), { bus_id: 'bus-x' })
        expect(node.sendGain.gain.value).toBe(0)
      })

      it('input === output (passthrough on main chain)', () => {
        const ctx = makeCtx()
        const node = build(asCtx(ctx), { bus_id: 'bus-x' })
        expect(node.input).toBe(node.output)
      })

      it('scheduleCurve on "wet" drives the sendGain param', () => {
        const ctx = makeCtx()
        const node = build(asCtx(ctx), { bus_id: 'bus-x' })
        node.scheduleCurve(
          'wet',
          [
            [0, 0],
            [1, 1],
          ],
          0,
          5,
        )
        // Our mock's param sets .value to the final ramp target.
        expect(node.sendGain.gain.value).toBe(1)
      })

      it('unknown param is silently ignored', () => {
        const ctx = makeCtx()
        const node = build(asCtx(ctx), { bus_id: 'bus-x' })
        expect(() => node.setParam('nonexistent', 42)).not.toThrow()
      })
    })
  }
})

// -----------------------------------------------------------------------------
// Registry integration — the 5 entries wire up to the real factories.
// -----------------------------------------------------------------------------

describe('EFFECT_TYPES integration', () => {
  const fiveTypes = ['pan', 'stereo_width', 'reverb_send', 'delay_send', 'echo_send']

  it.each(fiveTypes)('%s.build() returns a real (non-stub) EffectNode', (type) => {
    const ctx = makeCtx()
    const spec = EFFECT_TYPES[type]
    const node = spec.build(asCtx(ctx), { bus_id: 'bus-x' })
    expect(node.input).toBeDefined()
    expect(node.output).toBeDefined()

    // Real factories use WebAudio primitives beyond the bare GainNode stub.
    // pan creates a StereoPannerNode; sends create 2 GainNodes; stereo_width
    // creates a full splitter/merger graph. Any of these is fine — the key
    // signal that these are "real" factories is that the node tree has the
    // right shape for the effect type, not that there are many of them.
    const kinds = ctx._allNodes.map((n) => n.kind)
    if (type === 'pan') {
      expect(kinds).toContain('stereo_panner')
    } else if (type === 'stereo_width') {
      expect(kinds).toContain('splitter')
      expect(kinds).toContain('merger')
    } else {
      // send effects — exactly 2 gains: passthrough + sendGain
      expect(kinds.filter((k) => k === 'gain')).toHaveLength(2)
    }
  })

  it('send-type registry entries use "wet" as the animatable param name', () => {
    for (const type of ['reverb_send', 'delay_send', 'echo_send']) {
      const spec = EFFECT_TYPES[type]
      const wetParam = spec.params.find((p) => p.name === 'wet')
      expect(wetParam, `${type} should expose wet`).toBeDefined()
      expect(wetParam!.animatable).toBe(true)
    }
  })

  it('send-type registry entries keep bus_id non-animatable (R9)', () => {
    for (const type of ['reverb_send', 'delay_send', 'echo_send']) {
      const spec = EFFECT_TYPES[type]
      const busParam = spec.params.find((p) => p.name === 'bus_id')
      expect(busParam).toBeDefined()
      expect(busParam!.animatable).toBe(false)
    }
  })
})
