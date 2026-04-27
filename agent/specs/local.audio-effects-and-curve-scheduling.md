# Spec: Audio Effects Registry, Effect Chains, and Curve Scheduling

> **Agent Directive**: This is a retroactive black-box spec derived from the existing implementation in `src/lib/audio-effect-types.ts`, `src/lib/audio-graph.ts`, and the curve-scheduling helpers in `src/lib/mix-graph.ts`. It captures the end-system behavior of the effect registry, the per-track effect chain, the project send buses, bypass management, and the curve scheduling semantics that feed `AudioParam` ramps. Scenarios the source could not resolve are flagged `undefined` and linked to Open Questions — they are NOT guessed into tests.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive)
**Source Mode**: `--from-draft` (user-provided scope + audit §1E units 4–8)

---

## Purpose

Define the exact observable behavior of the audio-effect subsystem: the 17-entry `EFFECT_TYPES` registry, the per-effect `build(ctx)` factory contract, the per-track `TrackChain` wiring (effects serial → pan → gain with parallel send fan-out), the project-scoped `SendBusGraph` (reverb/delay/echo buses sharing a uniform `EffectNode` shape), the `BypassManager` (toggle without rebuild, preserve scheduled curves), and the `CurveScheduler` semantics (clip curves in normalized `[0,1]` time → absolute seconds via clip span; track curves already absolute seconds; `setValueCurveAtTime` for equal-power crossfades; `linearRampToValueAtTime` for volume curves).

## Source

- `/home/prmichaelsen/.acp/projects/scenecraft/src/lib/audio-effect-types.ts` (full)
- `/home/prmichaelsen/.acp/projects/scenecraft/src/lib/audio-graph.ts` (full)
- `/home/prmichaelsen/.acp/projects/scenecraft/src/lib/mix-graph.ts` (curve-scheduling + shared effect-chain builder only)
- `/home/prmichaelsen/.acp/projects/scenecraft/agent/reports/audit-2-architectural-deep-dive.md` §1E units 4–8

## Scope

**In scope**
- Contents and shape of the `EFFECT_TYPES` registry (17 effect types with full param specs, ranges, scales, defaults, and animatable flags).
- The `EffectTypeSpec.build(ctx, staticParams)` factory contract and the `EffectNode` interface it returns.
- `SYNTHETIC_SEND_EFFECT_TYPE = '__send'` reserved constant semantics (rejected by `/track-effects`, used only for animating per-bus sends in `effect_curves`).
- `buildTrackChain(ctx, trackId, effects, sends, buses)` topology: `input → fx_1 → … → fx_N → pan → trackGain`, with parallel `sendGain` taps fanning out from `trackGain`.
- `SendBusGraph` lifecycle: `upsertBus`, `removeBus`, `connectSend`, `getBus`, `listBuses`, `dispose`; uniform `{input, output, setParam, scheduleCurve, dispose}` bus shape; default 4-bus seed.
- `BypassManager` behavior: enable/disable without disposing inner nodes; preserve any scheduled AudioParam curves on the inner node; detached→inner/bypass transition via `applyInitial`.
- Curve scheduling (`scheduleClipCurveOnParam`, `scheduleTrackCurveOnParam`, `scheduleCrossfadeOnParams`, `buildEffectChain` from `mix-graph.ts`): coordinate systems (normalized `[0,1]` for clip curves vs absolute seconds for track curves), anchor-time semantics (`paramAnchorTime` = `ctx.currentTime` live / `0` offline / `start_time - renderStart` for clips offline), `cancelScheduledValues` + `setValueAtTime` anchoring, `linearRampToValueAtTime` for volume points, `setValueCurveAtTime` for equal-power crossfade (COS/SIN, 128 samples).

**Out of scope**
- `AudioMixer` outer control (live activation, clip scheduling, analyser taps, seek handling) — covered in a separate spec (`webaudio-mixer-and-mix-graph`).
- Offline bounce (`MixRender`) — covered in `bounce-and-analysis`.
- `pool_segments`, audio-clip CRUD, waveform cache — referenced only.
- Database schema for `track_effects`, `project_send_buses`, `track_sends`, `effect_curves` tables (row shape taken from TypeScript interfaces in `audio-graph.ts`; DDL out of scope).
- Actual DSP implementations inside the effect builders (`audio-effects/dynamics.ts`, `eq.ts`, etc.) — factory contract is in scope, internal topology is not.
- The `/api/track-effects` HTTP surface — only its rejection of `__send` is stated as an invariant.

---

## Requirements

**Registry shape**

- **R1** `EFFECT_TYPES` is a frozen keyed registry of exactly 17 effect types. Keys: `compressor`, `gate`, `limiter`, `eq_band`, `highpass`, `lowpass`, `pan`, `stereo_width`, `reverb_send`, `delay_send`, `echo_send`, `tremolo`, `auto_pan`, `chorus`, `flanger`, `phaser`, `drive`.
- **R2** Each entry is an `EffectTypeSpec` with `type`, `label`, `category`, `params[]`, `build()`. `category` is one of `dynamics | eq | spatial | time | modulation | distortion | send`.
- **R3** Each `EffectParamSpec` has `name`, `label`, `animatable: boolean`, `range: {min, max}`, `scale: 'linear' | 'log' | 'db' | 'hz'`, `default`, and optional `labelPresets`.
- **R4** Per-type param inventory and flags (exact values):
  | Type | Params (name · range · scale · default · animatable) |
  |---|---|
  | `compressor` | `threshold` −60..0 db −24 ✓ · `ratio` 1..20 linear 4 ✓ · `attack` 0..1 linear 0.003 ✓ · `release` 0..1 linear 0.25 ✓ · `knee` 0..40 linear 30 ✓ |
  | `gate` | `threshold` −80..0 db −40 ✓ · `attack` 0..1 linear 0.005 ✓ · `release` 0..1 linear 0.1 ✓ · `hold` 0..1 linear 0.05 ✓ |
  | `limiter` | `ceiling` −20..0 db −0.3 ✓ · `release` 0..1 linear 0.05 ✓ |
  | `eq_band` | `freq` 20..20000 hz 1000 ✓ (with `labelPresets = [...SPECTRUM_BANDS, ...INSTRUMENT_PRESETS]`) · `gain` −24..24 db 0 ✓ · `q` 0.1..18 linear 1 ✓ |
  | `highpass` | `cutoff` 20..20000 hz 80 ✓ · `q` 0.1..18 linear 0.707 ✓ |
  | `lowpass` | `cutoff` 20..20000 hz 8000 ✓ · `q` 0.1..18 linear 0.707 ✓ |
  | `pan` | `pan` −1..1 linear 0 ✓ |
  | `stereo_width` | `width` 0..2 linear 1 ✓ |
  | `reverb_send` | `bus_id` 0..0 linear 0 ✗ · `wet` 0..1 linear 0 ✓ |
  | `delay_send` | `bus_id` 0..0 linear 0 ✗ · `wet` 0..1 linear 0 ✓ |
  | `echo_send` | `bus_id` 0..0 linear 0 ✗ · `wet` 0..1 linear 0 ✓ |
  | `tremolo` | `rate` 0.1..20 log 5 ✗ · `depth` 0..1 linear 0.5 ✓ |
  | `auto_pan` | `rate` 0.1..20 log 1 ✗ · `depth` 0..1 linear 0.75 ✓ |
  | `chorus` | `rate` 0.1..10 log 1.5 ✗ · `depth` 0..1 linear 0.5 ✓ · `mix` 0..1 linear 0.5 ✓ |
  | `flanger` | `rate` 0.05..10 log 0.5 ✗ · `depth` 0..1 linear 0.5 ✓ · `feedback` 0..0.95 linear 0.5 ✓ · `mix` 0..1 linear 0.5 ✓ |
  | `phaser` | `rate` 0.05..10 log 0.5 ✗ · `depth` 0..1 linear 0.7 ✓ · `feedback` 0..0.95 linear 0.5 ✓ · `mix` 0..1 linear 0.5 ✓ |
  | `drive` | `character` 0..4 linear 0 ✗ · `amount` 0..1 linear 0.3 ✓ · `tone` 0..1 linear 0.5 ✓ · `mix` 0..1 linear 1 ✓ |
