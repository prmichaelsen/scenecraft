# Task 150: Research Spike — Multi-Channel Live Audio Inputs for light_show

**Milestone**: Unassigned (post-MVP — fits naturally between the modulation matrix landing and a "live show mode" feature)
**Design Reference**: None (this task produces the design doc; depends on `clarification-14-light-show-scene-editor-mvp.md` Item 7 — Modulation Matrix)
**Estimated Time**: 4-6 hours (research + write decision doc + minimal proof-of-concept)
**Dependencies**: None (can run anytime; integration depends on the modulation matrix being implemented)
**Status**: Not Started

---

## Objective

Decide whether and how the light_show plugin should accept **multi-channel live audio inputs** (raw audio from a venue's mixer, hardware audio interface, etc. — NOT audio that's already on the scenecraft timeline) as DSP sources that scenes can react to.

Output a written decision: yes/no, target browsers/devices, integration shape with the modulation matrix, and what (if any) native companion is required.

---

## Context

This came out of a side discussion during `clarification-14-light-show-scene-editor-mvp.md` Q&A. The user asked whether Web Audio supports multi-channel live audio capture, with the long-term goal of treating live show audio (e.g., FOH mixer feed) as additional DSP sources alongside the existing `masterLevel` / `masterLowLevel` derived from the scenecraft master bus.

Two related decisions are upstream of this work:
1. **The modulation matrix** (clarification-14, Item 7) — params can be `{source, mapper}` shapes. Live audio inputs would be additional named sources (e.g., `liveCh1Level`, `liveCh3LowLevel`).
2. **Live mode** (clarification-14, Item 1 — live override + chat-driven cues) — the natural runtime context where a venue feed would be plumbed in (light_show is operating during a real show, not authoring offline).

This task does NOT implement either of those. It only researches the live-input layer and decides the architecture.

---

## Captured Discussion (verbatim from chat — preserved per user request)

### User question

> what if we wanted to support multi ch INs for live audio signals from a live show (not already in timeline). does web api support that for one?

### Agent response

Yes — the Web Audio API supports multichannel live inputs, with a few constraints worth knowing.

**The capture path**: `navigator.mediaDevices.getUserMedia({ audio: { ... } })` returns a `MediaStream` that you wrap in a `MediaStreamAudioSourceNode`. That node's `channelCount` reflects whatever channels the underlying device exposes. Feed it into your existing `AudioMixer` graph and it behaves like any other source — `AnalyserNode` taps, filter splits, per-channel analysis all work normally.

**Multichannel capability depends on the device + browser**:
- **USB audio interfaces** (Focusrite Scarlett 18i20, MOTU, RME, etc.) that present as a single multichannel device: Chrome/Edge can capture up to the device's native channel count (8, 16, 32+) on Windows/Mac/Linux. Firefox is historically limited to 2ch for most devices but has improved.
- **Aggregate / virtual devices** (macOS aggregate device, ASIO wrappers, BlackHole, Loopback): work the same — one "device" with N channels.
- **Dante / AVB / AES67 network audio**: needs an OS-level virtual soundcard (Dante Virtual Soundcard, etc.) to appear as a browser-visible input. The browser doesn't speak those protocols natively.
- **WebRTC-forwarded streams** (another machine on the LAN sending audio): typically downmixed to stereo by the WebRTC stack unless you go out of your way.

**The gotchas**:
- `getUserMedia` often defaults to 1 or 2 channels even when the device has more — you have to pass the `channelCount` constraint explicitly (e.g., `audio: { channelCount: { ideal: 16 } }`) and many browsers silently clamp.
- Chrome historically applies AEC / noise suppression / auto-gain by default on "microphone" sources. For live-show inputs, disable all three: `echoCancellation: false, noiseSuppression: false, autoGainControl: false`. Otherwise your signal gets munged.
- Per-channel routing: `MediaStreamAudioSourceNode` exposes N channels; use `ChannelSplitterNode` with `numberOfOutputs` matching the device to get each channel as its own mono graph, then `AnalyserNode` on each for per-channel DSP.
- Latency: `getUserMedia` round-trip is ~10-50ms depending on OS/buffer size. Fine for light-show DSP (visual lag is imperceptible at that range); not fine for live monitoring back to speakers.
- Permissions UI: browser prompts for mic access every time the page is served from a non-stored origin. Production deployment on HTTPS + persistent permission grant handles it; the permission prompt still shows once per origin.

**For the scene-editor modulation matrix you were discussing**: a live input is just another DSP source. You'd register it alongside `masterLevel` / `masterLowLevel` as e.g. `liveCh1Level`, `liveCh2LowLevel`, etc. — each channel gets its own analyser chain. Scene params consume them through the same `{source, mapper}` shape.

**Alternative for venues without a browser-facing device**: run a tiny native companion (Electron, Node + portaudio, Rust + cpal) that does capture natively and streams samples to the browser over WebSocket or WebTransport. More moving parts but unlocks ASIO, ≥32ch, and <5ms latency when you need it.

Short answer: yes, Web Audio handles it natively for USB/interface-class devices; the real limits are at the device-enumeration and channel-constraint layer, not the audio graph itself.

