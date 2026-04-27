# Spec: ChatPanel + chat-client + JobStateContext (frontend integration)

> **Retroactive black-box spec** — derived by reading the shipped implementation. The source code is the ground truth; this spec re-expresses the observable contract so future changes have a proofing surface.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive)

---

## Purpose

Define the observable behavior of the frontend chat surface: `ChatPanel` (React component), `chat-client` (WebSocket + REST client + round-trip handlers), and `JobStateContext` (background-job tracking store) — including rendering, WS lifecycle, streaming event handling, elicitation flow, `onMutation` fan-out, and the entityKey-keyed job store.

## Source

- **Mode**: `--from-draft` (retroactive)
- **Source files**:
  - `src/components/editor/ChatPanel.tsx` (full)
  - `src/lib/chat-client.ts` (full)
  - `src/contexts/JobStateContext.tsx` (full)
- **Supporting**:
  - `agent/reports/audit-2-architectural-deep-dive.md` §1C unit 7, §1D unit 12

## Scope

**In scope**:
- ChatPanel rendering of history, streaming text blocks, tool-call badges (with progress), elicitation cards (Accept/Decline)
- Virtuoso scroll behavior (followOutput gated on `atBottom`; streaming-growth auto-scroll)
- Typing indicator when `loading && streamingBlocks.length === 0`
- WS connection lifecycle on mount; disconnect on unmount; reconnect with exponential backoff (max 5 attempts, 2s→5s cap)
- History load via GET `/api/projects/:name/chat?limit=50` at mount
- Sending a user message: optimistic append, input clear, `loading=true`, WS `{type:'message', content}`
- Handling all inbound `ServerMessage` variants: `chunk`, `tool_call`, `tool_progress`, `tool_result`, `elicitation`, `message`, `complete`, `error`, `status`, `mix_render_request`, `bounce_audio_request`, `master_bus_effects_changed`
- Elicitation response: WS `{type:'elicitation_response', id, action}` + local card state update to `accepted` / `declined`
- `onMutation` callback invoked on every non-error `tool_result`
- `JobStateContext`: `startJob(entityKey, jobId)` idempotency per entityKey; auto-register unknown `job_started` using `meta.keyframeId` / `meta.transitionId` / fallback `jobId` as entityKey
- Routing of `job_started` / `job_progress` / `job_completed` / `job_failed` onto the keyed entry; stale-jobId guard (`entry.jobId !== msg.jobId` → ignore)
- Auto-expire: 30s after `completed`, 10s after `failed`; prior timers cleared on new `startJob` for the same entityKey
- `consumeResult(entityKey)`: returns and clears `entry.result`
- `useSyncExternalStore` subscription + change counter

**Out of scope**:
- Backend chat dispatch (`chat.py` / `_stream_response` / `_is_destructive`) — separate spec (§5 item 4 of audit-2)
- Individual tool-handler semantics (`update_volume_curve`, `apply_mix_plan`, etc.)
- `useScenecraftSocket` internals — only its public shape (`subscribeAll`, `JobMessage`) is relied on
- `handleMixRenderRequest` / `handleBounceAudioRequest` / `handleMasterBusEffectsChanged` internal render-pipeline details — only their invocation trigger and error-swallowing contract
- Images / attachments on client messages (the `images` field exists on `ClientMessage` but is never sent by ChatPanel today)
- Chat history persistence *writes* (server-side concern)
- Router / TanStack behavior when `onMutation` calls `router.invalidate()`

---

## Requirements

### ChatPanel rendering

- **R1**: On mount, ChatPanel fetches chat history via `fetchChatHistory(projectName, 50)` and seeds `messages`. Until the fetch resolves, render a "Loading..." placeholder.
- **R2**: When the fetch resolves with zero messages AND no streaming blocks AND not loading, render the empty-state placeholder "Ask me anything about this project".
- **R3**: When there are messages or streaming blocks or the assistant is thinking, render a Virtuoso list of `displayItems` = `messages + (streaming block group?) + (typing indicator?)`.
- **R4**: While `streamingBlocks.length > 0`, render a single synthetic "streaming" list item at the tail. While `streamingBlocks.length === 0 && loading`, render a "typing indicator" item instead.
- **R5**: Each `tool_use` streaming block renders a `ToolCallBadge` with status `pending | success | error`. When `status === 'pending'` and `progress` is set, the badge shows `· {round(pct*100)}% {message}`.
- **R6**: Each `elicitation` streaming block renders an `ElicitationCard` with Confirm / Cancel buttons while `resolution === 'pending'`. After resolution, buttons are replaced by a status line ("✓ Confirmed" or "Cancelled") and card opacity drops.
- **R7**: Persisted assistant messages whose `content` is a `ContentBlock[]` render each text block as markdown and each `tool_use` block as a `ToolCallBadge`. Status comes from matching `tool_calls[i].is_error` (error → red, otherwise green — pending is not possible on persisted messages).
- **R8**: Persisted user messages with string content render right-aligned with a blue tint. System messages render with a red tint and a red border.
- **R9**: The blinking cursor (`w-2 h-4 bg-gray-500 animate-pulse`) appears at the end of the streaming bubble ONLY when no elicitation is currently `pending`.

### Virtuoso scroll behavior

- **R10**: `atBottomStateChange` writes to the `atBottom` state; `followOutput` returns `'auto'` when `atBottom`, `false` otherwise. Effect: when the user is scrolled up, new items do NOT yank them down.
- **R11**: When the streaming item's content grows (chunk deltas increase the text in the same item) and `atBottom` is true, the component calls `scrollToIndex(LAST, end, auto)`. When `atBottom` is false, it does not.
- **R12**: On initial history load AND on send, `scrollToBottom()` is called unconditionally (not gated on `atBottom`) via `requestAnimationFrame`.

### WS connection lifecycle

- **R13**: On mount, ChatPanel constructs a `ChatWebSocket(projectName, handleMessage, setConnected)` and calls `connect()`. On unmount, it calls `disconnect()` and nulls the ref.
- **R14**: `ChatWebSocket.connect()` opens the unified socket `${SCENECRAFT_WS_URL}/ws` (per INV-4; `/ws/chat/:project` is deprecated). Chat traffic multiplexes over the unified socket using the `core__chat__*` event namespace. On `open` it sets `reconnectAttempts=0` and fires `onConnectionChange(true)`. On `close` it fires `onConnectionChange(false)` and calls `attemptReconnect()`. On `error` it closes the socket (which triggers `close` → reconnect).
- **R15**: Reconnect uses exponential backoff `min(2000 * 2^attempts, 5000)` ms, capped at `maxReconnectAttempts=5`. After 5 failed attempts, the client stops trying.
- **R16**: `disconnect()` clears any pending reconnect timer, sets `reconnectAttempts = maxReconnectAttempts` (so no further reconnect fires), closes the socket, nulls the ref.
- **R17**: The "Connected" / "Disconnected" badge and the textarea's `disabled`/placeholder reflect `connected` state. The Send button is disabled when `!input.trim() || loading || !connected`.
- **R18**: The connection URL carries no auth token in header or query. Auth is assumed to be cookie-based (JWT HttpOnly cookie set by `/auth/login`); ChatPanel does nothing explicit about auth.

