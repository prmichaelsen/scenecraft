# AI Assistant Chat

**Concept**: Embedded Claude-powered chat panel in the beatlab editor with tool calling, streaming, vision, MCP server integration, and elicitation-based confirmations  
**Created**: 2026-04-10  
**Status**: Design Specification  

---

## Overview

An AI assistant chat panel docked in the editor's bottom-right (dockview panel) that can reason about the project, execute actions via tool calling, stream responses, handle image uploads for vision, and connect to external MCP servers. The assistant sees project context (keyframes, transitions, effects, audio intelligence) and can modify the project through the same REST endpoints the UI uses.

---

## Problem Statement

- Users need to perform complex multi-step operations (fix orphaned data, bulk style changes, prompt generation) that are tedious through the UI
- No way to ask natural language questions about the project state
- Color grading and creative direction require artistic judgment that AI can assist with
- No extensibility mechanism for third-party tools

---

## Solution

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React)                                   │
│  ┌─────────┐  ┌──────────┐  ┌────────────────────┐ │
│  │ChatPanel │  │MessageList│  │ MessageInput       │ │
│  │(dockview)│  │(Virtuoso) │  │ (textarea+drop)    │ │
│  └────┬─────┘  └──────────┘  └────────────────────┘ │
│       │ WebSocket                                    │
├───────┼─────────────────────────────────────────────┤
│  beatlab server (Python)                             │
│  ┌────┴─────┐  ┌───────────┐  ┌──────────────────┐ │
│  │ /chat WS │  │ Anthropic │  │ MCP Client       │ │
│  │ endpoint │──│ SDK       │  │ (external servers)│ │
│  └──────────┘  │ (streaming│  └──────────────────┘ │
│                │  +tools)  │                        │
│                └───────────┘                        │
│                      │                              │
│                ┌─────┴─────┐                        │
│                │ project.db│                        │
│                │ chat_msgs │                        │
│                └───────────┘                        │
└─────────────────────────────────────────────────────┘
```

### Frontend: ChatPanel Component

A standard dockview panel component (already registered as a placeholder). Contains:

1. **MessageList** — react-virtuoso (already a dep, `^4.18.4`) for virtualized scrolling
   - User messages: right-aligned, gray background
   - Assistant messages: left-aligned, rendered via ReactMarkdown + rehype-sanitize
   - Tool call badges inline: pending (blue spinner), success (green check), error (red X)
   - Elicitation widgets: rich inline cards with summary + confirm/cancel buttons
   - Typing indicator: bouncing dots ("Agent is thinking")
   - Images rendered inline with lightbox on click

2. **MessageInput** — plain auto-resizing textarea (agentbase.me pattern)
   - Shift+Enter sends, Enter is newline
   - Drag-and-drop, clipboard paste, file picker for image uploads
   - Image previews before sending
   - Markdown typed as plain text (rendered in output only)

### Backend: Chat WebSocket Endpoint

New WebSocket endpoint at `/ws/chat/{projectName}` on the beatlab server.

**Message flow:**
1. Client sends `{ type: "message", content: "...", images: [...] }`
2. Server injects project context into system prompt
3. Server calls Claude API with streaming + tool definitions
4. Server streams back interleaved events:
   - `{ type: "text", content: "..." }` — text tokens
   - `{ type: "tool_use", id: "...", name: "...", input: {...} }` — tool call started
   - `{ type: "tool_result", id: "...", result: {...} }` — tool call completed
   - `{ type: "elicitation", id: "...", message: "...", schema: {...} }` — confirmation needed
   - `{ type: "done" }` — stream complete
5. Client responds to elicitations: `{ type: "elicitation_response", id: "...", action: "accept"|"decline" }`

### Project Context Injection

On each message send, the system prompt includes a structured project summary:
```
Project: "{name}" | {fps}fps | {resolution}
Keyframes: {count} across {trackCount} tracks
Transitions: {count} ({withVideo} have video)
Effects: {count} active, {suppressionCount} suppressions
Audio: {audioFile || "none"} | {eventCount} intelligence events
Playhead: {currentTime}s
Selected: {selectedKeyframe?.id || selectedTransition?.id || "none"}
Sections: {sectionCount} narrative sections
```

This is injected fresh on each user message — not mid-stream.

### Tool Definitions

All beatlab REST endpoints exposed as Claude tools. Generic parameterized tools where sensible:

**Generic tools:**
- `update_curve` — `{ transition_id, curve_type: "opacity"|"saturation"|"red"|"green"|"blue"|"hue_shift"|"invert"|"black", points: [[x,y]...] }`
- `update_transform_curve` — `{ transition_id, axis: "x"|"y"|"z", points: [[x,y]...] }`

**Endpoint tools (auto-generated from REST API):**
- `get_keyframes`, `add_keyframe`, `delete_keyframe`, `update_keyframe_prompt`, `update_keyframe_timestamp`
- `get_transitions`, `delete_transition`, `split_transition`, `update_transition_action`
- `get_effects`, `update_effects`, `add_effect`, `delete_effect`
- `add_marker`, `update_marker`, `remove_marker`
- `get_audio_intelligence`, `get_descriptions`
- `assign_keyframe_image`, `assign_pool_video`
- `generate_keyframe_candidates`, `generate_transition_candidates`
- `checkpoint`, `get_checkpoints`, `restore_checkpoint`
- ... (all REST endpoints)

**Destructive tools** use MCP Elicitation for confirmation:
- `delete_keyframe`, `delete_transition`, `batch_delete_keyframes`
- `restore_checkpoint`
- Any bulk modification

### Elicitation UI

Rendered as inline cards in the message stream:

```
┌─────────────────────────────────────┐
│ 🔧 Delete Orphaned Transitions     │
│                                     │
│ Will remove 3 transitions with no   │
│ linked keyframes:                   │
│  • tr_045 (0:12 → 0:15)           │
│  • tr_072 (1:30 → 1:33)           │
│  • tr_089 (2:45 → 2:48)           │
│                                     │
│          [ Cancel ]  [ Confirm ]    │
└─────────────────────────────────────┘
```

### MCP Server Integration

Users can connect external MCP servers. The chat backend acts as an MCP client:
1. User configures MCP server URLs in settings (or a dedicated MCP settings panel)
2. Backend connects to each server, discovers available tools
3. External tools are merged with beatlab's built-in tools in the Claude tool list
4. Claude can call any tool from any connected server

Pattern reference: `agentbase.me` MCP integration.

### Conversation Storage

- `chat_messages` table in `project.db`:
  ```sql
  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,        -- 'user' | 'assistant' | 'system'
    content TEXT NOT NULL,     -- message content (JSON for structured)
    images TEXT,               -- JSON array of image paths
    tool_calls TEXT,           -- JSON array of tool call records
    created_at TEXT NOT NULL
  );
  ```
- Single continuous thread per project
- Persists across page refreshes
- Backed up by checkpoints automatically

### Claude Model

`claude-sonnet-4-5-20250929` (same as agentbase.me) via Python `anthropic` SDK with streaming.

### Rate Limiting

Cloudflare WAF rate limiting rule on the chat endpoint — 100 req/min per IP at the edge. No application-level rate limiting code needed.

### API Key

Server's `ANTHROPIC_API_KEY` environment variable (same key used for image generation / escalate operations).

---

## Benefits

- **Natural language project interaction** — ask questions, get answers, execute actions
- **Creative direction** — AI-assisted prompt generation, style suggestions, color grading (P2)
- **Extensibility** — MCP server integration for third-party tools
- **Safety** — elicitation-based confirmation for destructive actions, existing undo system catches all DB mutations
- **Performance** — streaming responses, virtualized message list, no pruning needed

---

## Trade-offs

- **API cost** — each message is a Claude API call (~$0.003-0.015 per message depending on context size). Mitigated by rate limiting.
- **Complexity** — adds AI/LLM dependency to the pipeline server. Mitigated by keeping it as a separate WebSocket endpoint.
- **Tool definition maintenance** — as REST endpoints change, tool definitions need updating. Mitigated by auto-generating tool defs from endpoint registrations.
- **Vision cost** — sending images to Claude increases token usage. Only send when user explicitly uploads or asks about a specific frame.

---

## Dependencies

- Python `anthropic` SDK (streaming + tool_use)
- `react-virtuoso` (already installed)
- `react-markdown` + `rehype-sanitize` (already installed)
- MCP client library (for external server integration)
- Existing WebSocket infrastructure in beatlab server

---

## Testing Strategy

- Unit: tool definition generation from REST endpoints
- Unit: message storage/retrieval from SQLite
- Integration: WebSocket chat flow (send message → receive streaming response)
- Integration: tool execution (Claude calls a tool → tool executes → result returned)
- Integration: elicitation flow (destructive tool → elicitation card → user confirms → tool executes)
- E2E: send a message, receive streaming response with tool calls, verify project state changed

---

## Key Design Decisions

### UX

| Decision | Choice | Rationale |
|---|---|---|
| Panel placement | Dockview panel, bottom-right default | Standard panel in layout system, can be moved |
| Input component | Plain textarea + file drop/paste | agentbase.me pattern — simple, proven, no TipTap overhead |
| Send key | Shift+Enter sends, Enter is newline | User preference — matches code editor behavior |
| Message rendering | ReactMarkdown + rehype-sanitize | Rich output (code blocks, images, lists) with XSS protection |
| Typing indicator | Bouncing dots + tool call badges | agentbase.me pattern (TypingIndicator + ToolCallBadge) |
| Confirmation UI | Rich inline elicitation cards | Summary + affected items preview + confirm/cancel buttons |

### Architecture

| Decision | Choice | Rationale |
|---|---|---|
| LLM backend | Python beatlab server (Claude API) | Same server owns the DB and REST endpoints, no extra service |
| Claude model | claude-sonnet-4-5 | agentbase.me uses it, good speed/cost/capability balance |
| Tool strategy | All REST endpoints as tools, generic where sensible | User: "limitless tools, no degradation with 100+ tools" |
| Streaming | WebSocket with interleaved events | Already have WS infrastructure for logs/jobs |
| Storage | chat_messages table in project.db | Per-project, backed up by checkpoints |
| Rate limiting | Cloudflare WAF, 100 req/min per IP | Edge-based, no application code needed |
| MCP integration | Backend as MCP client to external servers | Extensibility — any MCP server's tools available to Claude |
| Confirmation | MCP Elicitation protocol | Standard, in-flow, no token waste |

### Priorities

| Priority | Capability |
|---|---|
| P0 | Action execution (fix data, add markers, assign images, tool calling) |
| P1 | Creative direction (prompt generation, style suggestions) |
| P2 | Natural language queries (statistics, data issues), AI color grading |

---

## Future Considerations

- AI-driven color grading (P2): user describes aesthetic, Claude sees frame via vision, calls curve update tools
- Multiple conversation threads per project
- Conversation search/filter
- Assistant memory (remember user preferences across sessions)
- Voice input
- Keyboard shortcut to focus chat (e.g., Cmd+L)

---

**Status**: Design Specification  
**Recommendation**: Create milestone + tasks for implementation. Start with backend WebSocket endpoint + basic chat flow, then add tool calling, then streaming, then MCP integration.  
**Related Documents**: [clarification-2-ai-assistant-chat.md](../clarifications/clarification-2-ai-assistant-chat.md), [local.dynamic-panel-layout.md](local.dynamic-panel-layout.md)  
