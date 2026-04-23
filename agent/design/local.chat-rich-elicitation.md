# Chat Rich Elicitation

**Concept**: Extend scenecraft's existing binary (accept/decline) chat elicitation to support MCP-spec rich structured input (text, number, boolean, enum) so plugins can ask typed questions mid-tool-call — not just gate destructive ops.
**Created**: 2026-04-23
**Status**: Proposal

---

## Overview

Scenecraft's chat currently supports a narrow elicitation pattern: server mid-tool-call sends `{type: "elicitation", elicitation: {...}}` with a message body, client renders it as a card with "Accept" / "Decline" buttons, server awaits `{action: "accept" | "decline"}` over the same WebSocket. Good enough for "about to run a destructive op, OK?" — insufficient for "what BPM should this stem be generated at?"

MCP spec version 2025-06-18 (still current in 2026) defines `elicitation/create` as a protocol-level pattern supporting flat JSON-Schema primitives: `string`, `number`, `integer`, `boolean`, and `enum`-string. Top-level is always an object, no nesting, no arrays-of-objects. Spec-compliant responses carry an `action` plus a typed `content` payload when accepted.

This design brings scenecraft's elicitation in line with that spec, extends the frontend renderer to produce typed form fields from a schema, and updates the server-side wire protocol to emit and validate structured responses. The existing accept/decline flow remains a degenerate case (schema with no properties, or just a boolean "confirm").

Upcoming plugins — notably the music-generation plugin in `clarification-10` — want to ask the user things like "what BPM?" and "pick a key from this list". This design is the prerequisite.

---

## Problem Statement

- **Plugins can't ask typed questions.** The current `{message, actions: [accept, decline]}` carries no schema. Anything richer requires the LLM to do multi-turn prompting via normal chat, which is slow, unreliable, and loses the tool-call context.
- **MCP interop is limited.** Third-party MCP servers that emit `elicitation/create` can't be mounted into scenecraft's chat — the protocol shapes don't match.
- **Confirmation is the wrong hammer for input.** Plugin authors end up encoding a BPM choice as "do you want to regenerate at 120 BPM? (yes/no)" which is both rude and broken if they want 125.

Out of scope for this design:
- Full MCP client implementation (transport, capability negotiation with external servers) — scenecraft's chat talks to its own server, not remote MCPs
- Rich widgets beyond spec (timeline pickers, file browsers) — spec explicitly excludes these; handle later as a separate non-spec extension
- Validation retries as a protocol flow — on validation fail, server re-emits a fresh elicitation with error hint in `message` (per spec)

---

## Solution

### Wire protocol

Extend the existing `elicitation` message shape to carry a `requestedSchema`. Responses carry typed `content` on accept.

**Server → client** (existing shape, with new optional `requestedSchema`):

```json
{
  "type": "elicitation",
  "elicitation": {
    "id": "elic_abc123",
    "message": "Pick a key and tempo for the generated stem",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "enum": ["C", "C#", "D", "Eb", "E", "F"],
          "enumNames": ["C", "C♯", "D", "E♭", "E", "F"]
        },
        "bpm": {
          "type": "integer",
          "minimum": 60,
          "maximum": 200,
          "default": 120
        },
        "sidechain_to_kick": {
          "type": "boolean",
          "default": false
        }
      },
      "required": ["key", "bpm"]
    }
  }
}
```

When `requestedSchema` is absent → degenerate to today's accept/decline card (backward compat).

**Client → server:**

```json
{
  "type": "elicitation_response",
  "id": "elic_abc123",
  "action": "accept",
  "content": { "key": "D", "bpm": 128, "sidechain_to_kick": true }
}
```

Three actions with distinct semantics:
- `accept` — user submitted; `content` validates against schema
- `decline` — user explicitly said no (e.g., "Skip" button)
- `cancel` — user dismissed / timed out without answering

Existing responses (no `content`) remain valid for schema-less elicitations.

### Schema subset

