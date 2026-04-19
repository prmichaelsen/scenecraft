import { useRef, useEffect, useCallback, memo, type MutableRefObject } from 'react'

type PlayheadProps = {
  currentTime: number
  pxPerSec: number
  onSeek: (time: number) => void
  duration: number
  audioElRef?: MutableRefObject<HTMLAudioElement | null>
  scrollTop?: number
}

export const Playhead = memo(function Playhead({ currentTime, pxPerSec, onSeek, duration, audioElRef, scrollTop = 0 }: PlayheadProps) {
  const x = currentTime * pxPerSec
  const isDragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const scrubTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastScrubTime = useRef(0)
  const pendingScrubTime = useRef<number | null>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true
    e.preventDefault()
    e.stopPropagation()
    // Prepare audio for scrub
    const audio = audioElRef?.current
    if (audio) {
      audio.playbackRate = 0.5
      audio.volume = 0.6
    }
    lastScrubTime.current = 0
    pendingScrubTime.current = null
  }, [audioElRef])

  useEffect(() => {
    // Throttle audio scrub bursts — audio seek+play is heavy and overwhelms the
    // main thread when called on every mousemove, causing visible playhead jitter.
    const SCRUB_INTERVAL_MS = 120

    const fireScrub = (time: number) => {
      const audio = audioElRef?.current
      if (!audio) return
      audio.currentTime = time
      audio.play().catch(() => {})
      if (scrubTimeout.current) clearTimeout(scrubTimeout.current)
      scrubTimeout.current = setTimeout(() => { audio.pause() }, 80)
      lastScrubTime.current = performance.now()
      pendingScrubTime.current = null
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const scrollParent = containerRef.current.closest('.overflow-x-auto')
      if (!scrollParent) return
      const rect = scrollParent.getBoundingClientRect()
      const clickX = e.clientX - rect.left + scrollParent.scrollLeft
      const time = Math.max(0, Math.min(duration, clickX / pxPerSec))
      onSeek(time)

      // Throttle audio: fire immediately if enough time has passed, else
      // schedule a trailing burst so the user hears where they finally stopped.
      const now = performance.now()
      if (now - lastScrubTime.current >= SCRUB_INTERVAL_MS) {
        fireScrub(time)
      } else {
        pendingScrubTime.current = time
        if (!scrubTimeout.current) {
          scrubTimeout.current = setTimeout(() => {
            scrubTimeout.current = null
            if (pendingScrubTime.current != null && isDragging.current) {
              fireScrub(pendingScrubTime.current)
            }
          }, SCRUB_INTERVAL_MS - (now - lastScrubTime.current))
        }
      }
    }

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false
        const audio = audioElRef?.current
        if (audio) {
          audio.pause()
          audio.volume = 1
          if (scrubTimeout.current) { clearTimeout(scrubTimeout.current); scrubTimeout.current = null }
        }
        pendingScrubTime.current = null
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [pxPerSec, duration, onSeek, audioElRef])

  return (
    <div
      ref={containerRef}
      className="absolute top-0 h-full z-[60] pointer-events-none"
      style={{ left: x, width: 1 }}
    >
      {/* Visible line */}
      <div className="absolute top-0 left-0 w-px h-full bg-red-500" />

      {/* Draggable cap — wider hit target, only this captures clicks, follows vertical scroll */}
      <div
        className="absolute -left-[5px] w-[11px] h-[11px] cursor-grab active:cursor-grabbing z-20 pointer-events-auto"
        style={{ top: scrollTop }}
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-0 bg-red-500 pointer-events-none" style={{ clipPath: 'polygon(50% 100%, 0% 0%, 100% 0%)' }} />
      </div>
    </div>
  )
})
