import { useRef, useEffect, type MutableRefObject } from 'react'
import WaveSurfer from 'wavesurfer.js'

type AudioTrackProps = {
  audioUrl: string
  pxPerSec: number
  onTimeUpdate: (time: number) => void
  onDurationChange: (duration: number) => void
  onPlayingChange: (playing: boolean) => void
  seekRef: MutableRefObject<((time: number) => void) | null>
  playPauseRef: MutableRefObject<(() => void) | null>
}

export function AudioTrack({
  audioUrl,
  pxPerSec,
  onTimeUpdate,
  onDurationChange,
  onPlayingChange,
  seekRef,
  playPauseRef,
}: AudioTrackProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)

  // Initialize wavesurfer
  useEffect(() => {
    if (!containerRef.current) return

    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: audioUrl,
      waveColor: '#4a5568',
      progressColor: '#3b82f6',
      cursorColor: 'transparent', // We draw our own playhead
      height: 'auto',
      fillParent: false,
      minPxPerSec: pxPerSec,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      interact: false, // We handle clicks at the timeline level
    })

    ws.on('timeupdate', (time) => onTimeUpdate(time))
    ws.on('ready', () => onDurationChange(ws.getDuration()))
    ws.on('play', () => onPlayingChange(true))
    ws.on('pause', () => onPlayingChange(false))

    // Expose seek and play/pause
    seekRef.current = (time: number) => {
      ws.setTime(time)
      onTimeUpdate(time)
    }
    playPauseRef.current = () => ws.playPause()

    wsRef.current = ws

    return () => {
      ws.destroy()
      wsRef.current = null
      seekRef.current = null
      playPauseRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl])

  // Sync zoom level
  useEffect(() => {
    if (wsRef.current) {
      wsRef.current.setOptions({ minPxPerSec: pxPerSec })
    }
  }, [pxPerSec])

  return <div ref={containerRef} className="h-full" />
}
