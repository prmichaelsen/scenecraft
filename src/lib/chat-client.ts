const SCENECRAFT_WS_URL = import.meta.env.VITE_SCENECRAFT_WS_URL || 'ws://localhost:8891'

// --- Types ---

export type ElicitationRequest = {
  id: string
  tool_use_id: string
  tool_name: string
  title: string
  message: string
  summary_items?: string[]
  schema?: Record<string, unknown>
}

export type ToolProgress = {
  id: string
  phase: string
  pct: number
  message: string
}

/**
 * Mix-render round-trip (M15 task-7).
 *
 * Server → Client (WS):
 *   { type: 'mix_render_request',
 *     request_id:      string (uuid4 hex),
 *     mix_graph_hash:  string (64-char hex SHA-256),
 *     start_time_s:    number,
 *     end_time_s:      number,
 *     sample_rate:     number }
 *
 * Client → Server (HTTP multipart POST):
 *   POST /api/projects/:name/mix-render-upload
 *     audio:           WAV blob (16-bit PCM)
 *     mix_graph_hash:  string
 *     start_time_s:    number
 *     end_time_s:      number
 *     sample_rate:     number
 *     channels:        number (1 or 2)
 *     request_id:      string  ← echoed back so the server can release
 *                                the waiting chat tool.
 */
export type MixRenderRequest = {
  type: 'mix_render_request'
  request_id: string
  mix_graph_hash: string
  start_time_s: number
  end_time_s: number
  sample_rate: number
}

export type ServerMessage =
  | { type: 'chunk'; content: string }
  | { type: 'tool_call'; toolCall: { id: string; name: string; input: Record<string, unknown> } }
  | { type: 'tool_result'; toolResult: { id: string; output: unknown; isError?: boolean }; durationMs?: number }
  | { type: 'tool_progress'; toolProgress: ToolProgress }
  | { type: 'message'; message: PersistedMessage }
  | { type: 'status'; statusMessage?: string }
  | { type: 'elicitation'; elicitation: ElicitationRequest }
  | { type: 'complete' }
  | { type: 'error'; error: string }
  | MixRenderRequest

export type ClientMessage =
  | { type: 'message'; content: string; images?: string[] }
  | { type: 'elicitation_response'; id: string; action: 'accept' | 'decline'; content?: Record<string, unknown> }

export type ToolCallRecord = {
  id: string
  name: string
  input?: Record<string, unknown>
  output?: unknown
  is_error?: boolean
  cancelled?: boolean
  duration_ms?: number
}

export type PersistedMessage = {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
  images?: string[]
  tool_calls?: ToolCallRecord[]
  created_at: string
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export type StreamingBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; status: 'pending' | 'success' | 'error'; progress?: ToolProgress }
  | { type: 'elicitation'; elicitation: ElicitationRequest; resolution: 'pending' | 'accepted' | 'declined' }

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

// --- Mix-render round-trip handler (M15 task-7) ---

import type { AudioTrack } from './audio-client'
import { encodePCMToWav, renderMixToBuffer, type MixRenderOptions } from './mix-render'
import { fetchAudioTracks } from './audio-client'

/**
 * Minimal mixer surface the handler needs — matches ``AudioMixer`` from
 * ``audio-mixer.ts`` but deliberately typed as a subset so callers can
 * also pass a mock with only the methods used here.
 */
export type PausableMixer = {
  pause(): void
  play(): void
}

