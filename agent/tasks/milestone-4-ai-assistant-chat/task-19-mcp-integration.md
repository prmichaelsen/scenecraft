# Task 19: MCP Server Integration

**Milestone**: [M4 - AI Assistant Chat](../../milestones/milestone-4-ai-assistant-chat.md)  
**Design Reference**: [AI Assistant Chat](../../design/local.ai-assistant-chat.md)  
**Estimated Time**: 8-10 hours  
**Dependencies**: [Task 16: Tool Calling](task-16-tool-calling.md)  
**Status**: Not Started  

---

## Objective

Enable users to connect external MCP servers to the chat assistant. The beatlab backend acts as an MCP client, discovers tools from connected servers, and merges them with beatlab's built-in tools for Claude.

---

## Steps

### 1. MCP Server Configuration

Add a settings UI (or section in Settings panel) where users can add/remove MCP server URLs. Store in project.db `meta` table as `mcp_servers` key (JSON array of URLs).

### 2. MCP Client in Python Backend

Implement an MCP client that connects to configured servers:
- On chat session start, connect to all configured MCP servers
- Discover available tools via MCP `tools/list`
- Merge external tool definitions with beatlab's built-in tools
- Pass combined tool list to Claude

### 3. External Tool Execution

When Claude calls an external tool:
1. Route the call to the correct MCP server
2. Send `tools/call` request via MCP protocol
3. Stream `tool_call` (pending) and `tool_result` (success/error) back to the frontend
4. Handle MCP elicitation requests from external servers (forward to frontend)

### 4. Connection Status

Show MCP server connection status in the chat panel or settings:
- Connected (green)
- Disconnected (red)
- Connecting (blue spinner)

Reference: agentbase.me's TypingIndicator supports MCP connection status display.

### 5. Error Handling

Handle MCP server disconnects gracefully — remove tools from the active list, notify user in chat, don't crash the conversation.

---

## Verification

- [ ] User can add/remove MCP server URLs in settings
- [ ] Backend connects to external MCP servers on chat session start
- [ ] External tools appear in Claude's tool list
- [ ] Claude can call external tools and get results
- [ ] Tool badges work for external tool calls (pending/success/error)
- [ ] Connection status displayed
- [ ] Disconnected server handled gracefully (tools removed, user notified)

---

**Next Task**: None (core milestone complete)  
