import { useEffect, useRef } from 'react'
import { openPreviewStream, type PreviewStream } from '@/lib/preview-client'

const MIME_TYPE = 'video/mp4; codecs="avc1.42E01E"'

/**
 * Wire a <video> element to the backend's MSE playback stream.
 *
 * Lifecycle:
 *   - When `playing` flips to true, opens a WebSocket + MediaSource and tells
 *     the backend to play from `currentTime`.
 *   - When `playing` flips to false, tears the whole pipe down (close socket,
 *     end MediaSource). The `<video>` retains the last-rendered frame.
 *   - `seek` is triggered when `currentTime` changes while already playing.
 *     The backend rebuilds its encoder on seek, so we mirror that by
 *     tearing down the existing MediaSource and rebuilding. Incoming
 *     fragments after the seek are appended to the fresh SourceBuffer.
 *
 * The caller (<PreviewViewport>) owns the `<video>` element ref.
 */
export function useMSEPlayback(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  projectName: string,
  playing: boolean,
  currentTime: number,
): void {
  // Track the current stream + resources so we can tear down cleanly
  const streamRef = useRef<PreviewStream | null>(null)
  const mediaSourceRef = useRef<MediaSource | null>(null)
  const sourceBufferRef = useRef<SourceBuffer | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  // Pending fragments queued while SourceBuffer is updating
  const pendingFragments = useRef<ArrayBuffer[]>([])
  const hasAppendedInit = useRef(false)

  // Track which seek we're currently servicing so stale async callbacks bail
  const generationRef = useRef(0)

  // Spin up playback whenever `playing` becomes true (or `currentTime` moves while playing)
  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl || !playing) {
      teardown()
      return
    }

    const gen = ++generationRef.current
    startPlayback(videoEl, gen)

    return () => {
      // Cleanup when deps change or component unmounts
      teardown()
    }
    // We intentionally re-run on currentTime changes to service seeks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, currentTime, projectName])

  function startPlayback(videoEl: HTMLVideoElement, gen: number) {
    teardown()

    pendingFragments.current = []
    hasAppendedInit.current = false

    const ms = new MediaSource()
    mediaSourceRef.current = ms
    const objectUrl = URL.createObjectURL(ms)
    objectUrlRef.current = objectUrl
    videoEl.src = objectUrl

    ms.addEventListener('sourceopen', () => {
      if (gen !== generationRef.current) return
      if (!MediaSource.isTypeSupported(MIME_TYPE)) {
        console.error('[useMSEPlayback] browser does not support', MIME_TYPE)
        return
      }
      let sb: SourceBuffer
      try {
        sb = ms.addSourceBuffer(MIME_TYPE)
      } catch (err) {
        console.error('[useMSEPlayback] addSourceBuffer failed', err)
        return
      }
      sourceBufferRef.current = sb
      sb.addEventListener('updateend', () => flushPending(gen))

      // Open the WebSocket now that the SourceBuffer is ready
      const stream = openPreviewStream(projectName, {
        onFragment: (bytes) => enqueueFragment(bytes, gen),
        onError: (err) => {
          if (gen !== generationRef.current) return
          console.warn('[useMSEPlayback] stream error', err)
        },
        onClose: () => {
          if (gen !== generationRef.current) return
          try { if (ms.readyState === 'open') ms.endOfStream() } catch { /* noop */ }
        },
      })
      streamRef.current = stream
      stream.play(currentTime)

      // Start the video playing immediately — it'll pause itself at the
      // first frame while waiting for fragments, then resume.
      videoEl.play().catch(() => { /* autoplay may be blocked; UI prompts user */ })
    })

    ms.addEventListener('sourceended', () => {
      if (gen !== generationRef.current) return
    })
  }

  function enqueueFragment(bytes: ArrayBuffer, gen: number) {
    if (gen !== generationRef.current) return
    pendingFragments.current.push(bytes)
    flushPending(gen)
  }

  function flushPending(gen: number) {
    if (gen !== generationRef.current) return
    const sb = sourceBufferRef.current
    const ms = mediaSourceRef.current
    if (!sb || !ms || ms.readyState !== 'open') return
    if (sb.updating) return
    const next = pendingFragments.current.shift()
    if (!next) return
    try {
      sb.appendBuffer(new Uint8Array(next))
      if (!hasAppendedInit.current) hasAppendedInit.current = true
    } catch (err) {
      // QuotaExceededError — evict behind the playhead and retry
      const videoEl = videoRef.current
      if ((err as DOMException)?.name === 'QuotaExceededError' && videoEl) {
        try {
          sb.remove(0, Math.max(0, videoEl.currentTime - 10))
          pendingFragments.current.unshift(next) // retry after eviction
        } catch { /* noop */ }
      } else {
        console.warn('[useMSEPlayback] appendBuffer failed', err)
      }
    }
  }

  function teardown() {
    // Bump generation so any in-flight async callbacks bail out
    generationRef.current++

    const stream = streamRef.current
    if (stream) {
      try { stream.stop() } catch { /* noop */ }
      try { stream.close() } catch { /* noop */ }
      streamRef.current = null
    }

    const ms = mediaSourceRef.current
    if (ms) {
      try { if (ms.readyState === 'open') ms.endOfStream() } catch { /* noop */ }
      mediaSourceRef.current = null
    }

    sourceBufferRef.current = null
    pendingFragments.current = []
    hasAppendedInit.current = false

    const objectUrl = objectUrlRef.current
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrlRef.current = null
    }
  }
}