- **R5** The non-animatable params across the registry are exactly: `drive.character`, `{reverb,delay,echo}_send.bus_id`, and LFO `rate` on `tremolo`, `auto_pan`, `chorus`, `flanger`, `phaser`. Every other param is animatable.
- **R6** `SYNTHETIC_SEND_EFFECT_TYPE === '__send'`; the registry MUST NOT contain a key `'__send'`; the `POST /track-effects` endpoint rejects `effect_type === '__send'`. (Invariant; endpoint itself out of scope.)

**Effect factory + node contract**

- **R7** `spec.build(ctx, staticParams)` returns an `EffectNode` with `input: AudioNode`, `output: AudioNode`, `setParam(name, value, when?)`, `scheduleCurve(name, points, startTime, duration)`, `dispose()`.
- **R8** `input` and `output` may reference the same `AudioNode` (the "stub / passthrough" case). `BypassManager` special-cases that identity.
- **R9** `dispose()` is idempotent-safe in the sense that the chain's outer code calls it inside try/catch — builders are not required to be idempotent themselves, but must not throw synchronously on a first disposal of a fully-wired node.

**Per-track chain wiring (`buildTrackChain`)**

- **R10** Topology is:
  ```
  input (Gain, unity) → fx_1 → fx_2 → … → fx_N → pan (StereoPanner) → trackGain (Gain, unity)
                                                               ↓ (fan-out)
                                                          ctx.destination
                                                               ↓ (also fan-out)
                                         sendGain_a → bus_a.input
                                         sendGain_b → bus_b.input
                                         …
  ```
  `input`, `pan`, `trackGain` are stable references exposed on the returned `TrackChain`; they outlive effect-list changes that rebuild the chain at the same `trackId`.
- **R11** Effects are sorted by `order_index` ascending before wiring.
- **R12** Effects whose `effect_type` is not in `EFFECT_TYPES` are skipped with a `console.warn`; the rest of the chain builds normally (one bad row never bricks the track).
- **R13** Disabled effects are still built and wired; their `BypassManager` is initialized in bypass mode via `applyInitial()`. The inner `EffectNode` is created up-front so any scheduled curves survive enable/disable toggles (R15).
- **R14** `trackGain.connect(ctx.destination)` is wired inside the builder. WebAudio fan-out means adding `trackGain.connect(sendGain)` does NOT steal signal from the destination path.
- **R15** For every entry in `sends` whose `track_id === trackId`, the builder creates a `GainNode` with `gain.value = send.level`, connects `trackGain → sendGain`, and records it in `chain.sends: Map<bus_id, GainNode>`. The builder does NOT connect `sendGain → bus.input`; the caller invokes `SendBusGraph.connectSend(busId, sendGain)` after `buildTrackChain` returns.
- **R16** A `send` whose `bus_id` is not in `buses` is dropped silently (dangling send; mid-rebuild race).
- **R17** `chain.setEffectEnabled(effectId, enabled)`:
  - No-op if `disposed`.
  - No-op if `effectId` not found in the chain.
  - Otherwise flips `built[idx].enabled` and calls `bypassers[idx].setEnabled(enabled)`.
- **R18** `chain.dispose()`:
  - Idempotent (second call is a no-op).
  - Tears down tail-to-head: `trackGain.disconnect()`, `pan.disconnect()`, each `ef.node.dispose()` in reverse `order_index`, each `sendGain.disconnect()`, `input.disconnect()`; all wrapped in try/catch.

**BypassManager**

- **R19** Constructor captures `(effect, enabled)`; `#currentRoute` starts as `'detached'`.
- **R20** `applyInitial()` transitions `'detached' → 'inner'` or `'detached' → 'bypass'` based on `enabled`. For stub effects where `effect.input === effect.output`, `applyInitial()` does NOT mutate any WebAudio connections; it only updates `#currentRoute`.
- **R21** `setEnabled(enabled)`:
  - If `enabled === #enabled` AND `#currentRoute !== 'detached'`, it is a no-op (idempotent re-set).
  - Otherwise `#enabled` is updated and the route is re-applied.
  - For stub effects (`input === output`), this is a pure state flip (no graph mutation).
  - For real effects, `input.disconnect()` is called (inside try/catch) and then `input.connect(output)` is re-wired; the inner node graph is NOT disposed, so `AudioParam` curves scheduled on inner nodes survive.
- **R22** The manager never touches the downstream edge `effect.output → next_fx.input` / `pan`. That edge is wired once by the chain builder and persists across enable/disable cycles.

**SendBusGraph**

- **R23** `DEFAULT_BUS_SEED` contains exactly 4 entries in order: `reverb/Plate (ir:plate)`, `reverb/Hall (ir:hall)`, `delay/Delay (time:0.35, feedback:0.45)`, `echo/Echo (time:0.5, tone:4000)`.
- **R24** `upsertBus(row)`:
  - If a bus with `row.id` already exists, its `dispose()` is called first.
  - Dispatches on `row.bus_type ∈ {'reverb','delay','echo'}`; any other value throws `[audio-graph] unknown bus_type: <value>`.
  - Stores the new `BusNode` in `#buses`, the row in `#rows`, and wires `busNode.output.connect(ctx.destination)`.
  - Returns the new `BusNode`.
- **R25** Reverb bus:
  - Nodes: `convolver → wet (Gain, unity)`.
  - `input === convolver`; `output === wet`; `node === convolver`.
  - IR load: if `row.static_params.ir` is a string, `env.loadBuiltinIr(name)` is invoked asynchronously; when it resolves with a non-null `AudioBuffer`, `convolver.buffer = buf`. The bus is operational (passthrough, `buffer = null`) immediately.
  - `setParam`: no-op (ConvolverNode has no `AudioParam`s; IR swaps require `upsertBus`).
  - `scheduleCurve`: no-op in current code (known unimplemented; see Resolved OQ-4 cross-cutting note).
- **R26** Delay bus:
  - Nodes: `input (Gain) → delay (DelayNode, max 5.0s) → fb (Gain) → delay` (feedback loop).
  - `input === input`; `output === delay`; `node === delay`.
  - `setParam('time', v, when?)` → `delay.delayTime.setValueAtTime(v, when ?? ctx.currentTime)`.
  - `setParam('feedback', v, when?)` → `fb.gain.setValueAtTime(v, when ?? ctx.currentTime)`.
  - `setParam(<other>, …)` is a silent no-op.
  - `scheduleCurve`: no-op in current code (known unimplemented; see Resolved OQ-4 cross-cutting note).
- **R27** Echo bus:
  - Nodes: `input (Gain) → delay (DelayNode, max 5.0s) → filter (BiquadFilter, lowpass)`.
  - `input === input`; `output === filter`; `node === delay`.
  - `setParam('time', v, when?)` → `delay.delayTime.setValueAtTime(v, when ?? ctx.currentTime)`.
  - `setParam('tone', v, when?)` → `filter.frequency.setValueAtTime(v, when ?? ctx.currentTime)`.
  - `setParam(<other>, …)` is a silent no-op.
  - No feedback loop; single tap only.
- **R28** `removeBus(busId)`: if unknown, no-op; else calls `bus.dispose()`, deletes both maps.
- **R29** `connectSend(busId, sendGain)`: if bus unknown, no-op; else `sendGain.connect(bus.input)`.
- **R30** `getBus(busId)`: returns the `BusNode` or `undefined`.
- **R31** `listBuses()`: returns rows in insertion order (which equals `order_index` when seeded via the default seed).
- **R32** `dispose()`: calls `dispose()` on every bus (each wrapped in try/catch), clears both maps.
- **R33** Every bus exposes the uniform `EffectNode` shape: `{ input, output, setParam, scheduleCurve, dispose }`, plus extras `busType` and `node`.

**CurveScheduler (mix-graph helpers)**

- **R34** `scheduleClipCurveOnParam(param, clip, playhead, paramAnchorTime)`:
  - Always begins with `param.cancelScheduledValues(paramAnchorTime)`.
  - If `clip.muted`, sets `param.setValueAtTime(0, paramAnchorTime)` and returns.
  - Otherwise sets `param.setValueAtTime(dbToLinear(sampleClipDbAtPlayhead(clip, playhead)), paramAnchorTime)` as the anchor.
  - Iterates sorted curve points (`sortedCurvePoints(clip.volume_curve)`; stable sort by `x`).
  - Each point `[xNorm, db]` is mapped to absolute seconds: `xSec = clip.start_time + xNorm * max(end_time - start_time, 1e-9)`.
  - Points with `xSec <= playhead` are skipped.
  - Points with `xSec > clip.end_time` terminate the loop (`break`).
  - Remaining points schedule `param.linearRampToValueAtTime(dbToLinear(db), paramAnchorTime + (xSec - playhead))`.
