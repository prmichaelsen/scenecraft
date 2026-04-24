import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { ChatWebSocket, fetchChatHistory, type ServerMessage, type PersistedMessage, type StreamingBlock, type ContentBlock, type ElicitationRequest, type ToolCallRecord } from '@/lib/chat-client'

type ChatPanelProps = {
  projectName: string
  onClose: () => void
  /**
   * Called after any successful agent tool call that could have mutated
   * project state. Hosts wire this to `router.invalidate()` / `refreshTimeline()`
   * so edit surfaces (AudioPropertiesPanel, MacroPanel, Timeline, etc.) pick
   * up the change. Fires on `tool_result` events with `isError: false` —
   * read-only tools like `sql_query` also fire it (cheap no-op refetch).
   */
  onMutation?: () => void
}

export function ChatPanel({ projectName, onMutation }: ChatPanelProps) {
  const [messages, setMessages] = useState<PersistedMessage[]>([])
  const [streamingBlocks, setStreamingBlocks] = useState<StreamingBlock[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  // Virtuoso-managed scroller. `atBottom` gates whether the stream drives the
  // viewport — if the user has scrolled up to read older messages, new chunks
  // and new messages do NOT yank them back down. Matches the agentbase.me
  // chat pattern: followOutput only when isAtBottom, plus a manual scroll
  // when the streaming content grows the existing last item (Virtuoso fires
  // totalListHeightChanged/itemsRendered but followOutput itself only reacts
  // to item count).
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wsRef = useRef<ChatWebSocket | null>(null)

  // Unconditional scroll — used for events we initiated on behalf of the user
  // (initial history load, send). atBottom gating is applied separately for
  // streaming-driven scroll (see useEffect below).
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: 'LAST',
        align: 'end',
        behavior: 'smooth',
      })
    })
  }, [])

  // Handle incoming WebSocket messages. Stream-driven events no longer
  // force-scroll — Virtuoso's followOutput(isAtBottom) handles item-count
  // growth and the streaming-blocks useEffect below handles content growth
  // of the currently-streaming item. Both gate on `atBottom`, so a user who
  // scrolled up to read older messages is never yanked back down.
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
        break

      case 'tool_call':
        setStreamingBlocks(prev => [...prev, {
          type: 'tool_use', id: msg.toolCall.id, name: msg.toolCall.name, status: 'pending',
        }])
        break

      case 'tool_result':
        setStreamingBlocks(prev => prev.map(b =>
          b.type === 'tool_use' && b.id === msg.toolResult.id
            ? { ...b, status: msg.toolResult.isError ? 'error' : 'success', progress: undefined } as StreamingBlock
            : b
        ))
        // Every successful tool run potentially mutated project state
        // (update_volume_curve, add_audio_effect, apply_mix_plan, etc.).
        // Notify the host so Timeline + panels refetch. Errors skip —
        // no mutation occurred server-side to reflect.
        if (!msg.toolResult.isError) {
          onMutation?.()
        }
        break

      case 'tool_progress':
        setStreamingBlocks(prev => prev.map(b =>
          b.type === 'tool_use' && b.id === msg.toolProgress.id
            ? { ...b, progress: msg.toolProgress } as StreamingBlock
            : b
        ))
        break

      case 'elicitation':
        setStreamingBlocks(prev => [...prev, {
          type: 'elicitation', elicitation: msg.elicitation, resolution: 'pending',
        }])
        break

      case 'message':
        setMessages(prev => {
          if (msg.message.role === 'user' && prev.length > 0) {
            const last = prev[prev.length - 1]
            if (
              last.role === 'user' &&
              typeof last.content === 'string' &&
              typeof msg.message.content === 'string' &&
              last.content === msg.message.content
            ) {
              return [...prev.slice(0, -1), msg.message]
            }
          }
          return [...prev, msg.message]
        })
        setStreamingBlocks([])
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
        break

      case 'status':
        // Could show in a status bar, for now just log
        break
    }
  }, [])

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

  // Respond to an elicitation prompt
  const respondElicitation = useCallback((elicitationId: string, action: 'accept' | 'decline') => {
    wsRef.current?.send({ type: 'elicitation_response', id: elicitationId, action })
    setStreamingBlocks(prev => prev.map(b =>
      b.type === 'elicitation' && b.elicitation.id === elicitationId
        ? { ...b, resolution: action === 'accept' ? 'accepted' : 'declined' } as StreamingBlock
        : b
    ))
  }, [])

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

  // followOutput only re-fires when the item count changes. While a single
  // streaming item grows with chunk deltas, the item count is stable, so we
  // re-run scrollToIndex here — but only if the user is still at the bottom.
  useEffect(() => {
    if (!atBottom) return
    if (streamingBlocks.length === 0) return
    virtuosoRef.current?.scrollToIndex({
      index: 'LAST',
      align: 'end',
      behavior: 'auto',
    })
  }, [streamingBlocks, atBottom])

  return (
    <div className="flex flex-col h-full bg-[#111827]">
      {/* Messages */}
      {initialLoading ? (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">Loading...</div>
      ) : displayItems.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          Ask me anything about this project
        </div>
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          className="flex-1"
          data={displayItems}
          initialTopMostItemIndex={displayItems.length - 1}
          atBottomStateChange={setAtBottom}
          followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
          computeItemKey={(_index, item) => {
            if (item.type === 'message') return `m:${item.message.id}`
            if (item.type === 'streaming') return '__streaming__'
            return '__typing__'
          }}
          itemContent={(_index, item) => {
            if (item.type === 'typing') {
              return (
                <div className="px-3 py-1.5">
                  <TypingIndicator />
                </div>
              )
            }
            if (item.type === 'streaming') {
              return (
                <div className="px-3 py-1.5">
                  <StreamingMessage blocks={item.blocks} onElicitationResponse={respondElicitation} />
                </div>
              )
            }
            return (
              <div className="px-3 py-1.5">
                <MessageBubble message={item.message} />
              </div>
            )
          }}
        />
      )}

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
        <div className="flex items-center justify-between mt-1 gap-2">
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
        <MessageContent content={message.content} toolCalls={message.tool_calls} />
        <div className={`text-[9px] mt-1 ${isUser ? 'text-blue-400/50' : 'text-gray-600'}`}>
          {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  )
}