### Sending a message

- **R19**: `handleSend` ignores empty/whitespace-only input and is a no-op when `loading` is true.
- **R20**: On send, ChatPanel optimistically appends a user `PersistedMessage` (id = `Date.now()`, role `user`, string content, ISO timestamp), clears the input, resets textarea height, sets `loading=true`, scrolls to bottom, and sends `{type:'message', content: text}` via `wsRef.current?.send(...)`.
- **R21**: Keyboard: `Enter` alone inserts a newline (default textarea behavior); `Shift+Enter` triggers send. (This is intentional and opposite the common chat convention — see `handleKeyDown`.)
- **R22**: Textarea auto-resizes up to a max of 120px via `scrollHeight` measurement on each change.

### Inbound event handling

- **R23**: On `core__chat__chunk`: if the last streaming block is `text`, append to its text; otherwise push a new `text` block. Does not affect `loading`.
- **R24**: On `core__chat__tool_call`: push a new `tool_use` streaming block with `status: 'pending'` and the given id+name.
- **R25**: On `core__chat__tool_progress`: find the matching `tool_use` block by id and replace its `progress` field. No status change.
- **R26**: On `core__chat__tool_result`: find the matching `tool_use` block by id, set `status` to `'error'` if `isError`, else `'success'`, and clear `progress`. If not `isError`, invoke `onMutation?.()`.
- **R27**: On `core__chat__elicitation`: push a new `elicitation` streaming block with `resolution: 'pending'`.
- **R28**: On `core__chat__message` (finalized persisted message): if the incoming message is a user string message equal to the last optimistic user message, REPLACE the optimistic one (dedup). Otherwise append. Then clear `streamingBlocks` to `[]`.
- **R29**: On `core__chat__complete`: clear `streamingBlocks` to `[]` and set `loading=false`.
- **R30**: On `core__chat__error`: clear `streamingBlocks`, set `loading=false`, and append a system message `{role:'system', content:\`Error: ${msg.error}\`}`.
- **R31**: On `status`: no state change (log-only).
- **R32**: On `mix_render_request`: call `handleMixRenderRequest(msg, {projectName})`; do not await; catch and log errors. No ChatPanel state change.
- **R33**: On `bounce_audio_request`: call `handleBounceAudioRequest({msg, projectName})`; do not await; catch and log. No ChatPanel state change.
- **R34**: On `master_bus_effects_changed`: dispatch a `CustomEvent(MASTER_BUS_EFFECTS_CHANGED_EVENT)` on `window`. No direct state change; `useAudioMixer` listens.

### Elicitation response

- **R35**: `respondElicitation(id, action)` sends `{type:'elicitation_response', id, action}` via WS and updates the matching elicitation block's `resolution` to `'accepted'` or `'declined'` locally.
- **R36**: After an elicitation is resolved, the Confirm/Cancel buttons are not re-clickable; the card shows a passive status label and dimmed styling.

### Chat history persistence

- **R37**: Chat history is NOT persisted client-side between mounts. On every mount, `fetchChatHistory` re-fetches; no localStorage / sessionStorage / IndexedDB is used.
- **R38**: If `fetchChatHistory` returns non-OK or throws, it returns `[]` (no visible error to the user beyond an empty list + "Ask me anything" placeholder).

### onMutation fan-out

- **R39**: `onMutation` fires ONLY on `tool_result` with `isError: false`. It does NOT fire on `tool_call`, `tool_progress`, `message`, `complete`, `error`, `chunk`, `elicitation`, or mix/bounce/master-bus channels.
- **R40**: Every successful tool run fires `onMutation` once — including read-only tools (`sql_query`, etc.). The contract is "potentially mutated"; the host is responsible for idempotent refetch.

### JobStateContext

- **R41**: Context throws if `useJobState` / `useJobContext` is called outside a `JobStateProvider`.
- **R42**: `startJob(entityKey, jobId)` creates (or replaces) an entry at `jobs[entityKey]` with `status:'in_progress', progress:0, detail:'Starting...', result:null`, records `jobIdToEntity[jobId] = entityKey`, clears any prior auto-expire timer for that entityKey, and notifies listeners.
- **R43**: On any WS `JobMessage` without `jobId`, ignore.
- **R44**: On `job_started` for an unknown jobId, auto-register: entityKey = `meta.keyframeId ?? meta.transitionId ?? jobId`, then call `startJob(entityKey, jobId)`.
- **R45**: On `job_started` / `job_progress` / `job_completed` / `job_failed` for a known jobId, look up `entry = jobs[entityKey]`. If `entry.jobId !== msg.jobId` (stale), ignore.
- **R46**: `job_started` update: `status='in_progress', progress=0, detail=\`0/${total}\``.
- **R47**: `job_progress` update: `progress = total>0 ? completed/total : 0`, `detail = msg.detail ?? \`${completed}/${total}\``, `status='in_progress'`.
- **R48**: `job_completed` update: `progress=1, status='completed', detail='Complete', result=msg.result`. Schedule a 30s auto-expire timer that deletes `jobs[entityKey]`, `jobIdToEntity[jobId]`, and the timer entry itself, then notifies.
- **R49**: `job_failed` update: `status='failed', detail=msg.error ?? 'Failed'`. Schedule a 10s auto-expire timer with the same deletion semantics.
- **R50**: `consumeResult(entityKey)` returns `entry.result` and sets `entry.result = null`. Returns `null` if no entry.
- **R51**: On `JobStateProvider` unmount, the WS `subscribeAll` unsubscribe runs AND all pending auto-expire timers are cleared.
- **R52**: `getSnapshot` returns a monotonically increasing number; every mutation calls `notify()` which increments the counter and invokes all listeners. `useSyncExternalStore` wires this into React re-renders.

### INV-4 / INV-6 additions