- **R35** `scheduleTrackCurveOnParam(param, track, playhead, paramAnchorTime, effectiveMuted)`:
  - Always begins with `param.cancelScheduledValues(paramAnchorTime)`.
  - If `effectiveMuted`, sets `param.setValueAtTime(0, paramAnchorTime)` and returns.
  - Otherwise anchors at `dbToLinear(sampleTrackDbAtPlayhead(track, playhead))`.
  - Iterates sorted points. Points are ALREADY in absolute seconds (no normalization).
  - Skips `xSec <= playhead`; does NOT break on upper bound (tracks have no end).
  - Schedules `linearRampToValueAtTime(dbToLinear(db), paramAnchorTime + (xSec - playhead))`.
- **R36** `scheduleCrossfadeOnParams(incumbentParam, newcomerParam, incumbent, newcomer, playhead, paramAnchorTime)`:
  - Computes `overlapStart = max(incumbent.start_time, newcomer.start_time)`, `overlapEnd = min(incumbent.end_time, newcomer.end_time)`, `duration = max(0, overlapEnd - overlapStart)`.
  - Returns early if `duration <= 0`.
  - `fadeStartCtx = paramAnchorTime + max(0, overlapStart - playhead)`.
  - Cancels scheduled values on both params at `paramAnchorTime`.
  - `incumbentParam.setValueCurveAtTime(COS_CURVE, fadeStartCtx, duration)` — fade-out, equal-power.
  - `newcomerParam.setValueCurveAtTime(SIN_CURVE, fadeStartCtx, duration)` — fade-in, equal-power.
- **R37** `COS_CURVE` and `SIN_CURVE` are `Float32Array` of length `CROSSFADE_CURVE_LEN = 128`, precomputed at module load: `cos(t·π/2)` and `sin(t·π/2)` for `t ∈ [0,1]`.
- **R38** `isTrackEffectivelyMuted(track, allTracks)` = `true` if `track.muted`, OR if any track in `allTracks` has `solo === true` and `track.solo !== true`.
- **R39** `sortedCurvePoints(curve)` returns `[]` for null/undefined/empty. Otherwise it returns a copy sorted ascending by `x`, with duplicate-`x` entries deduped last-wins (the later entry in the input replaces the earlier at the same `x`). Non-monotonic input is thus clamped to a monotonic sequence downstream. (Updated per OQ-7 resolution.)
- **R40** Coordinate systems:
  - Clip `volume_curve` x-values: normalized `[0,1]` relative to `[start_time, end_time]`.
  - Track `volume_curve` x-values: absolute seconds on the timeline.
  - `paramAnchorTime` in live playback: `ctx.currentTime` at call time.
  - `paramAnchorTime` in offline render: `0` for track curves; `max(0, clip.start_time - renderStart)` for clip curves.

**Parameter validation + bypass lifecycle**

- **R46** `EffectNode.setParam(name, value, when?)` MUST clamp `value` to
  `EFFECT_TYPES[type].params[name].range` before writing to the WebAudio param.
  Out-of-range inputs are silently clamped; the graph layer does not rely on
  WebAudio to validate finite/in-bounds values. Applies uniformly to builders and
  send buses.