// --- Message Content Renderer ---

function MessageContent({ content, toolCalls }: { content: string | ContentBlock[]; toolCalls?: ToolCallRecord[] }) {
  if (typeof content === 'string') {
    return (
      <div className="prose prose-invert prose-sm max-w-none [&_p]:my-1 [&_pre]:my-1 [&_code]:text-[11px] [&_code]:bg-gray-900 [&_code]:px-1 [&_code]:rounded">
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    )
  }

  const tcById = new Map<string, ToolCallRecord>()
  for (const tc of toolCalls || []) {
    if (tc.id) tcById.set(tc.id, tc)
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
          const tc = tcById.get(block.id)
          const status: 'pending' | 'success' | 'error' = tc?.is_error ? 'error' : 'success'
          return <ToolCallBadge key={block.id} name={block.name} status={status} />
        }
        if (block.type === 'tool_result') {
          return null
        }
        return null
      })}
    </div>
  )
}

// --- Streaming Message ---

function StreamingMessage({ blocks, onElicitationResponse }: {
  blocks: StreamingBlock[]
  onElicitationResponse: (id: string, action: 'accept' | 'decline') => void
}) {
  const hasPendingElicitation = blocks.some(b => b.type === 'elicitation' && b.resolution === 'pending')
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] w-full rounded-lg px-3 py-2 bg-gray-800/60 text-gray-300 space-y-2">
        {blocks.map((block, i) => {
          if (block.type === 'text') {
            return (
              <div key={i} className="prose prose-invert prose-sm max-w-none [&_p]:my-1 [&_pre]:my-1 [&_code]:text-[11px] [&_code]:bg-gray-900 [&_code]:px-1 [&_code]:rounded">
                <ReactMarkdown>{block.text}</ReactMarkdown>
              </div>
            )
          }
          if (block.type === 'tool_use') {
            return <ToolCallBadge key={block.id} name={block.name} status={block.status} progress={block.progress} />
          }
          if (block.type === 'elicitation') {
            return (
              <ElicitationCard
                key={block.elicitation.id}
                request={block.elicitation}
                resolution={block.resolution}
                onRespond={onElicitationResponse}
              />
            )
          }
          return null
        })}
        {!hasPendingElicitation && <span className="inline-block w-2 h-4 bg-gray-500 animate-pulse rounded-sm ml-0.5" />}
      </div>
    </div>
  )
}

// --- Elicitation Card ---

function ElicitationCard({ request, resolution, onRespond }: {
  request: ElicitationRequest
  resolution: 'pending' | 'accepted' | 'declined'
  onRespond: (id: string, action: 'accept' | 'decline') => void
}) {
  const pending = resolution === 'pending'
  const accepted = resolution === 'accepted'

  return (
    <div className={`border rounded-md p-2.5 my-1 space-y-1.5 transition-opacity ${
      pending
        ? 'border-amber-700/60 bg-amber-900/10'
        : accepted
          ? 'border-green-800/40 bg-green-900/10 opacity-75'
          : 'border-gray-700 bg-gray-900/40 opacity-60'
    }`}>
      <div className="flex items-start gap-2">
        <span className="text-amber-400 text-sm leading-tight">🔧</span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-medium text-gray-200 leading-tight">{request.title}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">{request.message}</div>
        </div>
      </div>
      {request.summary_items && request.summary_items.length > 0 && (
        <ul className="text-[10px] text-gray-400 font-mono space-y-0.5 pl-5 border-l border-gray-700/60 ml-1">
          {request.summary_items.map((s, i) => (
            <li key={i} className="truncate">{s}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        {pending ? (
          <>
            <button
              onClick={() => onRespond(request.id, 'decline')}
              className="text-[10px] px-2 py-0.5 rounded text-gray-300 bg-gray-800 hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              onClick={() => onRespond(request.id, 'accept')}
              className="text-[10px] px-2 py-0.5 rounded text-white bg-amber-700 hover:bg-amber-600"
            >
              Confirm
            </button>
          </>
        ) : (
          <span className={`text-[10px] ${accepted ? 'text-green-500' : 'text-gray-500'}`}>
            {accepted ? '✓ Confirmed' : 'Cancelled'}
          </span>
        )}
      </div>
    </div>
  )
}

// --- Tool Call Badge ---

function ToolCallBadge({ name, status, progress }: {
  name: string
  status: 'pending' | 'success' | 'error'
  progress?: { pct: number; message: string }
}) {
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
      {status === 'pending' && progress && (
        <span className="text-blue-300/80 font-mono">
          · {Math.round(progress.pct * 100)}% {progress.message}
        </span>
      )}
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