- **R53**: All chat events use the `core__chat__*` namespace and all job events use the `core__job__*` namespace per INV-4. No separate `/ws/chat/:project` or `/ws/jobs` sockets exist; both flow through the unified `/ws` socket (plus the binary preview-stream exception).
- **R54**: On WS reconnect, ChatPanel collects the ids of all currently-pending elicitation blocks and emits `core__chat__session_resume_check` with `{pendingElicitationIds: [...]}`. Backend responds with `{known: [...], unknown: [...]}`. For every id in `unknown`, ChatPanel replaces the pending elicitation card with an error card "Connection lost — re-run the action".
- **R55**: `handleSend` is a no-op when WS is disconnected (`!connected`). The Send button is disabled in this state, and any programmatic send attempt (not via the button) silently drops. Chat sends require an open WS; no client-side queuing or flush-on-reconnect.
- **R56**: Persisted assistant message with zero content blocks renders as an empty `space-y-2` div. Accepted rendering; not filtered at `message` time.
- **R57**: `core__job__completed` / `core__job__progress` / `core__job__failed` events for an entityKey that has no registered entry are silently ignored (only `core__job__started` auto-registers per R44). Treats unmatched events as backend noise.
- **R58**: Receipt of `core__chat__tool_loop_exceeded` event clears `streamingBlocks`, sets `loading=false`, and appends a system message "Tool loop exceeded 10 iterations — Claude stopped mid-thought. Continue?" (renderable with a Continue button that re-sends the last user message).
- **R59**: Receipt of `core__chat__elicitation_timeout` event replaces the matching pending elicitation card with an error card "Timed out — re-run the action"; distinct from user-declined state.
- **R60** (INV-6 singleton): ChatPanel is contributed with `singleton: true` in its panel manifest. By construction, at most one ChatPanel instance can exist across all panels/windows in a session; adding ChatPanel to a new location moves the existing instance rather than spawning a duplicate.

---

## Interfaces / Data Shapes

### `ClientMessage` (frontend → backend via WS)

```ts
type ClientMessage =
  | { type: 'message'; content: string; images?: string[] }
  | { type: 'elicitation_response'; id: string; action: 'accept' | 'decline'; content?: Record<string, unknown> }
```

### `ServerMessage` (backend → frontend via WS)

```ts
// All discriminators use the INV-4 namespaced form `core__chat__<event>` on the wire.
type ServerMessage =
  | { type: 'core__chat__chunk'; content: string }
  | { type: 'core__chat__tool_call'; toolCall: { id: string; name: string; input: Record<string, unknown> } }
  | { type: 'core__chat__tool_result'; toolResult: { id: string; output: unknown; isError?: boolean }; durationMs?: number }
  | { type: 'core__chat__tool_progress'; toolProgress: { id: string; phase: string; pct: number; message: string } }
  | { type: 'core__chat__message'; message: PersistedMessage }
  | { type: 'core__chat__status'; statusMessage?: string }
  | { type: 'core__chat__elicitation'; elicitation: ElicitationRequest }
  | { type: 'core__chat__elicitation_timeout'; id: string }
  | { type: 'core__chat__tool_loop_exceeded' }
  | { type: 'core__chat__complete' }
  | { type: 'core__chat__error'; error: string }
  | { type: 'core__chat__halted' }
  | { type: 'core__chat__interrupted' }
  | { type: 'core__chat__session_resume_ack'; known: string[]; unknown: string[] }
  | MixRenderRequest
  | BounceAudioRequest
  | MasterBusEffectsChanged

// Job events multiplex over the same unified WS:
type JobMessage =
  | { type: 'core__job__started'; jobId: string; total?: number; meta?: Record<string, unknown> }
  | { type: 'core__job__progress'; jobId: string; completed?: number; total?: number; detail?: string }
  | { type: 'core__job__completed'; jobId: string; result?: unknown }
  | { type: 'core__job__failed'; jobId: string; error?: string }
  | { type: 'core__job__evicted'; jobId: string }
```

### `PersistedMessage`, `ContentBlock`, `StreamingBlock` — see `chat-client.ts:115-143`.

### `JobEntry`

```ts
type JobEntry = {
  jobId: string
  entityKey: string
  status: 'in_progress' | 'completed' | 'failed'
  progress: number
  detail: string
  result: unknown
}
```

### `JobStateContextValue`

```ts
type JobStateContextValue = {
  startJob: (entityKey: string, jobId: string, label?: string) => void
  getJob: (entityKey: string) => JobEntry | null
  getAllJobs: () => JobEntry[]
  consumeResult: (entityKey: string) => unknown
  subscribe: (cb: () => void) => () => void
  getSnapshot: () => number
}
```

### REST endpoints touched

- `GET  /api/projects/:name/chat?limit=50` → `{ messages: PersistedMessage[] }`
- `POST /api/projects/:name/mix-render-upload` (multipart, triggered by `mix_render_request`)
- `POST /api/projects/:name/bounce-upload` (multipart, triggered by `bounce_audio_request`)

### WS endpoint

