# Task 18: Image Handling and Vision

**Milestone**: [M4 - AI Assistant Chat](../../milestones/milestone-4-ai-assistant-chat.md)  
**Design Reference**: [AI Assistant Chat](../../design/local.ai-assistant-chat.md)  
**Estimated Time**: 6-8 hours  
**Dependencies**: [Task 15: Frontend ChatPanel](task-15-frontend-chat-panel.md)  
**Status**: Not Started  

---

## Objective

Enable image upload in chat (paste, drop, file picker), send images to Claude as vision input, and allow the assistant to assign uploaded images to keyframes.

---

## Steps

### 1. Image Upload in MessageInput

- Drag-and-drop zone on the input area
- Clipboard paste handler for `image/*` types
- File picker button for manual selection
- Image previews below the textarea before sending (thumbnail + remove button)
- Upload images to beatlab server on send (store in `pool/keyframes/` or a chat uploads dir)

### 2. Send Images to Claude as Vision

Include uploaded images in the Claude API call as `image` content blocks. The Python anthropic SDK supports base64 image content in messages.

### 3. Assign Image Tool

The assistant can call `assign_keyframe_image` tool to assign an uploaded/chat image to a specific keyframe. Images uploaded via chat are stored server-side and referenced by path.

### 4. Vision for Existing Keyframes

When the assistant needs to "see" a keyframe image (e.g., for color grading suggestions), it can call a `get_keyframe_image` tool that returns the image as base64 for the next Claude turn.

### 5. Image Rendering in Messages

Display images inline in the message list. Click to open lightbox. Both user-uploaded and assistant-referenced images.

---

## Verification

- [ ] User can paste, drop, or pick images in the chat input
- [ ] Image previews show before sending
- [ ] Images are sent to Claude as vision input
- [ ] Assistant can describe what it sees in the image
- [ ] Assistant can assign uploaded images to keyframes
- [ ] Images render inline in message history
- [ ] Images persist across page reload (stored server-side)

---

**Next Task**: [Task 19: MCP Integration](task-19-mcp-integration.md)  