Per MCP spec:
- Top-level must be `{ type: "object", properties: {...}, required?: [...] }`
- Properties limited to primitives: `string`, `number`, `integer`, `boolean`
- `string` supports: `enum`, `enumNames`, `minLength`, `maxLength`, `pattern`, `format` (`email | uri | date | date-time`), `default`
- `number`/`integer` support: `minimum`, `maximum`, `default`
- `boolean` supports: `default`
- No nested objects, no arrays of objects, no `oneOf`/`anyOf` — spec excludes them

If a plugin wants a list, it elicits once per item (chained elicitations). If it wants nested structure, it either flattens or rethinks the interaction.

### Frontend renderer

New `<ElicitationForm schema={...} onSubmit onDecline onCancel />` component in the chat panel. Schema-driven field selection:

| Schema type | Field widget |
|---|---|
| `string` with `enum` (≤ 5 options) | radio group |
| `string` with `enum` (> 5 options) | dropdown |
| `string` with `format: date` | `<input type="date">` |
| `string` otherwise | `<input type="text">` with pattern validation |
| `integer` / `number` with bounds | `<input type="number" min max>` |
| `boolean` | `<input type="checkbox">` |

Renders inline in the chat message stream as a card that gates further assistant output, matching Claude Desktop's pattern. Three buttons at the bottom: **Submit**, **Skip** (→ decline), implicit dismiss (→ cancel on timeout or panel close).

Client-side validation on submit (pattern, min/max, required) — show inline field errors. Don't send until valid.

### Server-side

- `chat.py` gets a new helper `build_elicitation_request(message, schema)` that returns the typed payload.
- `_recv_elicitation_response` already handles the accept/decline action; extend to surface `content` on accept and distinguish `cancel` from `decline`.
- Plugin API gets a `ctx.elicit(schema, message)` async method returning the parsed `content` dict on accept, raising `ElicitationDeclined` / `ElicitationCancelled` otherwise.
- Schema validation happens server-side using `jsonschema` before handing `content` to the plugin. On validation fail: emit a fresh elicitation with error hint in `message`, don't retry the same id.

### Timeout and cancel

- Client has a configurable idle timeout (default 5 min) — on expiry, sends `{action: "cancel"}` automatically
- Server treats `cancel` as "user didn't engage" — graceful fail with no error surfaced to the LLM's context
- Server treats `decline` as "user explicitly said no" — the plugin decides whether that's an error or a normal branch
- Unmounting the chat panel during a live elicitation sends `cancel`

### Capability negotiation

Chat connection opens a `capabilities` handshake message:
- Client announces: `{ elicitation: { schemas: true } }` — "I support schema-driven elicitation"
- Server checks before sending rich elicitation; for clients without the flag, falls back to binary accept/decline (describe the request in natural language in the `message` field, ignore `content` on response)

This keeps old clients functional and new clients feature-complete.

---

## Implementation

### Files touched

**Engine (`scenecraft-engine`):**
- `src/scenecraft/chat.py` — extend `_recv_elicitation_response` to parse typed `content`; add `build_elicitation_request`; add capability check against the peer's handshake
- `src/scenecraft/plugin_api.py` (or equivalent) — add `ctx.elicit(schema, message) -> dict` (async)
- `src/scenecraft/elicitation_validator.py` (new) — thin wrapper around `jsonschema` for spec subset validation
- Tests: `tests/test_elicitation.py` — schema shapes, action dispatch, validation, timeout→cancel

**Frontend (`scenecraft`):**
- `src/lib/chat-client.ts` — extend `ElicitationRequest` type to carry `requestedSchema`; add typed `content` to the response
- `src/components/editor/ChatPanel.tsx` — route `elicitation` messages to new `<ElicitationForm>` when `requestedSchema` present, fall back to existing accept/decline buttons when absent
- `src/components/editor/ElicitationForm.tsx` (new) — schema-driven form renderer (text, number, boolean, enum widgets)
- `src/lib/elicitation-schema.ts` (new) — client-side validation mirror for inline field errors

### Backward compatibility

Elicitations without `requestedSchema` render exactly as today (accept/decline buttons). Plugins don't need to migrate. The rich form only kicks in when a plugin opts in by providing a schema.

### Example plugin usage

