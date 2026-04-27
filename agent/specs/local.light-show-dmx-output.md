# Spec: Light Show DMX Output Layer (WebSerial → ENTTEC Pro)

> **🤖 Agent Directive**: This is a **retroactive black-box spec** for the light_show DMX output layer as it ships today. The Behavior Table is the reviewer's scannable proofing surface; every `undefined` row marks a scenario the current code does not resolve and needs product decisions before implementation hardens. The Tests section is language-agnostic: frontend tests run under Vitest (install on demand per project convention — no frontend tests exist yet), hardware-dependent cases are described but not expected to run in CI.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Retroactive — Ready for Proofing

---

## Purpose

Specify the exact observable behavior of the browser-side DMX output bridge: the WebSerial connection flow, the cross-panel `dmx-ref` singleton that owns it, the 512-channel universe model, the `autoPatch` / `fixturesToDMX` mapping layer, the decoupled ~30 Hz transmit loop that coalesces 60 fps frame writes onto USB, and the disconnect/error teardown. This is the **hardware bridge only** — scene authoring, evaluator precedence, and per-fixture override semantics are covered by `local.light-show-scene-editor.md` and only appear here at the seam where rendered `FixtureState[]` crosses into DMX bytes.

The layer exists because the browser is the audio/visual source of truth (see project memory): the same `FixtureState[]` that drives the 3D preview is what must reach real movers and pars on stage, and the ENTTEC DMX USB Pro is the cheapest widely-supported USB-DMX dongle that speaks a documented widget protocol over WebSerial.

---

## Source

