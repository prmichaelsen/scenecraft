import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { ChatWebSocket, fetchChatHistory, type ServerMessage, type PersistedMessage, type StreamingBlock, type ContentBlock } from '@/lib/chat-client'

type ChatPanelProps = {
  projectName: string
  onClose: () => void
}

export function ChatPanel({ projectName }: ChatPanelProps) {
  const [messages, setMessages] = useState<PersistedMessage[]>([])
  const [streamingBlocks, setStreamingBlocks] = useState<StreamingBlock[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wsRef = useRef<ChatWebSocket | null>(null)

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    })
  }, [])

  // Handle incoming WebSocket messages
  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'chunk':
        setStreamingBlocks(prev => {
          const last = prev[prev.length - 1]
          if (last?.type === 'text') {
            return [...prev.slice(0, -1), { type: 'text', text: last.text + msg.content }]
          }
          return [...prev, { type: 'text', text: msg.content }]
        })
        scrollToBottom()
        break

      case 'tool_call':
        setStreamingBlocks(prev => [...prev, {
          type: 'tool_use', id: msg.toolCall.id, name: msg.toolCall.name, status: 'pending',
        }])
        scrollToBottom()
        break

      case 'tool_result':
        setStreamingBlocks(prev => prev.map(b =>
          b.type === 'tool_use' && b.id === msg.toolResult.id
            ? { ...b, status: msg.toolResult.isError ? 'error' : 'success' } as StreamingBlock
            : b
        ))
        break

      case 'message':
        setMessages(prev => [...prev, msg.message])
        setStreamingBlocks([])
        scrollToBottom()
        break

      case 'complete':
        setStreamingBlocks([])
        setLoading(false)
        break

      case 'error':
        setStreamingBlocks([])
        setLoading(false)
        // Show error as a system message
        setMessages(prev => [...prev, {
          id: Date.now(),
          role: 'system',
          content: `Error: ${msg.error}`,
          created_at: new Date().toISOString(),
        }])
        scrollToBottom()
        break

      case 'status':
        // Could show in a status bar, for now just log
        break
    }
  }, [scrollToBottom])

  // Connect WebSocket and load history
  useEffect(() => {
    fetchChatHistory(projectName).then(msgs => {
      setMessages(msgs)
      setInitialLoading(false)
      scrollToBottom()
    })

    const ws = new ChatWebSocket(projectName, handleMessage, setConnected)
    wsRef.current = ws
    ws.connect()

    return () => {
      ws.disconnect()
      wsRef.current = null
    }
  }, [projectName, handleMessage, scrollToBottom])

  // Send message
  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || loading) return

    // Optimistic: add user message immediately
    const userMsg: PersistedMessage = {
      id: Date.now(),
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)
    scrollToBottom()

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // Send via WebSocket
    wsRef.current?.send({ type: 'message', content: text })
  }, [input, loading, scrollToBottom])

  // Keyboard handler
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const t = e.target
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, 120) + 'px'
  }, [])

  // Build display items: messages + streaming blocks as synthetic last item
  const displayItems = useMemo(() => {
    const items: Array<{ type: 'message'; message: PersistedMessage } | { type: 'streaming'; blocks: StreamingBlock[] } | { type: 'typing' }> =
      messages.map(m => ({ type: 'message' as const, message: m }))

    if (streamingBlocks.length > 0) {
      items.push({ type: 'streaming', blocks: streamingBlocks })
    } else if (loading) {
      items.push({ type: 'typing' })
    }

    return items
  }, [messages, streamingBlocks, loading])

  return (
    <div className="flex flex-col h-full bg-[#111827]">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {initialLoading ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">Loading...</div>
        ) : displayItems.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            Ask me anything about this project
          </div>
        ) : (
          displayItems.map((item, i) => {
            if (item.type === 'typing') {
              return <TypingIndicator key="typing" />
            }
            if (item.type === 'streaming') {
              return <StreamingMessage key="streaming" blocks={item.blocks} />
            }
            return <MessageBubble key={item.message.id || i} message={item.message} />
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-gray-800 px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={connected ? 'Message... (Shift+Enter to send)' : 'Connecting...'}
            disabled={!connected}
            rows={1}
            className="flex-1 bg-gray-800 text-sm text-gray-300 rounded px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none resize-none overflow-hidden leading-relaxed"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading || !connected}
            className="shrink-0 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-3 py-2 rounded transition-colors"
          >
            Send
          </button>
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className={`text-[9px] ${connected ? 'text-green-600' : 'text-gray-600'}`}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
          <span className="text-[9px] text-gray-600">Shift+Enter to send</span>
        </div>
      </div>
    </div>
  )
}