```python
# In a plugin
async def generate_stem(ctx, params):
    config = await ctx.elicit(
        message="How should the stem be generated?",
        schema={
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "enum": ["C", "C#", "D", "Eb", "E", "F"],
                },
                "bpm": {"type": "integer", "minimum": 60, "maximum": 200, "default": 120},
            },
            "required": ["key", "bpm"],
        },
    )
    # config is {"key": "D", "bpm": 128}; plugin runs with typed values
    return await _generate(key=config["key"], bpm=config["bpm"])
```

On decline / cancel, `ctx.elicit` raises a typed exception; the plugin decides whether to surface the error to the LLM or handle gracefully.

---

## Key Design Decisions

### Protocol

| Decision | Choice | Rationale |
|---|---|---|
| Spec alignment | MCP 2025-06-18 shape | Future-proofs for mounting external MCP servers; well-documented; real client implementations to study. |
| Schema subset | Flat primitives only | Per spec; keeps client rendering tractable; forces plugin authors toward digestible prompts. |
| Action semantics | Three-valued (accept/decline/cancel) | Decline = explicit no, cancel = didn't engage. Plugin needs to distinguish. |
| Backward compat | Elicitations without `requestedSchema` = today's accept/decline | Existing plugins don't break; no migration required. |

### UI

| Decision | Choice | Rationale |
|---|---|---|
| Render location | Inline card in chat stream | Matches Claude Desktop / Continue / VS Code — industry convention, familiar to users. |
| Gating behavior | Elicitation blocks further assistant output until resolved | Prevents the model from proceeding with stale context; matches spec expectation. |
| Field breakdown | Schema type → widget (radio/dropdown/text/number/checkbox) | Deterministic rendering; no room for plugin authors to design ad-hoc widgets. |
| Max form size | Soft-limit: 4 fields; warn in dev mode | Research shows >4 fields consistently confuses users. Plugins should chain elicitations. |
| Client-side validation | Yes (pattern, bounds, required) | Immediate feedback; reduces server round-trips. |

### Edge cases

| Case | Handling |
|---|---|
| User dismisses panel mid-elicitation | Send `cancel`, plugin continues with exception |
| Timeout (5 min idle) | Send `cancel` automatically |
| Validation fails server-side | Server emits a fresh elicitation with hint in `message`; don't retry same id |
| Schema contains unsupported shape (nested object, array) | Server returns validation error on its own schema before sending; don't send malformed to client |
| Client sends `content` that doesn't match schema | Server validates, treats as `cancel` (or sends re-elicitation) |
| Plugin doesn't await `ctx.elicit` | Not supported — elicitation is synchronous from the plugin's perspective |

### Out of scope

| Item | Reason |
|---|---|
| Rich widgets (timeline picker, file browser) | Non-spec; handle as separate extension using resource URIs + webview when the time comes |
| Multi-step wizards as a single protocol call | Spec opposes it; chain elicitations instead |
| Elicitation over HTTP (not WS) | Current chat is WS-only; no demand |
| Elicitation from the chat LLM itself | Separate concern — this is for plugins/tools |

---

## Open Questions

- **Timeout default.** 5 min matches Continue.dev; Claude Desktop has no hard timeout. Lean: 5 min for scenecraft since plugin operations should resolve quickly.
- **Should validation errors be a distinct action?** Right now fail → `cancel`. Alternative: `action: "invalid", errors: [...]` so client can re-render the same form with field-level errors. Leaning: stick with re-elicitation per spec, simpler.
- **Multiple concurrent elicitations?** Spec doesn't forbid, but UI can only meaningfully show one at a time. Enforce single-in-flight per chat session server-side?
- **Capability advertisement timing.** Add to existing chat `hello` handshake, or introduce a new `capabilities` message? Leaning: piggyback on the existing handshake.

---

## Related

- **Clarification:** [`clarification-10-musicful-music-generation-plugin.md`](../clarifications/clarification-10-musicful-music-generation-plugin.md) — motivating use case
- **Existing implementation:**
  - `scenecraft-engine/src/scenecraft/chat.py` §Elicitation
  - `scenecraft/src/components/editor/ChatPanel.tsx` (StreamingMessage → elicitation block)
- **MCP spec:** Model Context Protocol version 2025-06-18, `elicitation/create` section