- `ws://host/ws` — unified socket (INV-4). Chat and job events share this connection via the `core__chat__*` and `core__job__*` namespaces. The binary preview-stream transport (`/ws/preview-stream/*`) remains separate.
- Legacy `/ws/chat/:project` and `/ws/jobs` paths are deprecated and removed.
- ChatPanel reuses the single unified WS managed by `useScenecraftSocket`; it does not open its own socket.

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | ChatPanel mounts with empty history | Loading placeholder, then empty-state prompt, WS connected | `mount-empty-history`, `ws-connect-on-mount` |
| 2 | ChatPanel mounts with 3 persisted messages | Loading placeholder, then 3 messages rendered, scrolled to bottom | `mount-with-history` |
| 3 | User types text and Shift+Enter | Message optimistically appended, input cleared, WS `message` sent, `loading=true` | `send-happy-path` |
| 4 | Plain `Enter` in textarea | Newline inserted; no send | `enter-inserts-newline` |
| 5 | Empty / whitespace-only send attempt | No-op; no WS frame sent; Send button disabled | `empty-send-noop`, `send-button-disabled-empty` |
| 6 | Send while `loading=true` | No-op; no WS frame | `send-noop-while-loading` |
| 7 | Inbound `core__chat__chunk` with no prior streaming block | New `text` block pushed | `chunk-creates-text-block` |
| 8 | Inbound `core__chat__chunk` after another chunk | Text appended to last text block | `chunk-appends-text` |
| 9 | Inbound `core__chat__tool_call` | `tool_use` block pushed with `status:'pending'` | `tool-call-badge-pending` |
| 10 | Inbound `core__chat__tool_progress` for known id | Badge updates with pct+message; status remains pending | `tool-progress-updates-badge` |
| 11 | Inbound `core__chat__tool_result` success | Badge turns green; `onMutation` fires once | `tool-result-success-fires-mutation` |
| 12 | Inbound `core__chat__tool_result` error | Badge turns red; `onMutation` does NOT fire | `tool-result-error-no-mutation` |
| 13 | Inbound `core__chat__elicitation` | `ElicitationCard` rendered with Confirm/Cancel buttons, blinking cursor hidden | `elicitation-card-pending` |
| 14 | User clicks Confirm on elicitation | WS `elicitation_response accept` sent; card shows "✓ Confirmed", dims | `elicitation-accept` |
| 15 | User clicks Cancel on elicitation | WS `elicitation_response decline` sent; card shows "Cancelled", dims | `elicitation-decline` |
| 16 | Inbound `core__chat__message` (finalized assistant) | Message appended; streaming blocks cleared | `message-finalizes` |
| 17 | Inbound `core__chat__message` (user echo dupe of optimistic) | Last optimistic user message replaced, not duplicated | `message-user-dedup` |
| 18 | Inbound `core__chat__complete` | Streaming cleared; `loading=false` | `complete-clears-loading` |
| 19 | Inbound `core__chat__error` | Streaming cleared; `loading=false`; red system message appended | `error-adds-system-message` |
| 20 | Inbound `core__chat__status` | No state change | `status-noop` |
| 21 | Inbound `mix_render_request` | `handleMixRenderRequest` called; ChatPanel state unchanged | `mix-render-request-dispatch` |
| 22 | Inbound `bounce_audio_request` | `handleBounceAudioRequest` called; state unchanged | `bounce-audio-request-dispatch` |
| 23 | Inbound `master_bus_effects_changed` | Window `CustomEvent(MASTER_BUS_EFFECTS_CHANGED_EVENT)` dispatched | `master-bus-effects-event` |
| 24 | WS drops cleanly | `connected=false`; reconnect attempt 1 after 2s | `reconnect-first-attempt` |
| 25 | WS drops repeatedly | Exponential backoff capped at 5s and 5 attempts, then gives up | `reconnect-backoff-cap` |
| 26 | ChatPanel unmounts while WS open | `disconnect()` closes socket, clears reconnect timer, no further reconnect | `unmount-stops-reconnect` |
| 27 | User scrolled up, new chunk arrives | No auto-scroll; `atBottom=false` blocks followOutput and the streaming-growth effect | `scroll-up-blocks-autoscroll` |
| 28 | User at bottom, new chunk arrives | Viewport scrolls to end (auto behavior) | `at-bottom-autoscrolls` |
| 29 | `fetchChatHistory` returns 500 | Empty list; empty-state placeholder shown; no user-facing error | `history-fetch-failure-silent` |
| 30 | JobStateContext receives `core__job__started` with known jobId | Entry transitions to in_progress, detail `0/N` | `job-started-update` |
| 31 | JobStateContext receives `core__job__progress` | Entry progress/detail updated | `job-progress-update` |
| 32 | JobStateContext receives `core__job__completed` | Entry marked complete; 30s timer scheduled | `job-completed-schedules-expire` |
| 33 | 30s after `core__job__completed` elapses | Entry removed; listeners notified | `job-completed-expires` |
| 34 | JobStateContext receives `core__job__failed` | Entry marked failed; 10s timer scheduled | `job-failed-schedules-expire` |
| 35 | `core__job__started` for unknown jobId with `meta.keyframeId` | Auto-register entityKey = keyframeId | `job-auto-register-keyframe` |
| 36 | `core__job__started` for unknown jobId with `meta.transitionId` | Auto-register entityKey = transitionId | `job-auto-register-transition` |
| 37 | `core__job__started` for unknown jobId without meta | Auto-register entityKey = jobId | `job-auto-register-fallback` |
| 38 | JobMessage without `jobId` field | Ignored | `job-msg-no-jobid-ignored` |
| 39 | Stale jobId (entityKey reassigned to newer jobId) | Stale message ignored | `job-stale-jobid-ignored` |
| 40 | `startJob` called again for same entityKey | Previous entry replaced; old expire timer cleared | `startjob-replaces-entry` |
| 41 | `consumeResult(entityKey)` with completed job | Returns result; entry.result set to null | `consume-result-clears` |
| 42 | `consumeResult(unknownKey)` | Returns null | `consume-result-unknown` |
| 43 | `useJobState` outside provider | Throws | `usejobstate-no-provider` |
| 44 | Provider unmounts with live timers | All timers cleared; WS subscription removed | `provider-unmount-cleanup` |
| 45 | WS drops mid-tool-elicitation | On reconnect, client sends `core__chat__session_resume_check` with pending elicitation ids. Backend responds `{known, unknown}`. Unknown ids → client converts each pending card to a "Connection lost — re-run the action" error card. Known ids → card stays live and Confirm/Cancel work on the new socket | `reconnect-resume-known-elicitation`, `reconnect-unknown-elicitation-becomes-error` |
| 46 | Send message before WS connected | Send button disabled when `!connected`; programmatic sends outside the button silently drop. No client-side queue, no flush-on-reconnect | `send-before-connect-silently-drops` |
| 47 | Clear chat during streaming (no UI action exists) | Out of scope — no clear-chat feature planned; interrupt path handles cancel | (removed) |
| 48 | Assistant persisted message with zero content blocks | Renderer emits empty `space-y-2` div. Accepted; not filtered | `empty-content-blocks-renders-empty-div` |
| 49 | `core__job__completed` for unknown entityKey | Silently ignored — only `core__job__started` auto-registers. `progress`/`completed`/`failed` for unknown entities are treated as backend noise | `job-completed-unknown-entitykey-ignored` |
| 50 | Two ChatPanel instances attempted (same project or different windows) | Unreachable by construction — ChatPanel is `singleton: true` (INV-6). Adding ChatPanel elsewhere moves the existing instance rather than spawning a duplicate | `chatpanel-singleton-move-not-duplicate` |
| 51 | `handleMixRenderRequest` fails (render / upload) | Error logged; no ChatPanel state change; backend times out | `mix-render-handler-swallows-errors` |
| 52 | Assistant persisted message with `ContentBlock[]` containing `tool_use` | Renders text + ToolCallBadge; status derived from `tool_calls[id].is_error` | `persisted-tool-use-renders-badge` |
| 53 | Streaming bubble while elicitation pending | Blinking cursor hidden | `cursor-hidden-during-elicitation` |
| 54 | Inbound `core__chat__tool_loop_exceeded` | Streaming cleared; `loading=false`; system message "Tool loop exceeded 10 iterations — Claude stopped mid-thought. Continue?" appended | `tool-loop-exceeded-surfaces-error` |
| 55 | Inbound `core__chat__elicitation_timeout` | Matching pending elicitation card replaced with error card "Timed out — re-run the action"; distinct from user-declined state | `elicitation-timeout-distinct-from-decline` |

---

## Behavior (step-by-step)

### Mount

1. `ChatPanel` renders. `useEffect([projectName, handleMessage, scrollToBottom])` runs.
2. `fetchChatHistory(projectName)` resolves → `messages` populated, `initialLoading=false`, `scrollToBottom()`.
3. `new ChatWebSocket(...)` is constructed and stored in `wsRef`.
4. `ws.connect()` opens the socket. On `open`, `setConnected(true)` fires.
5. Each inbound frame is parsed JSON and dispatched into `handleMessage`.

### Send

1. User types, `input` state grows, textarea resizes.
2. Shift+Enter → `handleSend`.
3. Guard: `text` non-empty and `!loading`.
4. Optimistic user message appended; `input=''`; `loading=true`; `scrollToBottom()`.
5. `wsRef.current?.send({type:'message', content: text})`.

### Streaming turn

