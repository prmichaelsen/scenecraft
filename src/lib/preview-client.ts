/**
 * Backend-rendered preview client.
 *
 * Backs the <PreviewViewport> component by talking to the scenecraft-engine
 * backend:
 *
 *  - `fetchScrubFrame`  : one-shot JPEG from `/api/projects/:name/render-frame`
 *                         used for paused / scrubbing state
 *  - `openPreviewStream`: bidirectional WebSocket to `/ws/preview-stream/:name`
 *                         for MSE playback (fMP4 fragments)
 *
 * Seek note — the backend rebuilds the encoder on seek, so consumers must
 * close the current MediaSource/SourceBuffer and open a new stream on seek.
 */

const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'
const SCENECRAFT_WS_URL = import.meta.env.VITE_SCENECRAFT_WS_URL || 'ws://localhost:8891'

// ── Scrub ──────────────────────────────────────────────────────────

export class ScrubFetchError extends Error {
  constructor(public status: number, public body: string) {
    super(`render-frame ${status}: ${body}`)
    this.name = 'ScrubFetchError'
  }
}

/**
 * Fetch a single composited frame from the backend and decode it to an
 * ImageBitmap ready to blit onto a canvas.
 *
 * Pass an AbortSignal to cancel in-flight fetches — used by the
 * background prefetcher to drop stale work when the playhead moves.
 * Primary scrub requests typically don't need cancellation (paint is
 * gated by caller on the latest-t check).
 */
export async function fetchScrubFrame(
  project: string,
  t: number,
  quality = 85,
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  const url =
    `${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}` +
    `/render-frame?t=${t}&quality=${quality}`
  const res = await fetch(url, { credentials: 'include', signal })
  if (!res.ok) {
    throw new ScrubFetchError(res.status, await res.text().catch(() => ''))
  }
  const blob = await res.blob()
  return await createImageBitmap(blob)
}

// ── Playback (MSE) ─────────────────────────────────────────────────

export type PreviewStreamEvents = {
  /** Fired for each binary frame from the server. First is the fMP4 init segment. */
  onFragment: (bytes: ArrayBuffer) => void
  /** Fired on socket error or explicit server error message. */
  onError?: (err: Error) => void
  /** Fired when the socket closes (clean or not). */
  onClose?: () => void
}

export type PreviewStream = {
  play(t: number): void
  seek(t: number): void
  pause(): void
  stop(): void
  close(): void
  readyState(): 'connecting' | 'open' | 'closing' | 'closed'
}

/**
 * Open a MSE playback stream for a project. The returned object proxies
 * play/seek/pause/stop commands over the WebSocket. Binary frames are
 * surfaced via `events.onFragment`.
 *
 * The caller is responsible for:
 *  - calling `close()` when done (e.g. on unmount)
 *  - handling the seek-tears-down-MediaSource contract (close + reopen)
 */
export function openPreviewStream(
  project: string,
  events: PreviewStreamEvents,
): PreviewStream {
  const url = `${SCENECRAFT_WS_URL}/ws/preview-stream/${encodeURIComponent(project)}`
  console.log('[preview-client] openPreviewStream →', url)
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'

  // Commands issued before `open` get buffered until the socket is ready.
  const outbox: string[] = []
  let isOpen = false

  ws.addEventListener('open', () => {
    console.log('[preview-client] WS open, flushing outbox:', outbox.length)
    isOpen = true
    for (const msg of outbox) ws.send(msg)
    outbox.length = 0
  })

  ws.addEventListener('message', (ev) => {
    const data = ev.data
    if (typeof data === 'string') {
      // Server error messages arrive as text (JSON). Everything else is binary.
      try {
        const parsed = JSON.parse(data)
        if (parsed?.type === 'error' && events.onError) {
          events.onError(new Error(parsed.error || 'preview-stream error'))
        }
      } catch {
        // Non-JSON text — ignore.
      }
      return
    }
    if (data instanceof ArrayBuffer) {
      events.onFragment(data)
    } else if (data instanceof Blob) {
      data.arrayBuffer().then(events.onFragment).catch(() => {})
    }
  })

  ws.addEventListener('error', (ev) => {
    console.warn('[preview-client] WS error event', ev)
    events.onError?.(new Error('preview-stream socket error'))
  })

  ws.addEventListener('close', (ev) => {
    console.log('[preview-client] WS close code=', ev.code, 'reason=', ev.reason, 'wasClean=', ev.wasClean)
    isOpen = false
    events.onClose?.()
  })

  const send = (obj: Record<string, unknown>) => {
    const msg = JSON.stringify(obj)
    if (isOpen) {
      console.log('[preview-client] send (live):', msg)
      ws.send(msg)
    } else {
      console.log('[preview-client] send (queued, ws state=', ws.readyState, '):', msg)
      outbox.push(msg)
    }
  }

  return {
    play(t: number) { send({ action: 'play', t }) },
    seek(t: number) { send({ action: 'seek', t }) },
    pause() { send({ action: 'pause' }) },
    stop() { send({ action: 'stop' }) },
    close() {
      try { ws.close() } catch { /* noop */ }
    },
    readyState() {
      switch (ws.readyState) {
        case WebSocket.CONNECTING: return 'connecting'
        case WebSocket.OPEN: return 'open'
        case WebSocket.CLOSING: return 'closing'
        default: return 'closed'
      }
    },
  }
}