---

## Open Research Questions to Answer

1. **Device discovery UX** — how does the user pick which audio device to use as a live input? `navigator.mediaDevices.enumerateDevices()` returns labels only after permission is granted; without permission, only generic ids. What's the chat-driven flow look like? (e.g., a `light_show.live_input.list_devices` MCP tool that triggers permission prompt and returns enumerated devices?)

2. **Per-channel labels and routing** — interfaces expose physical channels (e.g., "Input 1", "Input 5") but the show context wants semantic labels ("kick mic", "lead vocal", "ambient L"). Is there a per-channel labeling step the user does once per device? Stored where (project.db, server.db, browser localStorage)?

3. **Real-world latency** — measure round-trip on representative hardware (a Focusrite Scarlett, a built-in laptop mic, an aggregate device). Determine whether <50ms is achievable in practice for typical setups, and whether jitter is acceptable for visual-DMX use.

4. **Browser support matrix** — concretely document which browsers + OSes can capture ≥8 channels reliably. Chrome/Edge on Windows/Mac/Linux likely fine; Firefox unclear; Safari historically restrictive. Decide what we support at v1 (Chrome/Edge desktop only is probably enough).

5. **DSP source registration** — should live-input sources be registered dynamically (chat says "use Scarlett channel 3 as `liveKick`" → backend creates a source with that name) or with a fixed naming scheme (`liveCh1Level`, `liveCh1LowLevel`, ... auto-generated based on device channel count)? Trade-off: dynamic = more authoring flexibility but a bigger surface; fixed = simpler but uglier names in scene params.

6. **Native companion path** — if/when a companion is needed (Dante/AVB venues, ultra-low latency, ASIO-only interfaces), what's the simplest stack that could ship? Options to evaluate:
   - Electron app wrapping the existing scenecraft frontend (full native audio access)
   - Sidecar process (Rust + cpal, Node + portaudio) streaming PCM to browser via WebSocket/WebTransport
   - Different web tech entirely (PWA + experimental browser audio APIs as they mature)

7. **Persistence of input config** — does the active live-input device + per-channel labels persist across browser reload / engine restart, similar to how the live override persists per Q 1.4? Probably yes for show continuity. Where does it live?

8. **Per-channel DSP cost** — how expensive is N independent `AnalyserNode` chains at typical buffer sizes? Validate that 16ch with low/mid/high band analysers each (48 analysers running) doesn't tank frame rate.

9. **Conflict with the modulation matrix design** — verify that the proposed `{source, mapper}` shape from clarification-14 Item 7 cleanly accommodates live-input sources, including hot-swap (device disconnect/reconnect) and per-channel signal availability.

10. **Show-mode UX** — when a live input is configured, is there a toggle that switches the light_show from "scenecraft master bus" sources to "live device" sources? Or do they coexist (both available, scene picks)? Probably coexist, but worth confirming.

---

## Deliverables

### Files to Create

- `agent/design/local.live-audio-inputs.md` — design document covering:
  - Recommendation (ship Web Audio path? add native companion? hybrid?)
  - Scope for v1 (browser support matrix, channel count, what gets shipped first)
  - Integration shape with the modulation matrix (`{source, mapper}` extensions)
  - Device discovery + per-channel labeling flow (UX + API surface)
  - DSP source registration model (dynamic vs fixed naming)
  - Latency / performance findings from any minimal POC
  - Persistence model for device config + channel labels
  - Open issues / risks
  - Phased implementation plan (what to ship first when this graduates from spike to actual feature)
- (Optional) `agent/drafts/live-audio-input-poc.md` — notes from any hands-on Web Audio experimentation, including code snippets demonstrating multichannel capture + per-channel analysis

### Files to Modify

- `agent/clarifications/clarification-14-light-show-scene-editor-mvp.md` — Item 8 (Deferred) gets a cross-reference to the new design doc once it exists
- `agent/index/local.main.yaml` — add the new design doc to the index if it's broadly relevant (likely weight 0.6, applies `acp.proceed, acp.plan, acp.design-create`)

---

## Steps

### 1. Web Audio API Spec Review (1h)

- Read MDN docs for `MediaStreamAudioSourceNode`, `ChannelSplitterNode`, `getUserMedia` audio constraints, `enumerateDevices`
- Note: `MediaTrackConstraints.channelCount` (`ideal`, `exact`, `max`), browser-specific quirks
- Document AEC / noise suppression / auto-gain disable strategy
- Capture findings in scratch notes (`agent/drafts/live-audio-input-poc.md`)

### 2. Browser Support Matrix Research (1h)

- Test Chrome on Linux (current dev env): does it actually surface multichannel devices when present?
- Cross-reference Chromium / WebKit / Gecko bug trackers for known multichannel limitations
- Check `caniuse.com` for `getUserMedia` channel constraint support
- Decide v1 support target (likely Chrome/Edge desktop)

### 3. Minimal Proof-of-Concept (1-2h)