1. Backend emits `chunk` repeatedly → `text` block grows.
2. Backend emits `tool_call` → `tool_use` pending badge appears.
3. Backend emits `tool_progress` → badge shows pct.
4. (Optional) Backend emits `elicitation` → card appears; user responds; WS `elicitation_response` sent back; card resolution updates.
5. Backend emits `tool_result` → badge color updates; `onMutation` fires on success.
6. Loop steps 1–5 per tool iteration.
7. Backend emits `message` → persisted assistant turn appended; streaming cleared.
8. Backend emits `complete` → `loading=false`.

### Reconnect

1. Socket closes unexpectedly → `setConnected(false)`; `attemptReconnect()`.
2. Schedule retry at `min(2000 * 2^attempts, 5000)` ms; increment `reconnectAttempts`.
3. After 5 failed attempts, give up.
4. A successful `open` zeroes `reconnectAttempts`.

### Unmount

1. `ws.disconnect()` clears reconnect timer, sets `reconnectAttempts = max` (suppresses future reconnect), closes socket, nulls ref.
2. `wsRef.current = null`.

### Job lifecycle (JobStateContext)

1. Caller (usually a panel handling an action) invokes `startJob(entityKey, jobId)` optimistically.
2. Alternatively, a `job_started` event from an unknown jobId auto-registers.
3. `job_progress` events update the keyed entry; UI consumers re-render via `useSyncExternalStore`.
4. `job_completed` finalizes and starts a 30s expire timer.
5. `job_failed` finalizes and starts a 10s expire timer.
6. Timer fires → entry + reverse-map deleted → listeners notified.

---

## Acceptance Criteria

- [ ] ChatPanel mounts, fetches history, connects WS, and renders history + empty-state correctly.
- [ ] All 11 `ServerMessage` variants route to the documented state transitions.
- [ ] `onMutation` fires exactly on non-error `tool_result`; nowhere else.
- [ ] Elicitation round-trip: card renders → user clicks → WS frame sent → card resolution visible.
- [ ] Virtuoso auto-scroll respects `atBottom`.
- [ ] Shift+Enter sends; Enter inserts newline.
- [ ] Reconnect gives up after 5 attempts, caps backoff at 5s.
- [ ] `disconnect()` prevents any further reconnect.
- [ ] JobStateContext: entityKey-keyed store with stale-jobId guard, auto-register on unknown `job_started`, 30s/10s auto-expire.
- [ ] `consumeResult` returns result once and clears it.
- [ ] Provider teardown clears all timers.

---

## Tests

### Base Cases

#### Test: mount-empty-history (covers R1, R2, R13)

**Given**: `fetchChatHistory` resolves to `[]`; WS server accepts connection.
**When**: ChatPanel mounts with a valid `projectName`.
**Then** (assertions):
- **loading-placeholder-then-empty**: "Loading..." shown first, then "Ask me anything about this project".
- **ws-connected-true**: `connected` state becomes `true`; badge shows "Connected".
- **no-ws-send**: No `send()` call is issued until user sends.

#### Test: mount-with-history (covers R1, R3, R12)

**Given**: `fetchChatHistory` resolves to 3 persisted messages.
**When**: ChatPanel mounts.
**Then**:
- **messages-rendered**: All 3 messages appear in the Virtuoso list.
- **scrolled-to-bottom**: `virtuosoRef.scrollToIndex({index:'LAST',...})` is called once.

#### Test: ws-connect-on-mount (covers R13, R14, R18)

**Given**: ChatPanel about to mount.
**When**: Mount.
**Then**:
- **ws-url-matches**: WebSocket opened to `${SCENECRAFT_WS_URL}/ws/chat/${encodeURIComponent(projectName)}`.
- **no-query-token**: No auth query parameter or subprotocol header present.

#### Test: send-happy-path (covers R19, R20, R21)

**Given**: WS connected; `loading=false`; input contains "hello".
**When**: User presses Shift+Enter.
**Then**:
- **optimistic-append**: A user message with `content:'hello'` appears last.
- **input-cleared**: Textarea value is empty.
- **loading-true**: `loading` state becomes `true`.
- **ws-send-called**: WS `send({type:'message', content:'hello'})` called exactly once.
- **scroll-bottom**: `scrollToBottom` invoked.

#### Test: enter-inserts-newline (covers R21)

**Given**: Input focused with "hello".
**When**: User presses Enter (no shift).
**Then**:
- **no-send**: WS `send` not called.
- **no-optimistic-append**: No new message appended.

#### Test: empty-send-noop (covers R19)

**Given**: Input is empty or whitespace; `loading=false`; connected.
**When**: Programmatic `handleSend` invocation.
**Then**:
- **no-send**: WS `send` not called.
- **loading-unchanged**: `loading` stays `false`.

#### Test: send-button-disabled-empty (covers R17)

**Given**: Input empty OR `loading=true` OR `connected=false`.
**When**: Render.
**Then**:
- **button-disabled**: Send button has `disabled` attribute.

#### Test: send-noop-while-loading (covers R19)

**Given**: `loading=true`; input "hi"; connected.
**When**: Shift+Enter pressed.
**Then**:
- **no-send**: No WS send.
- **no-append**: No new message.

#### Test: chunk-creates-text-block (covers R23)

**Given**: `streamingBlocks = []`.
**When**: Inbound `{type:'chunk', content:'Hello'}`.
**Then**:
- **text-block-pushed**: `streamingBlocks = [{type:'text', text:'Hello'}]`.

#### Test: chunk-appends-text (covers R23)

**Given**: `streamingBlocks = [{type:'text', text:'Hello'}]`.
**When**: Inbound `{type:'chunk', content:' world'}`.
**Then**:
- **text-appended**: `streamingBlocks = [{type:'text', text:'Hello world'}]`.
- **no-new-block**: List length unchanged.

#### Test: tool-call-badge-pending (covers R24, R5)

**Given**: Active streaming turn.
**When**: Inbound `{type:'tool_call', toolCall:{id:'t1', name:'update_volume_curve', input:{}}}`.
**Then**:
- **tool-use-pushed**: `streamingBlocks` contains `{type:'tool_use', id:'t1', name:'update_volume_curve', status:'pending'}`.
- **badge-rendered**: DOM shows a `ToolCallBadge` with spinner icon.

#### Test: tool-progress-updates-badge (covers R25)

**Given**: `tool_use` block with id 't1' pending.
**When**: Inbound `{type:'tool_progress', toolProgress:{id:'t1', phase:'rendering', pct:0.5, message:'halfway'}}`.
**Then**:
- **progress-set**: Block's `progress` field equals the payload.
- **status-still-pending**: Status not changed.
- **badge-shows-pct**: DOM shows "· 50% halfway".

#### Test: tool-result-success-fires-mutation (covers R26, R39, R40)

