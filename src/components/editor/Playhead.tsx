import { useRef, useEffect, useCallback } from 'react'

type PlayheadProps = {
  currentTime: number
  pxPerSec: number
  onSeek: (time: number) => void
  duration: number
}

export function Playhead({ currentTime, pxPerSec, onSeek, duration }: PlayheadProps) {
  const x = currentTime * pxPerSec
  const isDragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true
    e.preventDefault()
    e.stopPropagation()
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const scrollParent = containerRef.current.closest('.overflow-x-auto')
      if (!scrollParent) return
      const rect = scrollParent.getBoundingClientRect()
      const clickX = e.clientX - rect.left + scrollParent.scrollLeft
      const time = Math.max(0, Math.min(duration, clickX / pxPerSec))
      onSeek(time)
    }

    const handleMouseUp = () => {
      isDragging.current = false
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [pxPerSec, duration, onSeek])

  return (
    <div
      ref={containerRef}
      className="absolute top-0 h-full z-10 pointer-events-none"
      style={{ left: x, width: 1 }}
    >
      {/* Visible line */}
      <div className="absolute top-0 left-0 w-px h-full bg-red-500" />

      {/* Draggable cap — wider hit target, only this captures clicks */}
      <div
        className="absolute -top-0 -left-2 w-4 h-4 cursor-grab active:cursor-grabbing z-20 pointer-events-auto"
        onMouseDown={handleMouseDown}
      >
        <div className="absolute left-1.5 top-0.5 w-3 h-3 bg-red-500 rounded-full pointer-events-none" />
      </div>
    </div>
  )
}
