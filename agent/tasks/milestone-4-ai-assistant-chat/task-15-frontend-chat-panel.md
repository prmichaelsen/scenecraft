# Task 15: Frontend ChatPanel with Streaming

**Milestone**: [M4 - AI Assistant Chat](../../milestones/milestone-4-ai-assistant-chat.md)  
**Design Reference**: [AI Assistant Chat](../../design/local.ai-assistant-chat.md)  
**Estimated Time**: 8-10 hours  
**Dependencies**: [Task 14: Backend Chat Endpoint](task-14-backend-chat-endpoint.md)  
**Status**: Not Started  

---

## Objective

Replace the chat placeholder in EditorLayout with a real ChatPanel component featuring MessageList (react-virtuoso), MessageInput (textarea + file handling), streaming text display, and typing indicator.

---

## Steps

### 1. Create ChatPanel Component

Dockview panel component in `src/components/editor/ChatPanel.tsx`. Manages WebSocket connection to `/ws/chat/{projectName}`.

### 2. Create MessageList

react-virtuoso list rendering messages. Both user and assistant messages left-aligned, rendered via ReactMarkdown + rehype-sanitize (user messages visually distinguished by subtle background/label, not alignment). Load history from backend on mount.

### 3. Create MessageInput

Auto-resizing textarea. Shift+Enter sends, Enter is newline. Drag-and-drop, clipboard paste, file picker for images. Image previews before sending.

### 4. Streaming State Machine

Implement `streamingBlocks` state per the design doc:
- `chunk` → append text to last text block
- `complete` → persist to message list, clear streaming
- Render streaming blocks as synthetic last item in MessageList

### 5. TypingIndicator

Bouncing dots component shown while waiting for first chunk.

### 6. Register in EditorLayout

Replace `placeholder` component for chat with real `ChatPanel`. Pass `projectName` via params.

---

## Verification

- [ ] ChatPanel renders in dockview bottom-right
- [ ] Messages load from DB on mount
- [ ] User can type and send messages
- [ ] Assistant response streams in token-by-token
- [ ] Typing indicator shows while waiting
- [ ] Shift+Enter sends, Enter is newline
- [ ] Messages persist across page reload
- [ ] Virtuoso handles 100+ messages without lag

---

**Next Task**: [Task 16: Tool Calling](task-16-tool-calling.md)  
