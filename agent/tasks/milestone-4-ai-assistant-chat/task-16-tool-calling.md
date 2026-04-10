# Task 16: Tool Calling and Badges

**Milestone**: [M4 - AI Assistant Chat](../../milestones/milestone-4-ai-assistant-chat.md)  
**Design Reference**: [AI Assistant Chat](../../design/local.ai-assistant-chat.md)  
**Estimated Time**: 10-12 hours  
**Dependencies**: [Task 15: Frontend ChatPanel](task-15-frontend-chat-panel.md)  
**Status**: Not Started  

---

## Objective

Expose beatlab REST endpoints as Claude tool definitions, handle tool_use/tool_result in the streaming pipeline, render ToolCallBadge components inline in messages, and implement the `sql_query` read-only tool.

---

## Steps

### 1. Generate Tool Definitions

Build tool definition list from beatlab REST endpoints. Each endpoint becomes a tool with typed parameters. Include generic tools: `update_curve`, `update_transform_curve`, `sql_query`.

### 2. Backend Tool Execution

When Claude returns a `tool_use` content block:
1. Stream `tool_call` event to client (badge shows pending)
2. Execute the tool (call the corresponding REST handler internally)
3. Stream `tool_result` event (badge updates to success/error)
4. Feed result back to Claude for next turn

### 3. sql_query Tool

Execute arbitrary read-only SQL against project.db. Reject non-SELECT statements. Return rows as JSON array. Enforce via `conn.execute()` with a whitelist check on the statement prefix.

### 4. ToolCallBadge Component

Inline badge: tool name + status icon. Pending = blue spinner, success = green check, error = red X. Renders both in streaming view and persisted messages.

### 5. Update Streaming State Machine

Add `tool_call` and `tool_result` handling to `streamingBlocks`:
- `tool_call` → insert `{ type: 'tool_use', status: 'pending' }` block
- `tool_result` → update matching block to `success` or `error`

### 6. Persist Tool Calls in Messages

Store tool_use and tool_result content blocks in `chat_messages.content` as JSON arrays (mixed text + tool blocks).

---

## Verification

- [ ] Claude can call beatlab tools (add keyframe, delete transition, etc.)
- [ ] Tool call badge shows pending → success/error transition
- [ ] sql_query returns results for valid SELECT, rejects non-SELECT
- [ ] Tool results feed back to Claude for follow-up reasoning
- [ ] Tool calls persist in message history and render on reload
- [ ] Generic tools (update_curve, update_transform_curve) work

---

**Next Task**: [Task 17: Elicitation UI](task-17-elicitation-ui.md)  
