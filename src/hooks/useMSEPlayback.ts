import { useEffect, useRef, useState } from 'react'
import { openPreviewStream, type PreviewStream } from '@/lib/preview-client'

// Backoff for engine-restart auto-recovery. On WS close (engine hot-reload,
// crash, deploy) we rebuild the MediaSource instead of leaving it pinned to a
// dead encoder's init segment — otherwise fragments from the new encoder get
// silently rejected and the user sees a frozen tab until they hard-reload.
const RECONNECT_DELAY_MS = 750

// avc1.640028 = H.264 High Profile, Level 4.0 (max 1920×1080 @ ~30fps) —
// matches what `libx264 preset=faster` emits for 1080p24 content. The
// previous value `avc1.42E01E` was Baseline L3.0 (max 720p); browser
// accepted the init but silently refused to decode our 1080p frames,
// leaving readyState stuck at 1 (HAVE_METADATA) and canplay never firing.
const MIME_TYPE = 'video/mp4; codecs="avc1.640028"'

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

  // Bumped on preview-stream WS close to tear down + rebuild the MediaSource.
  // See RECONNECT_DELAY_MS note above.
  const [sessionKey, setSessionKey] = useState(0)

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

    // Feature-detect MSE before touching the constructor. iOS Safari
    // (iPhone) does not expose `MediaSource` in-page at all — referencing
    // `new MediaSource()` throws `ReferenceError` there. Fail soft: log
    // once and leave the <video> element inert so the rest of the editor
    // keeps rendering. A proper HLS fallback can layer on later without
    // removing this guard.
    if (typeof window === 'undefined' || typeof window.MediaSource === 'undefined') {
      console.warn(
        '[useMSEPlayback] MediaSource Extensions not available (likely iOS Safari on iPhone). ' +
        'Preview stream disabled for this browser.',
      )
      return
    }
    if (!window.MediaSource.isTypeSupported(MIME_TYPE)) {
      console.warn(
        `[useMSEPlayback] MediaSource does not support ${MIME_TYPE}. ` +
        'Preview stream disabled for this browser.',
      )
      return
    }

    console.log('[useMSEPlayback] session open for project=', projectName)

    pendingFragments.current = []

    const ms = new window.MediaSource()
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
        const appendStart = (sb as SourceBuffer & { _appendStart?: number })._appendStart
        const appendMs = appendStart !== undefined
          ? (performance.now() - appendStart).toFixed(0)
          : '?'
        console.log(
          '[mse-audit] updateend append=' + appendMs + 'ms buffered:',
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
          console.log('[useMSEPlayback] stream onClose — scheduling session rebuild')
          try { if (ms.readyState === 'open') ms.endOfStream() } catch { /* noop */ }
          // Rebuild after a short delay so the backend has time to finish
          // restarting. The session effect's cleanup handles teardown; bumping
          // sessionKey triggers the effect to re-run and re-open everything.
          setTimeout(() => setSessionKey((k) => k + 1), RECONNECT_DELAY_MS)
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
  }, [projectName, sessionKey])

  // Performance audit: report dropped-frame counters every second during
  // playback + long-task (main-thread block) observer that correlates React
  // render stalls with video stutter.
  useEffect(() => {
    if (!playing) return
    const videoEl = videoRef.current
    if (!videoEl) return
    let lastTotal = 0
    let lastDropped = 0
    const statsTimer = setInterval(() => {
      const q = (videoEl as HTMLVideoElement & {
        getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number }
      }).getVideoPlaybackQuality?.()
      if (!q) return
      const dTotal = q.totalVideoFrames - lastTotal
      const dDrop = q.droppedVideoFrames - lastDropped
      lastTotal = q.totalVideoFrames
      lastDropped = q.droppedVideoFrames
      const buffered = videoEl.buffered.length > 0
        ? videoEl.buffered.end(videoEl.buffered.length - 1) - videoEl.currentTime
        : 0
      console.log(
        `[mse-audit] frames=+${dTotal} dropped=+${dDrop} ` +
        `buffered-ahead=${buffered.toFixed(2)}s ` +
        `currentTime=${videoEl.currentTime.toFixed(2)} ` +
        `readyState=${videoEl.readyState}`,
      )
    }, 1000)

    let longTaskObserver: PerformanceObserver | null = null
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) {
            console.log(
              `[long-task] ${entry.duration.toFixed(0)}ms at ${entry.startTime.toFixed(0)}ms ` +
              `name=${entry.name} attribution=${(entry as PerformanceEntry & { attribution?: unknown[] }).attribution?.length ?? 0}`,
            )
          }
        }
      })
      longTaskObserver.observe({ entryTypes: ['longtask'] })
    } catch { /* longtask not supported */ }

    return () => {
      clearInterval(statsTimer)
      longTaskObserver?.disconnect()
    }
  }, [playing])

  // Play/pause: drive the backend via action messages on the live socket.
  useEffect(() => {
    const videoEl = videoRef.current
    const stream = streamRef.current
    if (!videoEl) return

    if (playing) {
      const sb = sourceBufferRef.current
      const bufferedEnd = sb && sb.buffered.length > 0
        ? sb.buffered.end(sb.buffered.length - 1)
        : 0
      console.log(
        '[useMSEPlayback] play action @', currentTimeRef.current,
        'video.currentTime=', videoEl.currentTime.toFixed(3),
        'buffered.end=', bufferedEnd.toFixed(3),
        'readyState=', videoEl.readyState,
      )
      // Snap video.currentTime to the end of buffered content. In sb.mode =
      // 'sequence' the video's currentTime is sequence-time (not project-
      // time) and doesn't reset between play/pause cycles on the same mount.
      // If stale, video could be positioned past the buffered end and wait
      // forever for data that won't arrive.
      if (bufferedEnd > 0) {
        videoEl.currentTime = bufferedEnd
      }
      stream?.play(currentTimeRef.current)

      // video.play() on readyState=0 is a no-op in practice — the browser
      // doesn't auto-start when data eventually arrives. First-play symptom
      // was "black square." Play now if already ready; otherwise defer to
      // the next 'canplay' event.
      const attemptPlay = () => {
        if (!playingRef.current) return
        videoEl.play().catch((err) => {
          console.warn('[useMSEPlayback] video.play() rejected:', err)
        })
      }
      if (videoEl.readyState >= 2 /* HAVE_CURRENT_DATA */) {
        attemptPlay()
      } else {
        console.log('[useMSEPlayback] readyState < 2, deferring play() to canplay')
        videoEl.addEventListener('canplay', attemptPlay, { once: true })
      }
    } else {
      console.log('[useMSEPlayback] pause action')
      stream?.pause()
      videoEl.pause()
    }
  }, [playing])

  // Seek: when currentTime jumps (user clicks the playhead bar) during
  // playback, send a seek action to the backend AND clear the buffered
  // pre-seek fragments so the video doesn't play through the old buffer
  // before arriving at the new position.
  //
  // Discontinuity detection: a Timeline rAF tick advances currentTime by
  // ~16ms worth. Any jump >0.3s (or backward) is a user seek.
  const lastObservedTimeRef = useRef(currentTime)
  const seekDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!playing) {
      lastObservedTimeRef.current = currentTime
      return
    }
    const delta = currentTime - lastObservedTimeRef.current
    lastObservedTimeRef.current = currentTime
    if (Math.abs(delta) < 0.3) return // normal tick

    console.log(`[useMSEPlayback] seek detected: delta=${delta.toFixed(3)} → ${currentTime.toFixed(3)}`)

    if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current)
    seekDebounceRef.current = setTimeout(() => {
      seekDebounceRef.current = null
      const stream = streamRef.current
      const sb = sourceBufferRef.current
      if (!stream) return

      console.log(`[useMSEPlayback] seek action @ ${currentTimeRef.current.toFixed(3)}`)
      stream.seek(currentTimeRef.current)

      // Clear pre-seek fragments so the new content plays immediately.
      pendingFragments.current = []
      if (sb && !sb.updating) {
        try {
          sb.abort()
        } catch { /* noop */ }
        try {
          if (sb.buffered.length > 0) {
            sb.remove(0, sb.buffered.end(sb.buffered.length - 1) + 1)
          }
        } catch { /* noop */ }
      }
    }, 150)
  }, [currentTime, playing])

  function enqueueFragment(bytes: ArrayBuffer) {
    const receivedAt = performance.now()
    ;(bytes as ArrayBuffer & { _receivedAt?: number })._receivedAt = receivedAt
    console.log(
      '[mse-audit] fragment received:', bytes.byteLength, 'bytes',
      'at', receivedAt.toFixed(0), '(queue now', pendingFragments.current.length + 1, ')',
    )
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
      const receivedAt = (next as ArrayBuffer & { _receivedAt?: number })._receivedAt
      const enqueueLag = receivedAt !== undefined
        ? (performance.now() - receivedAt).toFixed(0) + 'ms since receive'
        : ''
      console.log('[mse-audit] appending', next.byteLength, 'bytes to SourceBuffer', enqueueLag)
      ;(sb as SourceBuffer & { _appendStart?: number })._appendStart = performance.now()
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
