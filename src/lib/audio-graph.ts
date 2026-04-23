/**
 * M13 task-47: per-track effect chain + project send buses (WebAudio runtime).
 *
 * Owns the graph side of the effect-curves spec (R11-R15):
 *   - `TrackChain`: `input → effect_1 → effect_2 → … → effect_N → output`,
 *     with every effect bypass-toggleable without tearing down the graph.
 *   - `SendBusGraph`: 4 default buses per project (2 reverb + delay + echo),
 *     each with a simple WebAudio realization and a uniform {input, output}
 *     shape. Track-side send taps are parallel GainNodes routed from
 *     `track_gain → sendGain → bus.input`.
 *   - `BypassManager`: flips an effect's internal wiring between
 *     `input→inner…→output` and a direct `input→output` pass-through without
 *     disposing the effect's nodes, so scheduled AudioParam curves survive
 *     across enable/disable toggles (spec R15).
 *
 * Static params come from `EFFECT_TYPES[type].build(ctx, staticParams)`. We
 * do NOT re-implement the effect-type registry here; this module is pure
 * glue + topology.
 *
 * Curve scheduling (`scheduleCurve`) is intentionally not driven here —
 * task-48 wires `effect.scheduleCurve(…)` from the timeline clock. Places
 * where the hook belongs are marked with `TODO(task-48)`.
 *
 * Data types (TrackEffect / SendBus / TrackSend) are defined locally to
 * keep this module importable without the task-52 HTTP layer; once
 * `/api/track-effects` lands we replace these with the shared client types.
 * See `TODO(task-52)` markers.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md (R11-R15, R53-R54).
 */

import { EFFECT_TYPES, type EffectNode } from './audio-effect-types'

// ── Data shapes (local stubs; TODO(task-52): import from audio-client) ─

/** One row from the `track_effects` SQLite table (R1). */
export interface TrackEffect {
  id: string
  track_id: string
  effect_type: string
  order_index: number
  enabled: boolean
  static_params: Record<string, unknown>
}

/** One row from the `project_send_buses` table (R3). */
export interface SendBus {
  id: string
  bus_type: 'reverb' | 'delay' | 'echo'
  label: string
  order_index: number
  static_params: Record<string, unknown>
}

/** One row from the `track_sends` table (R4). */
export interface TrackSend {
  track_id: string
  bus_id: string
  level: number
}

// ── Types ──────────────────────────────────────────────────────────────

/**
 * A bus realization. Same shape as `EffectNode` intentionally — spec says
 * each bus "exposes input/output/setParam/dispose (same EffectNode shape)".
 * The `node` and `busType` fields are extras for introspection + tests.
 */
export interface BusNode extends EffectNode {
  readonly busType: SendBus['bus_type']
  /** The bus's primary processing node (ConvolverNode / DelayNode). */
  readonly node: AudioNode
}

/**
 * Per-track runtime audio chain. The caller wires the upstream side
 * (`clip → volume_gain`) into `input` and the chain's `output` continues
 * into pan → track_gain → sends → destination.
 */
export interface TrackChain {
  /** Track id this chain belongs to. */
  readonly trackId: string
  /** Upstream attach point — this is where `volume_gain.connect(…)` lands. */
  readonly input: AudioNode
  /** Downstream attach point — drives pan / track_gain downstream. */
  readonly output: AudioNode
  /** Pan node, reserved for the pan effect (R11). */
  readonly pan: StereoPannerNode
  /** Track gain node (R11 — the mixer's per-track volume). */
  readonly trackGain: GainNode
  /** Parallel send taps, keyed by bus id (R11). GainNode is the curve target (R13). */
  readonly sends: ReadonlyMap<string, GainNode>
  /** Effect instances, in `order_index` order. */
  readonly effects: readonly ChainedEffect[]
  /** Re-wire a single effect's bypass (enabled flag) without rebuilding neighbors. */
  setEffectEnabled(effectId: string, enabled: boolean): void
  /** Tear down every node in the chain (including the effects). */
  dispose(): void
}

