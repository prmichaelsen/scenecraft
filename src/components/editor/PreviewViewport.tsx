import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { fetchScrubFrame, ScrubFetchError } from '@/lib/preview-client'
import { useLatestWinsRequest } from '@/hooks/useLatestWinsRequest'
import { useMSEPlayback } from '@/hooks/useMSEPlayback'

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
    const scrubQueue = useLatestWinsRequest<number>()

    useImperativeHandle(ref, () => ({
      getCanvas: () => canvasRef.current,
      getVideo: () => videoRef.current,
      getActiveSurface: () => (playing ? videoRef.current : canvasRef.current),
    }), [playing])

    // ── Scrub path: fetch JPEG and blit to canvas when paused ────
    const paintBitmap = useCallback((bmp: ImageBitmap) => {
      const canvas = canvasRef.current
      if (!canvas) return
      // Size canvas to the source bitmap on first paint (or resize) — preserves pixel parity.
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width
        canvas.height = bmp.height
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(bmp, 0, 0)
      bmp.close?.()
    }, [])

    useEffect(() => {
      if (playing) return // video handles its own rendering during playback
      scrubQueue.request(currentTime, async (t, signal) => {
        setScrubState((s) => (s === 'idle' ? 'loading' : s))
        try {
          const bmp = await fetchScrubFrame(projectName, t, scrubQuality, signal)
          if (signal.aborted) return
          paintBitmap(bmp)
          setScrubState('idle')
          setErrorText(null)
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') return
          if (err instanceof ScrubFetchError && err.status === 404) {
            setScrubState('empty')
            setErrorText(null)
            clearCanvas()
            return
          }
          setScrubState('error')
          setErrorText((err as Error)?.message ?? String(err))
        }
      })
      // scrubQueue is stable across renders
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playing, currentTime, projectName, scrubQuality, paintBitmap])

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
    return (
      <div className={`relative w-full h-full ${className ?? ''}`}>
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-contain bg-black"
          style={{ zIndex: playing ? 2 : 1, pointerEvents: playing ? 'auto' : 'none' }}
          playsInline
          muted
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full object-contain bg-black"
          style={{ zIndex: playing ? 1 : 2, pointerEvents: playing ? 'none' : 'auto' }}
        />

        {!playing && scrubState === 'loading' && (
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