- Write a standalone HTML page (NOT integrated with scenecraft yet) that:
  - Calls `getUserMedia({ audio: { channelCount: { ideal: 16 } } })`
  - Logs the actual `channelCount` of the resulting `MediaStreamAudioSourceNode`
  - Splits into per-channel `AnalyserNode` chains
  - Displays per-channel level meters in real time
- Test with whatever multichannel-capable hardware is available (laptop mic = 1ch baseline; aggregate device or USB interface if available)
- Measure round-trip latency by feeding a click into the input and timing visible meter response

### 4. Modulation Matrix Integration Review (1h)

- Re-read clarification-14 Item 7 (modulation matrix) and confirm the `{source, mapper}` shape extends cleanly to live inputs
- Sketch concrete examples:
  - `params: { period_sec: { source: "liveCh1Level", mapper: { scale: 4, offset: 1 } } }`
  - `params: { intensity: { source: "liveKickLow", mapper: { threshold: 0.3, hold: { decay_sec: 0.4 } } } }`
- Identify any source-registration plumbing not yet considered in clarification-14

### 5. Native Companion Spike Decision (30min)

- Estimate when a native companion becomes necessary (Dante venues, ASIO-only, sub-5ms latency)
- Pick a default native stack to recommend if needed (Rust + cpal recommended for portability + small binary; Electron if reusing the frontend wholesale is desirable)
- Decide: do we keep this as a future option, or rule it out for v1?

### 6. Write Design Document (1h)

- Synthesize findings into `agent/design/local.live-audio-inputs.md` covering all 10 open research questions above
- Recommend the v1 scope (likely: Chrome/Edge, USB-class interfaces, 8-16ch, browser-only, no companion yet)
- Phased plan: spike-result → modulation matrix lands → live input v1 → native companion if/when needed
- Cross-reference clarification-14 Item 7 + Item 8 (Deferred)

### 7. Update Index + Close Spike (15min)

- Add design doc entry to `agent/index/local.main.yaml`
- Cross-reference from clarification-14 Item 8
- Mark task 150 completed in progress.yaml

---

## Verification

- [ ] `agent/design/local.live-audio-inputs.md` exists with sections covering all 10 open research questions
- [ ] Design doc has a clear "Recommendation" section stating yes/no for v1 and the chosen integration shape
- [ ] Design doc includes a browser support matrix (concrete: which browsers, which OSes, which channel counts)
- [ ] Design doc includes a phased implementation plan
- [ ] Cross-references to `clarification-14-light-show-scene-editor-mvp.md` Item 7 and Item 8
- [ ] Modulation matrix `{source, mapper}` shape is confirmed to accommodate live-input sources (with concrete param examples)
- [ ] Latency measurement from POC documented (or noted as "not testable on available hardware" with explanation)
- [ ] Native companion path: either ruled out for v1 with rationale, or scoped as a future option
- [ ] Design doc entry added to `agent/index/local.main.yaml` (if broadly relevant)
- [ ] Task 150 marked completed in progress.yaml

---

## Key Design Decisions (from chat discussion, captured)

| Decision | Choice | Rationale |
|---|---|---|
| Web Audio API supports multichannel live inputs | **Yes, confirmed** | `MediaStreamAudioSourceNode` exposes the device's full channel count when configured correctly |
| Default channel count | **Must specify explicitly** | `getUserMedia` defaults to 1-2ch even on multichannel devices; pass `channelCount: { ideal: N }` in constraints |
| AEC / NS / AGC defaults | **Disable all three** | Chrome applies these by default on "microphone" sources; disabled for clean signal: `echoCancellation: false, noiseSuppression: false, autoGainControl: false` |
| Per-channel routing | **`ChannelSplitterNode` + per-channel `AnalyserNode`** | One mono graph per channel; standard Web Audio pattern |
| Latency expectation | **~10-50ms round trip** | Fine for visual DMX (lag imperceptible at that range); not fine for live audio monitoring back to speakers |
| Modulation matrix integration | **Live inputs are additional named sources** | E.g., `liveCh1Level`, `liveKickLow`. Same `{source, mapper}` shape from clarification-14 Item 7. No new abstraction needed |
| Network audio (Dante / AVB / AES67) | **Requires OS-level virtual soundcard** | Browser doesn't speak these protocols. User installs Dante Virtual Soundcard (or equivalent), which presents as a normal audio device |
| WebRTC-forwarded streams | **Typically downmix to stereo** | Not a viable path for ≥3ch unless special handling |
| Native companion need | **Only for: Dante/AVB without virtual soundcard, ASIO-only interfaces, sub-5ms latency** | Out of scope for v1 if Web Audio path covers the common case |

---

## Notes

- This is a **research spike**, not a feature implementation. The output is a design doc, not code that ships in production.
- Marker for graduating spike to feature: when the modulation matrix is implemented AND the user explicitly wants live-show authoring (a "live mode" feature) AND there's hardware available to actually test against.
- Capture any hands-on POC code in `agent/drafts/` (untracked or tracked — depends on whether it's worth keeping). Don't commit POC HTML to the main app.
- This task may be re-prioritized into a milestone (e.g., a future "live show mode" milestone) once the modulation matrix lands. Until then, it stays unassigned.