// --- Message Bubble ---

function MessageBubble({ message }: { message: PersistedMessage }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 ${
        isUser
          ? 'bg-blue-600/20 text-gray-200'
          : isSystem
            ? 'bg-red-900/20 text-red-300 border border-red-800/30'
            : 'bg-gray-800/60 text-gray-300'
      }`}>
        <MessageContent content={message.content} />
        <div className={`text-[9px] mt-1 ${isUser ? 'text-blue-400/50' : 'text-gray-600'}`}>
          {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  )
}

// --- Message Content Renderer ---

function MessageContent({ content }: { content: string | ContentBlock[] }) {
  if (typeof content === 'string') {
    return (
      <div className="prose prose-invert prose-sm max-w-none [&_p]:my-1 [&_pre]:my-1 [&_code]:text-[11px] [&_code]:bg-gray-900 [&_code]:px-1 [&_code]:rounded">
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {content.map((block, i) => {
        if (block.type === 'text') {
          return (
            <div key={i} className="prose prose-invert prose-sm max-w-none [&_p]:my-1 [&_pre]:my-1 [&_code]:text-[11px] [&_code]:bg-gray-900 [&_code]:px-1 [&_code]:rounded">
              <ReactMarkdown>{block.text}</ReactMarkdown>
            </div>
          )
        }
        if (block.type === 'tool_use') {
          return <ToolCallBadge key={block.id} name={block.name} status="success" />
        }
        if (block.type === 'tool_result') {
          return null // tool results are shown via badges
        }
        return null
      })}
    </div>
  )
}

// --- Streaming Message ---

function StreamingMessage({ blocks }: { blocks: StreamingBlock[] }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg px-3 py-2 bg-gray-800/60 text-gray-300 space-y-2">
        {blocks.map((block, i) => {
          if (block.type === 'text') {
            return (
              <div key={i} className="prose prose-invert prose-sm max-w-none [&_p]:my-1 [&_pre]:my-1 [&_code]:text-[11px] [&_code]:bg-gray-900 [&_code]:px-1 [&_code]:rounded">
                <ReactMarkdown>{block.text}</ReactMarkdown>
              </div>
            )
          }
          if (block.type === 'tool_use') {
            return <ToolCallBadge key={block.id} name={block.name} status={block.status} />
          }
          return null
        })}
        <span className="inline-block w-2 h-4 bg-gray-500 animate-pulse rounded-sm ml-0.5" />
      </div>
    </div>
  )
}

// --- Tool Call Badge ---

function ToolCallBadge({ name, status }: { name: string; status: 'pending' | 'success' | 'error' }) {
  const colors = {
    pending: 'bg-blue-900/20 text-blue-400 border-blue-800/30',
    success: 'bg-green-900/20 text-green-400 border-green-800/30',
    error: 'bg-red-900/20 text-red-400 border-red-800/30',
  }
  const icons = {
    pending: '⟳',
    success: '✓',
    error: '✗',
  }

  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded border ${colors[status]}`}>
      <span className={status === 'pending' ? 'animate-spin' : ''}>{icons[status]}</span>
      <span className="font-mono">{name}</span>
    </span>
  )
}

// --- Typing Indicator ---

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bg-gray-800/60 rounded-lg px-3 py-2 flex items-center gap-1">
        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:0ms]" />
        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:150ms]" />
        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:300ms]" />
        <span className="text-[10px] text-gray-600 ml-1.5">Thinking</span>
      </div>
    </div>
  )
}
