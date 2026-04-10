# Task 17: Elicitation Confirmation UI

**Milestone**: [M4 - AI Assistant Chat](../../milestones/milestone-4-ai-assistant-chat.md)  
**Design Reference**: [AI Assistant Chat](../../design/local.ai-assistant-chat.md)  
**Estimated Time**: 4-6 hours  
**Dependencies**: [Task 16: Tool Calling](task-16-tool-calling.md)  
**Status**: Not Started  

---

## Objective

Implement MCP Elicitation for destructive tool actions — the backend pauses tool execution and sends an elicitation request, the frontend renders a rich inline card with action summary + confirm/cancel buttons, and the user's response resumes or aborts the tool.

---

## Steps

### 1. Backend Elicitation Flow

Before executing destructive tools (delete_keyframe, delete_transition, batch_delete, restore_checkpoint):
1. Build a summary of what will change (affected items, counts)
2. Send `elicitation` WebSocket event with message + JSON schema
3. Block (await) until client responds
4. If `accept` → execute tool, send `tool_result`
5. If `decline` → send tool_result with "cancelled by user"

### 2. ElicitationCard Component

Inline card widget rendered in the streaming message area:
- Title with icon (e.g., "🔧 Delete Orphaned Transitions")
- Summary text (what will happen)
- List of affected items (if applicable)
- Confirm / Cancel button pair
- Disabled state after response (greyed out with "Confirmed" or "Cancelled" label)

### 3. WebSocket Elicitation Protocol

- Server sends: `{ type: "elicitation", id: "...", message: "...", schema: { ... } }`
- Client renders card, user clicks
- Client sends: `{ type: "elicitation_response", id: "...", action: "accept"|"decline" }`

### 4. Categorize Destructive Tools

Maintain a set of tool names that require elicitation. All others execute immediately.

---

## Verification

- [ ] Destructive tools show confirmation card before executing
- [ ] Confirm button executes the tool, Cancel aborts
- [ ] Card shows summary of what will change
- [ ] Card disables after response (can't double-click)
- [ ] Non-destructive tools execute immediately (no card)
- [ ] Elicitation state persists in message history

---

**Next Task**: [Task 18: Image Handling](task-18-image-handling.md)  
