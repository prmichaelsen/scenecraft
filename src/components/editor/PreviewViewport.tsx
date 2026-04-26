import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { fetchScrubFrame, ScrubFetchError } from '@/lib/preview-client'
import { useMSEPlayback } from '@/hooks/useMSEPlayback'
import { getVideoBlocked, subscribeVideoBlocked } from '@/lib/playback-sync-ref'

type PreviewViewportProps = {
  projectName: string
  currentTime: number
  playing: boolean
  /** JPEG quality for scrub frames (1-100). Defaults to 85. */
  scrubQuality?: number
  className?: string
}

export type PreviewViewportHandle = {
  getCanvas: () => HTMLCanvasElement | null
  getVideo: () => HTMLVideoElement | null
  /** Returns the element currently on top in the z-stack — useful for captureStream(). */
  getActiveSurface: () => HTMLCanvasElement | HTMLVideoElement | null
}

type ScrubState = 'idle' | 'loading' | 'error' | 'empty'

export const PreviewViewport = forwardRef<PreviewViewportHandle, PreviewViewportProps>(
  function PreviewViewport({ projectName, currentTime, playing, scrubQuality = 85, className }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [scrubState, setScrubState] = useState<ScrubState>('idle')
    const [errorText, setErrorText] = useState<string | null>(null)
    // True while useMSEPlayback is mid-seek, between issuing the seek and
    // the first fresh fragment landing. Drives the "Rendering…" overlay
    // and the freeze-last-frame path below.
    const videoBlocked = useSyncExternalStore(
      subscribeVideoBlocked,
      getVideoBlocked,
      () => false,
    )
    // Paint gate: every scrub fires a request unless the frame is already
    // cached locally (see frameCacheRef). If a fetch does go out, we only
    // paint when the response matches the current scrub position.
    const latestScrubTimeRef = useRef<number>(0)
    const inFlightRef = useRef(0)
    // Client-side frame cache keyed on t_ms. Lives for the lifetime of the
    // component. Cleared wholesale when the project changes. Task-38 covers
    // finer-grained invalidation once the backend push channel lands.
    const frameCacheRef = useRef<Map<number, ImageBitmap>>(new Map())
    const FRAME_CACHE_MAX = 500
    // Drop the cache if projectName changes (different project = different
    // pixels at the same t).
    useEffect(() => {
      for (const bmp of frameCacheRef.current.values()) bmp.close?.()
      frameCacheRef.current.clear()
    }, [projectName])

    useImperativeHandle(ref, () => ({
      getCanvas: () => canvasRef.current,
      getVideo: () => videoRef.current,
      // While videoBlocked, the canvas holds the last good frame and is
      // on top — return it so captureStream consumers see what the user
      // sees instead of the (currently-loading) video element.
      getActiveSurface: () => (playing && !videoBlocked ? videoRef.current : canvasRef.current),
    }), [playing, videoBlocked])

    // ── Scrub path: fetch JPEG and blit to canvas when paused ────
    // paintBitmap does NOT close the bitmap — the cache owns bitmap
    // lifetimes. Closes happen on eviction or component unmount.
    const paintBitmap = useCallback((bmp: ImageBitmap) => {
      const canvas = canvasRef.current
      if (!canvas) return
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width
        canvas.height = bmp.height
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(bmp, 0, 0)
    }, [])

    // When transitioning from play → pause, snapshot the current video
    // frame onto the canvas before the z-index swap reveals it. Otherwise
    // you'd see the stale scrub frame from before play started, or a
    // different frame than what was just playing, depending on encoder lag.
    // sb.mode = 'sequence' means video.currentTime doesn't map to project
    // time, so fetching a scrub JPEG at currentTime doesn't necessarily
    // show the same frame the video was showing — we just grab the pixels.
    const wasPlayingRef = useRef(playing)
    useEffect(() => {
      if (wasPlayingRef.current && !playing) {
        const video = videoRef.current
        const canvas = canvasRef.current
        if (video && canvas && video.videoWidth > 0) {
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth
            canvas.height = video.videoHeight
          }
          const ctx = canvas.getContext('2d')
          ctx?.drawImage(video, 0, 0, canvas.width, canvas.height)
        }
      }
      wasPlayingRef.current = playing
    }, [playing])

    // When videoBlocked rises during playback, copy the current video frame
    // to the canvas so the canvas has a real "last good frame" to show
    // when it gets raised above the (loading) video element. Without this
    // the canvas would show whatever stale scrub frame was last painted.
    const wasBlockedRef = useRef(videoBlocked)
    useEffect(() => {
      if (videoBlocked && !wasBlockedRef.current && playing) {
        const video = videoRef.current
        const canvas = canvasRef.current
        if (video && canvas && video.videoWidth > 0) {
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth
            canvas.height = video.videoHeight
          }
          const ctx = canvas.getContext('2d')
          ctx?.drawImage(video, 0, 0, canvas.width, canvas.height)
        }
      }
      wasBlockedRef.current = videoBlocked
    }, [videoBlocked, playing])

    // Touch the cache on access to mark as most-recently-used (Map iteration
    // order = insertion, so delete+set moves to end).
    const cacheTouch = useCallback((tKey: number, bmp: ImageBitmap) => {
      const c = frameCacheRef.current
      const existing = c.get(tKey)
      if (existing && existing !== bmp) existing.close?.()
      c.delete(tKey)
      c.set(tKey, bmp)
      while (c.size > FRAME_CACHE_MAX) {
        const oldestKey = c.keys().next().value
        if (oldestKey === undefined) break
        c.get(oldestKey)?.close?.()
        c.delete(oldestKey)
      }
    }, [])

    // Background prefetch: renders + caches frames around the current
    // playhead while idle. Canceled when the playhead moves so that near-
    // playhead renders always win the scheduling race.
    const prefetchControllerRef = useRef<AbortController | null>(null)
    const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Stable flag for the prefetch inner loop to check — avoids a deps-chain
    // rerun of schedulePrefetch on every playing toggle.
    const playingRef = useRef(playing)
    playingRef.current = playing

    const schedulePrefetch = useCallback((centerT: number) => {
      // Cancel the previous batch
      prefetchControllerRef.current?.abort()
      if (prefetchTimerRef.current) {
        clearTimeout(prefetchTimerRef.current)
        prefetchTimerRef.current = null
      }

      // Debounce: only kick in after the playhead has been still for 200ms.
      prefetchTimerRef.current = setTimeout(() => {
        prefetchTimerRef.current = null
        // Playback started between debounce schedule and fire — skip.
        if (playingRef.current) return
        const controller = new AbortController()
        prefetchControllerRef.current = controller
        // Offsets radiating outward from the playhead. Forward first, then
        // back. Clamped to non-negative t on the near-zero side.
        const offsets = [0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.0, -2.0, 3.0, -3.0, 4.0, -4.0]
        const runOne = async (offset: number) => {
          if (controller.signal.aborted) return
          const t = centerT + offset
          if (t < 0) return
          const tKey = Math.round(t * 1000)
          if (frameCacheRef.current.has(tKey)) return
          try {
            const bmp = await fetchScrubFrame(projectName, t, scrubQuality, controller.signal)
            if (controller.signal.aborted) { bmp.close?.(); return }
            cacheTouch(tKey, bmp)
          } catch {
            // AbortError or fetch error — drop silently
          }
        }
        // Fire them serially (one at a time) so we don't overwhelm the
        // backend render worker; each completes in ~100ms if cached on
        // backend, slower on first render.
        ;(async () => {
          for (const off of offsets) {
            if (controller.signal.aborted) break
            await runOne(off)
          }
        })()
      }, 200)
    }, [projectName, scrubQuality, cacheTouch])

    useEffect(() => {
      if (playing) {
        // Don't prefetch during playback — it competes with the render
        // worker for cycles and causes playback to stutter. Cancel any
        // in-flight batch AND kill the pending debounce timer so a timer
        // scheduled by the last pre-play scrub doesn't fire mid-playback.
        prefetchControllerRef.current?.abort()
        if (prefetchTimerRef.current) {
          clearTimeout(prefetchTimerRef.current)
          prefetchTimerRef.current = null
        }
        return
      }
      const t = currentTime
      const tKey = Math.round(t * 1000)
      latestScrubTimeRef.current = t

      const cached = frameCacheRef.current.get(tKey)
      if (cached) {
        cacheTouch(tKey, cached) // bump LRU
        paintBitmap(cached)
        setScrubState('idle')
        setErrorText(null)
        schedulePrefetch(t)
        return
      }

      // Cancel any in-flight prefetch — the user moved the playhead to a
      // new position that isn't cached, we want to spend server cycles on
      // this request, not on the old prefetch batch.
      prefetchControllerRef.current?.abort()

      inFlightRef.current += 1
      setScrubState('loading')
      fetchScrubFrame(projectName, t, scrubQuality)
        .then((bmp) => {
          if (latestScrubTimeRef.current !== t) {
            bmp.close?.()
            return
          }
          cacheTouch(tKey, bmp)
          paintBitmap(bmp)
          setScrubState('idle')
          setErrorText(null)
          schedulePrefetch(t)
        })
        .catch((err) => {
          if (latestScrubTimeRef.current !== t) return
          if (err instanceof ScrubFetchError && err.status === 404) {
            setScrubState('empty')
            setErrorText(null)
            clearCanvas()
            return
          }
          setScrubState('error')
          setErrorText((err as Error)?.message ?? String(err))
        })
        .finally(() => {
          inFlightRef.current -= 1
          if (inFlightRef.current === 0) {
            setScrubState((s) => (s === 'loading' ? 'idle' : s))
          }
        })
    }, [playing, currentTime, projectName, scrubQuality, paintBitmap, cacheTouch, schedulePrefetch])

    const clearCanvas = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      ctx?.clearRect(0, 0, canvas.width, canvas.height)
    }

    // ── Playback path: MSE-fed <video> ────────────────────────────
    useMSEPlayback(videoRef, projectName, playing, currentTime)

    // ── Layout ─────────────────────────────────────────────────────
    // Both surfaces render full-size; z-index toggled by play state.
    // pointer-events-none prevents the backgrounded surface from eating clicks.
    // During playback the video is on top; while videoBlocked, raise the
    // canvas instead so the user sees the last good frame instead of the
    // loading-into-blackness video element.
    const showCanvasOnTop = !playing || videoBlocked
    return (
      <div className={`relative w-full h-full ${className ?? ''}`}>
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-contain bg-black"
          style={{ zIndex: showCanvasOnTop ? 1 : 2, pointerEvents: showCanvasOnTop ? 'none' : 'auto' }}
          playsInline
          muted
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full object-contain bg-black"
          style={{ zIndex: showCanvasOnTop ? 2 : 1, pointerEvents: showCanvasOnTop ? 'auto' : 'none' }}
        />

        {((!playing && scrubState === 'loading') || (playing && videoBlocked)) && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-white/60 text-xs bg-black/40 px-2 py-0.5 rounded">
              Rendering…
            </span>
          </div>
        )}

        {!playing && scrubState === 'empty' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-white/50 text-sm">
              Add a keyframe to see a preview
            </span>
          </div>
        )}

        {scrubState === 'error' && errorText && (
          <div className="absolute bottom-1 left-1 right-1 pointer-events-none">
            <span className="text-red-300 text-xs bg-black/60 px-2 py-0.5 rounded block truncate">
              {errorText}
            </span>
          </div>
        )}
      </div>
    )
  },
)
