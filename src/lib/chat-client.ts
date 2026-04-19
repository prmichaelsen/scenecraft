const SCENECRAFT_WS_URL = import.meta.env.VITE_SCENECRAFT_WS_URL || 'ws://localhost:8891'

// --- Types ---

export type ServerMessage =
  | { type: 'chunk'; content: string }
  | { type: 'tool_call'; toolCall: { id: string; name: string; input: Record<string, unknown> } }
  | { type: 'tool_result'; toolResult: { id: string; output: unknown; isError?: boolean }; durationMs?: number }
  | { type: 'message'; message: PersistedMessage }
  | { type: 'status'; statusMessage?: string }
  | { type: 'complete' }
  | { type: 'error'; error: string }

export type ClientMessage =
  | { type: 'message'; content: string; images?: string[] }
  | { type: 'elicitation_response'; id: string; action: 'accept' | 'decline'; content?: Record<string, unknown> }

export type PersistedMessage = {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
  images?: string[]
  created_at: string
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export type StreamingBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; status: 'pending' | 'success' | 'error' }

// --- WebSocket Chat Client ---

export type ChatEventHandler = (msg: ServerMessage) => void

export class ChatWebSocket {
  private ws: WebSocket | null = null
  private projectName: string
  private onMessage: ChatEventHandler
  private onConnectionChange: (connected: boolean) => void
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    projectName: string,
    onMessage: ChatEventHandler,
    onConnectionChange: (connected: boolean) => void,
  ) {
    this.projectName = projectName
    this.onMessage = onMessage
    this.onConnectionChange = onConnectionChange
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return

    const url = `${SCENECRAFT_WS_URL}/ws/chat/${encodeURIComponent(this.projectName)}`
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.reconnectAttempts = 0
      this.onConnectionChange(true)
    }

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage
        this.onMessage(msg)
      } catch {
        console.error('[ChatWS] Failed to parse message:', event.data)
      }
    }

    this.ws.onclose = () => {
      this.onConnectionChange(false)
      this.attemptReconnect()
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts = this.maxReconnectAttempts // prevent reconnect
    this.ws?.close()
    this.ws = null
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return
    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 5000)
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }
}

// --- REST: Load chat history ---

const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

export async function fetchChatHistory(projectName: string, limit = 50): Promise<PersistedMessage[]> {
  try {
    const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(projectName)}/chat?limit=${limit}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.messages || []
  } catch {
    return []
  }
}
