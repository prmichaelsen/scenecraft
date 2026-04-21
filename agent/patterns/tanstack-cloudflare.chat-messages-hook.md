# Chat Messages Hook

**Category**: Code  
**Applicable To**: Real-time chat UIs combining REST initial load with WebSocket live updates  
**Status**: Stable

---

## Overview

The `useChatMessages` hook manages the full lifecycle of chat messages for a single conversation: initial REST fetch, WebSocket subscription for live updates, cursor-based pagination for older messages, message deduplication, and conversation switching. It provides a clean API (`messages`, `loadMore`, `sendMessage`, `removeMessage`) that abstracts the complexity of coordinating two data sources.

---

## When to Use This Pattern

✅ **Use this pattern when:**
- Building a chat UI with real-time message delivery
- You need both historical message loading and live WebSocket updates
- Messages must be paginated (conversations can have thousands of messages)

❌ **Don't use this pattern when:**
- Messages are read-only (no live updates needed) — use a simple loader
- You're building a notification feed (use polling or SSE instead)
- The message list is small enough to load all at once

---

## Core Principles

1. **REST for History, WebSocket for Live**: Initial and paginated loads use REST; new messages arrive via WebSocket
2. **Deduplication**: The server may echo back messages sent via WebSocket — deduplicate by message ID
3. **Cursor-Based Pagination**: Uses `createdAt` of the oldest loaded message as the cursor for `loadMore`
4. **Conversation Isolation**: Switching conversations resets state and re-fetches

---

## Implementation

```typescript
import { useState, useEffect, useCallback, useRef } from 'react'

interface UseChatMessagesOptions {
  conversationId: string | undefined
  ws: ChatWebSocket | null
  isConnected: boolean
  pageSize?: number  // default 50
}

interface UseChatMessagesReturn {
  messages: ChatMessage[]
  isLoading: boolean
  loadMore: () => Promise<void>
  hasMore: boolean
  sendMessage: (content: string, contentText: string, visibleToUserIds?: string[] | null) => void
  removeMessage: (messageId: string) => void
}

export function useChatMessages(options: UseChatMessagesOptions): UseChatMessagesReturn {
  const { conversationId, ws, isConnected, pageSize = 50 } = options
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const cursorRef = useRef<string | undefined>(undefined)
  const conversationIdRef = useRef(conversationId)

  // Reset on conversation switch
  useEffect(() => {
    if (conversationId !== conversationIdRef.current) {
      conversationIdRef.current = conversationId
      setMessages([])
      setHasMore(true)
      cursorRef.current = undefined
    }
  }, [conversationId])

  // Fetch initial messages via REST
  useEffect(() => {
    if (!conversationId) { setMessages([]); return }
    let cancelled = false

    const fetchInitial = async () => {
      setIsLoading(true)
      try {
        const res = await fetch(
          `/api/conversations/${conversationId}/messages?limit=${pageSize}`
        )
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json() as { messages: ChatMessage[]; hasMore: boolean }
        if (!cancelled) {
          setMessages(data.messages)
          setHasMore(data.hasMore)
          if (data.messages.length > 0) {
            cursorRef.current = data.messages[data.messages.length - 1].createdAt
          }
        }
      } catch {
        if (!cancelled) { setMessages([]); setHasMore(false) }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    fetchInitial()
    return () => { cancelled = true }
  }, [conversationId, pageSize])

  // Switch conversation on WebSocket
  useEffect(() => {
    if (conversationId && ws && isConnected) {
      ws.switchConversation(conversationId)
    }
  }, [conversationId, ws, isConnected])

  // Subscribe to live WebSocket messages
  useEffect(() => {
    if (!ws || !conversationId) return
    const handleMessage = (msg: ServerChatMessage) => {
      if (msg.conversationId !== conversationId) return
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev // deduplicate
        return [mapToChatMessage(msg), ...prev]
      })
    }
    const prevOnMessage = ws.onMessage
    ws.onMessage = (msg) => {
      handleMessage(msg)
      if (prevOnMessage && prevOnMessage !== handleMessage) prevOnMessage(msg)
    }
    return () => { ws.onMessage = prevOnMessage }
  }, [ws, conversationId])

  // Paginate older messages
  const loadMore = useCallback(async () => {
    if (!conversationId || isLoading || !hasMore) return
    setIsLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(pageSize) })
      if (cursorRef.current) params.set('before', cursorRef.current)
      const res = await fetch(
        `/api/conversations/${conversationId}/messages?${params}`
      )
      const data = await res.json() as { messages: ChatMessage[]; hasMore: boolean }
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id))
        return [...prev, ...data.messages.filter((m) => !existingIds.has(m.id))]
      })
      setHasMore(data.hasMore)
      if (data.messages.length > 0) {
        cursorRef.current = data.messages[data.messages.length - 1].createdAt
      }
    } finally {
      setIsLoading(false)
    }
  }, [conversationId, isLoading, hasMore, pageSize])

  const sendMessage = useCallback(
    (content: string, contentText: string, visibleToUserIds?: string[] | null) => {
      if (ws && conversationId) ws.sendMessage(content, contentText, conversationId, visibleToUserIds)
    },
    [ws, conversationId]
  )

  const removeMessage = useCallback(
    (messageId: string) => setMessages((prev) => prev.filter((m) => m.id !== messageId)),
    []
  )

  return { messages, isLoading, loadMore, hasMore, sendMessage, removeMessage }
}
```

---

## Examples

### Example: Chat UI Component

```typescript
function ChatView({ conversationId }: { conversationId: string }) {
  const { ws, isConnected } = useWebSocketManager()
  const { messages, isLoading, loadMore, hasMore, sendMessage, removeMessage } =
    useChatMessages({ conversationId, ws, isConnected })

  return (
    <div className="flex flex-col h-full">
      <MessageList
        messages={messages}
        onLoadMore={loadMore}
        hasMore={hasMore}
        isLoading={isLoading}
      />
      <MessageInput onSend={(text) => sendMessage(text, text)} />
    </div>
  )
}
```

---

## Benefits

### 1. Unified Data Source
Components see a single `messages` array — no need to merge REST and WebSocket data manually.

### 2. Automatic Deduplication
Server echoes and race conditions between REST and WebSocket are handled transparently.

### 3. Clean Conversation Switching
Changing `conversationId` resets everything and re-fetches — no stale messages leak between conversations.

---

## Trade-offs

### 1. Handler Chaining
**Downside**: Overrides `ws.onMessage` and chains to previous handler — fragile if multiple consumers exist.  
**Mitigation**: Consider an event emitter pattern if more than one hook subscribes to the same WebSocket.

### 2. No Optimistic Sends
**Downside**: Sent messages only appear when echoed back by the server.  
**Mitigation**: Add optimistic insertion with a temporary ID, then reconcile on server echo.

---

## Related Patterns

- **[WebSocket Manager](./tanstack-cloudflare.websocket-manager.md)**: Provides the `ChatWebSocket` client this hook depends on
- **[Chat Engine](./tanstack-cloudflare.chat-engine.md)**: Server-side Durable Object that handles message persistence
- **[Durable Objects WebSocket](./tanstack-cloudflare.durable-objects-websocket.md)**: Server-side WebSocket handling

---

**Status**: Stable  
**Last Updated**: 2026-04-08  