**Given**: `tool_use` block pending with id 't1'; `onMutation` callback provided.
**When**: Inbound `{type:'tool_result', toolResult:{id:'t1', output:{}, isError:false}}`.
**Then**:
- **status-success**: Block status becomes 'success'.
- **progress-cleared**: `progress` is `undefined`.
- **on-mutation-called-once**: `onMutation` called exactly once.

#### Test: tool-result-error-no-mutation (covers R26, R39)

**Given**: Same as above; `isError: true`.
**When**: Inbound tool_result.
**Then**:
- **status-error**: Block status becomes 'error'.
- **on-mutation-not-called**: `onMutation` not called.

#### Test: elicitation-card-pending (covers R27, R6, R9)

**Given**: Active turn.
**When**: Inbound `{type:'elicitation', elicitation:{id:'e1', tool_use_id:'t1', tool_name:'delete_keyframe', title:'Confirm deletion', message:'…'}}`.
**Then**:
- **card-pushed**: `streamingBlocks` contains elicitation with `resolution:'pending'`.
- **buttons-visible**: Confirm + Cancel buttons rendered.
- **cursor-hidden**: Blinking cursor NOT rendered (R9).

#### Test: elicitation-accept (covers R35, R36)

**Given**: Pending elicitation 'e1'.
**When**: User clicks Confirm.
**Then**:
- **ws-send-response**: WS send called with `{type:'elicitation_response', id:'e1', action:'accept'}`.
- **resolution-accepted**: Block resolution becomes 'accepted'.
- **status-label**: DOM shows "✓ Confirmed"; buttons gone.

#### Test: elicitation-decline (covers R35, R36)

**Given**: Pending elicitation 'e1'.
**When**: User clicks Cancel.
**Then**:
- **ws-send-response**: WS send `{type:'elicitation_response', id:'e1', action:'decline'}`.
- **resolution-declined**: Resolution becomes 'declined'.
- **status-label**: DOM shows "Cancelled".

#### Test: message-finalizes (covers R28)

**Given**: `streamingBlocks` contains text + tool_use blocks.
**When**: Inbound `{type:'message', message: {role:'assistant', content:[...]} }`.
**Then**:
- **message-appended**: `messages` gains the new entry.
- **streaming-cleared**: `streamingBlocks = []`.

#### Test: message-user-dedup (covers R28)

**Given**: Last message is optimistic user `{role:'user', content:'hi'}`.
**When**: Inbound `{type:'message', message:{role:'user', content:'hi', id:42, ...}}`.
**Then**:
- **last-replaced**: `messages` has same length; last message is the server-persisted one (id=42).
- **no-duplicate**: Only one 'hi' user message in the list.

#### Test: complete-clears-loading (covers R29)

**Given**: `loading=true`; `streamingBlocks` non-empty.
**When**: Inbound `{type:'complete'}`.
**Then**:
- **loading-false**: `loading` becomes `false`.
- **streaming-cleared**: `streamingBlocks = []`.

#### Test: error-adds-system-message (covers R30)

**Given**: Active turn.
**When**: Inbound `{type:'error', error:'Claude rate-limited'}`.
**Then**:
- **streaming-cleared**: `streamingBlocks = []`.
- **loading-false**: `loading=false`.
- **system-message-appended**: A `role:'system'` message with `content:'Error: Claude rate-limited'` appended.

#### Test: status-noop (covers R31)

**Given**: Any state.
**When**: Inbound `{type:'status', statusMessage:'thinking'}`.
**Then**:
- **no-state-change**: messages, streamingBlocks, loading unchanged.

#### Test: mix-render-request-dispatch (covers R32)

**Given**: WS handler installed.
**When**: Inbound `mix_render_request` message.
**Then**:
- **handler-called**: `handleMixRenderRequest` called with `(msg, {projectName})`.
- **no-await-block**: ChatPanel's handler returns synchronously.
- **no-state-change**: messages/streaming/loading unchanged.

#### Test: bounce-audio-request-dispatch (covers R33)

**Given**: Same.
**When**: Inbound `bounce_audio_request`.
**Then**:
- **handler-called**: `handleBounceAudioRequest` called with `{msg, projectName}`.
- **no-state-change**.

#### Test: master-bus-effects-event (covers R34)

**Given**: Window exists.
**When**: Inbound `master_bus_effects_changed`.
**Then**:
- **event-dispatched**: `window.dispatchEvent` called with a `CustomEvent` of type `MASTER_BUS_EFFECTS_CHANGED_EVENT`.
- **no-state-change**.

#### Test: persisted-tool-use-renders-badge (covers R7, R52)

**Given**: A persisted assistant message with `content = [{type:'text', text:'Done'}, {type:'tool_use', id:'t1', name:'apply_mix_plan', input:{}}]` and `tool_calls=[{id:'t1', is_error:false}]`.
**When**: Rendered in a `MessageBubble`.
**Then**:
- **text-renders-markdown**: "Done" shown.
- **badge-green**: `ToolCallBadge` rendered with `status='success'` styling.

#### Test: job-started-update (covers R42, R46)

**Given**: `startJob('kf-1', 'j-1')` previously called.
**When**: Inbound `{type:'job_started', jobId:'j-1', total:5}`.
**Then**:
- **status-in-progress**: Entry `status='in_progress'`.
- **detail-zero-of-total**: `detail='0/5'`.
- **listeners-notified**: Change counter incremented.

#### Test: job-progress-update (covers R47)

**Given**: Entry exists for 'kf-1' tied to 'j-1'.
**When**: Inbound `{type:'job_progress', jobId:'j-1', completed:3, total:5, detail:'frame 3/5'}`.
**Then**:
- **progress-0-6**: `entry.progress === 0.6`.
- **detail-string**: `entry.detail === 'frame 3/5'`.
- **status-in-progress**: status unchanged from in_progress.

#### Test: job-completed-schedules-expire (covers R48)

**Given**: Entry exists.
**When**: Inbound `{type:'job_completed', jobId:'j-1', result:{foo:1}}`.
**Then**:
- **progress-one**: `entry.progress === 1`.
- **status-completed**: `entry.status === 'completed'`.
- **detail-complete**: `entry.detail === 'Complete'`.
- **result-stored**: `entry.result === {foo:1}`.
- **timer-scheduled-30s**: A timer is scheduled for 30000 ms.

#### Test: job-completed-expires (covers R48)

**Given**: Entry completed; 30s timer armed.
**When**: 30s elapses.
**Then**:
- **entry-removed**: `jobs.get(entityKey)` returns undefined.
- **reverse-map-cleared**: `jobIdToEntity.get(jobId)` returns undefined.
- **listeners-notified**: Change counter incremented.

#### Test: job-failed-schedules-expire (covers R49)

**Given**: Entry exists.
**When**: Inbound `{type:'job_failed', jobId:'j-1', error:'boom'}`.
**Then**:
- **status-failed**: `entry.status === 'failed'`.
- **detail-error**: `entry.detail === 'boom'`.
- **timer-10s**: A timer is scheduled for 10000 ms.