/** A single slot in the track chain — pairs the row with its EffectNode. */
export interface ChainedEffect {
  readonly row: TrackEffect
  readonly node: EffectNode
  /** When false, the effect is bypassed (input wired straight to output). */
  enabled: boolean
}

// ── BypassManager (R15) ────────────────────────────────────────────────

/**
 * Controls one effect's enable/bypass wiring. On bypass, `input.disconnect()`
 * is called and `input` is wired directly to `output` (routing past the
 * inner node graph). The inner node is left intact so scheduled AudioParam
 * curves stay alive — re-enabling reconnects inner nodes without recreating
 * them (spec R15).
 *
 * The caller is responsible for wiring the effect's `output` into its
 * downstream neighbor; this manager only touches `input`.
 */
export class BypassManager {
  #effect: EffectNode
  #enabled: boolean
  /** We remember whether input was wired to the inner graph vs. direct to output. */
  #currentRoute: 'inner' | 'bypass' | 'detached' = 'detached'

  constructor(effect: EffectNode, enabled: boolean) {
    this.#effect = effect
    this.#enabled = enabled
  }

  get enabled(): boolean {
    return this.#enabled
  }

  /** Apply the current route (call once after initial output-wiring). */
  applyInitial(): void {
    // For stub effects (input === output, single GainNode), there is no
    // inner chain to detach and no wiring change needed — pass-through is
    // already the default. Real effects in task-48 have distinct
    // input/output nodes and THIS method does the real work.
    if (this.#effect.input === this.#effect.output) {
      this.#currentRoute = this.#enabled ? 'inner' : 'bypass'
      return
    }
    if (this.#enabled) this.#routeInner()
    else this.#routeBypass()
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled && this.#currentRoute !== 'detached') return
    this.#enabled = enabled
    // Stub path: enable/disable is a pure state flip (no graph mutation).
    if (this.#effect.input === this.#effect.output) {
      this.#currentRoute = enabled ? 'inner' : 'bypass'
      return
    }
    if (enabled) this.#routeInner()
    else this.#routeBypass()
  }

  #routeInner(): void {
    try {
      this.#effect.input.disconnect()
    } catch {
      // no-op if already disconnected
    }
    // TODO(task-48): real effects must re-expose their inner chain here.
    // Until then, we wire input → output directly — same shape as bypass.
    // The "inner" route differs from "bypass" only in conceptual intent;
    // when task-48 lands it wires input → inner_head and inner_tail →
    // output. The output node's downstream connection (fx_i.output →
    // fx_{i+1}.input) is NOT touched by this manager — the chain builder
    // wires that once, and we leave it alone through enable/disable cycles.
    this.#effect.input.connect(this.#effect.output)
    this.#currentRoute = 'inner'
  }

  #routeBypass(): void {
    try {
      this.#effect.input.disconnect()
    } catch {
      // no-op
    }
    this.#effect.input.connect(this.#effect.output)
    this.#currentRoute = 'bypass'
  }
}

// ── buildTrackChain ────────────────────────────────────────────────────

/**
 * Build a track's audio chain per R11:
 *
 *     input → effect_1 → effect_2 → … → effect_N → pan → trackGain →
 *        → (fan-out) → destination
 *                    ↓ (one parallel tap per bus)
 *                    → sendGain(bus_id) → bus.input
 *
 * The chain's upstream attach point is `chain.input`; the caller wires
 * `volume_gain.connect(chain.input)`. Downstream of `trackGain`, the chain
 * connects to `ctx.destination` AND to each per-bus `sendGain`. We do NOT
 * connect the buses' outputs here — `SendBusGraph` owns bus→destination.
 *
 * `effects` is sorted by `order_index` before building. Disabled effects
 * are built (so bypass-preserving is free) but their `BypassManager` is
 * initialized in bypass mode.
 */