export type HandleMixRenderRequestOptions = {
  /** Name of the project whose WAV is being rendered (URL-encoded in POST). */
  projectName: string
  /** Current tracks to feed into ``renderMixToBuffer``. When absent, the handler
   *  fetches fresh tracks from ``/audio-tracks`` — useful from contexts that
   *  don't hold the track list (e.g. the chat panel). */
  tracks?: readonly AudioTrack[]
  /** Active mixer. When playing, it will be paused for the duration of the
   *  offline render and resumed afterward. Absent: no pause/resume is done. */
  mixer?: PausableMixer | null
  /** True if the mixer is currently playing — used to decide whether to
   *  resume after the upload. Caller's responsibility to read this from the
   *  same state the play button reflects. */
  isPlaying?: boolean

  // ── Test injection hooks ─────────────────────────────────────────────────
  /** Override fetch for the multipart POST (tests mock this). */
  fetchImpl?: typeof fetch
  /** Override renderer (tests mock this). */
  renderImpl?: typeof renderMixToBuffer
  /** Override WAV encoder (tests mock this). */
  encodeImpl?: typeof encodePCMToWav
  /** Override audio-tracks fetcher (tests mock this). */
  fetchTracksImpl?: typeof fetchAudioTracks
  /** Override the apiBase URL — defaults to the module-level constant. */
  apiBase?: string
  /** Extra options forwarded to ``renderMixToBuffer`` (e.g. buffer cache). */
  renderExtras?: Pick<MixRenderOptions, 'bufferCache' | 'offlineCtxFactory' | 'sourceUrlFactory' | 'fetchBytes' | 'decode'>
}

/**
 * Handle a server-initiated ``mix_render_request``. Renders the project via
 * ``OfflineAudioContext``, encodes the result to a WAV, and POSTs it to the
 * backend's ``/mix-render-upload`` endpoint — echoing ``request_id`` so the
 * backend's analyze-master-bus tool can unblock.
 *
 * Errors are swallowed and logged. The backend times out on its own after
 * 60s; never retrying is fine because any transient problem (dropped WS,
 * decode failure, 500 on upload) is better reported via the chat's own
 * error channel rather than looping on the user's machine.
 *
 * Pauses live playback while the offline render runs so neither audio
 * pipeline contends for the same decoded buffers. Resumes only if playback
 * was active beforehand.
 */
export async function handleMixRenderRequest(
  msg: MixRenderRequest,
  opts: HandleMixRenderRequestOptions,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const renderImpl = opts.renderImpl ?? renderMixToBuffer
  const encodeImpl = opts.encodeImpl ?? encodePCMToWav
  const fetchTracksImpl = opts.fetchTracksImpl ?? fetchAudioTracks
  const apiBase = opts.apiBase ?? SCENECRAFT_API_URL

  const wasPlaying = Boolean(opts.isPlaying)
  if (wasPlaying && opts.mixer) {
    try { opts.mixer.pause() } catch (e) { console.warn('[mix-render] pause() failed:', e) }
  }

  try {
    const tracks = opts.tracks ?? (await fetchTracksImpl(opts.projectName))

    const result = await renderImpl(tracks, {
      projectName: opts.projectName,
      startTimeS: msg.start_time_s,
      endTimeS: msg.end_time_s,
      sampleRate: msg.sample_rate,
      channels: 2,
      ...(opts.renderExtras ?? {}),
    })

    const wav = encodeImpl(result.pcm, result.sampleRate, result.channels)

    // Multipart upload. We build the form body with Blob parts so the
    // request_id and numeric fields land as plain text form fields, matching
    // the api_server's multipart parser.
    const form = new FormData()
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'mix.wav')
    form.append('mix_graph_hash', msg.mix_graph_hash)
    form.append('start_time_s', String(msg.start_time_s))
    form.append('end_time_s', String(msg.end_time_s))
    form.append('sample_rate', String(result.sampleRate))
    form.append('channels', String(result.channels))
    form.append('request_id', msg.request_id)

    const res = await fetchImpl(
      `${apiBase}/api/projects/${encodeURIComponent(opts.projectName)}/mix-render-upload`,
      { method: 'POST', body: form },
    )
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      console.warn(`[mix-render] upload failed: ${res.status} ${txt}`)
      return
    }
  } catch (err) {
    console.warn('[mix-render] handler failed:', err)
  } finally {
    if (wasPlaying && opts.mixer) {
      try { opts.mixer.play() } catch (e) { console.warn('[mix-render] play() failed:', e) }
    }
  }
}
