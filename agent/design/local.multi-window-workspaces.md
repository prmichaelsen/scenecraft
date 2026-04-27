# Multi-Window Workspaces

**Concept**: First-class multi-window editor workflow — users open the same project across multiple browser windows/tabs for multi-monitor setups without losing state consistency.
**Created**: 2026-04-27
**Status**: Stub (black-box behavior specced in sibling feature specs; implementation deferred)
**Last Updated**: 2026-04-27

---

> **Note**: This design doc is a stub. The *observable behavior* of multi-window workspaces has been codified as invariant **INV-5** in the spec OQ-resolution pass (see `agent/reports/oq-resolution-decisions-2026-04-27.md`) and flows into the `panel-layout-and-plugin-panel-host`, `light-show-dmx-output`, `chat-panel-and-job-state`, and `webaudio-mixer-and-mix-graph` specs.
>
> This document captures the **implementation** side — the plumbing required to realize the behavior, collected in one place so the future milestone has a shared starting point. No implementation planned for this pass.

---

## Overview

Scenecraft users increasingly want multi-monitor workflows:
- Monitor A: timeline + preview + source monitor
- Monitor B: properties + effects + chat + logs
- Monitor C: light show 3D preview + DMX inspector

Today, each browser window opens its own detached instance with no shared state. User changes in one window don't appear in another; exclusive resources (DMX, audio playback) fight silently.

The goal: multiple windows of the same project coexist as **peers**. DB-backed state stays synced via the unified WebSocket. Exclusive browser resources (WebSerial/DMX, WebAudio playback, chat WS session) are owned by exactly one window at a time, transferable via take-over UX.

---

## Problem Statement

- **No state sync across windows**: Two tabs of the same project currently don't see each other's edits. Users either keep one tab open per project or manually refresh.
- **Exclusive-resource conflicts**: WebSerial permits multiple tabs to connect to the same device (on some OSes); WebAudio creates independent contexts per window. Playback or DMX output from two tabs interleaves and causes flicker/drift.
- **Per-window layout isn't supported**: The single `_autosave_v3` localStorage key means two windows share a layout tree — changes in one window get overwritten by the other.
- **Singleton panels duplicate**: Panels like Timeline, Chat, and DMX Connect that only make sense once-per-project appear twice if both windows mount them.

---

## Behavior (what the specs codify — INV-5 + INV-6)

- Multiple windows of the same project coexist as peers. Any window can initiate any edit.
- All DB-backed state stays synchronized across windows via the unified WebSocket (INV-4). Edits in window A reflect in window B's timeline/bin/properties/scene list without manual refresh.
- **Exclusive browser resources** — WebSerial/DMX, WebAudio playback graph, active HTMLAudioElement, chat WS session — are owned by exactly one window at a time.
- Take-over modals transfer ownership on user intent:
  - "Connect DMX" in a secondary window → modal: "DMX is controlled by another window. Take over?"
  - "Play" in a secondary window → modal: "Playback control is in another window. Take over?"
  - Same for chat (via the singleton-panel mechanism — see INV-6)
- Panel layouts are **per-window** (each window saves under `_autosave_v3:<windowId>`). Monitor A and monitor B have independent tab trees.
- **Singleton panels** (INV-6) — Timeline, Preview, ChatPanel, DMX Connect — use move-not-duplicate semantics. Adding a singleton panel to a new location **moves** the existing instance rather than spawning a duplicate.
- Closing the owning window transparently releases exclusive resources; the next user interaction in any remaining window claims them.

---

## Implementation (open)

The behavior is the contract. The implementation mechanism has open questions that this doc captures for a future milestone.

### Window discovery

How do windows learn of each other's existence?

- **BroadcastChannel** (`new BroadcastChannel(projectId)`): simplest, pure-browser, no shared worker needed. Each window emits `hello` on mount; others respond with their state. On close, window emits `bye`.
- **SharedWorker**: canonical for cross-tab coordination. More robust, more complex.
- **navigator.locks API**: standard for exclusive-resource election; pairs naturally with BroadcastChannel for non-lock messaging.