export function buildTrackChain(
  ctx: AudioContext,
  trackId: string,
  effects: readonly TrackEffect[],
  sends: readonly TrackSend[],
  buses: readonly SendBus[],
): TrackChain {
  // Head + tail glue. `input` is a plain GainNode so the caller has a
  // stable attach point that outlives chain rebuilds at the same trackId.
  const input = ctx.createGain()
  input.gain.value = 1
  const pan = ctx.createStereoPanner()
  const trackGain = ctx.createGain()
  trackGain.gain.value = 1

  // Build effects in order_index order.
  const sorted = [...effects].sort((a, b) => a.order_index - b.order_index)
  const built: ChainedEffect[] = []
  const bypassers: BypassManager[] = []
  for (const row of sorted) {
    const spec = EFFECT_TYPES[row.effect_type]
    if (!spec) {
      // Unknown effect_type — skip so a bad row can't brick the whole track.
      // TODO(task-52): surface this as an event to the UI.
      if (typeof console !== 'undefined') {
        console.warn(`[audio-graph] unknown effect_type=${row.effect_type} for track=${trackId}`)
      }
      continue
    }
    const node = spec.build(ctx, row.static_params)
    built.push({ row, node, enabled: row.enabled })
    bypassers.push(new BypassManager(node, row.enabled))
  }

  // Wire the chain: input → fx[0] → fx[1] → … → fx[N-1] → pan → trackGain.
  // Each fx's output connects to the next fx's input. The last fx's output
  // connects to pan. Bypass wiring (input→output) is handled inside each
  // BypassManager after this outer wiring is in place.
  let upstream: AudioNode = input
  for (let i = 0; i < built.length; i++) {
    const ef = built[i]
    upstream.connect(ef.node.input)
    upstream = ef.node.output
  }
  upstream.connect(pan)
  pan.connect(trackGain)
  trackGain.connect(ctx.destination)

  // Apply bypass routes now that input→output is already wired downstream.
  for (const b of bypassers) b.applyInitial()

  // Build per-bus send taps (R11 parallel GainNodes, R13 curve target).
  const sendGains = new Map<string, GainNode>()
  const busById = new Map(buses.map((b) => [b.id, b]))
  const trackSends = sends.filter((s) => s.track_id === trackId)
  for (const send of trackSends) {
    const bus = busById.get(send.bus_id)
    if (!bus) {
      // Dangling send (bus was deleted) — skip. The schema cascade should
      // normally remove these, but a mid-rebuild race could leak one.
      continue
    }
    const g = ctx.createGain()
    g.gain.value = send.level
    // Parallel tap off trackGain — trackGain → destination is already wired
    // above. Adding trackGain → sendGain does NOT steal signal from the
    // main path; WebAudio fan-out duplicates the signal.
    trackGain.connect(g)
    sendGains.set(send.bus_id, g)
    // NOTE: we do NOT connect sendGain → bus.input here. The SendBusGraph
    // exposes `connectSend(bus_id, sendGain)` which the caller invokes after
    // buildTrackChain; this keeps the track chain buildable in isolation
    // (useful for tests without a full SendBusGraph).
  }

  let disposed = false

  return {
    trackId,
    input,
    output: trackGain,
    pan,
    trackGain,
    sends: sendGains,
    effects: built,

    setEffectEnabled(effectId, enabled) {
      if (disposed) return
      const idx = built.findIndex((e) => e.row.id === effectId)
      if (idx < 0) return
      built[idx].enabled = enabled
      bypassers[idx].setEnabled(enabled)
      // TODO(task-48): if any curves are mid-schedule for this effect,
      // reschedule them against the bypassed node so they resume on re-enable.
    },

    dispose() {
      if (disposed) return
      disposed = true
      // Tear down from output → input to avoid disconnecting live audio
      // in the middle of a chain. (Matches tearDownTrack in audio-mixer.ts.)
      try { trackGain.disconnect() } catch { /* ignore */ }
      try { pan.disconnect() } catch { /* ignore */ }
      for (let i = built.length - 1; i >= 0; i--) {
        try { built[i].node.dispose() } catch { /* ignore */ }
      }
      for (const g of sendGains.values()) {
        try { g.disconnect() } catch { /* ignore */ }
      }
      try { input.disconnect() } catch { /* ignore */ }
    },
  }
}

// ── SendBusGraph (R12) ─────────────────────────────────────────────────

/** Resolve the URL for a built-in IR asset. Exported for test / reuse. */
export function builtinIrUrl(name: string): string {
  return new URL(`../assets/impulse_responses/${name}.wav`, import.meta.url).href
}

