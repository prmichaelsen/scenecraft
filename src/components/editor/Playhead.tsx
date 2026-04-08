import { useRef, useEffect, useCallback, type MutableRefObject } from 'react'

type PlayheadProps = {
  currentTime: number
  pxPerSec: number
  onSeek: (time: number) => void
  duration: number
  audioElRef?: MutableRefObject<HTMLAudioElement | null>
  scrollTop?: number
}

export function Playhead({ currentTime, pxPerSec, onSeek, duration, audioElRef, scrollTop = 0 }: PlayheadProps) {
  const x = currentTime * pxPerSec
  const isDragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const scrubTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

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
  }, [audioElRef])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const scrollParent = containerRef.current.closest('.overflow-x-auto')
      if (!scrollParent) return
      const rect = scrollParent.getBoundingClientRect()
      const clickX = e.clientX - rect.left + scrollParent.scrollLeft
      const time = Math.max(0, Math.min(duration, clickX / pxPerSec))
      onSeek(time)

      // Scrub audio: play a short burst at the seek position
      const audio = audioElRef?.current
      if (audio) {
        audio.currentTime = time
        audio.play().catch(() => {})
        if (scrubTimeout.current) clearTimeout(scrubTimeout.current)
        scrubTimeout.current = setTimeout(() => { audio.pause() }, 80)
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
        className="absolute -left-2 w-4 h-4 cursor-grab active:cursor-grabbing z-20 pointer-events-auto"
        style={{ top: scrollTop }}
        onMouseDown={handleMouseDown}
      >
        <div className="absolute left-1.5 top-0.5 w-3 h-3 bg-red-500 rounded-full pointer-events-none" />
      </div>
    </div>
  )
}