**Open**: which combination. Probably BroadcastChannel + navigator.locks is enough.

### Primary-window election on cold start

If three tabs open simultaneously (e.g., user restores a session with three windows), who becomes primary for exclusive resources?

Options:
- **First-to-acquire the lock wins.** Unpredictable but simple.
- **Explicit prompt on second-window mount**: "You already have this project open in another window. Continue in this window too?" → user chooses.
- **Auto-take-over on most-recent-interaction**: last-clicked window claims.

### Playhead synchronization precision

Secondary windows display a read-only synced playhead. How tight does the sync need to be?

- **Coarse (~100ms)**: server broadcasts playhead at 10Hz; secondary windows render that state. Fine for visual-reference-only.
- **Fine (~10ms)**: secondary windows compensate for latency by dead-reckoning (interpolating from last-received timestamp + local clock). Required if anyone wants to clap/beat-match in a secondary window.

**Open**: product decision. Start coarse; tighten if users complain.

### WebAudio graph transfer on take-over

When playback ownership transfers from window A to window B:
- Window A pauses its AudioMixer and tears down its WebAudio graph (HTMLMediaElement is disposed).
- Window B builds its AudioMixer from current DB state and resumes playback at the transferred playhead position.
- Audio will glitch/click at the handoff. Acceptable: take-over is a deliberate user action.

### DMX handoff

When DMX ownership transfers:
- Window A: sends `navigator.serial.port.close()` on its writer. Cancels transmit loop.
- Window B: calls `navigator.serial.requestPort()` (or reuses existing grant if same origin). Starts its own transmit loop.
- Brief DMX blackout (~100ms) is acceptable. Could smooth with "hold last frame" if visually important.

### Chat session transfer

Since ChatPanel is a singleton panel (INV-6), chat "moves" rather than transfers in the exclusive-resource sense. When user adds ChatPanel to window B, window A's ChatPanel unmounts → WS disconnects → session state held by server → window B's ChatPanel mounts → reconnects → session resume handshake (already specced in chat-panel OQ-1).

### Per-window layout key

Window needs a stable id across page reloads but unique per window. Options:
- **sessionStorage nonce**: generated on first open, persists across reloads of that window, unique per window. Works.
- **URL hash param** (`?window=abc123`): survives reload, user-visible, supports explicit "clone window" workflows.

Probably hash param — explicit and lets users bookmark a specific multi-window setup.

---

## Dependencies

- **INV-4 (unified WebSocket)** must land first — cross-window state sync depends on all backend-initiated updates flowing over a single WS that any window can subscribe to.
- **INV-6 (singleton panels)** must land as part of the panel-layout work — singleton-move is orthogonal to multi-window but the spec references both.

---

## Out of Scope (for this doc)

- Mobile / smaller-screen multi-window: not planned.
- Cross-device multi-window (one user on laptop + tablet): requires server-side session tracking, very different problem.
- Presence indicators ("user is editing this clip"): nice-to-have for eventual multi-user, not needed for single-user multi-monitor.

---

## Open Questions

- Primary-window election strategy on cold start.
- Playhead sync precision (coarse vs dead-reckoning).
- Whether to animate take-over handoffs (crossfade audio through handoff? hold-last-DMX-frame?).
- Whether to support "link windows" mode (all windows share one layout, useful for screen-sharing demos).

---

## Related Artifacts

- `agent/reports/oq-resolution-decisions-2026-04-27.md` — authoritative source for INV-5 and INV-6.
- `agent/specs/local.panel-layout-and-plugin-panel-host.md` — specs the per-window layout and singleton panel behaviors.
- `agent/specs/local.light-show-dmx-output.md` — specs DMX as exclusive resource with take-over.
- `agent/specs/local.chat-panel-and-job-state.md` — specs ChatPanel singleton-move semantics.
- `agent/specs/local.webaudio-mixer-and-mix-graph.md` — specs playback as exclusive resource.