/** Default buses created on project load when `project_send_buses` is empty. */
export const DEFAULT_BUS_SEED: ReadonlyArray<Omit<SendBus, 'id'>> = [
  { bus_type: 'reverb', label: 'Plate', order_index: 0, static_params: { ir: 'plate' } },
  { bus_type: 'reverb', label: 'Hall', order_index: 1, static_params: { ir: 'hall' } },
  { bus_type: 'delay', label: 'Delay', order_index: 2, static_params: { time: 0.35, feedback: 0.45 } },
  { bus_type: 'echo', label: 'Echo', order_index: 3, static_params: { time: 0.5, tone: 4000 } },
]

/** Factory for the IR fetch+decode path (injectable for tests). */
export interface BusEnv {
  /** Returns a decoded AudioBuffer for a built-in IR by name, or null on error. */
  loadBuiltinIr: (name: string) => Promise<AudioBuffer | null>
  /**
   * Returns a decoded AudioBuffer for a custom IR in the project pool, or null.
   * `pathInPool` is the path portion passed to `scenecraftFileUrl`.
   * TODO(task-52): wire to /api/files endpoint.
   */
  loadPoolIr?: (pathInPool: string) => Promise<AudioBuffer | null>
}

/** Default env uses `fetch` + `audioCtx.decodeAudioData` + builtinIrUrl(). */
export function defaultBusEnv(ctx: AudioContext): BusEnv {
  return {
    async loadBuiltinIr(name) {
      try {
        const url = builtinIrUrl(name)
        const res = await fetch(url)
        if (!res.ok) return null
        const ab = await res.arrayBuffer()
        return await ctx.decodeAudioData(ab)
      } catch (err) {
        if (typeof console !== 'undefined') console.warn(`[audio-graph] IR load failed for "${name}"`, err)
        return null
      }
    },
  }
}

/**
 * Project-scoped manager for the 4 default send buses (R12). Owns each
 * bus's WebAudio node graph and their output wiring into `ctx.destination`.
 * Track-side send taps (built inside `TrackChain`) are attached via
 * `connectSend(bus_id, sendGain)`.
 */
export class SendBusGraph {
  #ctx: AudioContext
  #env: BusEnv
  #buses = new Map<string, BusNode>()
  #rows = new Map<string, SendBus>()

  constructor(ctx: AudioContext, env: BusEnv = defaultBusEnv(ctx)) {
    this.#ctx = ctx
    this.#env = env
  }

  /** Current list of bus rows (iteration order = insertion order = order_index). */
  listBuses(): readonly SendBus[] {
    return [...this.#rows.values()]
  }

  /** Look up the WebAudio realization of a bus (or undefined if unknown). */
  getBus(busId: string): BusNode | undefined {
    return this.#buses.get(busId)
  }

  /**
   * Create (or replace) a bus. If a bus with the same id exists, it's
   * disposed first. The new bus's output is wired to `ctx.destination`.
   *
   * For reverb buses: if `static_params.ir` is a built-in IR name, the IR
   * is fetched+decoded asynchronously and assigned to `convolver.buffer`
   * when it arrives. The bus is usable (passthrough) immediately; missing
   * IRs leave `.buffer = null` (passthrough with a warning).
   */
  upsertBus(row: SendBus): BusNode {
    const existing = this.#buses.get(row.id)
    if (existing) existing.dispose()

    let busNode: BusNode
    switch (row.bus_type) {
      case 'reverb':
        busNode = this.#buildReverbBus(row)
        break
      case 'delay':
        busNode = this.#buildDelayBus(row)
        break
      case 'echo':
        busNode = this.#buildEchoBus(row)
        break
      default: {
        // exhaustiveness guard
        const _never: never = row.bus_type
        throw new Error(`[audio-graph] unknown bus_type: ${String(_never)}`)
      }
    }
    this.#buses.set(row.id, busNode)
    this.#rows.set(row.id, row)
    busNode.output.connect(this.#ctx.destination)
    return busNode
  }

  /** Remove a bus, disposing its nodes. */
  removeBus(busId: string): void {
    const bus = this.#buses.get(busId)
    if (!bus) return
    bus.dispose()
    this.#buses.delete(busId)
    this.#rows.delete(busId)
  }

  /** Wire a track-side sendGain into a bus's input. */
  connectSend(busId: string, sendGain: GainNode): void {
    const bus = this.#buses.get(busId)
    if (!bus) return
    sendGain.connect(bus.input)
  }

  /** Tear down every bus. */
  dispose(): void {
    for (const b of this.#buses.values()) {
      try { b.dispose() } catch { /* ignore */ }
    }
    this.#buses.clear()
    this.#rows.clear()
  }

  // ── per-bus builders ────────────────────────────────────────────────

  #buildReverbBus(row: SendBus): BusNode {
    const convolver = this.#ctx.createConvolver()
    const wet = this.#ctx.createGain()
    wet.gain.value = 1
    convolver.connect(wet)

    // Load IR asynchronously; bus is operational (passthrough) immediately.
    const irParam = row.static_params.ir
    if (typeof irParam === 'string') {
      void this.#env.loadBuiltinIr(irParam).then((buf) => {
        if (buf) convolver.buffer = buf
      })
    }