#### Test: consume-result-clears (covers R50)

**Given**: Completed entry with `result={foo:1}`.
**When**: `consumeResult('kf-1')`.
**Then**:
- **returns-result**: Returns `{foo:1}`.
- **result-nulled**: A follow-up `getJob('kf-1').result` is null.

#### Test: consume-result-unknown (covers R50)

**Given**: No entry for 'nope'.
**When**: `consumeResult('nope')`.
**Then**:
- **returns-null**: Returns null.

#### Test: usejobstate-no-provider (covers R41)

**Given**: Component renders without `JobStateProvider` ancestor.
**When**: Calls `useJobState('x')`.
**Then**:
- **throws**: Throws `Error('useJobState must be used within JobStateProvider')`.

### Edge Cases

#### Test: reconnect-first-attempt (covers R14, R15)

**Given**: WS was open; backend drops the connection.
**When**: `onclose` fires.
**Then**:
- **connected-false**: `setConnected(false)`.
- **timer-scheduled**: A reconnect timer set at 2000 ms (attempt 1: `min(2000*2^0, 5000)`).

#### Test: reconnect-backoff-cap (covers R15)

**Given**: Five reconnect attempts have failed.
**When**: Sixth `onclose` fires.
**Then**:
- **no-more-retries**: No new timer scheduled; `reconnectAttempts === 5`.

#### Test: unmount-stops-reconnect (covers R16, R26)

**Given**: WS open; ChatPanel mounted.
**When**: ChatPanel unmounts.
**Then**:
- **timer-cleared**: Any pending reconnect timer is cleared.
- **no-reconnect-on-close**: Subsequent `onclose` triggers no new timer because `reconnectAttempts >= max`.
- **ws-closed**: `ws.close()` called.

#### Test: scroll-up-blocks-autoscroll (covers R10, R11)

**Given**: `atBottom=false`.
**When**: Inbound `chunk` grows the streaming text block.
**Then**:
- **no-scroll-call**: `scrollToIndex` not called by the streaming-growth effect.
- **followoutput-returns-false**: `followOutput(isAtBottom=false)` returns false.

#### Test: at-bottom-autoscrolls (covers R11)

**Given**: `atBottom=true`; streaming in progress.
**When**: `chunk` arrives.
**Then**:
- **scroll-to-last**: `scrollToIndex({index:'LAST', align:'end', behavior:'auto'})` called.

#### Test: history-fetch-failure-silent (covers R38)

**Given**: `/api/projects/:name/chat` returns 500.
**When**: ChatPanel mounts.
**Then**:
- **empty-messages**: `messages = []`.
- **empty-state-shown**: "Ask me anything" placeholder.
- **no-error-toast**: No user-visible error text.

#### Test: job-auto-register-keyframe (covers R44)

**Given**: No entry in store.
**When**: Inbound `{type:'job_started', jobId:'j-2', total:4, meta:{keyframeId:'kf-9'}}`.
**Then**:
- **entity-key-kf9**: `jobs.get('kf-9')` exists with jobId 'j-2'.
- **reverse-map**: `jobIdToEntity.get('j-2') === 'kf-9'`.

#### Test: job-auto-register-transition (covers R44)

**Given**: No entry.
**When**: `job_started` with `meta:{transitionId:'tr-3'}`.
**Then**:
- **entity-key-tr3**: `jobs.get('tr-3')` exists.

#### Test: job-auto-register-fallback (covers R44)

**Given**: No entry; no meta.
**When**: `job_started` with jobId 'j-99' and no `meta`.
**Then**:
- **entity-key-jobid**: `jobs.get('j-99')` exists with entityKey 'j-99'.

#### Test: job-msg-no-jobid-ignored (covers R43)

**Given**: Any store state.
**When**: Inbound message without `jobId` field.
**Then**:
- **no-change**: Store unchanged; no notify.

#### Test: job-stale-jobid-ignored (covers R45)

**Given**: Entry for 'kf-1' was registered with jobId 'j-old'; subsequently `startJob('kf-1', 'j-new')` replaced it.
**When**: A late `job_progress` arrives with `jobId:'j-old'`.
**Then**:
- **entry-untouched**: Current entry tied to 'j-new' is not updated.

  *Note on correctness*: the code looks up entityKey via `jobIdToEntity.get(msg.jobId)`; if `startJob` replaces the entry for 'kf-1', the reverse-map for 'j-old' is NOT cleared in `startJob` itself — so this test asserts the guard `entry.jobId !== msg.jobId` actually does the job. If the test fails, either the guard or `startJob`'s reverse-map cleanup is at fault.

#### Test: startjob-replaces-entry (covers R42)

**Given**: Entry for 'kf-1' exists, status 'completed', with an armed 30s timer.
**When**: `startJob('kf-1', 'j-new')` called.
**Then**:
- **old-timer-cleared**: Previous expire timer is cleared (assertion: after 30s passes, entry still exists because new one took over).
- **entry-replaced**: Entry jobId is now 'j-new'; status 'in_progress'; detail 'Starting...'.

#### Test: provider-unmount-cleanup (covers R51)

**Given**: Provider mounted; 3 pending expire timers; WS subscription active.
**When**: Provider unmounts.
**Then**:
- **timers-cleared**: All 3 timers cleared (no subsequent fire).
- **ws-unsub-called**: `socket.subscribeAll`'s unsub fn invoked.

#### Test: cursor-hidden-during-elicitation (covers R9)

**Given**: Streaming bubble has a pending elicitation block.
**When**: Render.
**Then**:
- **no-cursor**: No `animate-pulse` cursor element in the streaming bubble.

#### Test: mix-render-handler-swallows-errors (covers R32)

**Given**: `handleMixRenderRequest` rejects.
**When**: Inbound `mix_render_request`.
**Then**:
- **console-warn-called**: `console.warn('[ChatPanel] mix_render_request failed:', err)`.
- **no-chat-error-message**: No system message appended; no loading change.

#### Test: reconnect-resume-known-elicitation (covers R54, OQ-1 resolution)

**Given**: ChatPanel has a pending elicitation block with id `e-1`; WS drops and reconnects.

**When**: On reconnect, backend responds to `core__chat__session_resume_check` with `{known: ['e-1'], unknown: []}`.

**Then**:
- **resume-check-sent**: Outbound `core__chat__session_resume_check` frame contained `pendingElicitationIds: ['e-1']`.
- **card-still-pending**: The `e-1` elicitation card still renders Confirm/Cancel buttons; `resolution === 'pending'`.
- **confirm-works**: Clicking Confirm sends `elicitation_response accept` on the new socket and the backend acknowledges.

#### Test: reconnect-unknown-elicitation-becomes-error (covers R54, OQ-1 resolution)

**Given**: Pending elicitation `e-2`; WS drops and reconnects.

**When**: Backend responds `{known: [], unknown: ['e-2']}`.

