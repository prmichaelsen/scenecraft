# Spec: Chat Tool Dispatch and Destructive-Op Elicitation Gate

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive — codifies observed behavior)

---

## Purpose

Define the exact contract by which the scenecraft chat subsystem (a) advertises tools to Claude, (b) dispatches Claude's `tool_use` blocks to handlers, (c) gates destructive / expensive tools behind a user confirmation round-trip ("elicitation"), and (d) streams the resulting events to the chat WebSocket. This spec is the contract between `chat.py` (backend) and `chat-client.ts` + `ChatPanel.tsx` (frontend).

## Source

- **Mode**: `--from-draft` (retroactive from source reading)
- **Primary sources**:
  - `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/chat.py` — `TOOLS` list (aka `CHAT_TOOLS` in the audit), `_DESTRUCTIVE_TOOL_PATTERNS`, `_DESTRUCTIVE_TOOL_ALLOWLIST`, `_is_destructive`, `_format_tool_input_summary`, `_humanize_tool_name`, `_recv_elicitation_response`, `_execute_tool`, `_stream_response`, `handle_chat_connection`
  - `/home/prmichaelsen/.acp/projects/scenecraft/src/lib/chat-client.ts` — `ServerMessage` / `ClientMessage` union, `ChatWebSocket`, `ElicitationRequest`, `StreamingBlock`
  - `/home/prmichaelsen/.acp/projects/scenecraft/src/components/editor/ChatPanel.tsx` — `handleMessage` switch, `respondElicitation`
- **Related audit**: `agent/reports/audit-2-architectural-deep-dive.md` §1C (units 1–5).

---

## Scope

### In Scope

- The **tool registry shape** advertised to Claude (`{name, description, input_schema}`), its three contribution sources (built-in `TOOLS`, plugin-contributed via `PluginHost.list_mcp_tools`, MCP bridge tools), and how they are concatenated for each stream call.
- The **tool dispatch flow**: Claude emits `tool_use` → `_is_destructive` check → optional elicitation round-trip → `_execute_tool` (or `bridge.call_tool`) → `core__chat__tool_result` event → loop back to Claude.
- The **destructive-op gate**: which tool names are considered destructive (substring patterns, allowlist, plugin `destructive` flag), and what happens on accept / decline / timeout.
- The **WS event protocol**: exact event types emitted by the backend per INV-4 namespacing (`core__chat__chunk`, `core__chat__tool_call`, `core__chat__tool_progress`, `core__chat__tool_result`, `core__chat__tool_loop_exceeded`, `core__chat__elicitation`, `core__chat__elicitation_timeout`, `core__chat__message`, `core__chat__complete`, `core__chat__error`, `core__chat__halted`) and the exact client-initiated message types consumed (`core__chat__message`, `core__chat__elicitation_response`, `core__chat__stop`, `core__chat__ping`). All chat traffic multiplexes over the unified `/ws` socket per INV-4.
- The **plugin-namespaced tool dispatch branch**: `name` contains `__` → `PluginHost.get_mcp_tool(name)` lookup → handler called with `(input_data, context)` → result wrapped as `(result, is_error)`.
- The **10-iteration tool loop cap** and the **50-message history window** fed to Claude.
- The **elicitation timeout** (300s) and the single-reader-ws / elicitation futures dict pattern.

### Out of Scope