- **R47** `chain.setEffectEnabled(id, false)` MUST call `cancelScheduledValues(ctx.currentTime)`
  on the effect's inner animatable `AudioParam`(s) so pending curves do not
  continue to tick on the detached inner node. `chain.setEffectEnabled(id, true)`
  MUST re-schedule the curve against the current playhead via the standard
  clip/track curve helpers. The BypassManager itself still does not dispose the
  inner node (R21). (Resolves OQ-4; the code's `TODO(task-48)` marker is removed.)
- **R48** `scheduleClipCurveOnParam` / `scheduleTrackCurveOnParam` / `scheduleCrossfadeOnParams`
  MUST clamp `paramAnchorTime` to `max(paramAnchorTime, ctx.currentTime)` before any
  `cancelScheduledValues` / `setValueAtTime` call. This prevents silent-skip on
  seek races where a helper is called with a stale anchor.
- **R49** `EffectNode.scheduleCurve(name, points, …)` with `points.length === 0`
  is contract-defined as **anchor-only scheduling**: it calls
  `cancelScheduledValues(paramAnchorTime)` + `setValueAtTime(current_param_value,
  paramAnchorTime)` and returns. No ramps are scheduled. (Resolves OQ-2.)
- **R50** `TrackSend` with `level === 0` retains full wiring
  (`trackGain → sendGain → bus.input`); `sendGain.gain.value === 0` is a "silent
  send". The send counts toward `chain.sends` and toward any UI "active bus"
  indicator. (Resolves OQ-5.)
- **R51** `BypassManager.setEnabled(enabled)` invoked twice in the same animation
  frame (e.g., `false → true`) MUST apply each transition as-observed; no
  coalescing or rAF-trailing-edge batching. Each call performs at most one
  `disconnect/connect` pair (idempotent within a given state, per R21).

**Shared master-bus effect chain (`buildEffectChain` in mix-graph.ts)**

- **R41** Topology: `inputNode (Gain, unity) → fx_1 → … → fx_N → outputNode (Gain, unity)`. Head/tail passthroughs are always present even when `effects` is empty.
- **R42** Effects sorted by `order_index` ascending; unknown types skipped with `console.warn('[mix-graph] unknown effect_type=…')`.
- **R43** Disabled effects are INCLUDED in the chain (master-bus MVP does not expose bypass). This differs from `buildTrackChain` which uses `BypassManager`.
- **R44** Typed on `BaseAudioContext` so the same builder works for live (`AudioContext`) and offline (`OfflineAudioContext`); factory `build(ctx, staticParams)` is called with `ctx as AudioContext` cast.
- **R45** `dispose()` is idempotent; tears down tail-to-head (`outputNode.disconnect()`, `built[i].dispose()` in reverse, `inputNode.disconnect()`); all in try/catch.

---

## Interfaces / Data Shapes

```ts
// audio-effect-types.ts
type EffectCategory = 'dynamics' | 'eq' | 'spatial' | 'time' | 'modulation' | 'distortion' | 'send'
type ParamScale = 'linear' | 'log' | 'db' | 'hz'

interface EffectParamSpec {
  name: string
  label: string
  animatable: boolean
  range: { min: number; max: number }
  scale: ParamScale
  default: number
  labelPresets?: FrequencyLabelPreset[]
}

interface EffectNode {
  input: AudioNode
  output: AudioNode
  setParam: (name: string, value: number, when?: number) => void
  scheduleCurve: (name: string, points: CurvePoint[], startTime: number, duration: number) => void
  dispose: () => void
}

interface EffectTypeSpec {
  type: string
  label: string
  category: EffectCategory
  params: EffectParamSpec[]
  build: (ctx: AudioContext, staticParams: Record<string, unknown>) => EffectNode
}

declare const EFFECT_TYPES: Record<string, EffectTypeSpec>
declare const SYNTHETIC_SEND_EFFECT_TYPE: '__send'

// audio-graph.ts
interface TrackEffect {
  id: string; track_id: string; effect_type: string
  order_index: number; enabled: boolean
  static_params: Record<string, unknown>
}
interface SendBus { id: string; bus_type: 'reverb'|'delay'|'echo'; label: string; order_index: number; static_params: Record<string, unknown> }
interface TrackSend { track_id: string; bus_id: string; level: number }

interface BusNode extends EffectNode { readonly busType: SendBus['bus_type']; readonly node: AudioNode }
interface ChainedEffect { readonly row: TrackEffect; readonly node: EffectNode; enabled: boolean }

interface TrackChain {
  readonly trackId: string
  readonly input: AudioNode
  readonly output: AudioNode
  readonly pan: StereoPannerNode
  readonly trackGain: GainNode
  readonly sends: ReadonlyMap<string, GainNode>
  readonly effects: readonly ChainedEffect[]
  setEffectEnabled(effectId: string, enabled: boolean): void
  dispose(): void
}

declare function buildTrackChain(
  ctx: AudioContext,
  trackId: string,
  effects: readonly TrackEffect[],
  sends: readonly TrackSend[],
  buses: readonly SendBus[],
): TrackChain

class BypassManager {
  constructor(effect: EffectNode, enabled: boolean)
  get enabled(): boolean
  applyInitial(): void
  setEnabled(enabled: boolean): void
}

class SendBusGraph {
  constructor(ctx: AudioContext, env?: BusEnv)
  listBuses(): readonly SendBus[]
  getBus(busId: string): BusNode | undefined
  upsertBus(row: SendBus): BusNode
  removeBus(busId: string): void
  connectSend(busId: string, sendGain: GainNode): void
  dispose(): void
}

// mix-graph.ts (curve scheduling)
declare function scheduleClipCurveOnParam(param: AudioParam, clip: AudioClip, playhead: number, paramAnchorTime: number): void
declare function scheduleTrackCurveOnParam(param: AudioParam, track: AudioTrack, playhead: number, paramAnchorTime: number, effectiveMuted: boolean): void
declare function scheduleCrossfadeOnParams(incumbentParam: AudioParam, newcomerParam: AudioParam, incumbent: AudioClip, newcomer: AudioClip, playhead: number, paramAnchorTime: number): void
declare function isTrackEffectivelyMuted(track: AudioTrack, allTracks: readonly AudioTrack[]): boolean
declare function sortedCurvePoints(curve: CurvePoint[] | null | undefined): CurvePoint[]
declare const COS_CURVE: Float32Array   // length 128
declare const SIN_CURVE: Float32Array   // length 128
declare const CROSSFADE_CURVE_LEN: 128
```

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | Look up any of the 17 registered effect types | Returns `EffectTypeSpec` with expected category, label, params | `registry-contains-17-types`, `per-type-param-inventory` |
| 2 | Build effect via `spec.build(ctx, staticParams)` | Returns `EffectNode` with input/output/setParam/scheduleCurve/dispose | `build-returns-effect-node-shape` |
| 3 | Read `SYNTHETIC_SEND_EFFECT_TYPE` | Equals `'__send'` and absent from `EFFECT_TYPES` | `synthetic-send-constant` |
| 4 | Check animatable flags across registry | Only the documented 9 non-animatable params are flagged ✗ | `animatable-flags-match-spec` |
| 5 | Build a track chain with two known effects in reverse `order_index` | Effects are wired in ascending `order_index` | `chain-sorts-by-order-index` |
| 6 | Build a chain with an unknown `effect_type` row | Row is skipped with `console.warn`; other effects still wire | `unknown-effect-type-skipped` |
| 7 | Build chain with a disabled effect | Effect is still built; `BypassManager` is bypassed via `applyInitial` | `disabled-effect-still-built` |
| 8 | Build chain with sends pointing at valid buses | One `GainNode` per send, level applied, recorded in `chain.sends` | `sends-created-with-level` |
| 9 | Build chain with a send referring to a missing bus | Send silently dropped | `dangling-send-dropped` |
| 10 | Call `chain.setEffectEnabled(id, false)` | Updates `built[idx].enabled` and flips bypasser | `set-effect-enabled-flips-bypass` |
| 11 | Call `chain.setEffectEnabled` with unknown id | No-op | `set-effect-enabled-unknown-id-noop` |
| 12 | Call `chain.dispose()` twice | Second call is no-op; no exception | `dispose-idempotent` |
| 13 | `BypassManager.setEnabled` with same state and non-detached route | No-op | `bypass-setenabled-idempotent` |
| 14 | `BypassManager.setEnabled` toggles between enabled/disabled | `input.disconnect()` then `input.connect(output)` called; inner node not disposed | `bypass-toggle-preserves-inner-node` |
| 15 | Schedule curve on inner AudioParam, then bypass, then re-enable | Scheduled curve values still present on the inner param | `bypass-preserves-scheduled-curves` |
| 16 | `SendBusGraph.upsertBus` reverb bus with known built-in IR | Bus is usable immediately (convolver has `buffer = null`); IR assigned when fetch resolves | `reverb-bus-ir-async-load` |
| 17 | `upsertBus` delay bus with `time` and `feedback` | `delay.delayTime.value = time`, `fb.gain.value = feedback`; feedback loop wired | `delay-bus-wiring` |
| 18 | `upsertBus` echo bus with `time` and `tone` | Delay tap + lowpass filter wired; no feedback loop | `echo-bus-wiring` |
| 19 | `upsertBus` replacing existing bus at same id | Previous bus `dispose()` called before new one installed | `upsert-replaces-existing` |
| 20 | `upsertBus` with invalid `bus_type` | Throws `[audio-graph] unknown bus_type: …` | `upsert-unknown-type-throws` |
| 21 | `connectSend` to known bus | `sendGain.connect(bus.input)` invoked | `connect-send-wires-input` |
| 22 | `connectSend` to missing bus | No-op | `connect-send-missing-bus-noop` |
| 23 | `removeBus` on known id | `bus.dispose()` called; maps cleaned | `remove-bus-disposes` |
| 24 | `removeBus` on unknown id | No-op | `remove-bus-unknown-noop` |
| 25 | Delay bus `setParam('time'/'feedback')` | Calls `setValueAtTime` on the respective param at `when` (or `ctx.currentTime`) | `delay-bus-setparam` |
| 26 | Echo bus `setParam('time'/'tone')` | Calls `setValueAtTime` on delay/filter | `echo-bus-setparam` |
| 27 | Reverb bus `setParam(any)` | No-op | `reverb-bus-setparam-noop` |
| 28 | Schedule clip curve on unmuted clip with 3 points inside span | Anchor `setValueAtTime` at playhead; 3 `linearRampToValueAtTime` at absolute seconds | `schedule-clip-curve-happy` |
| 29 | Schedule clip curve where `clip.muted === true` | `setValueAtTime(0, anchor)`; no ramps | `schedule-clip-curve-muted-silences` |
| 30 | Schedule clip curve with points before playhead | Those points skipped; later points still scheduled | `schedule-clip-curve-skips-past-points` |
| 31 | Schedule clip curve with a point past `clip.end_time` | Loop breaks at first out-of-range point | `schedule-clip-curve-breaks-after-end` |
| 32 | Schedule clip curve on zero-length clip (`end_time <= start_time`) | Uses `span = 1e-9`; points collapse to `start_time` and are skipped vs playhead | `schedule-clip-curve-zero-length-span` |
| 33 | Schedule track curve (absolute seconds) with `effectiveMuted = true` | `setValueAtTime(0, anchor)`; no ramps | `schedule-track-curve-muted-silences` |
| 34 | Schedule track curve with points after playhead | Anchors at current db; ramps for each later point | `schedule-track-curve-happy` |
| 35 | Crossfade two overlapping clips | `setValueCurveAtTime(COS_CURVE,…)` on incumbent, `SIN_CURVE` on newcomer | `crossfade-equal-power-curves` |
| 36 | Crossfade two non-overlapping clips | Early return; no writes to either param | `crossfade-no-overlap-noop` |
| 37 | `isTrackEffectivelyMuted` with no solos, track muted | Returns true | `mute-no-solo` |
| 38 | `isTrackEffectivelyMuted` with other track solo'd, this not solo'd | Returns true | `solo-mutes-non-solo-tracks` |
| 39 | `buildEffectChain` (master bus) with empty `effects` | Returns passthrough: single chain where `input === output === Gain(1)` OR equivalent head-tail passthrough | `master-bus-empty-chain-passthrough` |
| 40 | `buildEffectChain` with disabled effect | Effect still wired (master bus has no BypassManager) | `master-bus-includes-disabled` |
| 41 | `sortedCurvePoints([])` / null / undefined | Returns `[]` | `sorted-curve-points-empty` |
| 42 | Effect type not in registry (DB row for a deprecated/new type) | Row is skipped with `console.warn('[audio-graph] unknown effect_type=…')`; chain builds without it | `unknown-effect-type-silently-skipped-in-chain` |
| 43 | `scheduleCurve` called with `points.length === 0` | Contract is anchor-only: `cancelScheduledValues(anchor)` + `setValueAtTime(anchor_value, anchor)`; no ramps. No early short-circuit. | `schedule-curve-empty-points-anchor-only` |
| 44 | `setParam` called with value outside the declared `range` | Graph layer clamps to `[range.min, range.max]` before writing to the WebAudio param; never relies on WebAudio for validation | `setparam-clamps-to-range` |
| 45 | `setEffectEnabled(id, false)` mid-scheduled-curve on that effect | `setEffectEnabled(id, false)` calls `cancelScheduledValues` on the inner param to freeze pending curves; `setEffectEnabled(id, true)` re-schedules from the current playhead | `disable-midcurve-cancels-pending`, `enable-resumes-curve-from-playhead` |
| 46 | `TrackSend.level === 0` | Wiring is preserved (`trackGain → sendGain → bus.input`); `sendGain.gain.value === 0` is "silent send", NOT "disconnected" | `send-level-zero-preserves-wiring` |
| 47 | Two `BypassManager.setEnabled` calls in the same animation frame | Accepted: each call performs its disconnect/connect idempotently; no coalescing. Flip-flip runs both transitions. | `bypass-flip-flip-same-frame-both-run` |
| 48 | Clip curve with non-monotonic x-values | `sortedCurvePoints` dedupes duplicate-x (last-wins) and sorts ascending; non-monotonic input is clamped to monotonic | `sorted-curve-dedupes-duplicate-x` |
| 49 | Curve scheduled where `paramAnchorTime` is in the past relative to `ctx.currentTime` | Helper clamps `paramAnchorTime = max(paramAnchorTime, ctx.currentTime)` before any `cancel/setValueAtTime` call | `curve-anchor-clamped-to-currenttime` |

---

## Behavior

1. **Module load** imports `EFFECT_TYPES` (17 entries) and `SYNTHETIC_SEND_EFFECT_TYPE = '__send'`; `COS_CURVE` / `SIN_CURVE` are precomputed into 128-sample `Float32Array`s.
2. **Chain construction** (`buildTrackChain`):
   1. Create `input` (Gain unity), `pan` (StereoPanner), `trackGain` (Gain unity).
   2. Sort effects by `order_index`; for each, look up `EFFECT_TYPES[row.effect_type]`. Unknown → `console.warn`, skip. Known → `spec.build(ctx, row.static_params)`; push `{row, node, enabled}`; push a new `BypassManager(node, row.enabled)`.
   3. Wire serially: `input → fx_0.input`, `fx_i.output → fx_{i+1}.input`, last `fx.output → pan`, `pan → trackGain`, `trackGain → ctx.destination`.
   4. Call `applyInitial()` on each `BypassManager`.
   5. For each send where `track_id === trackId` and `bus_id ∈ buses`, create `GainNode(level)`, `trackGain.connect(sendGain)`, store in `chain.sends`. Caller later invokes `SendBusGraph.connectSend(busId, sendGain)`.
3. **Bypass toggling** (`setEffectEnabled`): update `ChainedEffect.enabled`; call `BypassManager.setEnabled`. Stub effects (input===output) flip a state flag only. Real effects `input.disconnect()` then `input.connect(output)`; the inner node graph is untouched so AudioParam curves scheduled on its internals remain.
4. **Curve scheduling** (volume-curve path):
   - Always `cancelScheduledValues(paramAnchorTime)` first.
   - Anchor `setValueAtTime(dbToLinear(sample_at_playhead), paramAnchorTime)`.
   - Walk sorted points; skip past playhead; for clip curves, translate normalized x into absolute seconds via `start_time + xNorm·span` and break past `end_time`; for track curves, x is already seconds.
   - Each retained point emits `linearRampToValueAtTime(dbToLinear(db), paramAnchorTime + (xSec - playhead))`.
5. **Crossfade scheduling**: compute overlap window; if empty, no-op. Else, `cancelScheduledValues` on both params at `paramAnchorTime`; `setValueCurveAtTime(COS_CURVE, fadeStartCtx, duration)` on incumbent and `setValueCurveAtTime(SIN_CURVE, fadeStartCtx, duration)` on newcomer.
6. **Send buses** (`SendBusGraph`):
   - `upsertBus` disposes any existing bus at the same id, dispatches on `bus_type`, stores new bus, wires `output → destination`.
   - Reverb bus asynchronously fetches IR via injected `BusEnv.loadBuiltinIr`; bus works as passthrough until buffer lands.
   - `connectSend(bus_id, sendGain)` wires the track-side tap into the bus input.
   - `dispose` tears down every bus and clears both maps.

---

## Acceptance Criteria

- [ ] `Object.keys(EFFECT_TYPES).length === 17` and the set matches R1 exactly.
- [ ] Every param spec in R4 is present with the exact `range`, `scale`, `default`, and `animatable` flag.
- [ ] `SYNTHETIC_SEND_EFFECT_TYPE === '__send'` and `'__send' in EFFECT_TYPES === false`.
- [ ] `buildTrackChain` returns a `TrackChain` with stable `input`, `pan`, `trackGain` references; effects sorted by `order_index`; unknown types skipped with warning; disabled effects still built.
- [ ] `trackGain.connect(ctx.destination)` happens inside the builder; each send appears in `chain.sends` as a GainNode with the given `level`.
- [ ] `BypassManager.setEnabled` preserves the inner `EffectNode` across toggles (curves scheduled on inner params survive).
- [ ] `SendBusGraph` exposes `upsertBus / removeBus / connectSend / getBus / listBuses / dispose`; every bus has `{input, output, setParam, scheduleCurve, dispose}`; invalid `bus_type` throws.
- [ ] Default seed has exactly 4 buses in the documented order with the documented `static_params`.
- [ ] `scheduleClipCurveOnParam` converts normalized x to absolute seconds via `start_time + x·span`; `scheduleTrackCurveOnParam` treats x as absolute seconds.
- [ ] `scheduleCrossfadeOnParams` uses `setValueCurveAtTime` with 128-sample cos/sin; no-op on empty overlap.
- [ ] `buildEffectChain` (master bus) creates head/tail passthrough Gains even when `effects` is empty; does NOT apply `BypassManager`.

---

## Tests

### Base Cases

#### Test: registry-contains-17-types (covers R1, R2)

**Given**: the module `audio-effect-types.ts` is imported.
**When**: the caller inspects `Object.keys(EFFECT_TYPES)` and each entry's shape.
**Then** (assertions):
- **key-set**: keys equal the exact set listed in R1 (17 entries).
- **every-entry-has-spec-fields**: each value has `type`, `label`, `category`, `params` (array), and `build` (function).
- **category-enum-respected**: every `category` is one of the seven allowed strings in R2.

#### Test: per-type-param-inventory (covers R3, R4)

**Given**: the registry is loaded.
**When**: the caller iterates each effect's `params` array.
**Then** (assertions):
- **param-names-match**: param name list per type matches the table in R4.
- **param-ranges-match**: `range.min` / `range.max` match R4 exactly.
- **param-scales-match**: `scale` matches R4 exactly.
- **param-defaults-match**: `default` matches R4 exactly.
- **eq-band-has-label-presets**: `eq_band.freq.labelPresets` is a non-empty array (spectrum + instrument presets).

#### Test: build-returns-effect-node-shape (covers R7, R8)

**Given**: a fresh `AudioContext` (or test double with the minimum WebAudio factories) and a registered effect type.
**When**: `EFFECT_TYPES[type].build(ctx, {})` is invoked.
**Then** (assertions):
- **returns-effect-node**: result has `input`, `output`, `setParam`, `scheduleCurve`, `dispose`.
- **input-is-audio-node**: `input` is an `AudioNode` instance (or mock equivalent).
- **output-is-audio-node**: `output` is an `AudioNode` instance.
- **dispose-does-not-throw**: calling `dispose()` once does not throw.

#### Test: synthetic-send-constant (covers R6)

**Given**: the module is imported.
**When**: the caller reads `SYNTHETIC_SEND_EFFECT_TYPE`.
**Then** (assertions):
- **value-is-underscore-send**: equals the literal string `'__send'`.
- **not-in-registry**: `'__send' in EFFECT_TYPES` is `false`.

#### Test: animatable-flags-match-spec (covers R5)

**Given**: the registry.
**When**: iterating every param across every type.
**Then** (assertions):
- **non-animatable-set**: the exact set of non-animatable params is `{drive.character, reverb_send.bus_id, delay_send.bus_id, echo_send.bus_id, tremolo.rate, auto_pan.rate, chorus.rate, flanger.rate, phaser.rate}`.
- **all-others-animatable**: every other param has `animatable === true`.

#### Test: chain-sorts-by-order-index (covers R11)

**Given**: a track with three effects whose `order_index` is `[2, 0, 1]`.
**When**: `buildTrackChain` is called.
**Then** (assertions):
- **chain-effect-order**: `chain.effects.map(e => e.row.order_index)` equals `[0, 1, 2]`.
- **input-to-first-fx-wired**: `input` connects into the fx with `order_index = 0`.
- **tail-into-pan-wired**: the fx with `order_index = 2`'s `output` connects into `pan`; `pan` connects into `trackGain`; `trackGain` connects into `ctx.destination`.

#### Test: unknown-effect-type-skipped (covers R12)

**Given**: a track with one registered effect and one row whose `effect_type = 'no_such_effect'`.
**When**: `buildTrackChain` is called (`console.warn` observed).
**Then** (assertions):
- **warn-emitted**: a warning containing `'[audio-graph] unknown effect_type=no_such_effect'` is logged.
- **chain-has-only-known-effect**: `chain.effects.length === 1`.
- **chain-still-wired-to-destination**: `trackGain → ctx.destination` is still present.

#### Test: disabled-effect-still-built (covers R13)

**Given**: a track with a single registered effect whose `enabled === false`.
**When**: `buildTrackChain` is called.
**Then** (assertions):
- **effect-built**: `chain.effects[0].node` exists (is an `EffectNode`).
- **enabled-false-on-chained-effect**: `chain.effects[0].enabled === false`.
- **bypass-initially-applied**: the internal `BypassManager` is in `'bypass'` (or for stub effects, `#currentRoute === 'bypass'`).

#### Test: sends-created-with-level (covers R15)

**Given**: a track with two sends (`level = 0.3` and `level = 0.7`) pointing at two existing buses.
**When**: `buildTrackChain` runs.
**Then** (assertions):
- **sends-map-size-2**: `chain.sends.size === 2`.
- **gain-values-match**: each `sendGain.gain.value` equals its row's `level`.
- **track-gain-fanned-out**: each `sendGain` has `trackGain` as an upstream connection.
- **bus-input-not-yet-connected**: the builder did NOT connect `sendGain → bus.input` (caller invokes `SendBusGraph.connectSend`).

#### Test: dangling-send-dropped (covers R16)

**Given**: a track with a send whose `bus_id` is not in `buses`.
**When**: `buildTrackChain` runs.
**Then** (assertions):
- **send-not-in-map**: `chain.sends.has(missingBusId) === false`.
- **no-warning**: no console output is produced for dangling sends.

#### Test: set-effect-enabled-flips-bypass (covers R17, R21)

**Given**: a track chain with one enabled effect.
**When**: `chain.setEffectEnabled(effect.id, false)` is invoked, then `setEffectEnabled(effect.id, true)`.
**Then** (assertions):
- **chained-effect-enabled-false-then-true**: `chain.effects[0].enabled` toggles false then true.
- **bypass-manager-state-follows**: the underlying `BypassManager.enabled` matches after each call.

#### Test: set-effect-enabled-unknown-id-noop (covers R17)

**Given**: a built chain.
**When**: `chain.setEffectEnabled('nonexistent', false)` is called.
**Then** (assertions):
- **no-throw**: no exception.
- **no-chain-mutation**: `chain.effects` and every `bypasser.enabled` remain unchanged.

#### Test: dispose-idempotent (covers R18)

**Given**: a built chain with at least one effect and one send.
**When**: `chain.dispose()` is called twice.
**Then** (assertions):
- **no-throw**: neither call throws.
- **effect-dispose-called-once-per-effect**: each effect's `dispose()` runs exactly once (first call); not called a second time.

#### Test: bypass-setenabled-idempotent (covers R21)

**Given**: a `BypassManager` constructed with `enabled = true`, and `applyInitial()` has been called.
**When**: `setEnabled(true)` is called.
**Then** (assertions):
- **no-op-when-same-state**: no `disconnect` / `connect` calls are issued on `effect.input`.

#### Test: bypass-toggle-preserves-inner-node (covers R21, R22)

**Given**: a real (non-stub) effect with distinct `input` and `output` nodes.
**When**: `setEnabled(false)` then `setEnabled(true)`.
**Then** (assertions):
- **input-disconnect-then-connect**: `effect.input.disconnect()` is called, then `effect.input.connect(effect.output)` (or reconnection to inner chain); the inner nodes are NOT disposed.
- **output-downstream-edge-untouched**: the connection from `effect.output` to the next chain neighbor is unchanged across the toggle.

#### Test: bypass-preserves-scheduled-curves (covers R13, R15, R21)

**Given**: a built effect whose inner `AudioParam` has a scheduled ramp (`linearRampToValueAtTime` at a future time).
**When**: `BypassManager.setEnabled(false)` is called, time advances past the ramp end while bypassed, then `setEnabled(true)`.
**Then** (assertions):
- **inner-node-not-disposed**: the inner node's `dispose()` was NOT invoked.
- **scheduled-param-value-retained**: the param's value at re-enable time reflects the scheduled ramp (no anchor reset by the bypass).

#### Test: reverb-bus-ir-async-load (covers R24, R25)

**Given**: a `SendBusGraph` with a `BusEnv` whose `loadBuiltinIr` resolves with a dummy `AudioBuffer` after a microtask.
**When**: `upsertBus({ id, bus_type:'reverb', static_params:{ir:'plate'}, … })` is called; then the microtask drains.
**Then** (assertions):
- **bus-usable-immediately**: `getBus(id).input` and `.output` are non-null; `output` is connected to `ctx.destination`.
- **convolver-buffer-null-before-await**: before the promise resolves, `convolver.buffer === null`.
- **convolver-buffer-assigned-after-await**: after the promise resolves, `convolver.buffer` is the returned `AudioBuffer`.

#### Test: delay-bus-wiring (covers R26)

**Given**: `upsertBus({ bus_type:'delay', static_params:{ time:0.4, feedback:0.5 } })`.
**When**: the bus is built.
**Then** (assertions):
- **delay-time-set**: `delay.delayTime.value === 0.4`.
- **feedback-gain-set**: `fb.gain.value === 0.5`.
- **feedback-loop-present**: `delay → fb → delay` edge exists.
- **input-equals-gain-input**: `bus.input` is the dedicated input `GainNode`.
- **output-equals-delay**: `bus.output === delay`.

#### Test: echo-bus-wiring (covers R27)

**Given**: `upsertBus({ bus_type:'echo', static_params:{ time:0.6, tone:3000 } })`.
**When**: the bus is built.
**Then** (assertions):
- **delay-time-set**: `delay.delayTime.value === 0.6`.
- **filter-frequency-set**: `filter.frequency.value === 3000`.
- **no-feedback-edge**: `delay → delay` edge is absent.
- **output-equals-filter**: `bus.output === filter`.

#### Test: upsert-replaces-existing (covers R24)

**Given**: a bus exists at id `B` (reverb/plate).
**When**: `upsertBus({ id:'B', bus_type:'delay', … })` is called.
**Then** (assertions):
- **previous-dispose-called**: the original reverb bus's `dispose()` was invoked.
- **new-bus-stored**: `getBus('B').busType === 'delay'`.

#### Test: upsert-unknown-type-throws (covers R24)

**Given**: a `SendBusGraph`.
**When**: `upsertBus({ id:'X', bus_type:'weird' as any, … })`.
**Then** (assertions):
- **throws-unknown-bus-type**: throws an `Error` whose message contains `unknown bus_type`.

#### Test: connect-send-wires-input (covers R29)

**Given**: a bus `B` exists; a `GainNode sendGain`.
**When**: `graph.connectSend('B', sendGain)` is called.
**Then** (assertions):
- **sendgain-connects-to-bus-input**: the WebAudio connection `sendGain → bus.input` exists.

#### Test: connect-send-missing-bus-noop (covers R29)

**Given**: a bus id not present in the graph.
**When**: `graph.connectSend('missing', sendGain)`.
**Then** (assertions):
- **no-throw**: does not throw.
- **no-connections-made**: `sendGain` has no new outgoing connection as a result of the call.

#### Test: remove-bus-disposes (covers R28)

**Given**: an existing bus `B`.
**When**: `graph.removeBus('B')` is called.
**Then** (assertions):
- **dispose-called**: the bus's `dispose()` ran.
- **get-bus-returns-undefined**: `graph.getBus('B') === undefined`.
- **list-buses-omits-b**: `graph.listBuses()` no longer contains `B`.

#### Test: remove-bus-unknown-noop (covers R28)

**Given**: an empty or unrelated `SendBusGraph`.
**When**: `graph.removeBus('missing')`.
**Then** (assertions):
- **no-throw**: does not throw.
- **no-state-change**: `listBuses()` is unchanged.

#### Test: delay-bus-setparam (covers R26)

**Given**: an installed delay bus.
**When**: `bus.setParam('time', 0.8)` then `bus.setParam('feedback', 0.6, ctx.currentTime + 1)`.
**Then** (assertions):
- **delaytime-setvalueattime-called**: `delay.delayTime.setValueAtTime(0.8, ctx.currentTime)` is invoked.
- **feedback-setvalueattime-called-with-when**: `fb.gain.setValueAtTime(0.6, ctx.currentTime + 1)` is invoked.

#### Test: echo-bus-setparam (covers R27)

**Given**: an installed echo bus.
**When**: `bus.setParam('time', 0.7)` and `bus.setParam('tone', 2500)`.
**Then** (assertions):
- **delaytime-setvalueattime-called**: `delay.delayTime.setValueAtTime(0.7, …)`.
- **filter-frequency-setvalueattime-called**: `filter.frequency.setValueAtTime(2500, …)`.

#### Test: reverb-bus-setparam-noop (covers R25)

**Given**: an installed reverb bus.
**When**: `bus.setParam('anything', 42)`.
**Then** (assertions):
- **no-throw**: no exception.
- **no-param-writes**: no `setValueAtTime` calls occur on any node owned by the bus.

#### Test: schedule-clip-curve-happy (covers R34, R40)

**Given**: a clip with `start_time = 10`, `end_time = 20`, `muted = false`, `volume_curve = [[0, -6], [0.5, 0], [1, -12]]`; `playhead = 10`; `paramAnchorTime = 0`; `sampleClipDbAtPlayhead → -6`.
**When**: `scheduleClipCurveOnParam(param, clip, 10, 0)`.
**Then** (assertions):
- **cancel-scheduled-values**: `param.cancelScheduledValues(0)` is invoked first.
- **anchor-setvalueattime**: `param.setValueAtTime(dbToLinear(-6), 0)` is invoked.
- **ramp-at-midpoint**: `param.linearRampToValueAtTime(dbToLinear(0), 5)` (xSec=15 → delta 5).
- **ramp-at-end**: `param.linearRampToValueAtTime(dbToLinear(-12), 10)` (xSec=20 → delta 10).
- **no-ramps-past-end**: no further ramps are scheduled.

#### Test: schedule-clip-curve-muted-silences (covers R34)

**Given**: `clip.muted = true`.
**When**: `scheduleClipCurveOnParam` is called.
**Then** (assertions):
- **cancel-called**: `cancelScheduledValues(anchor)` ran.
- **anchor-zero**: `setValueAtTime(0, anchor)` invoked.
- **no-ramps**: `linearRampToValueAtTime` is NOT invoked.

#### Test: schedule-clip-curve-skips-past-points (covers R34)

**Given**: a clip with curve points before the playhead.
**When**: `scheduleClipCurveOnParam` is called.
**Then** (assertions):
- **no-ramps-for-past-points**: no ramp is scheduled for any `xSec ≤ playhead`.
- **later-points-scheduled**: later points ARE scheduled.

#### Test: schedule-track-curve-happy (covers R35, R40)

**Given**: a track with `volume_curve = [[5, -3], [15, 0]]`; `playhead = 10`; `paramAnchorTime = 0`; `effectiveMuted = false`; `sampleTrackDbAtPlayhead → -1.5`.
**When**: `scheduleTrackCurveOnParam`.
**Then** (assertions):
- **anchor-setvalueattime**: `setValueAtTime(dbToLinear(-1.5), 0)`.
- **skip-point-before-playhead**: no ramp scheduled for xSec=5.
- **ramp-for-future-point**: `linearRampToValueAtTime(dbToLinear(0), 5)` for xSec=15.

#### Test: schedule-track-curve-muted-silences (covers R35)

**Given**: `effectiveMuted = true`.
**When**: `scheduleTrackCurveOnParam` is called.
**Then** (assertions):
- **anchor-zero**: `setValueAtTime(0, anchor)`.
- **no-ramps**: no `linearRampToValueAtTime` calls.

#### Test: crossfade-equal-power-curves (covers R36, R37)

**Given**: two clips with overlap `[12, 14]`; `playhead = 10`; `paramAnchorTime = 0`.
**When**: `scheduleCrossfadeOnParams`.
**Then** (assertions):
- **fade-start-ctx**: `fadeStartCtx = 2` (= 0 + max(0, 12 − 10)).
- **duration-correct**: `duration = 2`.
- **incumbent-curve-cos**: `incumbentParam.setValueCurveAtTime(COS_CURVE, 2, 2)` invoked.
- **newcomer-curve-sin**: `newcomerParam.setValueCurveAtTime(SIN_CURVE, 2, 2)` invoked.
- **cos-length-128**: `COS_CURVE.length === 128`.
- **sin-length-128**: `SIN_CURVE.length === 128`.

#### Test: crossfade-no-overlap-noop (covers R36)

**Given**: two clips whose intervals do not overlap.
**When**: `scheduleCrossfadeOnParams` is called.
**Then** (assertions):
- **no-cancel**: neither param has `cancelScheduledValues` invoked.
- **no-curve-calls**: neither param has `setValueCurveAtTime` invoked.

#### Test: mute-no-solo (covers R38)

**Given**: a track with `muted=true`, no other track solo'd.
**When**: `isTrackEffectivelyMuted(track, allTracks)`.
**Then** (assertions):
- **returns-true**: returns `true`.

#### Test: solo-mutes-non-solo-tracks (covers R38)

**Given**: track A `solo=true`, track B `solo=false, muted=false`.
**When**: `isTrackEffectivelyMuted(B, [A, B])`.
**Then** (assertions):
- **non-solo-is-muted**: returns `true`.
- **solo-track-not-muted**: `isTrackEffectivelyMuted(A, [A, B]) === false`.

#### Test: master-bus-empty-chain-passthrough (covers R41)

**Given**: `effects = []`.
**When**: `buildEffectChain(ctx, [])`.
**Then** (assertions):
- **head-and-tail-present**: `handle.input` and `handle.output` are both non-null `GainNode`s.
- **input-connects-to-output**: `inputNode → outputNode` edge exists.
- **effects-array-empty**: `handle.effects.length === 0`.

#### Test: master-bus-includes-disabled (covers R43)

**Given**: one registered effect with `enabled = false`.
**When**: `buildEffectChain`.
**Then** (assertions):
- **effect-included**: `handle.effects.length === 1` (disabled effects ARE included).

#### Test: sorted-curve-points-empty (covers R39)

**Given**: `null`, `undefined`, and `[]` inputs.
**When**: `sortedCurvePoints(input)` is called for each.
**Then** (assertions):
- **returns-empty-array-for-all**: each call returns an array of length 0.

### Edge Cases

#### Test: schedule-clip-curve-breaks-after-end (covers R34)

**Given**: a clip with one curve point whose `xNorm > 1` (maps past `end_time`) plus valid earlier points.
**When**: `scheduleClipCurveOnParam`.
**Then** (assertions):
- **loop-breaks-at-out-of-range**: no ramp is scheduled for any point with `xSec > end_time`.
- **earlier-points-still-scheduled**: valid in-range points ARE scheduled.

#### Test: unknown-effect-type-silently-skipped-in-chain (covers R12, R42, OQ-1)

**Given**: A DB row for a `track_effects` entry whose `effect_type` is not in `EFFECT_TYPES`.
**When**: `buildTrackChain` / `buildEffectChain` builds.
**Then** (assertions):
- **warn-emitted**: `console.warn` contains `[audio-graph] unknown effect_type=` or `[mix-graph] unknown effect_type=`.
- **row-skipped**: the chain's effects list omits the unknown row.
- **other-effects-wired**: known effects build and wire normally.
- **no-ui-surface**: no additional UI event is emitted today (silent-skip is the contract).

#### Test: schedule-curve-empty-points-anchor-only (covers R49)

**Given**: A clip or track whose `volume_curve` is `[]` (or whose scheduled points are empty post-sort).
**When**: `scheduleClipCurveOnParam` / `scheduleTrackCurveOnParam` runs.
**Then** (assertions):
- **cancel-called**: `param.cancelScheduledValues(anchor)` invoked.
- **anchor-set**: `param.setValueAtTime(current_value_at_playhead, anchor)` invoked.
- **no-ramps**: `linearRampToValueAtTime` NOT invoked.

#### Test: setparam-clamps-to-range (covers R46)

**Given**: A delay bus with param `feedback` whose range is `[0, 0.95]`.
**When**: `bus.setParam('feedback', 1.5)` is called.
**Then** (assertions):
- **clamped-value**: `fb.gain.setValueAtTime(0.95, ...)` is invoked (clamped, not raw).
- **no-webaudio-error**: no exception from the WebAudio layer.

#### Test: disable-midcurve-cancels-pending (covers R47)

**Given**: A chain effect with an active scheduled curve on its inner animatable param; curve still has future ramp points.
**When**: `chain.setEffectEnabled(id, false)` is invoked.
**Then** (assertions):
- **cancel-called**: `cancelScheduledValues(ctx.currentTime)` observed on the inner param.
- **bypass-applied**: the BypassManager transitions to bypass.
- **inner-not-disposed**: inner node `.dispose()` is NOT called.

#### Test: enable-resumes-curve-from-playhead (covers R47)

**Given**: Same chain after `setEffectEnabled(id, false)`; playhead has advanced by 0.5s.
**When**: `chain.setEffectEnabled(id, true)` is invoked.
**Then** (assertions):
- **curve-rescheduled**: a fresh `cancelScheduledValues` + `setValueAtTime` + `linearRampToValueAtTime` sequence is observed on the inner param, anchored at the current playhead.
- **route-restored**: the BypassManager transitions back to inner.

#### Test: send-level-zero-preserves-wiring (covers R50)

**Given**: A `TrackSend { track_id, bus_id, level: 0 }`.
**When**: `buildTrackChain` runs.
**Then** (assertions):
- **sendgain-present**: `chain.sends.has(bus_id) === true`.
- **gain-zero**: `sendGain.gain.value === 0`.
- **upstream-connected**: `trackGain → sendGain` edge is present.
- **connect-send-still-invoked**: caller can still call `SendBusGraph.connectSend(bus_id, sendGain)` successfully.

#### Test: bypass-flip-flip-same-frame-both-run (covers R51)

**Given**: A `BypassManager` in `enabled=true, inner` state.
**When**: `setEnabled(false)` then `setEnabled(true)` within the same animation frame (no await between).
**Then** (assertions):
- **disconnect-then-reconnect-observed**: one `input.disconnect()` + `input.connect(output)` pair from the first call, then a second `disconnect()` + re-wire to inner chain from the second.
- **no-coalescing**: neither call is a no-op; both transitions execute.

#### Test: sorted-curve-dedupes-duplicate-x (covers R39)

**Given**: `volume_curve = [[0.3, -6], [0.3, -2], [0.7, -10]]` (duplicate `x=0.3`).
**When**: `sortedCurvePoints(curve)` runs.
**Then** (assertions):
- **dedupe-last-wins**: result is `[[0.3, -2], [0.7, -10]]` (the later duplicate survived).
- **ascending-order**: result is sorted by `x` ascending.

#### Test: curve-anchor-clamped-to-currenttime (covers R48)

**Given**: Helper is called with `paramAnchorTime = ctx.currentTime - 0.5` (stale, in the past).
**When**: `scheduleClipCurveOnParam` (or track/crossfade helper) runs.
**Then** (assertions):
- **anchor-bumped**: `cancelScheduledValues` is called with `ctx.currentTime` (not the stale value).
- **setvalueattime-bumped**: `setValueAtTime(..., ctx.currentTime)` is observed.
- **ramps-offset-from-current**: any `linearRampToValueAtTime(v, t)` uses `t = ctx.currentTime + (xSec - playhead)`, not `stale_anchor + (...)`.

#### Test: schedule-clip-curve-zero-length-span (covers R34)

**Given**: a clip with `end_time === start_time` and one curve point at `xNorm = 0.5`.
**When**: `scheduleClipCurveOnParam` with `playhead = start_time`.
**Then** (assertions):
- **span-clamped-to-1e-9**: `xSec ≈ start_time + 0.5e-9` (finite, not NaN).
- **point-skipped-versus-playhead**: the point is skipped (xSec ≤ playhead after rounding / or ramps at a sub-nanosecond delta — documented as "collapses to anchor").

---

## Non-Goals

- **DSP correctness of individual effect bodies**: this spec does not audit that `buildCompressor` actually compresses, only that it returns an `EffectNode` that wires and disposes cleanly.
- **`/api/track-effects` HTTP surface**: only the `__send` rejection is named as an invariant; request/response shapes live elsewhere.
- **Effect-curve table DDL / persistence**: TypeScript row shapes are reproduced; database migration details are not.
- **Macro panel UI / automation editor**: UI layer is out of scope.
- **Offline renderer activation / seek logic**: covered by `webaudio-mixer-and-mix-graph` and `bounce-and-analysis` specs.
- **Bit-identical live-vs-offline parity proofs** for the effect chain (covered by `bounce-and-analysis`).

---

## Open Questions

### Resolved

- **OQ-1 — Effect type not in registry**: **Resolved (codify)**. Silent-skip with `console.warn` is the contract; no UI event, no raise. Test `unknown-effect-type-silently-skipped-in-chain`.
- **OQ-2 — `scheduleCurve` with zero points**: **Resolved (codify)**. Anchor-only: `cancelScheduledValues` + `setValueAtTime(current, anchor)`; no ramps. Requirement R49. Test `schedule-curve-empty-points-anchor-only`.
- **OQ-3 — `setParam` out of declared range**: **Resolved (fix)**. Graph-layer clamps to `[range.min, range.max]` before writing to the WebAudio param. Requirement R46. Test `setparam-clamps-to-range`.
- **OQ-4 — Disable effect mid-scheduled-curve**: **Resolved (fix)**. `setEffectEnabled(id, false)` cancels pending curves on the inner animatable param; `setEffectEnabled(id, true)` re-schedules from the current playhead. The code's `TODO(task-48)` marker is removed. Requirement R47. Tests `disable-midcurve-cancels-pending`, `enable-resumes-curve-from-playhead`.
- **OQ-5 — `TrackSend.level === 0`**: **Resolved (codify)**. Wiring preserved; level 0 is "silent send" not "disconnected". Requirement R50. Test `send-level-zero-preserves-wiring`.
- **OQ-6 — Two `BypassManager.setEnabled` calls same frame**: **Resolved (codify)**. No coalescing; each transition applied as-called. Requirement R51. Test `bypass-flip-flip-same-frame-both-run`.
- **OQ-7 — Non-monotonic curve x-values**: **Resolved (fix)**. `sortedCurvePoints` dedupes duplicate-x (last-wins) and sorts ascending; non-monotonic input clamped to monotonic. Requirement R39 updated. Test `sorted-curve-dedupes-duplicate-x`.
- **OQ-8 — Curve scheduled in the past**: **Resolved (fix)**. Helper clamps `paramAnchorTime = max(paramAnchorTime, ctx.currentTime)` before any schedule call. Requirement R48. Test `curve-anchor-clamped-to-currenttime`.

### Cross-cutting notes

- **Master-bus divergence from track bypass**: per-track chains use `BypassManager`; master bus does NOT (disabled effects still included in the master chain). This is explicit design, not a bug. Codified by R43.
- **`SendBusGraph.scheduleCurve` TODO**: reverb/delay/echo bus `scheduleCurve` methods are currently no-ops. This is known unimplemented work and tracked as future. The contract surfaced to callers today is: calls succeed silently without scheduling. Spec does not promise automation on send-bus params until task-48 lands.

---

## Related Artifacts

- **Source material**: `src/lib/audio-effect-types.ts`, `src/lib/audio-graph.ts`, `src/lib/mix-graph.ts` (curve scheduling + shared effect-chain builder only).
- **Audit**: `agent/reports/audit-2-architectural-deep-dive.md` §1E (units 4–8: EffectRegistry, TrackChain, SendBusGraph, BypassManager, CurveScheduler).
- **Prior spec referenced in code**: `agent/specs/local.effect-curves-macro-panel.md` (R7-R15, R48-R49, R19 cited in docstrings — pre-existing design spec; this retro-spec narrows to the already-implemented behavior).
- **Sibling specs** (proposed; not yet written): `local.webaudio-mixer-and-mix-graph` (#16), `local.bounce-and-analysis` (#18).
- **Invariants carried forward**:
  - "Frontend WebAudio is audio source of truth" (user memory).
  - "Live and offline produce bit-identical output via shared `mix-graph`" (audit §1E).
  - R9: LFO rates + `drive.character` + `*_send.bus_id` non-animatable.
  - R8a: `__send` is synthetic and rejected at the API layer.

---

**Namespace**: local
**Spec**: audio-effects-and-curve-scheduling
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive black-box spec)
**Commit**: not committed (per caller instruction)