**Then**:
- **card-replaced-with-error**: Card at id `e-2` renders "Connection lost — re-run the action"; Confirm/Cancel buttons are gone.
- **no-elicitation-response-sent**: Any subsequent Confirm click (if still present) is inert.

#### Test: send-before-connect-silently-drops (covers R55, OQ-2 resolution)

**Given**: `connected === false` (WS not open).

**When**: A programmatic caller invokes `wsRef.current?.send({type:'message', content:'hi'})`.

**Then**:
- **no-frame-sent**: No WS frame observed on the socket mock.
- **no-queue**: No internal queue state holds the message.
- **send-button-disabled**: Send button is also disabled in the UI (assertion on DOM).

#### Test: empty-content-blocks-renders-empty-div (covers R56, OQ-4 resolution)

**Given**: A persisted assistant message with `content: []`.

**When**: Rendered.

**Then**:
- **empty-space-y-2**: A `div.space-y-2` is present with no children.
- **no-throw**: Render does not throw.

#### Test: job-completed-unknown-entitykey-ignored (covers R57, OQ-5 resolution)

**Given**: Empty `jobs` map; empty `jobIdToEntity`.

**When**: Inbound `{type:'core__job__completed', jobId:'j-ghost'}` arrives.

**Then**:
- **store-unchanged**: `jobs.size === 0` still.
- **no-notify**: Listeners receive no notification.
- **debug-log-only**: Optional `console.debug` may appear; no user-facing effect.

#### Test: chatpanel-singleton-move-not-duplicate (covers R60, OQ-6 resolution)

**Given**: ChatPanel is mounted in window A. Panel manifest declares `singleton: true`.

**When**: User adds ChatPanel to window B via menu / drag.

**Then**:
- **panel-moved**: Window A's ChatPanel is unmounted; window B has exactly one ChatPanel.
- **global-count-one**: Across the session, `document.querySelectorAll('[data-panel-id="chat"]').length === 1`.
- **no-second-ws**: No second unified WS is opened; the session still uses one WS.

#### Test: tool-loop-exceeded-surfaces-error (covers R58, INV-4 + OQ-4 chat-tool-dispatch)

**Given**: Streaming turn in progress; `loading=true`; streamingBlocks contains a few tool_use blocks.

**When**: Inbound `{type:'core__chat__tool_loop_exceeded'}`.

**Then**:
- **streaming-cleared**: `streamingBlocks.length === 0`.
- **loading-false**: `loading === false`.
- **system-message-appended**: Last message has `role:'system'` and content contains "Tool loop exceeded 10 iterations".

#### Test: elicitation-timeout-distinct-from-decline (covers R59)

**Given**: Pending elicitation `e-3`.

**When**: Inbound `{type:'core__chat__elicitation_timeout', id:'e-3'}`.

**Then**:
- **card-replaced-with-timeout-error**: Card at `e-3` now shows "Timed out — re-run the action".
- **distinct-from-declined**: Card does NOT render "Cancelled" text (that's the user-decline path).

---

## Non-Goals

- Offline / retry-on-upload for `mix_render_request` or `bounce_audio_request`. The backend times out at 60s; the frontend logs and moves on.
- Persisting chat history client-side between mounts.
- Auth-token refresh inside `ChatWebSocket` — auth is cookie-based and out of band.
- Multi-tab coordination for in-flight jobs (each tab has its own `JobStateContext`).
- Cancel button for in-flight tools (destructive confirmation is the only user-facing gate).
- Attachment / image upload in the chat composer (the `images` field on `ClientMessage` is present for future use; ChatPanel never populates it).
- Toasts for `master_bus_effects_changed` / successful tool runs (audit's "v1: agent narrates mutations itself" decision).

---

## Open Questions

*(all resolved — see `### Resolved` below)*

### Resolved

- **OQ-1 (row 45) — WS drops mid-tool-elicitation**: Resolved as **fix** — client tracks pending elicitation ids; on reconnect, sends `core__chat__session_resume_check` with pending ids. Backend responds known/unknown. Unknown ids → client converts card to "Connection lost — re-run the action" error. R54 added; tests `reconnect-resume-known-elicitation`, `reconnect-unknown-elicitation-becomes-error`.
- **OQ-2 (row 46) — Send before WS connected**: Resolved as **codify** — button is disabled when disconnected; programmatic sends outside the button silently drop. Contract: "chat sends require an open WS; no queuing." R55 added; test `send-before-connect-silently-drops`.
- **OQ-3 (row 47) — Clear chat during streaming**: Resolved as **out of scope** — no clear-chat feature planned. Interrupt path already handles cancel. Behavior Table row 47 marked (removed).
- **OQ-4 (row 48) — Assistant message with zero content blocks**: Resolved as **codify** — renderer emits empty `space-y-2` div. Acceptable. R56 added; test `empty-content-blocks-renders-empty-div`.
- **OQ-5 (row 49) — `job_completed` for unknown entityKey**: Resolved as **codify silent-ignore** — only `core__job__started` auto-registers. Unknown-entity `progress`/`completed`/`failed` events silently ignored as backend noise. R57 added; test `job-completed-unknown-entitykey-ignored`.
- **OQ-6 (row 50) — Concurrent ChatPanel instances**: Resolved via **INV-6 singleton panels** — ChatPanel is `singleton: true`; cannot have two instances by construction. R60 added; test `chatpanel-singleton-move-not-duplicate`.

### INV-4 consolidation (unified WebSocket)

All chat events on the wire use the `core__chat__<event>` namespace; all job events use `core__job__<event>`. The legacy `/ws/chat/:project` and `/ws/jobs` sockets are removed; both multiplex over `/ws`. See R14, R53, and the ServerMessage / JobMessage interface definitions.

New core-chat event shapes introduced by related spec decisions:
- `core__chat__tool_loop_exceeded` — emitted when the 10-iteration tool loop cap trips (see R58; chat-tool-dispatch OQ-4).
- `core__chat__elicitation_timeout` — emitted when the 300s elicitation future times out without a client response (see R59; chat-tool-dispatch OQ-1).
- `core__chat__session_resume_ack` — backend response to client's reconnect-time `core__chat__session_resume_check`.

---

## Related Artifacts

- Audit: `agent/reports/audit-2-architectural-deep-dive.md` (§1C unit 7, §1D unit 12, §5 target #15)
- Backend counterpart spec (not yet written): `chat-tool-dispatch-and-elicitation` (§5 item 4) — will own `_stream_response`, `_is_destructive`, elicitation future lifecycle, and the 300s timeout
- Backend counterpart spec (not yet written): `job-manager-and-ws-events` (§5 item 5) — will own the `JobManager` broadcast side of the contract consumed here
- Related frontend spec: `timeline-composition-and-playback-loop` (§5 item 11) — hosts the `onMutation` callback target

---

**Namespace**: local
**Spec**: chat-panel-and-job-state
**Version**: 1.0.0
**Status**: Active (retroactive)