- Per-tool handler logic (e.g. what `_exec_update_keyframe_prompt` actually does — each has its own spec or is covered by the owning plugin's spec).
- **JobManager** + `/ws/jobs` event bus (separate spec — audit §1C unit 6; referenced here only as the mechanism `_await_generation_job` polls).
- Concrete behavior of `generate_*` / `isolate_*` job awaits (separate specs per plugin).
- MCP bridge internals (OAuth connect, tool listing) — treated as a black box that exposes `has_tool`, `call_tool`, `all_tools`.
- Chat history persistence schema (DB layout of `messages` / `tool_calls` columns — covered by a chat-persistence spec).
- System-prompt construction (`_build_system_prompt`) — content is a prompt-engineering detail, not a protocol contract.
- Frontend rendering of tool badges beyond the accept/decline flow (styling, animations).

---

## Interfaces / Data Shapes

### Tool definition (advertised to Claude)

Each entry in the merged tool list has exactly these three keys (Claude's required shape):

```json
{
  "name": "string — unique across built-ins + plugin tools + bridge tools",
  "description": "string",
  "input_schema": { "type": "object", "properties": { ... }, "required": [ ... ] }
}
```

### Tool registry sources (merged, in this order, per stream call)

1. `TOOLS` — module-level list in `chat.py`, currently **34 built-in entries**
   (`sql_query`, `update_keyframe_prompt`, `update_keyframe_timestamp`, `update_curve`, `update_transform_curve`, `delete_keyframe`, `delete_transition`, `batch_delete_keyframes`, `batch_delete_transitions`, `add_keyframe`, `update_keyframe`, `update_transition`, `split_transition`, `assign_keyframe_image`, `assign_pool_video`, `checkpoint`, `list_checkpoints`, `restore_checkpoint`, `generate_keyframe_candidates`, `generate_transition_candidates`, `isolate_vocals__run`, `generate_foley`, `add_audio_track`, `add_audio_clip`, `update_volume_curve`, `generate_dsp`, `add_audio_effect`, `add_master_bus_effect`, `remove_master_bus_effect`, `update_effect_param_curve`, `generate_descriptions`, `apply_mix_plan`, `analyze_master_bus`, `bounce_audio`).
2. `PluginHost.list_mcp_tools()` — plugin-contributed tools; `name` is `full_name` = `{plugin_id}__{tool_id}`.
3. `bridge.all_tools()` — external MCP tools (e.g. Remember). May be empty if bridge hasn't connected yet. Not available on the first stream of a session.

The order determines shadow precedence: built-ins listed first; a duplicate tool name later in the list is ignored by Claude.

### Destructive classifier — `_is_destructive(name: str) -> bool`

1. Lowercase `name`.
2. If `name in _DESTRUCTIVE_TOOL_ALLOWLIST` → **False**.
   Current allowlist: `{"generate_dsp", "generate_descriptions", "analyze_master_bus", "bounce_audio"}`.
3. If `"__"` in name (plugin-namespaced) → look up `PluginHost.get_mcp_tool(name)`;
   if found → return `bool(tool.destructive)`. Lookup failure is swallowed, falls through to step 4.
4. Return `True` if any substring in `_DESTRUCTIVE_TOOL_PATTERNS` appears in `name`, else `False`.
   Current patterns: `("delete", "remove", "destroy", "drop", "publish", "retract", "revise", "moderate", "restore_checkpoint", "batch_delete", "generate_", "isolate_")`.

### WS event protocol — server → client

Emitted over the unified `/ws` socket per INV-4 (the legacy `/ws/chat/{project}` path is deprecated).

| `type` | Shape (JSON) | Emitted when |
|---|---|---|
| `core__chat__chunk` | `{ type, content: string }` | Claude streams a `text_delta`. |
| `core__chat__tool_call` | `{ type, toolCall: { id, name, input: {} } }` | First `content_block_start` of a `tool_use` block. `input` is always `{}` — final input is in `core__chat__tool_result`. Emitted at most once per tool id. |
| `core__chat__tool_progress` | `{ type, toolProgress: { id, phase: string, pct: number, message: string } }` | Forwarded by generation-job awaits mid-execution. |
| `core__chat__tool_result` | `{ type, toolResult: { id, output: unknown, isError?: boolean }, durationMs: number }` | After handler returns (or after decline — see below). |
| `core__chat__tool_loop_exceeded` | `{ type, iterations: 10 }` | Emitted when the 10-iteration tool-loop cap is hit (before `core__chat__complete`). |
| `core__chat__elicitation` | `{ type, elicitation: { id, tool_use_id, tool_name, title, message, summary_items } }` | Before executing a destructive tool. |
| `core__chat__elicitation_timeout` | `{ type, elicitation_id: string }` | Emitted when the 300s elicitation wait times out without a client response. Client renders "Timed out — re-run the action" error. |
| `core__chat__message` | `{ type, message: PersistedMessage }` | User message echoed back (post-persist) and final assistant message on turn completion. |
| `core__chat__complete` | `{ type }` | End of a stream, success or error. |
| `core__chat__error` | `{ type, error: string }` | Claude API error, bridge error, or unhandled exception inside `_stream_response`. Followed by `core__chat__complete`. |
| `core__chat__halted` | `{ type, reason: "interrupted_by_user" }` | `_stream_response` was cancelled mid-flight (new user message or explicit `core__chat__stop`). Followed by `core__chat__complete`. |
| `core__chat__pong` | `{ type }` | Reply to a client `core__chat__ping`. |

Plus three non-chat side-channel events documented in `chat-client.ts` but emitted by other backend paths that share the same WS (`mix_render_request`, `bounce_audio_request`, `master_bus_effects_changed`) — **out of scope** for this spec.

### WS messages — client → server

| `type` | Shape | Semantics |
|---|---|---|
| `core__chat__message` | `{ type, content: string, images?: string[] }` | New user turn. Halts any in-flight stream, persists the user message, starts a new `_stream_response` task. |
| `core__chat__elicitation_response` | `{ type, id: string, action: "accept" \| "decline" }` | Resolves the elicitation future keyed by `id`. |
| `core__chat__stop` | `{ type }` | Explicit halt of in-flight stream. Same persistence semantics as a new user `core__chat__message`. |
| `core__chat__ping` | `{ type }` | Liveness probe. |

Invalid JSON from the client → server sends `{ type: "core__chat__error", error: "Invalid JSON" }` and continues the read loop.

### Elicitation request payload (`core__chat__elicitation` event)

```json
{
  "id": "elic_<12-hex>",
  "tool_use_id": "<Claude tool_use id>",
  "tool_name": "<tool name>",
  "title": "<humanized tool name, e.g. 'Delete · Keyframe'>",
  "message": "<short confirmation question>",
  "summary_items": ["line 1", "line 2", ...]
}
```

For seven specific tools — `delete_keyframe`, `delete_transition`, `batch_delete_keyframes`, `batch_delete_transitions`, `generate_keyframe_candidates`, `generate_transition_candidates`, `restore_checkpoint`, `isolate_vocals__run` — `summary_items` is a **rich preview** (entity id, prompt snippet, cost estimate, ETA). For any other destructive tool it is a generic key/value dump of the tool's input (first 12 keys, values truncated to ~160 chars).

Enrichment failure falls through to the generic formatter (never raises).

### Handler context for plugin tools

When `_execute_tool` dispatches a plugin-namespaced tool, the handler is called as `handler(input_data, context)` with:

```python
context = {
  "project_dir": Path,
  "project_name": str | None,
  "ws": ServerConnection | None,
  "tool_use_id": str | None,
}
```

A handler MUST return a `dict`. Any exception is translated to `{"error": f"{type(exc).__name__}: {exc}"}` + `is_error=True`. A non-dict return is translated to `{"error": "plugin tool {name!r} returned non-dict: ..."}` + `is_error=True`. `is_error` is set to `"error" in result`.

---

## Requirements

1. **R1 — Tool list shape**. Every entry merged into `tools_for_claude` MUST have exactly `name`, `description`, `input_schema` keys. Plugin entries get `name = t.full_name`. MCP bridge entries are passed through unchanged.

2. **R2 — Source ordering**. Merge order for each `_stream_response` call MUST be: `TOOLS` (built-ins), then `PluginHost.list_mcp_tools()`, then `bridge.all_tools()`. The list is re-materialized on every outer iteration? **No** — it is materialized once per `_stream_response` call and reused across the 10-iteration loop.

3. **R3 — History window**. The Claude `messages` array MUST be built from at most the last 50 persisted messages (`_get_messages(..., limit=50)`), converted via `_history_to_claude_messages` (which splits assistant blocks at each `tool_use` boundary and injects synthetic `core__chat__tool_result` messages from the `tool_calls` column).

4. **R4 — Tool loop cap**. `_stream_response` MUST cap Claude's tool-use turns at **10 iterations per user message**. Exit conditions: (a) Claude's `stop_reason != "tool_use"`, (b) Claude returned no `tool_use` blocks this turn, or (c) loop counter reaches 10.

5. **R5 — `core__chat__tool_call` emission**. On `content_block_start` for a `tool_use` block, emit exactly one `core__chat__tool_call` event per tool_use id (tracked via `announced_tool_ids` set). `input` in the event is `{}` — the final input is carried in the final message and surfaced via `core__chat__tool_result`.

6. **R6 — Destructive classifier**. `_is_destructive(name)` MUST return `True` iff (a) `name` is not in the allowlist AND (b) the plugin flag says so (for `__`-namespaced tools with a registered plugin tool) OR any pattern substring appears in the lowercased name. `"__"` in the name without a registered plugin tool falls through to pattern matching.

7. **R7 — Allowlist wins**. `_DESTRUCTIVE_TOOL_ALLOWLIST` MUST override substring patterns. `generate_dsp` MUST NOT be gated by the `"generate_"` pattern.

8. **R8 — Plugin flag authoritative**. For a plugin tool registered in `PluginHost`, the plugin's declared `destructive: bool` MUST override substring matching against its name.

9. **R9 — Elicitation round-trip**. Before a destructive tool handler is invoked, the stream MUST:
   - Generate `elic_<uuid.uuid4().hex[:12]>`.
   - Emit an `core__chat__elicitation` event with `id`, `tool_use_id`, `tool_name`, humanized `title`, `message`, `summary_items`.
   - Create an `asyncio.Future`, register it in the `elicitation_waiters` dict keyed by the elicitation id.
   - Await the future with `asyncio.wait_for(..., timeout=300)`.
   - On completion, pop the future from the dict.

10. **R10 — Accept path**. If the resolved action equals `"accept"`, execute the tool normally (bridge if `bridge.has_tool(name)` else `_execute_tool`), emit `core__chat__tool_result` with the real output and `durationMs`, record a `tool_calls_log` entry.

11. **R11 — Decline path**. If the resolved action is anything other than `"accept"` (including `"decline"`, timeout, cancellation), emit `core__chat__tool_result` with `output = {"error": "cancelled by user"}`, `isError: true`, `durationMs: 0`; append a `core__chat__tool_result` block with the same error to `tool_result_blocks`; record a `tool_calls_log` entry with `cancelled: true` and `is_error: true`. The tool handler MUST NOT run.

12. **R12 — Elicitation timeout = decline**. `_recv_elicitation_response` MUST return `"decline"` on `asyncio.TimeoutError` (300s). `asyncio.CancelledError` MUST be re-raised (not swallowed).

13. **R13 — Single-reader WS pattern**. Only `handle_chat_connection`'s main `async for raw in ws:` loop reads WS frames. Elicitation responses are routed to the waiting stream task through the shared `elicitation_waiters` futures dict. `_stream_response` MUST NOT call `ws.recv()` directly.

14. **R14 — Stale elicitation response**. An `core__chat__elicitation_response` whose `id` no longer appears in `elicitation_waiters` MUST be silently dropped (stream was cancelled / timed out). No error is surfaced.

15. **R15 — Plugin-namespaced dispatch**. If `"__" in name`, `_execute_tool` MUST look up `PluginHost.get_mcp_tool(name)` FIRST and dispatch through the plugin handler if found. Only if not found does it fall through to the built-in switch (which will then return `{"error": f"unknown tool: {name}"}`).

16. **R16 — Bridge precedence in stream**. In `_stream_response`, for non-declined tools, the bridge is consulted first: `if bridge and bridge.has_tool(name)` → `bridge.call_tool(...)`, else `_execute_tool(...)`. Built-in tools therefore cannot be shadowed by bridge tools unless the bridge claims the exact same name (undefined behavior — see Open Questions).

17. **R17 — `core__chat__tool_result` always emitted**. For every `tool_use` block Claude produced this turn, exactly one `core__chat__tool_result` event MUST be emitted (accept path: real result; decline path: `{"error": "cancelled by user"}`), in the order Claude emitted them. No tool is silently skipped.

18. **R18 — History feed-back**. After executing all of a turn's tool uses, `_stream_response` MUST append to `messages`: (a) one assistant message with `content = [...blocks]` from `final.content`, (b) one user message with `content = tool_result_blocks`, and then loop.

19. **R19 — Persist at end of turn**. On successful completion, persist one assistant row via `_add_message`. If any non-text block is present, `content` is persisted as JSON-stringified `all_blocks`; otherwise it is persisted as the concatenated text. `tool_calls_log` is persisted on the `tool_calls` column (or omitted if empty).

20. **R20 — Persist on interruption**. If `_stream_response` is cancelled (user sent a new message mid-flight, or client sent `core__chat__stop`), any streamed text for the current turn is appended to `all_blocks`, and the partial is persisted via `_add_message`. A `message` event with `interrupted: true`, then `core__chat__halted` (`reason: "interrupted_by_user"`), then `core__chat__complete` are sent, and `CancelledError` is re-raised. Partial persistence MUST NOT raise — any failure there is logged, not propagated.

21. **R21 — Error emission**. On `anthropic.APIError` or any other exception inside `_stream_response`, emit `error` (with the message) followed by `core__chat__complete`. No `core__chat__halted` in this path.

22. **R22 — Connection teardown**. When the WS closes, `handle_chat_connection` MUST cancel the current stream (so R20 runs) and close the MCP bridge. Any exceptions from those two steps are logged, not propagated.

23. **R23 — API key missing**. If `ANTHROPIC_API_KEY` is not set, `_stream_response` MUST emit `error` + `core__chat__complete` and return without calling Claude. Same for missing `anthropic` SDK import.

24. **R24 — Frontend accept/decline**. On accept or decline click in `ChatPanel`, the panel MUST send `{ type: "core__chat__elicitation_response", id, action }` over the WS and mark the in-flight elicitation block's resolution as `"accepted"` or `"declined"` locally (optimistic, does NOT wait for the server).

25. **R25 — Frontend tool badge lifecycle**. A `core__chat__tool_call` event inserts a `tool_use` streaming block with `status: "pending"`. `core__chat__tool_progress` updates its `progress`. `core__chat__tool_result` sets `status` to `"success"` (if `!isError`) or `"error"` (if `isError`), and clears `progress`. On non-error tool results the panel calls `onMutation?.()` so Timeline and panels refetch.

26. **R26 — Frontend ping cadence**. `core__chat__ping` is consumed (server replies `core__chat__pong`) but the current frontend client does NOT send any pings automatically. Reconnect logic uses browser WS close events; reconnect backoff is `min(2000 * 2^attempt, 5000) ms`, capped at 5 attempts.

27. **R27 — Elicitation timeout distinguished from decline**. On 300s timeout without a client response, the backend MUST emit `{type: "core__chat__elicitation_timeout", elicitation_id}` (NOT a `core__chat__tool_result` with `"cancelled by user"`). Client renders a "Timed out — re-run the action" error card. Decline action still produces `core__chat__tool_result` with `{"error": "cancelled by user"}` per R11. This lets the UI distinguish user-decline from server-timeout.

28. **R28 — Stale elicitation response dropped silently**. Backend validates `elicitation_response.id` against `elicitation_waiters` keys. If the id is not a live waiter (already resolved, already timed out), the response is silently dropped with a DEBUG log. No WS error is emitted.

29. **R29 — Tool loop cap emits event**. When the 10-iteration tool loop cap is hit, the backend MUST emit `{type: "core__chat__tool_loop_exceeded", iterations: 10}` BEFORE `core__chat__complete`. Client renders "Tool loop exceeded 10 iterations — Claude stopped mid-thought. Continue?" error. The stream does NOT silently exit.

30. **R30 — Tool name precedence**. Plugin-namespaced tools (`plugin__*`) take priority over built-ins; built-ins take priority over bridge (Remember MCP) tools. If a bridge tool name collides with a built-in, the bridge tool is hidden from the merged tool list with a log warning; built-in wins. If a plugin tool name collides with a built-in (only possible if the plugin manifest bypasses the `__` invariant), the plugin entry wins and a WARNING is logged.

31. **R31 — WS disconnect mid-tool per INV-4/INV-5**. Per INV-4 (unified WS) and INV-5 (multi-window), WS reconnect resumes job tracking via `core__job__*` event namespace. In-flight generation jobs survive disconnect (existing invariant). Pending elicitations are NOT automatically resumed server-side; client surfaces "Connection lost — re-run the action" per chat-panel OQ-1.

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | Stream advertises tool list to Claude | Merged list `[TOOLS..., plugin_tools..., bridge_tools...]` with `{name, description, input_schema}` shape | `advertises-merged-tool-list`, `tool-entries-have-three-keys` |
| 2 | User message triggers stream with 50-msg history | `_get_messages(limit=50)` loaded, converted via `_history_to_claude_messages`, passed to Claude | `history-window-50`, `history-splits-on-tool-use` |
| 3 | Claude emits text_delta | `core__chat__chunk` event emitted with the delta text | `emits-chunk-on-text-delta` |
| 4 | Claude emits non-destructive tool_use | `core__chat__tool_call` event emitted once; handler runs; `core__chat__tool_result` emitted with real output | `non-destructive-tool-runs-without-elicitation` |
| 5 | Claude emits destructive tool_use, user accepts | `core__chat__tool_call` + `core__chat__elicitation` emitted; handler runs on accept; `core__chat__tool_result` with real output | `destructive-accept-runs-handler` |
| 6 | Claude emits destructive tool_use, user declines | `core__chat__tool_call` + `core__chat__elicitation` emitted; handler does NOT run; `core__chat__tool_result` has `{"error": "cancelled by user"}`, `isError: true`, `durationMs: 0`; `tool_calls_log` row marked `cancelled: true` | `destructive-decline-does-not-run`, `decline-emits-cancelled-tool-result` |
| 7 | Tool in allowlist but matches destructive pattern | Classifier returns False; no elicitation; handler runs | `allowlist-overrides-pattern` (covers R7) |
| 8 | Plugin tool with `destructive: true` flag | Classifier returns True; elicitation emitted before handler | `plugin-destructive-flag-triggers-elicitation` |
| 9 | Plugin tool with `destructive: false` flag, name contains "delete" | Classifier returns False (plugin flag wins over pattern match); no elicitation | `plugin-flag-overrides-substring-pattern` |
| 10 | Plugin-namespaced tool dispatched | `_execute_tool` routes to `PluginHost.get_mcp_tool` handler; context dict passed; dict result wrapped | `plugin-namespaced-dispatch` |
| 11 | Plugin handler raises | `_execute_tool` returns `{"error": "<Exc>: <msg>"}` with `is_error=True`; stream emits `core__chat__tool_result` with `isError: true` | `plugin-handler-exception-becomes-tool-result-error` |
| 12 | Plugin handler returns non-dict | `_execute_tool` returns error dict; `is_error=True` | `plugin-handler-non-dict-is-error` |
| 13 | Unknown built-in tool name | `_execute_tool` returns `{"error": "unknown tool: <name>"}`, `is_error=True` | `unknown-tool-errors` |
| 14 | Tool loop hits 10 iterations | After 10th outer loop the stream exits, persists, emits `message` + `core__chat__complete` | `ten-iteration-cap` |
| 15 | Claude returns `stop_reason != "tool_use"` | Loop exits early; persist + `message` + `core__chat__complete` | `early-exit-on-stop-reason` |
| 16 | User sends new `message` mid-generation | In-flight stream cancelled; partial persisted as assistant message with `interrupted: true`; `core__chat__halted` + `core__chat__complete` emitted; new stream starts | `interrupt-by-new-message-persists-partial` |
| 17 | Client sends `core__chat__stop` message | Same as scenario 16 but no new stream starts | `explicit-stop-persists-partial` |
| 18 | Client sends invalid JSON | Server replies `{type:"core__chat__error", error:"Invalid JSON"}` and continues read loop | `invalid-json-does-not-kill-ws` |
| 19 | Client sends `core__chat__ping` | Server replies `{type:"core__chat__pong"}` | `ping-pong` |
| 20 | Elicitation response matches a live waiter | Future resolved with action; `_recv_elicitation_response` returns normalized `"accept"` / `"decline"` | `elicitation-response-resolves-future` |
| 21 | Elicitation response after waiter is gone (stream cancelled) | Dropped silently; no error | `stale-elicitation-response-dropped` |
| 22 | Elicitation response with action other than "accept" | Treated as decline | `non-accept-action-is-decline` |
| 23 | ANTHROPIC_API_KEY missing | `error` + `core__chat__complete` emitted; no Claude call | `no-api-key-errors-cleanly` |
| 24 | Claude API raises | `error` (with message) + `core__chat__complete` emitted | `api-error-surfaces-to-client` |
| 25 | WS disconnects cleanly | In-flight stream cancelled, partial persisted, bridge closed | `disconnect-cleans-up` |
| 26 | `core__chat__tool_result` fires `onMutation` on frontend | Non-error tool_result → `onMutation?.()` called; error → not called | `on-mutation-fires-on-success-only` |
| 27 | Frontend accept click | Sends `core__chat__elicitation_response` with `action:"accept"`; local block marked `accepted` | `frontend-accept-sends-ws-and-updates-ui` |
| 28 | Frontend decline click | Sends `core__chat__elicitation_response` with `action:"decline"`; local block marked `declined` | `frontend-decline-sends-ws-and-updates-ui` |
| 29 | Two tool_uses in a single turn, one destructive | First gated / second not; both get `core__chat__tool_result` in order | `mixed-turn-preserves-order` |
| 30 | Enrichment formatter raises for known destructive tool | Falls through to generic key/value summary; elicitation still emitted | `enrichment-failure-falls-through` |
| 31 | Client sends no elicitation response for 300s | Backend emits `core__chat__elicitation_timeout` event (not a tool_result); client shows timeout error card | `elicitation-timeout-emits-distinct-event` (covers R27, OQ-1) |
| 32 | WS disconnects while tool handler is executing | Unified WS reconnect resumes tool tracking via `core__job__*`; in-flight jobs survive; elicitation resumption handled by client | `ws-disconnect-tool-survival` (covers R31, OQ-2) |
| 33 | Elicitation response arrives AFTER tool_result already emitted (race) | Stale response silently dropped with DEBUG log; no error surfaced | `stale-elicitation-response-silently-dropped` (covers R28, OQ-3) |
| 34 | Tool loop exceeds 10 iterations because Claude keeps calling tools | Backend emits `core__chat__tool_loop_exceeded` before `core__chat__complete` | `tool-loop-exceeded-emits-event` (covers R29, OQ-4) |
| 35 | Built-in tool name shadowed by plugin tool with same name | Plugin wins; WARNING logged (only possible if plugin bypasses `__` invariant) | `plugin-tool-shadows-builtin` (covers R30, OQ-5) |
| 36 | Bridge tool name collides with built-in | Bridge tool hidden from merged list with log warning; built-in wins | `bridge-collision-hidden` (covers R30, OQ-6) |

---

## Behavior (step-by-step)

### Connection lifecycle (`handle_chat_connection`)

1. On WS connect: instantiate `MCPBridge`, kick off `bridge.connect("remember", user_id=user_id)` as a background task (fire-and-forget — cannot block the read loop).
2. Initialize `current_stream: asyncio.Task | None = None` and `elicitation_waiters: dict[str, asyncio.Future] = {}`.
3. Enter `async for raw in ws:` read loop. This is the **only** consumer of WS frames for this connection.
4. Parse JSON. Invalid → emit `{type:"core__chat__error", error:"Invalid JSON"}` and continue.
5. Branch on `type`:
   - `message`: halt any `current_stream` (`cancel()` + `await`), persist the user message via `_add_message`, echo a `message` event back, then create `current_stream = asyncio.create_task(_stream_response(...))`.
   - `core__chat__elicitation_response`: pop `elicitation_waiters[id]` (if present) and set its result to `action`. If no waiter, drop silently.
   - `core__chat__stop`: halt `current_stream`.
   - `core__chat__ping`: reply `{type:"core__chat__pong"}`.
6. On WS close / exception: halt `current_stream`, close bridge, return. Log everything.

### Stream (`_stream_response`)

1. Check `ANTHROPIC_API_KEY` — missing → emit `error` + `core__chat__complete`, return.
2. Import `anthropic` — missing → emit `error` + `core__chat__complete`, return.
3. Load history (50 msgs), convert to Claude shape, build system prompt.
4. Merge `tools_for_claude = list(TOOLS) + plugin_contributed + mcp_tools`.
5. Initialize `all_blocks = []`, `tool_calls_log = []`, `announced_tool_ids = set()`, `streamed_text_this_turn = ""`.
6. For `i in range(10)`:
   - Reset `streamed_text_this_turn = ""`.
   - Open `client.messages.stream(model="claude-sonnet-4-20250514", max_tokens=4096, system=..., messages=..., tools=tools_for_claude)`.
   - Iterate events:
     - `content_block_start` with `type=="tool_use"` → if new id, add to `announced_tool_ids`, emit `core__chat__tool_call` with empty input.
     - `content_block_delta` with `type=="text_delta"` → append to `streamed_text_this_turn`, emit `core__chat__chunk`.
   - `final = await stream.get_final_message()`; clear `streamed_text_this_turn`.
   - Append `final.content` blocks (text / tool_use) to `all_blocks`.
   - Collect `turn_tool_uses`.
   - If `final.stop_reason != "tool_use"` or `not turn_tool_uses`: break.
   - For each tool_use `tu`:
     - If `_is_destructive(tu["name"])`:
       - Build `elic_id`, `title`, `message`, `summary_items`.
       - Emit `core__chat__elicitation`.
       - `action = await _recv_elicitation_response(elicitation_waiters, elic_id, timeout=300)`.
       - If `action != "accept"`: emit `core__chat__tool_result` with `cancel_result`, append `core__chat__tool_result` block with `is_error: true`, append cancelled row to `tool_calls_log`, continue.
     - `t0 = time.monotonic()`.
     - Dispatch: `bridge.call_tool(name, input)` if `bridge.has_tool(name)`; else `_execute_tool(project_dir, name, input, ws=ws, tool_use_id=tu["id"], project_name=project_name)`.
     - `dt_ms = int((time.monotonic() - t0) * 1000)`.
     - Emit `core__chat__tool_result` with result, `isError`, `durationMs`.
     - Append `core__chat__tool_result` block to `tool_result_blocks`, append row to `tool_calls_log`.
   - Append to `messages`: `{"role":"assistant", "content":[_block_to_dict(b) for b in final.content]}`, then `{"role":"user", "content":tool_result_blocks}`.
7. After loop: persist assistant row (JSON content if any non-text block present, else concatenated text), emit `message` + `core__chat__complete`.

### Dispatch (`_execute_tool`)

1. `input_data = input_data or {}`.
2. If `"__" in name` → look up `PluginHost.get_mcp_tool(name)`; if found, call `handler(input_data, context)`, wrap exceptions, validate dict return, return `(result, "error" in result)`.
3. Otherwise, fall through to a large `if/elif` switch on `name` that routes to `_exec_*` synchronous DB helpers or to `_await_generation_job` for `generate_*` / `isolate_vocals__run` / `generate_foley`.
4. Unknown name → `({"error": f"unknown tool: {name}"}, True)`.

### Destructive classifier (`_is_destructive`)

See R6–R8 for exact rules.

### Elicitation waiter (`_recv_elicitation_response`)

1. Create future, register in `waiters[elic_id]`.
2. `await asyncio.wait_for(fut, timeout=300)`.
3. `asyncio.TimeoutError` → log, return `"decline"`.
4. `asyncio.CancelledError` → re-raise.
5. In `finally`, `waiters.pop(elic_id, None)`.
6. Return `"accept"` iff action == `"accept"`, else `"decline"`.

---

## Acceptance Criteria

- [ ] Merged tool list has exactly three keys per entry and merge order TOOLS → plugin → bridge.
- [ ] `_is_destructive` behaves per R6–R8 with table-driven coverage.
- [ ] Destructive tool use always emits `core__chat__elicitation` before running.
- [ ] Decline path emits a synthetic `core__chat__tool_result` with `{"error":"cancelled by user"}` and marks `cancelled:true` in the persisted `tool_calls` row.
- [ ] Plugin-namespaced tools dispatch through `PluginHost.get_mcp_tool` in both the destructive classifier and `_execute_tool`.
- [ ] Elicitation timeout of 300s → decline; `CancelledError` re-raised.
- [ ] Stale `core__chat__elicitation_response` is dropped silently.
- [ ] 10-iteration tool loop cap is observed.
- [ ] 50-message history window is used in every stream call.
- [ ] User interrupt persists partial assistant content with `interrupted:true`.
- [ ] WS close halts the stream and closes the bridge without raising.
- [ ] Frontend `handleMessage` updates `StreamingBlock[]` per R25; `respondElicitation` sends the right WS frame per R24.
- [ ] Every behavior-table row with a named test has a matching `#### Test:` in the Tests section.
- [ ] Every `undefined` row has a matching Open Question.

---

## Tests

### Base Cases

The core dispatch contract: merged registry, tool_use round-trip, destructive gate, decline short-circuit, persistence.

#### Test: advertises-merged-tool-list (covers R1, R2)

**Given**: A chat stream starts with 3 built-in tools, 2 registered plugin tools, and 1 MCP bridge tool.
**When**: `_stream_response` calls `client.messages.stream(...)`.
**Then**:
- **call-arg-tools-count**: `tools` kwarg has length 6.
- **call-arg-order**: entries appear in order [built-ins..., plugin..., bridge...].
- **plugin-full-name**: plugin entry's `name` equals `{plugin_id}__{tool_id}`.

#### Test: tool-entries-have-three-keys (covers R1)

**Given**: Merged tool list from scenario above.
**When**: Inspect every entry.
**Then**:
- **keys-exact**: each entry has exactly the keys `{name, description, input_schema}` (no extras).

#### Test: history-window-50 (covers R3)

**Given**: The project has 120 persisted chat messages.
**When**: A user sends a new message.
**Then**:
- **history-loaded-50**: `_get_messages` is called with `limit=50`.
- **messages-sent-to-claude**: `messages` passed to Claude contains only the mapped result of those 50 rows (plus injected tool_result messages).

#### Test: history-splits-on-tool-use (covers R3)

**Given**: An assistant row in history has content `[text, tool_use, text]` with a matching `tool_calls` entry.
**When**: `_history_to_claude_messages` runs.
**Then**:
- **split-at-tool-use**: output contains an assistant message ending at the `tool_use` block, a synthetic user `core__chat__tool_result` message, then another assistant message with the trailing text.

#### Test: emits-chunk-on-text-delta (covers R5 implicitly)

**Given**: Claude stream yields a `content_block_delta` with `text_delta.text = "hi"`.
**When**: `_stream_response` handles the event.
**Then**:
- **chunk-sent**: a WS frame `{type:"chunk", content:"hi"}` is sent.

#### Test: non-destructive-tool-runs-without-elicitation (covers R4, R17)

**Given**: Claude emits a single `tool_use` for `sql_query` (non-destructive).
**When**: The turn completes.
**Then**:
- **tool-call-emitted**: exactly one `core__chat__tool_call` event was sent for this id.
- **no-elicitation**: no `core__chat__elicitation` event was sent.
- **handler-called**: `_execute_tool` ran with the provided input.
- **tool-result-emitted**: exactly one `core__chat__tool_result` event with the handler's output and `isError:false`.
- **duration-present**: `durationMs` field is an integer ≥ 0.

#### Test: destructive-accept-runs-handler (covers R9, R10)

**Given**: Claude emits a `tool_use` for `delete_keyframe`.
**When**: Server sends `core__chat__elicitation`; client responds `{action:"accept"}`.
**Then**:
- **elicitation-emitted**: `core__chat__elicitation` event sent with `id`, `tool_use_id`, `tool_name`, `title` (humanized), `message`, `summary_items`.
- **handler-ran**: the `delete_keyframe` handler was called with the provided input.
- **tool-result-real**: `core__chat__tool_result` emitted with handler's actual output.
- **log-not-cancelled**: `tool_calls_log` entry has no `cancelled:true`.

#### Test: destructive-decline-does-not-run (covers R11)

**Given**: Claude emits a `tool_use` for `delete_keyframe`.
**When**: Client responds `{action:"decline"}`.
**Then**:
- **handler-not-called**: the `delete_keyframe` handler is never invoked.
- **log-cancelled**: the `tool_calls_log` row has `cancelled:true`, `is_error:true`, `duration_ms:0`.

#### Test: decline-emits-cancelled-tool-result (covers R11, R17)

**Given**: Same as above.
**When**: The turn continues past the decline.
**Then**:
- **tool-result-error**: a `core__chat__tool_result` event was emitted with `output:{"error":"cancelled by user"}`, `isError:true`, `durationMs:0`.
- **history-block-appended**: a `core__chat__tool_result` block with `is_error:true` was appended to `tool_result_blocks` so Claude sees the cancellation next iteration.

#### Test: plugin-namespaced-dispatch (covers R15)

**Given**: A registered plugin tool `foo__bar` with handler `h`.
**When**: `_execute_tool(project_dir, "foo__bar", {"x":1}, ws=ws, tool_use_id="t", project_name="p")`.
**Then**:
- **handler-called-with-context**: `h` was called with `({"x":1}, {"project_dir":..., "project_name":"p", "ws":ws, "tool_use_id":"t"})`.
- **result-returned**: the handler's dict return flows back with `is_error = "error" in result`.

#### Test: plugin-handler-exception-becomes-tool-result-error (covers R15)

**Given**: Plugin handler raises `RuntimeError("boom")`.
**When**: `_execute_tool` dispatches.
**Then**:
- **error-dict**: returns `({"error":"RuntimeError: boom"}, True)`.

#### Test: plugin-handler-non-dict-is-error (covers R15)

**Given**: Plugin handler returns `"ok"` (not a dict).
**When**: `_execute_tool` dispatches.
**Then**:
- **error-dict**: returns an error dict with `is_error=True`, message mentions `non-dict`.

#### Test: unknown-tool-errors (covers R15)

**Given**: Tool name `nonexistent_tool`, no plugin match, no built-in match.
**When**: `_execute_tool` runs.
**Then**:
- **unknown-error**: returns `({"error":"unknown tool: nonexistent_tool"}, True)`.

#### Test: allowlist-overrides-pattern (covers R7)

**Given**: Tool name `generate_dsp`.
**When**: `_is_destructive` runs.
**Then**:
- **returns-false**: returns `False` despite the `"generate_"` substring.

#### Test: plugin-destructive-flag-triggers-elicitation (covers R6, R8)

**Given**: Plugin tool `safe__zap` registered with `destructive=True`.
**When**: Claude calls it.
**Then**:
- **elicitation-emitted**: `core__chat__elicitation` event is sent before the handler runs.

#### Test: plugin-flag-overrides-substring-pattern (covers R8)

**Given**: Plugin tool `foo__delete_thing` registered with `destructive=False`.
**When**: `_is_destructive("foo__delete_thing")` runs.
**Then**:
- **returns-false**: returns `False` (plugin flag wins despite `"delete"` substring).

#### Test: elicitation-response-resolves-future (covers R9, R13)

**Given**: A pending elicitation future registered for `id="elic_abc"`.
**When**: Client sends `{type:"core__chat__elicitation_response", id:"elic_abc", action:"accept"}`.
**Then**:
- **future-set**: the future resolves with `"accept"`.
- **returned-normalized**: `_recv_elicitation_response` returns `"accept"`.
- **waiter-removed**: `elicitation_waiters` no longer contains `"elic_abc"`.

#### Test: stale-elicitation-response-dropped (covers R14)

**Given**: Client sends an `core__chat__elicitation_response` with an id not present in `elicitation_waiters`.
**When**: The read loop processes it.
**Then**:
- **no-error-emitted**: no WS `error` event sent.
- **loop-continues**: the loop still accepts subsequent frames.

#### Test: non-accept-action-is-decline (covers R11, R12)

**Given**: Client sends `action:"maybe"` to a live waiter.
**When**: `_recv_elicitation_response` resolves.
**Then**:
- **normalized-to-decline**: returns `"decline"`.
- **handler-not-run**: tool is not executed.

#### Test: early-exit-on-stop-reason (covers R4)

**Given**: Claude's first turn returns `stop_reason: "end_turn"` and no tool_uses.
**When**: The loop completes one iteration.
**Then**:
- **loop-exits**: no further `messages.stream(...)` calls.
- **persisted**: assistant row persisted.
- **complete-emitted**: `core__chat__complete` event sent.

#### Test: ten-iteration-cap (covers R4)

**Given**: Claude keeps returning `stop_reason: "tool_use"` with one `tool_use` per turn, indefinitely.
**When**: `_stream_response` runs.
**Then**:
- **stream-calls-ten**: exactly 10 `client.messages.stream(...)` calls are made.
- **persisted**: assistant row persisted with all 10 turns' blocks.
- **complete-emitted**: `core__chat__complete` sent.

#### Test: mixed-turn-preserves-order (covers R17)

**Given**: Claude emits `[tool_use_A (destructive), tool_use_B (non-destructive)]` in one turn.
**When**: User accepts A.
**Then**:
- **order-preserved**: WS events include a `core__chat__tool_result` for A before a `core__chat__tool_result` for B.
- **both-persisted**: `tool_calls_log` has rows for both, in order.

#### Test: interrupt-by-new-message-persists-partial (covers R20)

**Given**: `_stream_response` has streamed "partial " and is awaiting an elicitation.
**When**: The client sends a new `message` and `handle_chat_connection` cancels the stream.
**Then**:
- **partial-persisted**: an assistant row with content `"partial "` (or blocks ending in a `text` block with that text) exists.
- **interrupted-flag**: the emitted `message` event has `interrupted:true`.
- **halted-emitted**: `core__chat__halted` event with `reason:"interrupted_by_user"` sent.
- **complete-emitted**: `core__chat__complete` sent.

#### Test: explicit-stop-persists-partial (covers R20)

**Given**: `_stream_response` mid-flight; client sends `{type:"core__chat__stop"}`.
**When**: The read loop handles it.
**Then**:
- **partial-persisted**: same as above.
- **no-new-stream**: no new `_stream_response` task is created.

#### Test: invalid-json-does-not-kill-ws (covers R22 implicitly)

**Given**: Client sends `"not json"`.
**When**: Read loop parses it.
**Then**:
- **error-emitted**: `{type:"core__chat__error", error:"Invalid JSON"}` sent.
- **loop-continues**: the next valid frame is still processed.

#### Test: ping-pong

**Given**: Client sends `{type:"core__chat__ping"}`.
**When**: Read loop handles it.
**Then**:
- **pong-sent**: `{type:"core__chat__pong"}` frame emitted.

#### Test: no-api-key-errors-cleanly (covers R23)

**Given**: `ANTHROPIC_API_KEY` unset in env.
**When**: `_stream_response` is invoked.
**Then**:
- **error-emitted**: `{type:"core__chat__error", error:"ANTHROPIC_API_KEY not configured on server"}`.
- **complete-emitted**: `core__chat__complete` follows.
- **no-claude-call**: `client.messages.stream` never called.

#### Test: api-error-surfaces-to-client (covers R21)

**Given**: Claude SDK raises `anthropic.APIError` mid-stream.
**When**: `_stream_response` catches it.
**Then**:
- **error-emitted**: `{type:"core__chat__error", error:"Claude API error: <msg>"}`.
- **complete-emitted**: `core__chat__complete` follows.
- **no-halted**: no `core__chat__halted` frame.

#### Test: disconnect-cleans-up (covers R22)

**Given**: An in-flight `_stream_response` and an open bridge.
**When**: The WS closes (exits `async for` loop).
**Then**:
- **stream-cancelled**: the stream task is cancelled (partial persisted per R20).
- **bridge-closed**: `bridge.close()` was called.
- **no-exception-propagated**: `handle_chat_connection` returns cleanly.

#### Test: on-mutation-fires-on-success-only (covers R25)

**Given**: Frontend receives two successive `core__chat__tool_result` events, one `isError:false`, one `isError:true`.
**When**: `handleMessage` runs for each.
**Then**:
- **mutation-called-once**: `onMutation` is called exactly once (for the non-error one).

#### Test: frontend-accept-sends-ws-and-updates-ui (covers R24)

**Given**: A pending elicitation block with `id="elic_1"` and `resolution:"pending"`.
**When**: User clicks Accept.
**Then**:
- **ws-frame**: `ws.send({type:"core__chat__elicitation_response", id:"elic_1", action:"accept"})` was called.
- **local-resolution**: the streaming block's resolution becomes `"accepted"`.

#### Test: frontend-decline-sends-ws-and-updates-ui (covers R24)

**Given**: Same pending block.
**When**: User clicks Decline.
**Then**:
- **ws-frame**: `ws.send({..., action:"decline"})`.
- **local-resolution**: block becomes `"declined"`.

### Edge Cases

Boundaries, concurrency, malformed inputs, ordering, enrichment failures, allowlist corners.

#### Test: enrichment-failure-falls-through (covers R9)

**Given**: `_format_destructive_summary` raises for `delete_keyframe` (e.g. DB read fails).
**When**: The gate runs.
**Then**:
- **generic-fallback**: the `core__chat__elicitation` event is still emitted with a generic key/value `summary_items` list.
- **no-exception-propagated**: the stream continues normally.

#### Test: empty-input-dict (covers R6, R9)

**Given**: Claude emits a `tool_use` with `input: None`.
**When**: `_execute_tool` dispatches.
**Then**:
- **normalized-to-empty**: handlers receive `{}`.

#### Test: generate-dsp-not-gated (covers R7)

**Given**: Claude emits `generate_dsp`.
**When**: Stream processes it.
**Then**:
- **no-elicitation**: no `core__chat__elicitation` event sent.
- **handler-ran**: handler executed directly.

#### Test: bounce-audio-not-gated (covers R7)

**Given**: Claude emits `bounce_audio`.
**When**: Stream processes it.
**Then**:
- **no-elicitation**: no `core__chat__elicitation` event.

#### Test: multiple-tool-calls-unique-ids (covers R5)

**Given**: Claude streams the same `tool_use` id twice in `content_block_start` events (malformed stream).
**When**: Both events fire.
**Then**:
- **one-tool-call-event**: only one `core__chat__tool_call` event is emitted for that id.

#### Test: destructive-pattern-case-insensitive (covers R6)

**Given**: Tool name `DELETE_KEYFRAME` (uppercase).
**When**: `_is_destructive` runs.
**Then**:
- **returns-true**: returns `True` (classifier lowercases).

#### Test: bridge-precedence-for-non-shadowed-names (covers R16)

**Given**: Bridge has tool `remember_add_memory`; not in built-in `TOOLS`.
**When**: Claude calls `remember_add_memory`.
**Then**:
- **bridge-path**: `bridge.call_tool` was called.
- **execute-tool-not-called**: `_execute_tool` was NOT called.

#### Test: humanize-tool-name-in-title

**Given**: Tool `remember_delete_memory`.
**When**: Elicitation is built.
**Then**:
- **title**: `title = "Remember · Delete Memory"`.

#### Test: elicitation-id-format (covers R9)

**Given**: A destructive tool_use.
**When**: Elicitation is emitted.
**Then**:
- **id-prefix**: `id` starts with `elic_` and has 12 hex chars after the prefix.

#### Test: elicitation-cancelled-error-reraises (covers R12)

**Given**: `_recv_elicitation_response` is awaiting; surrounding task is cancelled.
**When**: `asyncio.CancelledError` fires.
**Then**:
- **reraised**: the function re-raises `CancelledError` (does NOT return `"decline"`).
- **waiter-removed**: `elicitation_waiters` no longer contains the id (finally block).

#### Test: enrichment-batch-delete-truncation (covers R9)

**Given**: `batch_delete_keyframes` with 25 valid ids.
**When**: `_format_destructive_summary` runs.
**Then**:
- **first-ten-previewed**: first 10 kf lines appear in `summary_items`.
- **truncation-line**: an extra line like `"… and 15 more"` is appended.

#### Test: persist-json-blocks-when-tool-uses-present (covers R19)

**Given**: An assistant turn with `[text, tool_use, tool_result_block_from_cancel]`.
**When**: Persistence runs after the loop.
**Then**:
- **json-content**: `content` column is a JSON string of `all_blocks`.
- **plain-text-otherwise**: a turn with only text blocks persists concatenated text instead.

#### Test: persist-failure-during-interrupt-does-not-raise (covers R20)

**Given**: `_add_message` raises during the interrupt-persist path.
**When**: Cancellation proceeds.
**Then**:
- **logged**: error is logged.
- **cancelled-error-still-reraised**: `CancelledError` propagates.

#### Test: bridge-unavailable-on-first-stream (covers R2)

**Given**: `bridge.all_tools()` returns `[]` (background connect not yet complete).
**When**: Stream opens.
**Then**:
- **tools-equal-builtins-plus-plugin**: merged tool list is `TOOLS + plugin_contributed` only.
- **no-error**: stream proceeds normally.

#### Test: elicitation-timeout-emits-distinct-event (covers R27, OQ-1)

**Given**: a destructive tool is awaiting elicitation; the client sends no response for 300 seconds.
**When**: the 300s timeout fires.
**Then**:
- **timeout-event-emitted**: backend emits `{type:"core__chat__elicitation_timeout", elicitation_id:<id>}`.
- **no-cancelled-tool-result**: backend does NOT emit a `core__chat__tool_result` with `"cancelled by user"` for this timeout (that shape is reserved for explicit decline).
- **client-renders-timeout**: UI shows "Timed out — re-run the action" error card rather than a cancelled-tool card.
- **waiter-cleared**: the elicitation entry is popped from `elicitation_waiters`.

#### Test: ws-disconnect-tool-survival (covers R31, OQ-2)

**Given**: an in-flight generation tool (e.g. `generate_keyframe_candidates`) dispatched via `_await_generation_job`; the client WS drops mid-job.
**When**: the client reconnects.
**Then**:
- **job-still-running**: backend worker thread continued running past the disconnect.
- **job-events-resume**: on reconnect, the unified WS emits `core__job__progress` / `core__job__completed` for the tracked job id.
- **no-server-side-resume-of-elicitation**: backend does NOT auto-re-emit pending elicitations; client is responsible for surfacing "Connection lost" per chat-panel OQ-1.

#### Test: stale-elicitation-response-silently-dropped (covers R28, OQ-3)

**Given**: an elicitation with id `elic_1` has already been resolved or timed out (popped from `elicitation_waiters`).
**When**: client sends `{type:"core__chat__elicitation_response", id:"elic_1", action:"accept"}`.
**Then**:
- **dropped-silently**: no WS error emitted.
- **debug-log**: a DEBUG-level log line notes the stale elicitation id.
- **loop-continues**: next valid frame still processed.

#### Test: tool-loop-exceeded-emits-event (covers R29, OQ-4)

**Given**: Claude returns `stop_reason:"tool_use"` with one tool_use every iteration, indefinitely.
**When**: the loop completes its 10th iteration.
**Then**:
- **exceeded-event**: backend emits `{type:"core__chat__tool_loop_exceeded", iterations:10}` BEFORE `core__chat__complete`.
- **ordered-emission**: the sequence is `…tool_result of iter 10 → core__chat__tool_loop_exceeded → core__chat__message → core__chat__complete`.
- **client-renders-error**: UI shows "Tool loop exceeded 10 iterations — Claude stopped mid-thought. Continue?".

#### Test: plugin-tool-shadows-builtin (covers R30, OQ-5)

**Given**: a plugin registers a tool with name exactly equal to a built-in (e.g. `sql_query`) — possible only by bypassing the `__` namespace invariant.
**When**: the merged tool list is computed.
**Then**:
- **plugin-wins**: the entry for `sql_query` in the final tools array is the plugin's, not the built-in's.
- **warning-logged**: a WARNING log line notes the collision and which side won.

#### Test: bridge-collision-hidden (covers R30, OQ-6)

**Given**: bridge returns a tool named `sql_query` (colliding with a built-in).
**When**: tool list is merged.
**Then**:
- **bridge-hidden**: no `sql_query` entry from the bridge appears in the final list.
- **builtin-wins**: the built-in's `sql_query` is used.
- **warning-logged**: a WARNING log line notes the hidden bridge tool.

#### Negative: single-reader-ws (covers R13)

**Given**: The running chat connection.
**When**: Searching the code paths inside `_stream_response`.
**Then**:
- **no-ws-recv**: `_stream_response` makes no call to `ws.recv()` — all elicitation responses arrive via the futures dict.

#### Negative: no-concurrent-stream-tasks (covers R4, R22)

**Given**: A user sends a second message while the first stream is mid-tool.
**When**: The second message is processed.
**Then**:
- **exactly-one-stream-running**: at any time `current_stream` points to at most one non-done task.
- **prior-halted**: the prior task was cancelled and awaited before the new one started.

---

## Non-Goals

- **Guaranteeing tool name uniqueness across sources.** Collisions between built-ins, plugin tools, and bridge tools are handled by dispatch precedence (see OQ-5, OQ-6), not rejected up front.
- **Enforcing schema validity in plugin `input_schema`.** Plugin-provided schemas flow to Claude unchanged; a malformed schema is a plugin bug.
- **Rate-limiting or authorizing individual tools.** No quota, no per-user ACL beyond the destructive gate.
- **Surfacing `core__chat__tool_progress` for non-generation tools.** Only `_await_generation_job` emits progress frames today; regular DB tools emit none.
- **Automatic retry of tool handlers.** A handler failure is reported as `core__chat__tool_result` with `isError:true` and surfaced to Claude as-is.
- **Front-end reconnect of in-flight elicitations.** If the WS drops while an elicitation is pending, the pending `StreamingBlock` is lost with the rest of `streamingBlocks` state (cleared on `core__chat__complete`). Re-opening chat history shows the persisted partial turn instead.

---

## Open Questions

### Resolved

**OQ-1 (resolved)**: Client sends no elicitation response for 300s. **Decision**: Codify current timeout behavior with a distinct event shape. On timeout, backend emits `core__chat__elicitation_timeout` (NOT a `core__chat__tool_result` with "cancelled by user"). Client renders "Timed out — re-run the action" error card so it can distinguish user-decline from server-timeout. **Tests**: `elicitation-timeout-emits-distinct-event`.

**OQ-2 (resolved)**: WS disconnect mid-tool. **Decision**: Close per INV-4 + INV-5 — unified WS reconnect resumes tool tracking via `core__job__*`; in-flight generation jobs survive disconnect per existing invariant; elicitation resume handled by chat-panel OQ-1. **Tests**: `ws-disconnect-tool-survival`.

**OQ-3 (resolved)**: Elicitation response after tool completed. **Decision**: Codify — backend validates `elicitation_id` against current waiters dict; stale responses silently dropped with DEBUG log. **Tests**: `stale-elicitation-response-silently-dropped`.

**OQ-4 (resolved)**: Tool loop cap. **Decision**: Fix — emit `core__chat__tool_loop_exceeded` event when the 10-iteration cap hits; client renders explicit error "Tool loop exceeded 10 iterations — Claude stopped mid-thought. Continue?" Don't silently exit. **Tests**: `tool-loop-exceeded-emits-event`.

**OQ-5 (resolved)**: Built-in tool name shadowed by plugin. **Decision**: Codify precedence — plugin-namespaced tools (`plugin__*`) > built-ins > bridge (Remember MCP). If a plugin tool name collides with a built-in (only possible if `__` invariant bypassed), plugin wins with WARNING log. **Tests**: `plugin-tool-shadows-builtin`.

**OQ-6 (resolved)**: Bridge tool name collides with built-in. **Decision**: Codify — bridge tool is hidden from the merged tool list with a log warning; built-in wins. **Tests**: `bridge-collision-hidden`.

---

## Related Artifacts

- **Source files**:
  - `../scenecraft-engine/src/scenecraft/chat.py`
  - `src/lib/chat-client.ts`
  - `src/components/editor/ChatPanel.tsx`
- **Audit**: `agent/reports/audit-2-architectural-deep-dive.md` §1C (units 1–5)
- **Related specs (out of scope but upstream/downstream)**:
  - `job-manager-and-ws-events` (planned) — owns `/ws/jobs`, `core__chat__tool_progress` payload origin
  - `plugin-host-and-manifest` (planned) — owns `PluginHost.list_mcp_tools` + `destructive` flag semantics
  - `plugin-api-surface-and-r9a` (planned) — handler context shape
  - Per-plugin specs (e.g. `local.music-generation-plugin.md`, `local.light-show-scene-editor.md`) — own their own tool-handler logic

---

**Namespace**: local
**Spec**: chat-tool-dispatch-and-elicitation
**Version**: 1.0.0
**Created**: 2026-04-27
**Status**: Active (retroactive)