`--from-draft` (retroactive): direct reading of shipped code in `src/plugins/light_show/` — specifically `enttec-pro.ts`, `dmx-mapper.ts`, `dmx-ref.ts`, `fixtures.ts`, and the integration sites in `LightShow3DPanel.tsx` (`handleDmxToggle`, `SceneRunner`'s per-frame `dmx.send(...)`). No prior written source existed.

Related: [local.light-show-scene-editor.md](local.light-show-scene-editor.md) (scene authoring — upstream of this layer).

---

## Scope

### In Scope

- WebSerial connection flow: user-initiated picker, FTDI VID/PID filter `0x0403:0x6001`, port open at 115200 baud
- ENTTEC DMX USB Pro widget frame format: `0x7E [label] [LSB] [MSB] [start_code=0x00] [512 channels] 0xE7`
- 60 fps → ~30 Hz transmit coalescing via a dedicated `transmitLoop()` reading the latest-frame buffer
- 512-channel single-universe model (`DMX_CHANNELS = 512`)
- Per-fixture DMX patch: `{fixtureId, role, universe, startAddress, channelCount}` with explicit pin + auto-fill
- `autoPatch()` two-pass algorithm: pinned fixtures first, then greedy auto-fill from address 1
- `fixturesToDMX()` translating `FixtureState[]` (intensity 0-1, color [r,g,b] 0-1, pan rad, tilt rad) → `Uint8Array(512)` by role:
  - `par` (6ch): dimmer, R, G, B, effects=0, speed=0
  - `moving_head` (6ch): dimmer, R, G, B, pan (−π..π → 0..255), tilt (−π/2..π/2 → 0..255)
- `dmx-ref` module-level singleton (`getActiveDmx`, `setActiveDmx`, `getDmxState`, `setDmxState`, `subscribeDmx`) decoupling the connection's lifetime from panel mount/unmount
- State machine: `disconnected → connecting → connected → error → disconnected`
- Disconnect semantics: flush `transmitTask` before releasing writer; idempotent cleanup
- "Simulation mode" = no EnttecPro instance attached; SQLite-backed fixtures/cues/scenes still persist and drive the 3D preview
- Seam with the evaluator: the DMX layer reads `FixtureState[]` **after** the evaluator + override pipeline has fully resolved the frame

### Out of Scope

- Scene authoring (see `local.light-show-scene-editor.md`)
- Fixture 3D placement UI (future spec)
- GDTF fixture profiles / MVR rig import (planned)
- sACN / Art-Net / OLA network protocols (planned; ENTTEC Pro USB only today)
- Multi-universe output (universe field on patches is forward-compat; today only universe 1 is transmitted)
- 16-bit fine pan/tilt channels (only 8-bit pan/tilt today)
- OFL fixture library import (planned; per-fixture channel profiles land with it)
- Backend Python DMX output (never intended — browser is audio/visual SoT)

---

## Requirements

### WebSerial connection flow

- **R1.** `EnttecPro.connect()` MUST detect WebSerial support by checking `'serial' in navigator`. When absent, it MUST set state to `error`, call `onError("WebSerial not supported in this browser")`, and return without throwing.
- **R2.** On supported browsers, `connect()` MUST set state to `connecting` before calling `navigator.serial.requestPort`.
- **R3.** `requestPort` MUST filter the picker by `{usbVendorId: 0x0403, usbProductId: 0x6001}` (FTDI chip used by ENTTEC Pro).
- **R4.** After port selection, `connect()` MUST open the port at `baudRate: 115200`, acquire the writable stream's writer, set state to `connected`, flip `transmitting = true`, and kick off `transmitLoop()` stored on `transmitTask`.
- **R5.** If `requestPort` is cancelled by the user (browser rejects the promise with `NotFoundError`), or `open` throws, or `port.writable` is null, `connect()` MUST set state to `error`, call `onError(message)`, run `cleanup()`, and return without propagating the exception to the caller.

### Transmit loop + frame coalescing

- **R6.** The DMX frame layout built by `buildDMXFrame(channels)` MUST be exactly 518 bytes: `[0x7E] [0x06] [LSB of 513] [MSB of 513] [0x00] [ch1..ch512] [0xE7]`.
- **R7.** `EnttecPro.send(channels)` MUST be O(1) non-blocking: it MUST copy at most `DMX_CHANNELS` bytes of the caller's buffer into the internal `lastFrame` and return synchronously without issuing any USB write.
- **R8.** The `transmitLoop()` MUST, while `transmitting && writer`, repeatedly: (a) build a frame from the current `lastFrame`, (b) `await writer.write(frame)`, (c) `await setTimeout(33ms)`. Any 60 fps `send()` calls that land between two loop iterations are coalesced — only the most recent `lastFrame` is transmitted on the next iteration (intermediate frames are silently dropped).
- **R9.** If `writer.write` throws, the loop MUST set state to `error`, call `onError("Write failed: <msg>")`, run `cleanup()`, and return. No further frames are transmitted and no auto-reconnect is attempted.

### 512-channel universe model

- **R10.** `DMX_CHANNELS` MUST be `512`. The transmit buffer is exactly 512 bytes regardless of how many fixtures are patched; unpatched channels are transmitted as `0x00`.
- **R11.** A `DMXPatch` MUST have shape `{fixtureId: string, role: FixtureRole, universe: number (1-based), startAddress: number (1-based), channelCount: number}`.

### autoPatch

- **R12.** `autoPatch(fixtures)` MUST run two passes: (1) pin pass — every fixture with non-null `dmxAddress` is placed at its requested `(dmxUniverse ?? 1, dmxAddress)`; (2) auto-fill pass — every fixture with null/undefined `dmxAddress` is placed in universe 1 at the next address ≥ 1 whose `channelCount`-wide range is fully unoccupied.
- **R13.** Default `channelCount` MUST be `6` for both `moving_head` and `par` when `dmxChannelCount` is not set on the fixture.
- **R14.** A pin that overlaps another pin's already-reserved range MUST be silently dropped (no patch emitted, no exception). Callers can detect this by comparing `fixtures.length` to `autoPatch(...).length`.
- **R15.** A pin whose range extends past channel 512 (i.e., `startAddress + channelCount - 1 > 512`) or whose `startAddress < 1` MUST be silently dropped.
- **R16.** Auto-fill MUST walk the cursor forward — earlier auto-filled fixtures get lower addresses. When no range fits in universe 1 (auto-fill exhausted), the fixture MUST be silently dropped.

### fixturesToDMX

- **R17.** `fixturesToDMX(states, patches)` MUST return a 512-byte `Uint8Array`.
- **R18.** For each patch, it MUST look up the matching state by `fixtureId`; if no state is found, that patch's channels MUST remain `0x00`.
- **R19.** Channel `base+0` (dimmer) MUST be `round(clamp(intensity, 0, 1) * 255)`.
- **R20.** Channels `base+1..base+3` (R, G, B) MUST be `round(clamp(color[i], 0, 1) * 255)` for `i = 0, 1, 2`.
- **R21.** For `patch.channelCount >= 6` with `role === 'moving_head'`: `base+4` = `radiansTo255(pan, -π, π)`, `base+5` = `radiansTo255(tilt, -π/2, π/2)`. Values are clamped before rounding, so pan/tilt outside the mapped range saturate at 0 or 255.
- **R22.** For `patch.channelCount >= 6` with any non-`moving_head` role (`par` today): `base+4` = `0`, `base+5` = `0` (effects macro off, speed zero).
- **R23.** A patch whose computed byte range escapes `[0, 512)` MUST be skipped (no partial writes).

### dmx-ref singleton

- **R24.** `getActiveDmx()` MUST return the currently-stored `EnttecPro | null`. `setActiveDmx(pro)` MUST replace it and notify all subscribers synchronously.
- **R25.** `getDmxState()` MUST return the last cached `DMXOutputState`. `setDmxState(s)` MUST update the cache and notify subscribers.
- **R26.** `subscribeDmx(cb)` MUST register `cb` and return an unsubscribe function that removes it. Multiple subscribers MUST all be notified on every `setActiveDmx` or `setDmxState` call.
- **R27.** Panel unmount (`LightShow3DPanel` removed from the dock) MUST NOT disconnect the active `EnttecPro`. The singleton MUST keep holding the instance, `transmitLoop` MUST continue running, and the dongle MUST continue receiving the last-written frame at ~30 Hz.
- **R28.** Panel remount MUST read the existing singleton via `getActiveDmx()` and attach its `SceneRunner` to it without touching the connection state. (The singleton decouples connection lifetime from component lifecycle — identical pattern to `audio-mixer-ref`.)

### Disconnect handling

- **R29.** `disconnect()` MUST set `transmitting = false`, `await transmitTask` (swallowing any rejection), run `cleanup()` (release writer lock and close port, both in try/catch), then set state to `disconnected`.
- **R30.** `disconnect()` MUST be safe to call when already disconnected (idempotent; no throw).
- **R31.** On `writer.write` failure mid-loop, the loop itself calls `cleanup()` and transitions to `error`. A subsequent explicit `disconnect()` MUST be a no-op that still resolves.

### Per-frame integration (SceneRunner → DMX)

- **R32.** On every `useFrame` tick in `SceneRunner`, after the evaluator + pin-override pipeline has mutated `stateRef.current`, the code MUST check `dmxRef.current?.connected`. When `true`, it MUST call `fixturesToDMX(stateRef.current, dmxPatchesRef.current)` and pass the result to `dmx.send(...)`. When `false`, no DMX computation or write occurs.
- **R33.** `dmxPatchesRef.current` MUST be recomputed via `autoPatch(rig)` whenever the rig array identity changes.

### Persistence invariant

- **R34.** Fixtures (with their `dmx_universe`, `dmx_address`, `dmx_channel_count` columns), cues, and scenes MUST persist in the per-project SQLite DB (`light_show__fixtures`, `light_show__scenes`, `light_show__scene_placements`, `light_show__live_override`) independent of any EnttecPro connection state. "Simulation mode" means no EnttecPro is attached — state still persists, the 3D preview still runs, chat MCP tools still mutate the DB.

### Per-fixture live overrides (seam)

- **R35.** Per-fixture pinned overrides (`light_show__overrides` rows; frontend `overridesRef`) MUST apply as a **fallback layer**, below live/timeline scenes — NOT as a top-winning layer. Precedence is `live override > timeline placement > pinned overrides > fallback scene`. (This matches shipped code in `LightShow3DPanel.tsx` and contradicts the brief's assumption that pins win; the pins-win case is flagged as OQ-1 below.)

---

## Interfaces / Data Shapes

### TypeScript types

```ts
// enttec-pro.ts
export type DMXOutputState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface EnttecProEvents {
  onStateChange?: (state: DMXOutputState) => void
  onError?: (error: string) => void
}

export class EnttecPro {
  constructor(events?: EnttecProEvents)
  readonly state: DMXOutputState
  readonly connected: boolean
  connect(): Promise<void>
  disconnect(): Promise<void>
  send(channels: Uint8Array): void  // non-blocking; stores into lastFrame
}

// dmx-mapper.ts
export interface DMXPatch {
  fixtureId: string
  role: 'par' | 'moving_head'
  universe: number        // 1-based
  startAddress: number    // 1-based, 1..512
  channelCount: number    // default 6
}
export function autoPatch(fixtures: readonly FixtureDef[]): DMXPatch[]
export function fixturesToDMX(states: FixtureState[], patches: DMXPatch[]): Uint8Array

// dmx-ref.ts
export function getActiveDmx(): EnttecPro | null
export function setActiveDmx(dmx: EnttecPro | null): void
export function getDmxState(): DMXOutputState
export function setDmxState(state: DMXOutputState): void
export function subscribeDmx(cb: () => void): () => void
```

### Widget frame layout (bytes)

```
byte 0:   0x7E                       START_OF_MSG
byte 1:   0x06                       LABEL (Output Only Send DMX)
byte 2:   0x01                       data length LSB  (513 & 0xFF)
byte 3:   0x02                       data length MSB  ((513 >> 8) & 0xFF)
byte 4:   0x00                       DMX start code
bytes 5..516:                        512 channel bytes (0x00..0xFF)
byte 517: 0xE7                       END_OF_MSG
```

### State transitions

```
disconnected  --connect()→ connecting
connecting    --picker+open OK→ connected
connecting    --picker cancel/open error/serial absent→ error
connected     --disconnect()→ disconnected
connected     --writer.write throws→ error  (loop self-tears-down)
error         --disconnect()→ disconnected  (idempotent cleanup)
```

---

## Behavior Table

| #  | Scenario                                                                           | Expected Behavior                                                                                | Tests |
|----|------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|-------|
| 1  | User clicks Connect on a Chrome/Edge browser with an ENTTEC Pro attached           | Picker shows, user selects port; state goes `connecting → connected`; transmit loop starts       | `connect-happy-path` |
| 2  | Browser lacks WebSerial (Safari/Firefox)                                           | State goes to `error`; `onError("WebSerial not supported…")` fires; no exception thrown          | `connect-rejects-no-webserial` |
| 3  | User cancels the port picker                                                       | State goes to `error`; `onError(msg)` fires; cleanup runs; caller's promise resolves             | `connect-user-cancels-picker` |
| 4  | App calls `send()` at 60 fps                                                       | Each call is O(1) memcpy; only the latest frame reaches the dongle at ~30 Hz (33 ms interval)    | `send-is-nonblocking`, `transmit-loop-coalesces-60fps-to-30hz` |
| 5  | Transmit loop is mid-`await writer.write` when `disconnect()` is called            | `disconnect()` awaits `transmitTask` before releasing the writer; no mid-write teardown race     | `disconnect-awaits-transmit-task` |
| 6  | `writer.write` throws mid-loop (cable unplugged)                                   | Loop sets state `error`, calls `onError("Write failed: …")`, runs cleanup, exits                 | `write-failure-tears-down` |
| 7  | Fixture with `dmxAddress=1, channelCount=6` is patched                             | Patch: `{startAddress: 1, channelCount: 6, universe: 1}`; bytes 0..5 reflect fixture state       | `autopatch-honors-explicit-pin`, `fixtures-to-dmx-par-layout` |
| 8  | Two pinned fixtures request overlapping channel ranges                             | First pin wins; second is silently dropped; `autoPatch(...).length < fixtures.length`            | `autopatch-drops-overlapping-pin` |
| 9  | Pin has `startAddress = 510, channelCount = 6` (runs past 512)                     | Pin is silently dropped                                                                          | `autopatch-drops-out-of-range-pin` |
| 10 | Rig of 4 moving_heads + 4 pars with no pins                                        | Auto-fill assigns contiguous blocks starting at 1: 1-6, 7-12, 13-18, …, 43-48                    | `autopatch-autofills-from-address-1` |
| 11 | `fixturesToDMX` for a `par` with intensity=0.5, color=[1,0,0]                      | Bytes: dimmer=128, R=255, G=0, B=0, effects=0, speed=0                                           | `fixtures-to-dmx-par-layout` |
| 12 | `fixturesToDMX` for a `moving_head` with pan=0, tilt=0                             | Bytes: dimmer/RGB per state; pan byte = 128 (center of −π..π), tilt byte = 128 (center)          | `fixtures-to-dmx-mover-pan-tilt-center` |
| 13 | Moving head with pan = π, tilt = π/2                                               | Pan byte = 255, tilt byte = 255 (saturated at top of mapped range)                               | `fixtures-to-dmx-mover-saturates` |
| 14 | Pan = 2π (past range) or intensity = 1.5                                           | Pan byte = 255; dimmer byte = 255 (clamped before rounding)                                      | `fixtures-to-dmx-clamps-out-of-range` |
| 15 | A patch references a `fixtureId` not present in `states[]`                         | That patch's 6 bytes stay `0x00`                                                                 | `fixtures-to-dmx-missing-state-leaves-zeros` |
| 16 | Panel unmounts while DMX is connected                                              | Singleton keeps the `EnttecPro`; transmit loop keeps running; dongle keeps receiving last frame  | `panel-unmount-does-not-disconnect-dmx` |
| 17 | Panel remounts after unmount                                                       | `getActiveDmx()` returns the same instance; new SceneRunner attaches `send()` to it              | `panel-remount-picks-up-singleton` |
| 18 | Multiple React components subscribe via `subscribeDmx`                             | All subscribers notified on every `setActiveDmx` / `setDmxState`; unsubscribe removes one only   | `subscribe-notifies-all`, `unsubscribe-removes-one` |
| 19 | `disconnect()` called when already disconnected                                    | No-op; resolves without throwing                                                                 | `disconnect-is-idempotent` |
| 20 | Simulation mode (no EnttecPro attached) with fixtures/scenes/cues in DB            | SQLite state persists; 3D preview renders; no DMX bytes computed; `dmx.send` never called       | `simulation-mode-persists-without-hardware` |
| 21 | SceneRunner frame tick when `dmxRef.current` is null                               | No `fixturesToDMX` call; no `send` call; no allocation                                           | `frame-tick-skips-dmx-when-disconnected` |
| 22 | Rig identity changes (new fixture added)                                           | `autoPatch(rig)` reruns; `dmxPatchesRef.current` replaced with new list                          | `patches-rebuilt-on-rig-change` |
| 23 | `autoPatch` input has 100 pinned fixtures filling the universe                     | Remaining unpinned fixtures silently dropped from auto-fill                                      | `autopatch-drops-when-universe-full` |
| 24 | Send buffer received from caller is shorter than 512 bytes                         | `send()` copies up to `min(len, 512)` into `lastFrame`; remaining bytes retain prior value       | `send-handles-short-buffer` (undefined — see OQ-2) |
| 25 | User clicks Connect and picks a non-ENTTEC serial device (e.g., Arduino)           | `undefined`                                                                                      | → [OQ-3](#open-questions) |
| 26 | Cable unplugged mid-scene                                                          | Loop detects write failure; state → `error`; no auto-reconnect; scene keeps rendering in 3D     | `write-failure-tears-down` + undefined reconnect policy (OQ-4) |
| 27 | Caller invokes `send()` faster than the loop can `await writer.write`              | Frames coalesced: latest wins; intermediate frames dropped; no queue buildup                    | `transmit-loop-coalesces-60fps-to-30hz` (undefined if dongle itself exerts backpressure — OQ-5) |
| 28 | Two browser tabs both call `navigator.serial.requestPort` for the same device      | `undefined`                                                                                      | → [OQ-6](#open-questions) |
| 29 | Fixture patched with role `'par'` and `channelCount = 12` (larger than default)    | Dimmer/RGB written to base+0..3; base+4..5 held at 0; base+6..11 stay `0x00`                     | `fixtures-to-dmx-oversized-channel-count` |
| 30 | Fixture with unknown role string (forward-compat; not `'par'` or `'moving_head'`)  | `undefined`                                                                                      | → [OQ-7](#open-questions) |
| 31 | Pinned override sets `fixture.intensity = 0.5` while a timeline scene is rendering | Timeline scene wins; pin does NOT apply (contradicts brief's "pins win" assumption)              | `pins-apply-only-when-no-scene-driving` (+ OQ-1) |
| 32 | Live override row persists across engine restart                                   | On reboot, scene_live.status returns active=true; evaluator resumes; DMX output resumes if attached | `persistence-invariant-live-override-survives-restart` |
| 33 | Dongle applies hardware backpressure (USB write blocks > 33 ms)                    | `undefined`                                                                                      | → [OQ-5](#open-questions) |
| 34 | Caller references channel > 512 via an oversized `channelCount` that escapes 512   | Patch is skipped in `fixturesToDMX` (`base + channelCount > 512` guard)                          | `fixtures-to-dmx-skips-out-of-bounds-patch` |

---

## Behavior

### Connect

1. User clicks the DMX Output toggle in `LightShow3DPanel`.
2. Handler checks `getActiveDmx()` — if present and connected, it calls `disconnect()`, `setActiveDmx(null)`, and returns.
3. Otherwise it constructs `new EnttecPro({onStateChange: setDmxState, onError: console.warn})`, calls `setActiveDmx(pro)`, then `await pro.connect()`.
4. `connect()` verifies WebSerial, transitions to `connecting`, pops the picker with VID/PID filter, opens at 115200, grabs the writer, transitions to `connected`, starts `transmitLoop()`.
5. State changes flow through `setDmxState`, which notifies all `subscribeDmx` listeners; `LightShow3DPanel` re-renders and the button flips green "DMX: ON".

### Per-frame DMX send

1. `SceneRunner`'s `useFrame` callback runs at ~60 fps.
2. Evaluator resolves `activeLayer` and writes `stateRef.current`.
3. Pinned-override layer optionally composites (only when `activeLayer ∈ {fallback, none}`).
4. `dmxRef.current?.connected` check; when true, call `fixturesToDMX(stateRef.current, dmxPatchesRef.current)` → 512-byte buffer → `dmx.send(buf)`.
5. `send()` does one `Uint8Array.set(...)` copy into `lastFrame` and returns.
6. The dedicated `transmitLoop()` (independent of React) wakes every 33 ms, builds the 518-byte widget frame from the current `lastFrame`, `await writer.write(frame)`, then `await setTimeout(33)`.

### Disconnect

1. User clicks the toggle again while connected.
2. `handleDmxToggle` calls `existing.disconnect()`; then `setActiveDmx(null)`.
3. `disconnect()` flips `transmitting = false`, awaits `transmitTask` (which observes the flag on its next iteration and returns), then releases the writer lock and closes the port, then sets state `disconnected`.

### Write failure mid-scene

1. Cable unplugged. `writer.write(frame)` rejects.
2. Loop catches, sets state `error`, fires `onError("Write failed: …")`, runs `cleanup()` (releases lock if possible, closes port if possible), returns.
3. `dmx.connected` is now `false`; the per-frame SceneRunner hook stops calling `send` from that point on.
4. 3D preview continues rendering normally — DMX failure is decoupled from the render loop.
5. No auto-reconnect today (see OQ-4). User must click Connect again.

---

## Acceptance Criteria

- [ ] `connect()` on unsupported browser sets state `error` without throwing
- [ ] `connect()` picker filter is exactly `{usbVendorId: 0x0403, usbProductId: 0x6001}`
- [ ] `connect()` opens at 115200 baud, transitions `connecting → connected`, starts transmit loop
- [ ] Widget frame is exactly 518 bytes with `0x7E`/`0x06`/`LSB(513)=0x01`/`MSB(513)=0x02`/`0x00`/…/`0xE7`
- [ ] `send()` is O(1) and does not issue USB writes
- [ ] Transmit loop coalesces bursts of `send()` calls; only the latest `lastFrame` reaches the dongle each ~33 ms
- [ ] `autoPatch` honors pins first, then auto-fills from address 1
- [ ] `autoPatch` drops overlapping pins, out-of-range pins, and auto-fill overflow — all silently
- [ ] `fixturesToDMX` returns exactly 512 bytes
- [ ] Par 6-ch layout: dimmer, R, G, B, 0, 0
- [ ] Moving head 6-ch layout: dimmer, R, G, B, pan, tilt (both 8-bit linear maps over their documented ranges)
- [ ] Missing state for a patched fixture leaves those channels at `0x00`
- [ ] Panel unmount/remount does not affect the active EnttecPro instance or the transmit loop
- [ ] `disconnect()` is idempotent and awaits the transmit task before releasing the writer
- [ ] A write failure flips state to `error` and exits the loop cleanly; no uncaught rejection escapes
- [ ] Simulation mode: fixtures/cues/scenes persist in SQLite; 3D preview runs; no DMX I/O
- [ ] Every pinned override scenario runs only when no live/timeline scene is active (matches shipped precedence)

---

## Tests

All tests are vitest-style where frontend-resident; no frontend tests exist in this repo today (see project memory `project_no_frontend_tests`). Hardware-dependent tests use a WebSerial mock — `navigator.serial` replaced with a fake `requestPort`/`Port`/`WritableStream` that records writes.

### Base Cases

#### Test: connect-happy-path (covers R1, R2, R3, R4)

**Given**: `'serial' in navigator` is true; fake `requestPort` returns a port whose `open()` resolves and whose `writable` yields a writer.

**When**: `const pro = new EnttecPro(); await pro.connect()`.

**Then** (assertions):
- **state-transitions**: `onStateChange` observed sequence is `['connecting', 'connected']`.
- **picker-filter**: `requestPort` was called with `{filters: [{usbVendorId: 0x0403, usbProductId: 0x6001}]}`.
- **baud-115200**: `port.open` was called with `{baudRate: 115200}`.
- **connected-true**: `pro.connected === true`.
- **transmit-loop-started**: fake writer receives at least one `write` within 100 ms.

#### Test: connect-rejects-no-webserial (covers R1)

**Given**: `navigator.serial` is undefined.

**When**: `await pro.connect()`.

**Then** (assertions):
- **state-is-error**: `pro.state === 'error'`.
- **on-error-fired**: `onError` received `"WebSerial not supported in this browser"`.
- **no-throw**: `connect()` promise resolved (did not reject).
- **connected-false**: `pro.connected === false`.

#### Test: connect-user-cancels-picker (covers R5)

**Given**: `requestPort` rejects with a `NotFoundError`.

**When**: `await pro.connect()`.

**Then** (assertions):
- **state-is-error**: `pro.state === 'error'`.
- **on-error-fired**: `onError` received a non-empty message.
- **cleanup-ran**: the fake `port.close` was called zero times (never opened) AND `writer` is null.
- **no-throw**: `connect()` resolved.

#### Test: send-is-nonblocking (covers R7)

**Given**: A connected `EnttecPro`.

**When**: `pro.send(new Uint8Array(512))` called 1000 times in a tight synchronous loop.

**Then** (assertions):
- **returns-synchronously**: each call returns `undefined` (not a Promise).
- **total-time-under-5ms**: 1000 calls complete in < 5 ms on a commodity laptop.
- **no-usb-writes-during-burst**: the fake writer received ≤ 1 `write` during the 1000-call burst (coalescing proof).

#### Test: transmit-loop-coalesces-60fps-to-30hz (covers R8)

**Given**: A connected `EnttecPro`; test clock drives `setTimeout` deterministically; caller calls `send(frameN)` every 16 ms.

**When**: 1000 ms of simulated time elapses with 62 `send` calls.

**Then** (assertions):
- **write-rate-30hz**: fake writer observed ~30 `write` calls (±1) over 1000 ms.
- **latest-frame-wins**: the payload of the final observed `write` contains the channel bytes corresponding to `frame61` or `frame62` (latest seen before the iteration).
- **no-queue-buildup**: fake writer's pending-write backlog never exceeds 1.

#### Test: frame-layout-518-bytes (covers R6)

**Given**: `channels = Uint8Array(512)` with `channels[0] = 0xAB, channels[511] = 0xCD`.

**When**: `buildDMXFrame(channels)` is called.

**Then** (assertions):
- **total-length**: frame.length === 518.
- **header**: `frame[0] === 0x7E`, `frame[1] === 0x06`, `frame[2] === 0x01`, `frame[3] === 0x02`.
- **start-code**: `frame[4] === 0x00`.
- **channel-copy**: `frame[5] === 0xAB`, `frame[516] === 0xCD`.
- **terminator**: `frame[517] === 0xE7`.

#### Test: disconnect-awaits-transmit-task (covers R29)

**Given**: Connected `EnttecPro`; fake `writer.write` is slowed to resolve after 50 ms.

**When**: `await pro.disconnect()` while a write is in flight.

**Then** (assertions):
- **state-disconnected**: final state is `'disconnected'`.
- **writer-released-after-write**: `releaseLock` was called AFTER the in-flight `write` resolved (not during).
- **no-unhandled-rejection**: no unhandled rejection observed.

#### Test: disconnect-is-idempotent (covers R30, R31)

**Given**: `EnttecPro` already in `disconnected` state.

**When**: `await pro.disconnect()` (first call); `await pro.disconnect()` (second call).

**Then** (assertions):
- **no-throw**: both calls resolve.
- **state-stays-disconnected**: final state `'disconnected'`.
- **no-extra-close-call**: fake `port.close` was called 0 or 1 times total (not incremented on second call).

#### Test: write-failure-tears-down (covers R9)

**Given**: Connected `EnttecPro`; fake `writer.write` throws on the 3rd call.

**When**: Transmit loop reaches the 3rd iteration.

**Then** (assertions):
- **state-is-error**: `pro.state === 'error'`.
- **on-error-contains-write-failed**: `onError` received a message starting with `"Write failed: "`.
- **cleanup-ran**: writer released, port closed.
- **loop-exited**: no further `write` calls observed for 200 ms.

#### Test: autopatch-honors-explicit-pin (covers R12, R13)

**Given**: One fixture `{id: 'mh_1', role: 'moving_head', dmxAddress: 10}`.

**When**: `autoPatch([fixture])`.

**Then** (assertions):
- **one-patch**: result.length === 1.
- **pin-preserved**: `patches[0] === {fixtureId: 'mh_1', role: 'moving_head', universe: 1, startAddress: 10, channelCount: 6}`.

#### Test: autopatch-autofills-from-address-1 (covers R12, R16)

**Given**: Four fixtures, no pins, 6ch each.

**When**: `autoPatch(fixtures)`.

**Then** (assertions):
- **addresses-contiguous**: startAddresses are `[1, 7, 13, 19]`.

#### Test: autopatch-drops-overlapping-pin (covers R14)

**Given**: Two fixtures both pinned to `dmxAddress: 1`.

**When**: `autoPatch(fixtures)`.

**Then** (assertions):
- **only-first-survives**: `patches.length === 1`, `patches[0].fixtureId === fixtures[0].id`.

#### Test: autopatch-drops-out-of-range-pin (covers R15)

**Given**: One fixture pinned at `dmxAddress: 510, channelCount: 6` (would extend to 515).

**When**: `autoPatch([fixture])`.

**Then** (assertions):
- **dropped**: `patches.length === 0`.

#### Test: fixtures-to-dmx-par-layout (covers R17, R18, R19, R20, R22)

**Given**: One patch `{fixtureId: 'p1', role: 'par', startAddress: 1, channelCount: 6}`; one state `{id: 'p1', role: 'par', intensity: 0.5, color: [1, 0, 0], pan: 0, tilt: 0}`.

**When**: `fixturesToDMX([state], [patch])`.

**Then** (assertions):
- **length-512**: buffer.length === 512.
- **dimmer**: `buf[0] === 128` (round(0.5 * 255)).
- **red-green-blue**: `buf[1] === 255, buf[2] === 0, buf[3] === 0`.
- **effects-zero**: `buf[4] === 0`.
- **speed-zero**: `buf[5] === 0`.
- **rest-zeros**: every byte at index ≥ 6 is `0x00`.

#### Test: fixtures-to-dmx-mover-pan-tilt-center (covers R21)

**Given**: Patch `{role: 'moving_head', startAddress: 1, channelCount: 6}`; state with `pan: 0, tilt: 0`.

**When**: `fixturesToDMX(...)`.

**Then** (assertions):
- **pan-center**: `buf[4] === 128` (round((0 − (−π)) / (2π) * 255) ≈ 127.5 → 128).
- **tilt-center**: `buf[5] === 128`.

#### Test: fixtures-to-dmx-mover-saturates (covers R21)

**Given**: state with `pan: Math.PI, tilt: Math.PI / 2`.

**When**: `fixturesToDMX(...)`.

**Then** (assertions):
- **pan-max**: `buf[4] === 255`.
- **tilt-max**: `buf[5] === 255`.

#### Test: fixtures-to-dmx-clamps-out-of-range (covers R19, R21)

**Given**: state with `intensity: 1.5, color: [−0.2, 2.0, 0.5], pan: 2 * Math.PI`.

**When**: `fixturesToDMX(...)`.

**Then** (assertions):
- **dimmer-clamped**: `buf[0] === 255`.
- **red-clamped-low**: `buf[1] === 0`.
- **green-clamped-high**: `buf[2] === 255`.
- **pan-saturated-high**: `buf[4] === 255`.

#### Test: fixtures-to-dmx-missing-state-leaves-zeros (covers R18)

**Given**: Patch for `fixtureId: 'ghost'`; `states` is empty.

**When**: `fixturesToDMX([], [patch])`.

**Then** (assertions):
- **all-zero**: every byte of the 512-byte buffer is `0x00`.

#### Test: subscribe-notifies-all (covers R24, R25, R26)

**Given**: Three subscribers registered via `subscribeDmx(cb1/cb2/cb3)`.

**When**: `setDmxState('connected')` is called.

**Then** (assertions):
- **all-three-called**: cb1, cb2, cb3 each observed one invocation.

#### Test: unsubscribe-removes-one (covers R26)

**Given**: Subscribers A, B registered; A's unsubscribe captured.

**When**: A's unsubscribe is invoked; then `setActiveDmx(null)`.

**Then** (assertions):
- **a-not-called**: A received 0 additional notifications after unsubscribe.
- **b-called-once**: B received 1 notification.

#### Test: panel-unmount-does-not-disconnect-dmx (covers R27)

**Given**: Connected `EnttecPro` set on the singleton; `LightShow3DPanel` mounted.

**When**: Panel is unmounted (removed from React tree).

**Then** (assertions):
- **singleton-still-holds**: `getActiveDmx()` returns the same instance.
- **state-still-connected**: `pro.connected === true`.
- **transmit-loop-still-alive**: fake writer continues receiving writes at ~30 Hz for 200 ms after unmount.

#### Test: panel-remount-picks-up-singleton (covers R28)

**Given**: Connected `EnttecPro` on singleton; panel has just been remounted.

**When**: SceneRunner's first `useFrame` tick fires and calls `dmx.send(...)`.

**Then** (assertions):
- **send-reaches-instance**: `pro.lastFrame` reflects the new send payload.
- **no-new-connect-called**: fake `requestPort` was NOT called again during remount.

#### Test: frame-tick-skips-dmx-when-disconnected (covers R32)

**Given**: `dmxRef.current === null` (singleton cleared).

**When**: SceneRunner's `useFrame` tick executes.

**Then** (assertions):
- **no-fixturestodmx-call**: `fixturesToDMX` spy was not invoked this tick.
- **no-send-call**: no `send` observed on any `EnttecPro` instance.

#### Test: patches-rebuilt-on-rig-change (covers R33)

**Given**: Rig with 4 fixtures; `dmxPatchesRef.current.length === 4`.

**When**: Rig prop changes to 5 fixtures.

**Then** (assertions):
- **patches-length-5**: `dmxPatchesRef.current.length === 5`.
- **autopatch-called-once**: `autoPatch` spy called exactly once per rig identity change.

#### Test: simulation-mode-persists-without-hardware (covers R34)

**Given**: No `EnttecPro` ever attached; fixtures/scenes/cues seeded in SQLite.

**When**: Project opens; `LightShow3DPanel` mounts; user mutates a fixture via chat MCP tool.

**Then** (assertions):
- **db-persists**: the mutation is present in `light_show__fixtures` after SceneRunner renders.
- **3d-preview-renders**: fixture shows up in the scene graph.
- **no-dmx-calls**: `fixturesToDMX` is never called, `send` is never called.

#### Test: pins-apply-only-when-no-scene-driving (covers R35)

**Given**: One pinned override `{fixture_id: 'par_1', intensity: 0.2}`; one timeline placement active at current playhead driving `par_1.intensity = 0.8`.

**When**: SceneRunner's frame tick runs.

**Then** (assertions):
- **scene-wins**: `stateRef.current[par_1].intensity === 0.8`.
- **pin-does-not-override**: pin is NOT applied because `activeLayer === 'timeline'`.
- (When `activeLayer` flips to `'fallback'`, a separate test verifies `par_1.intensity === 0.2`.)

#### Test: persistence-invariant-live-override-survives-restart (covers R34)

**Given**: A live override row inserted into `light_show__live_override`; engine restarts.

**When**: Engine reopens project.

**Then** (assertions):
- **row-present**: `scene_live.status` returns `{active: true}` with original `scene_id`, `label`, `activated_at`.
- **evaluator-resumes**: on the first frame after reconnect of the panel, `activeLayer === 'live'`.
- **dmx-resumes-if-attached**: if an `EnttecPro` is connected at that moment, the next transmitted frame reflects the live scene's output.

### Edge Cases

#### Test: fixtures-to-dmx-skips-out-of-bounds-patch (covers R23)

**Given**: Patch `{startAddress: 510, channelCount: 6}` (would write bytes 509..514 — one past the end).

**When**: `fixturesToDMX([state], [patch])`.

**Then** (assertions):
- **no-write**: bytes 509..511 are `0x00` (skipped; guard `base + channelCount > 512` trips).
- **buffer-length-still-512**: return buffer is still exactly 512 bytes.

#### Test: fixtures-to-dmx-oversized-channel-count (covers R22)

**Given**: Patch `{role: 'par', startAddress: 1, channelCount: 12}`; par state with intensity=1.0, red.

**When**: `fixturesToDMX(...)`.

**Then** (assertions):
- **dimmer-rgb-written**: `buf[0..3] === [255, 255, 0, 0]`.
- **slots-4-5-zero**: `buf[4] === 0, buf[5] === 0`.
- **slots-6-11-zero**: `buf[6..11]` all `0x00` (not addressed by today's layout).

#### Test: send-handles-short-buffer (covers R7 — behavior undefined)

**Given**: Caller invokes `send(Uint8Array(256))`.

**When**: call returns.

**Then** (assertions):
- **undefined**: documented as undefined behavior — see OQ-2. Current code path calls `channels.subarray(0, 512).set(...)` which would copy only 256 bytes; the trailing 256 bytes of `lastFrame` retain prior values. Test asserts that observed behavior but the spec flags this as unresolved: should short buffers be rejected, zero-padded, or accepted-as-is?

#### Test: autopatch-drops-when-universe-full (covers R16)

**Given**: 100 pinned fixtures consuming all 512 channels; 2 unpinned additional fixtures.

**When**: `autoPatch(fixtures)`.

**Then** (assertions):
- **only-pinned-kept**: `patches.length === 100` (pins only).
- **unpinned-dropped**: no patch for either unpinned fixture.

#### Test: negative-no-auto-reconnect-after-write-failure (covers R9)

**Given**: Write failure tears down the connection; state is `'error'`.

**When**: 2 seconds elapse with no user interaction.

**Then** (assertions):
- **no-reconnect-attempt**: `requestPort` was NOT called again.
- **state-stays-error**: `pro.state === 'error'`.
- **user-must-click-connect**: only explicit `connect()` on a fresh `EnttecPro` re-establishes output.

#### Test: negative-no-backend-dmx-calls (covers scope boundary)

**Given**: Any state.

**When**: Full scene playback runs.

**Then** (assertions):
- **no-backend-dmx-endpoint**: no HTTP request to any backend `/dmx` path is observed (DMX output is browser-only).
- **no-python-dmx-import**: backend code does NOT import a DMX serial library (grep assertion at repo level).

#### Test: negative-no-serial-calls-in-simulation (covers R34)

**Given**: Simulation mode (no EnttecPro ever constructed).

**When**: 5 seconds of scene playback.

**Then** (assertions):
- **no-requestport-call**: `navigator.serial.requestPort` never called.
- **no-open-call**: no `SerialPort.open` observed.

#### Test: negative-no-concurrency-in-transmit-loop (covers R8)

**Given**: `transmitLoop` running against a fake writer.

**When**: 1 second of simulated time.

**Then** (assertions):
- **sequential-writes-only**: no two `writer.write` calls are ever concurrent (each awaits the previous before the next begins).
- **single-writer-instance**: exactly one writer holds the lock at any time.

#### Test: live-connect-non-enttec-device (covers R3 — undefined)

**Given**: User somehow selects a non-ENTTEC device (e.g., by overriding filter, or the filter is permissive in a forked browser).

**When**: `connect()` proceeds with the bogus port.

**Then** (assertions):
- **undefined**: see OQ-3. Today the code has no post-open identification check — it will open the port, grab a writer, and start transmitting widget frames at a device that won't understand them. Writes may silently succeed on USB serial (non-fatal), may throw (→ R9 path), or may put the device into an undefined state.

#### Test: two-tabs-same-device (covers undefined)

**Given**: Two Chrome tabs both call `navigator.serial.requestPort` and select the same physical device.

**When**: Both call `open()` concurrently.

**Then** (assertions):
- **undefined**: see OQ-6. WebSerial behavior here is browser-dependent; some browsers grant one tab and reject the other, some serialize. Spec intentionally leaves this to the browser.

#### Test: dongle-backpressure (covers undefined)

**Given**: Dongle stalls USB writes beyond the 33 ms transmit interval (e.g., bus saturation).

**When**: `writer.write` takes 100 ms to resolve.

**Then** (assertions):
- **undefined**: see OQ-5. Current loop will just serialize — 10 Hz effective rate instead of 30 Hz. No explicit timeout, no error, no degradation signal. Acceptable? Unknown.

#### Test: unknown-role-fixture (covers undefined)

**Given**: Fixture with `role: 'laser'` (not in today's `FixtureRole` union; forward-compat).

**When**: `autoPatch` and `fixturesToDMX` run.

**Then** (assertions):
- **undefined**: see OQ-7. TypeScript compile blocks this today, but a JS caller or runtime-loaded rig could inject it. Default channel count comes out as `6` (current `defaultChannelCount` ignores role); `fixturesToDMX` hits the `else` branch of the `role !== 'moving_head'` test and treats it as a par — writing 0 to slots 4-5. Almost certainly wrong for a real laser but won't crash.

---

## Non-Goals

- **sACN / Art-Net / OLA.** Planned for multi-universe network output; not this spec.
- **GDTF fixture profiles.** Per-fixture channel layouts will replace the role-based switch in `fixturesToDMX`; not this spec.
- **MVR rig import.** Fixtures come from the hardcoded `RIG` plus user edits through chat MCP tools; bulk MVR import is a future path.
- **Auto-reconnect on write failure.** User must click Connect again after an `error` state.
- **Multi-universe transmit.** Universe field is forward-compat; today only universe 1 is sent and there's only one active `EnttecPro` instance on the singleton.
- **16-bit pan/tilt (fine channels).** Only 8-bit linear maps today.
- **Backend-side DMX output.** The browser is the audio/visual source of truth — no Python DMX code exists.
- **Queuing intermediate frames.** DMX is a continuous protocol; coalesce-to-latest is the whole design.
- **Dongle identity handshake.** No post-open challenge/response to verify ENTTEC Pro firmware (see OQ-3).

---

## Open Questions

### OQ-1 — Do pinned per-fixture overrides win over live/timeline scenes?

The brief's framing ("per-fixture live overrides winning over scenes") contradicts the shipped precedence (`live > timeline > pins > fallback`). Either:
- (a) The current pins-as-fallback behavior is correct and the brief is mistaken, OR
- (b) The design intent is pins-always-win and the current code is a bug.

Behavior Table row 31 is filed under (a) as observed; if the answer is (b), R35 needs inverting and `SceneRunner`'s composition order has to move pins into a post-scene pass. Pending Patrick's clarification.

### OQ-2 — Short-buffer `send()` semantics

`send(channels)` today calls `this.lastFrame.set(channels.subarray(0, DMX_CHANNELS))`. If `channels.length < 512`, only the first `channels.length` bytes are overwritten; trailing bytes retain prior values (potentially stale). Should short buffers be:
- (a) zero-padded to 512 before copy,
- (b) rejected with a thrown error or silent no-op, OR
- (c) accepted as-is (current behavior, with prior bytes retained)?

All callers today produce exactly 512 bytes, so no observed defect — but the contract is undefined.

### OQ-3 — Connect to non-ENTTEC device

The VID/PID filter narrows the picker but does not prevent a user from selecting an arbitrary serial device on a system with loose permissions (or in a forked browser that ignores filters). Today there is no handshake — `connect()` assumes the port speaks the widget protocol. Should there be:
- (a) a post-open identification probe (send widget label 10 "Get Widget Serial Number" and wait for the response), OR
- (b) no probe (current), accept that garbage writes to a non-ENTTEC device are the user's problem?

### OQ-4 — Cable disconnect mid-scene: auto-reconnect policy

Today: no auto-reconnect. User must click Connect again. Acceptable for a live-show ops context? Or should the layer attempt backoff-reconnect on transient failures?

### OQ-5 — Hardware backpressure

If `writer.write` takes longer than 33 ms (USB congestion, dongle stall), the transmit rate degrades silently. No timeout, no telemetry, no error. Should there be:
- (a) an AbortController timeout on each `write`,
- (b) a health metric on the singleton (reported write-rate),
- (c) a warning when effective rate drops below some threshold, OR
- (d) status quo (silent degradation)?

### OQ-6 — Two tabs, same device

`navigator.serial` behavior across concurrent tabs is browser-dependent. Does scenecraft want to actively detect/deny the second tab (e.g., via a BroadcastChannel heartbeat claiming the device), or accept the browser's default behavior?

### OQ-7 — Unknown fixture role in `fixturesToDMX`

A `role` string not in the current `{'par', 'moving_head'}` union falls through to the par branch today (effects=0, speed=0). Is that acceptable default, or should unknown roles be skipped entirely (no channel writes)?

### OQ-8 — Scene references deleted fixture

When a scene or pinned override references a fixture id that has been deleted from the rig: today the `fixturesToDMX` patch list is rebuilt from the current rig, so the stale state entry (if any) is simply not patched. The scene evaluator writes state into `states[i]` but there's no DMX patch for the ghost fixture → no bytes. Should the evaluator warn, or is silent skip correct? (Leaning correct, but not explicitly tested.)

### OQ-9 — Channel > 512 from oversized pinned channelCount

Partially covered by R15 (pin that extends past 512 is dropped by `autoPatch`) and R23 (`fixturesToDMX` guard). But a user could theoretically produce a `DMXPatch` by hand with `startAddress: 1, channelCount: 600` that slips past `autoPatch`. The R23 guard handles it. Confirm that the only ingress to `fixturesToDMX` is via `autoPatch`'s output (yes, in shipped code) → no realistic attack surface — but spec says so explicitly.

---

## Related Artifacts

- **Upstream spec**: [local.light-show-scene-editor.md](local.light-show-scene-editor.md) — scene authoring + evaluator + primitives feeding `FixtureState[]` into this layer.
- **ENTTEC DMX USB Pro Widget API spec**: public PDF at enttec.com (label 6 = Output Only Send DMX, §4.2).
- **WebSerial API**: https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API.
- **Shipped code**:
  - `src/plugins/light_show/enttec-pro.ts`
  - `src/plugins/light_show/dmx-mapper.ts`
  - `src/plugins/light_show/dmx-ref.ts`
  - `src/plugins/light_show/fixtures.ts`
  - `src/plugins/light_show/LightShow3DPanel.tsx` (connect/disconnect handler + per-frame send)
- **Backend fixture patch columns**: `scenecraft-engine/src/scenecraft/db.py` (`dmx_universe`, `dmx_address`, `dmx_channel_count` on `light_show__fixtures`).
- **Related memory**:
  - `project_dmx_persists_to_backend.md` — "simulation mode" = no hardware output, state persists
  - `project_panel_singletons_for_long_lived_connections.md` — rationale for `dmx-ref` singleton
  - `project_frontend_is_audio_source_of_truth.md` — browser as source of truth justification for browser-only DMX
  - `project_no_frontend_tests.md` — vitest not installed yet; tests above are specified but not runnable today
