# Milestone 4: AI Assistant Chat

**Goal**: Embed a Claude-powered chat panel in the editor with tool calling, streaming, vision, elicitation confirmations, and MCP server integration  
**Duration**: 3-4 weeks  
**Dependencies**: [M2 - Dynamic Panel Layout](milestone-2-dynamic-panel-layout.md) (ChatPanel is a dockview panel)  
**Status**: Not Started  

---

## Overview

Add an AI assistant to the beatlab editor that can reason about the project, execute actions via tool calling, stream responses, handle image uploads for vision, and connect to external MCP servers. The chat panel is a dockview panel in the bottom-right of the v2 layout. The assistant sees project context and can modify the project through the same REST endpoints the UI uses.

Design doc: [local.ai-assistant-chat.md](../design/local.ai-assistant-chat.md)

---

## Deliverables

### 1. Backend
- WebSocket chat endpoint (`/ws/chat/{projectName}`)
- `chat_messages` table in project.db
- Claude SDK integration (Python `anthropic`, streaming + tool_use)
- Project context injection into system prompt
- Tool definitions auto-generated from REST endpoints

### 2. Frontend
- ChatPanel dockview component (replaces placeholder)
- MessageList with react-virtuoso
- MessageInput with Shift+Enter send, drag/drop/paste images
- StreamingBlock state machine (text + tool badges)
- Elicitation card widgets (confirm/cancel for destructive actions)
- ToolCallBadge component (pending/success/error)
- TypingIndicator (bouncing dots)

### 3. Integration
- MCP client for external server connections
- `sql_query` read-only tool
- Generic parameterized tools (update_curve, update_transform_curve)

---

## Success Criteria

- [ ] User can send a message and receive a streaming response
- [ ] Assistant can call any beatlab REST endpoint as a tool
- [ ] Tool call badges show pending → success/error inline in messages
- [ ] Destructive actions show elicitation confirmation cards
- [ ] User can paste/drop images, assistant sees them via vision
- [ ] Conversation persists across page reloads (stored in project.db)
- [ ] External MCP servers can be connected, their tools appear in Claude's tool list
- [ ] `sql_query` tool executes read-only SQL and returns results
- [ ] Rate limiting via Cloudflare WAF (100 req/min)
- [ ] Existing undo system captures all assistant mutations

---

## Tasks

1. [Task 14: Backend chat endpoint and DB storage](../tasks/milestone-4-ai-assistant-chat/task-14-backend-chat-endpoint.md)
2. [Task 15: Frontend ChatPanel with streaming](../tasks/milestone-4-ai-assistant-chat/task-15-frontend-chat-panel.md)
3. [Task 16: Tool calling and badges](../tasks/milestone-4-ai-assistant-chat/task-16-tool-calling.md)
4. [Task 17: Elicitation confirmation UI](../tasks/milestone-4-ai-assistant-chat/task-17-elicitation-ui.md)
5. [Task 18: Image handling and vision](../tasks/milestone-4-ai-assistant-chat/task-18-image-handling.md)
6. [Task 19: MCP server integration](../tasks/milestone-4-ai-assistant-chat/task-19-mcp-integration.md)

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation Strategy |
|------|--------|-------------|---------------------|
| Claude API cost spikes | Medium | Medium | Cloudflare WAF rate limiting, monitor usage |
| Tool definition maintenance | Medium | High | Future: OpenAPI spec auto-generates tool defs |
| WebSocket complexity | Medium | Low | beatlab already has WS infrastructure for logs/jobs |
| MCP client compatibility | Low | Medium | Follow agentbase.me's tested patterns |

---

**Next Milestone**: TBD  
**Blockers**: None  
**Notes**: Design doc at agent/design/local.ai-assistant-chat.md. Priorities: P0 action execution, P1 creative direction, P2 queries + AI color grading.  