    return {
      busType: 'reverb',
      node: convolver,
      input: convolver,
      output: wet,
      setParam: () => {
        // ConvolverNode has no AudioParams. IR swap is handled via upsertBus.
      },
      scheduleCurve: () => {
        // TODO(task-48): if we expose a wet-level curve on the bus itself,
        // wire it here against `wet.gain`.
      },
      dispose: () => {
        try { wet.disconnect() } catch { /* ignore */ }
        try { convolver.disconnect() } catch { /* ignore */ }
      },
    }
  }

  #buildDelayBus(row: SendBus): BusNode {
    const time = typeof row.static_params.time === 'number' ? row.static_params.time : 0.35
    const feedback = typeof row.static_params.feedback === 'number' ? row.static_params.feedback : 0.45
    const input = this.#ctx.createGain()
    const delay = this.#ctx.createDelay(5.0)
    delay.delayTime.value = time
    const fb = this.#ctx.createGain()
    fb.gain.value = feedback
    // input → delay → output; delay → fb → delay (feedback loop).
    input.connect(delay)
    delay.connect(fb)
    fb.connect(delay)

    return {
      busType: 'delay',
      node: delay,
      input,
      output: delay,
      setParam: (name, value, when) => {
        const t = when ?? this.#ctx.currentTime
        if (name === 'time') delay.delayTime.setValueAtTime(value, t)
        else if (name === 'feedback') fb.gain.setValueAtTime(value, t)
      },
      scheduleCurve: () => {
        // TODO(task-48): wire curves for delay time / feedback.
      },
      dispose: () => {
        try { fb.disconnect() } catch { /* ignore */ }
        try { delay.disconnect() } catch { /* ignore */ }
        try { input.disconnect() } catch { /* ignore */ }
      },
    }
  }

  #buildEchoBus(row: SendBus): BusNode {
    const time = typeof row.static_params.time === 'number' ? row.static_params.time : 0.5
    const tone = typeof row.static_params.tone === 'number' ? row.static_params.tone : 4000
    const input = this.#ctx.createGain()
    const delay = this.#ctx.createDelay(5.0)
    delay.delayTime.value = time
    const filter = this.#ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = tone
    // input → delay → filter → output (single tap, no feedback).
    input.connect(delay)
    delay.connect(filter)

    return {
      busType: 'echo',
      node: delay,
      input,
      output: filter,
      setParam: (name, value, when) => {
        const t = when ?? this.#ctx.currentTime
        if (name === 'time') delay.delayTime.setValueAtTime(value, t)
        else if (name === 'tone') filter.frequency.setValueAtTime(value, t)
      },
      scheduleCurve: () => {
        // TODO(task-48): wire curves for echo time / tone.
      },
      dispose: () => {
        try { filter.disconnect() } catch { /* ignore */ }
        try { delay.disconnect() } catch { /* ignore */ }
        try { input.disconnect() } catch { /* ignore */ }
      },
    }
  }
}
