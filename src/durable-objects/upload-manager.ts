import { DurableObject } from 'cloudflare:workers'

/** Allowed MIME types for uploads. Customize per project. */
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']

/** Maximum upload size in bytes (default 10MB). */
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024

interface UploadSession {
  contextId: string
  userId: string
  uploads: Map<string, UploadState>
}

interface UploadState {
  uploadId: string
  filename: string
  contentType: string
  totalSize: number
  receivedSize: number
  chunks: Uint8Array[]
  status: 'receiving' | 'uploading' | 'complete' | 'error'
  storagePath?: string
  uploadUrl?: string
  error?: string
}

type ClientMessage =
  | { type: 'init'; contextId: string; userId: string }
  | {
      type: 'upload-start'
      uploadId: string
      filename: string
      contentType: string
      totalSize: number
      uploadUrl: string
      storagePath: string
    }
  | { type: 'upload-chunk'; uploadId: string; offset: number }
  | { type: 'upload-cancel'; uploadId: string }

type ServerMessage =
  | { type: 'ready' }
  | { type: 'progress'; uploadId: string; phase: 'transfer' | 'upload'; percent: number }
  | { type: 'complete'; uploadId: string; storagePath: string }
  | { type: 'error'; uploadId: string; message: string }
  | { type: 'session-error'; message: string }

/**
 * UploadManager Durable Object
 * Handles file uploads via WebSocket with progress streaming.
 *
 * Flow:
 * 1. Client connects via WebSocket
 * 2. Client sends 'init' with contextId and userId
 * 3. For each file:
 *    a. Client gets a signed URL from the API first
 *    b. Client sends 'upload-start' with file metadata and signed URL
 *    c. Client sends binary chunks with 'upload-chunk' text frames for metadata
 *    d. DO accumulates chunks, reports 0-50% progress (transfer phase)
 *    e. Once all chunks received, DO uploads to storage using signed URL
 *    f. DO reports 50-100% progress (upload phase)
 *    g. DO sends 'complete' with storagePath
 */
export class UploadManager extends DurableObject {
  private sessions: Map<WebSocket, UploadSession> = new Map()

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    this.ctx.acceptWebSocket(server)

    // Initialize empty session; will be populated on 'init' message
    this.sessions.set(server, {
      contextId: '',
      userId: '',
      uploads: new Map(),
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(ws)
    if (!session) {
      this.sendMessage(ws, { type: 'session-error', message: 'No session found' })
      return
    }

    // Binary message = upload chunk data
    if (message instanceof ArrayBuffer) {
      await this.handleBinaryChunk(ws, session, new Uint8Array(message))
      return
    }

    try {
      const msg = JSON.parse(message) as ClientMessage

      switch (msg.type) {
        case 'init':
          session.contextId = msg.contextId
          session.userId = msg.userId
          this.sendMessage(ws, { type: 'ready' })
          break

        case 'upload-start':
          await this.handleUploadStart(ws, session, msg)
          break

        case 'upload-chunk':
          // Text frame with chunk metadata; the actual binary follows
          // Store the current uploadId context for the next binary message
          ;(session as any)._currentUploadId = msg.uploadId
          break

        case 'upload-cancel':
          session.uploads.delete(msg.uploadId)
          break

        default:
          this.sendMessage(ws, { type: 'session-error', message: 'Unknown message type' })
      }
    } catch (err) {
      this.sendMessage(ws, {
        type: 'session-error',
        message: `Invalid message: ${err instanceof Error ? err.message : 'parse error'}`,
      })
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws)
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.sessions.delete(ws)
  }

  private async handleUploadStart(
    ws: WebSocket,
    session: UploadSession,
    msg: Extract<ClientMessage, { type: 'upload-start' }>
  ): Promise<void> {
    // Validate file type
    if (!ALLOWED_MIME_TYPES.includes(msg.contentType)) {
      this.sendMessage(ws, {
        type: 'error',
        uploadId: msg.uploadId,
        message: `Invalid file type: ${msg.contentType}`,
      })
      return
    }

    // Validate file size
    if (msg.totalSize > MAX_UPLOAD_SIZE) {
      this.sendMessage(ws, {
        type: 'error',
        uploadId: msg.uploadId,
        message: `File too large. Maximum size is ${Math.round(MAX_UPLOAD_SIZE / (1024 * 1024))}MB.`,
      })
      return
    }

    const state: UploadState = {
      uploadId: msg.uploadId,
      filename: msg.filename,
      contentType: msg.contentType,
      totalSize: msg.totalSize,
      receivedSize: 0,
      chunks: [],
      status: 'receiving',
      storagePath: msg.storagePath,
      uploadUrl: msg.uploadUrl,
    }

    session.uploads.set(msg.uploadId, state)
    ;(session as any)._currentUploadId = msg.uploadId

    this.sendMessage(ws, {
      type: 'progress',
      uploadId: msg.uploadId,
      phase: 'transfer',
      percent: 0,
    })
  }

  private async handleBinaryChunk(
    ws: WebSocket,
    session: UploadSession,
    data: Uint8Array
  ): Promise<void> {
    const uploadId = (session as any)._currentUploadId as string | undefined
    if (!uploadId) {
      this.sendMessage(ws, { type: 'session-error', message: 'No active upload for binary data' })
      return
    }

    const state = session.uploads.get(uploadId)
    if (!state || state.status !== 'receiving') {
      return
    }

    state.chunks.push(data)
    state.receivedSize += data.length

    // Phase 1 progress: 0-50% (transfer from client to DO)
    const transferPercent = Math.min(
      50,
      Math.round((state.receivedSize / state.totalSize) * 50)
    )
    this.sendMessage(ws, {
      type: 'progress',
      uploadId,
      phase: 'transfer',
      percent: transferPercent,
    })

    // Check if transfer is complete
    if (state.receivedSize >= state.totalSize) {
      await this.uploadToStorage(ws, session, state)
    }
  }

  private async uploadToStorage(
    ws: WebSocket,
    session: UploadSession,
    state: UploadState
  ): Promise<void> {
    state.status = 'uploading'

    this.sendMessage(ws, {
      type: 'progress',
      uploadId: state.uploadId,
      phase: 'upload',
      percent: 50,
    })

    try {
      // Combine chunks into a single buffer
      const totalLength = state.chunks.reduce((sum, c) => sum + c.length, 0)
      const combined = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of state.chunks) {
        combined.set(chunk, offset)
        offset += chunk.length
      }

      // Upload to storage using signed URL
      if (!state.uploadUrl) {
        throw new Error('No upload URL available')
      }

      const response = await fetch(state.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': state.contentType,
          'Content-Length': String(combined.length),
        },
        body: combined,
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Storage upload failed: ${response.status} ${text}`)
      }

      state.status = 'complete'
      state.chunks = [] // Free memory

      this.sendMessage(ws, {
        type: 'progress',
        uploadId: state.uploadId,
        phase: 'upload',
        percent: 100,
      })

      this.sendMessage(ws, {
        type: 'complete',
        uploadId: state.uploadId,
        storagePath: state.storagePath!,
      })
    } catch (err) {
      state.status = 'error'
      state.error = err instanceof Error ? err.message : 'Upload failed'
      state.chunks = [] // Free memory

      this.sendMessage(ws, {
        type: 'error',
        uploadId: state.uploadId,
        message: state.error,
      })
    }
  }

  private sendMessage(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // WebSocket may have closed
    }
  }
}
