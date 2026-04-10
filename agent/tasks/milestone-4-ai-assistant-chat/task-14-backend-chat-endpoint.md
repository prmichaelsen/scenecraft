# Task 14: Backend Chat Endpoint and DB Storage

**Milestone**: [M4 - AI Assistant Chat](../../milestones/milestone-4-ai-assistant-chat.md)  
**Design Reference**: [AI Assistant Chat](../../design/local.ai-assistant-chat.md)  
**Estimated Time**: 8-10 hours  
**Dependencies**: None  
**Status**: Not Started  

---

## Objective

Create the WebSocket chat endpoint on the beatlab server, integrate the Python Anthropic SDK with streaming, add the `chat_messages` table to SQLite, and inject project context into the system prompt.

---

## Steps

### 1. Add chat_messages Table to db.py

```sql
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  images TEXT,
  tool_calls TEXT,
  created_at TEXT NOT NULL
);
```

Add `get_chat_messages(project_dir, limit)` and `add_chat_message(project_dir, role, content, images, tool_calls)` functions.

### 2. Install Python Anthropic SDK

Add `anthropic` to requirements. Configure with `ANTHROPIC_API_KEY` env var.

### 3. Create WebSocket Chat Endpoint

Add `/ws/chat/{projectName}` WebSocket handler to the beatlab server (alongside existing `/ws` for logs/jobs). Handle:
- Client `message` → build messages array from DB history + new message → call Claude
- Stream Claude response tokens back as `chunk` events
- On `complete`, persist assistant message to DB

### 4. Project Context System Prompt

On each message, build a system prompt with project summary:
- Project name, fps, resolution, audio file
- Keyframe count, transition count, track count
- Current playhead position, selected KF/TR (sent by client in message payload)
- Active effects, suppressions count
- Narrative sections summary

### 5. Message History Management

Load last N messages from `chat_messages` as conversation history for Claude context. Start with N=50, make configurable.

---

## Verification

- [ ] `chat_messages` table created on first access
- [ ] WebSocket connects at `/ws/chat/{projectName}`
- [ ] Client sends message, receives streaming `chunk` events
- [ ] `complete` event fires when stream ends
- [ ] Messages persist to DB and survive page reload
- [ ] System prompt includes current project state
- [ ] Claude model is `claude-sonnet-4-5-20250929`

---

**Next Task**: [Task 15: Frontend ChatPanel](task-15-frontend-chat-panel.md)  
