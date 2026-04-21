import { useEffect, useRef } from 'react'
import { openPreviewStream, type PreviewStream } from '@/lib/preview-client'

const MIME_TYPE = 'video/mp4; codecs="avc1.42E01E"'

/**
 * Wire a <video> element to the backend's MSE playback stream.
 *
 * Lifecycle:
 *   - WebSocket opens on mount, closes on unmount. Never closed on play/pause.
 *     Play-pause-play cycles send `action: play` / `action: pause` over the
 *     live socket so the backend can pause its render loop without losing
 *     state.
 *   - MediaSource is also created on mount (empty). SourceBuffer is added on
 *     `sourceopen`. The video element keeps the last-rendered frame when
 *     paused.
 *   - `currentTime` changes while playing are Timeline's rAF ticks — we read
 *     via a ref so we never resubscribe. Explicit seeks will eventually need
 *     a separate seek-detection channel; for now, large currentTime jumps
 *     are not propagated to the backend automatically.
 */
export function useMSEPlayback(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  projectName: string,
  playing: boolean,
  currentTime: number,
): void {
  const streamRef = useRef<PreviewStream | null>(null)
  const mediaSourceRef = useRef<MediaSource | null>(null)
  const sourceBufferRef = useRef<SourceBuffer | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const pendingFragments = useRef<ArrayBuffer[]>([])

  // Read live currentTime + playing via refs so the session effect reacts to
  // the latest values without resubscribing on every tick or toggle.
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime
  const playingRef = useRef(playing)
  playingRef.current = playing

  // Session lifecycle: open WS + MediaSource on mount, close on unmount.
  // NOT on play/pause.
  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl) return

    console.log('[useMSEPlayback] session open for project=', projectName)

    pendingFragments.current = []

    const ms = new MediaSource()
    mediaSourceRef.current = ms
    const objectUrl = URL.createObjectURL(ms)
    objectUrlRef.current = objectUrl
    videoEl.src = objectUrl

    const onSourceOpen = () => {
      console.log('[useMSEPlayback] MediaSource sourceopen')
      if (!MediaSource.isTypeSupported(MIME_TYPE)) {
        console.error('[useMSEPlayback] browser does not support', MIME_TYPE)
        return
      }
      // Set Infinity so fragments with any DTS are accepted. Without this,
      // MediaSource.duration defaults to NaN/0 and far-forward fragments may
      // be silently dropped.
      try { ms.duration = Number.POSITIVE_INFINITY } catch { /* noop */ }

      let sb: SourceBuffer
      try {
        sb = ms.addSourceBuffer(MIME_TYPE)
      } catch (err) {
        console.error('[useMSEPlayback] addSourceBuffer failed', err)
        return
      }
      // Sequence mode: ignore fMP4 timestamps, append in order. Live preview
      // doesn't need seek-to-timecode accuracy.
      try { sb.mode = 'sequence' } catch { /* noop */ }
      sourceBufferRef.current = sb
      sb.addEventListener('updateend', () => {
        const v = videoEl
        console.log(
          '[useMSEPlayback] sb updateend — buffered:',
          v.buffered.length ? `${v.buffered.start(0).toFixed(2)}-${v.buffered.end(v.buffered.length - 1).toFixed(2)}` : 'empty',
          'currentTime=', v.currentTime.toFixed(2),
          'readyState=', v.readyState,
          'paused=', v.paused,
        )
        flushPending()
      })

      const stream = openPreviewStream(projectName, {
        onFragment: enqueueFragment,
        onError: (err) => console.warn('[useMSEPlayback] stream error', err),
        onClose: () => {
          console.log('[useMSEPlayback] stream onClose')
          try { if (ms.readyState === 'open') ms.endOfStream() } catch { /* noop */ }
        },
      })
      streamRef.current = stream

      // If the parent was already in playing=true when the session spun up,
      // the play/pause effect fired before streamRef was set and got a no-op.
      // Kick the initial action here now that the stream exists.
      if (playingRef.current) {
        console.log('[useMSEPlayback] initial play @', currentTimeRef.current)
        stream.play(currentTimeRef.current)
        videoEl.play().catch(() => { /* autoplay may be blocked */ })
      }
    }

    ms.addEventListener('sourceopen', onSourceOpen)

    return () => {
      console.log('[useMSEPlayback] session teardown for project=', projectName)
      const s = streamRef.current
      if (s) {
        try { s.close() } catch { /* noop */ }
        streamRef.current = null
      }
      if (ms) {
        ms.removeEventListener('sourceopen', onSourceOpen)
        try { if (ms.readyState === 'open') ms.endOfStream() } catch { /* noop */ }
      }
      mediaSourceRef.current = null
      sourceBufferRef.current = null
      pendingFragments.current = []
      const url = objectUrlRef.current
      if (url) {
        URL.revokeObjectURL(url)
        objectUrlRef.current = null
      }
    }
  }, [projectName])

  // Play/pause: drive the backend via action messages on the live socket.
  useEffect(() => {
    const videoEl = videoRef.current
    const stream = streamRef.current
    if (!videoEl) return

    if (playing) {
      console.log('[useMSEPlayback] play action @', currentTimeRef.current)
      stream?.play(currentTimeRef.current)
      videoEl.play().catch(() => { /* autoplay may be blocked */ })
    } else {
      console.log('[useMSEPlayback] pause action')
      stream?.pause()
      videoEl.pause()
    }
  }, [playing])

  function enqueueFragment(bytes: ArrayBuffer) {
    console.log('[useMSEPlayback] fragment received:', bytes.byteLength, 'bytes (queue now', pendingFragments.current.length + 1, ')')
    pendingFragments.current.push(bytes)
    flushPending()
  }

  function flushPending() {
    const sb = sourceBufferRef.current
    const ms = mediaSourceRef.current
    if (!sb || !ms || ms.readyState !== 'open') return
    if (sb.updating) return
    const next = pendingFragments.current.shift()
    if (!next) return
    try {
      console.log('[useMSEPlayback] appending', next.byteLength, 'bytes to SourceBuffer')
      sb.appendBuffer(new Uint8Array(next))
    } catch (err) {
      const videoEl = videoRef.current
      if ((err as DOMException)?.name === 'QuotaExceededError' && videoEl) {
        try {
          sb.remove(0, Math.max(0, videoEl.currentTime - 10))
          pendingFragments.current.unshift(next)
        } catch { /* noop */ }
      } else {
        console.warn('[useMSEPlayback] appendBuffer failed', err)
      }
    }
  }
}
