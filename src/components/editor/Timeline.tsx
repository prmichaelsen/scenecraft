import { useState, useRef, useCallback, useEffect } from 'react'
import type { EditorData, Keyframe } from '@/routes/project/$name/editor'
import { updateKeyframeTimestamp, secondsToTimestamp } from '@/routes/project/$name/editor'
import { AudioTrack } from './AudioTrack'
import { VideoTrack } from './VideoTrack'
import { Playhead } from './Playhead'
import { KeyframePanel } from './KeyframePanel'

function parseTimestamp(ts: string): number {
  const parts = ts.split(':')
  if (parts.length === 2) {
    const minutes = parseInt(parts[0], 10)
    const seconds = parseFloat(parts[1])
    return minutes * 60 + seconds
  }
  return 0
}

export type KeyframeWithTime = Keyframe & { timeSeconds: number }

const VIDEO_HEIGHT_KEY = 'beatlab-video-track-height'
const DEFAULT_VIDEO_HEIGHT = 96
const MIN_VIDEO_HEIGHT = 48
const MAX_VIDEO_HEIGHT = 400

export function Timeline({ data }: { data: EditorData }) {
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [pxPerSec, setPxPerSec] = useState(20)
  const [isPlaying, setIsPlaying] = useState(false)
  const [selectedKeyframe, setSelectedKeyframe] = useState<KeyframeWithTime | null>(null)
  // Drag overrides: keyframeId -> overridden timeSeconds (during drag only)
  const [dragOverrides, setDragOverrides] = useState<Record<string, number>>({})
  const [videoTrackHeight, setVideoTrackHeight] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_VIDEO_HEIGHT
    const stored = localStorage.getItem(VIDEO_HEIGHT_KEY)
    return stored ? Math.max(MIN_VIDEO_HEIGHT, Math.min(MAX_VIDEO_HEIGHT, parseInt(stored, 10))) : DEFAULT_VIDEO_HEIGHT
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  const seekFnRef = useRef<((time: number) => void) | null>(null)
  const playPauseFnRef = useRef<(() => void) | null>(null)
  const trackDragRef = useRef<{ dragging: boolean; startY: number; startHeight: number }>({ dragging: false, startY: 0, startHeight: 0 })

  const totalWidth = duration * pxPerSec

  const keyframes: KeyframeWithTime[] = data.keyframes.map((kf) => ({
    ...kf,
    timeSeconds: dragOverrides[kf.id] ?? parseTimestamp(kf.timestamp),
  }))

  const currentKeyframe = [...keyframes]
    .reverse()
    .find((kf) => kf.timeSeconds <= currentTime)

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const factor = e.deltaY > 0 ? 0.85 : 1.18
      setPxPerSec((prev) => Math.max(5, Math.min(200, prev * factor)))
    }
  }, [])

  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (!scrollRef.current) return
      const rect = scrollRef.current.getBoundingClientRect()
      const scrollLeft = scrollRef.current.scrollLeft
      const clickX = e.clientX - rect.left + scrollLeft
      const time = clickX / pxPerSec
      if (time >= 0 && time <= duration) {
        seekFnRef.current?.(time)
      }
    },
    [pxPerSec, duration]
  )

  const handlePlayPause = useCallback(() => {
    playPauseFnRef.current?.()
  }, [])

  const handleKeyframeClick = useCallback((kf: KeyframeWithTime) => {
    setSelectedKeyframe((prev) => prev?.id === kf.id ? null : kf)
  }, [])

  // Keyframe boundary drag — updates local state during drag, persists to YAML on release
  const handleKeyframeDrag = useCallback((id: string, newTimeSeconds: number) => {
    setDragOverrides((prev) => ({ ...prev, [id]: newTimeSeconds }))
  }, [])

  const handleKeyframeDragEnd = useCallback(async (id: string, newTimeSeconds: number) => {
    const newTimestamp = secondsToTimestamp(newTimeSeconds)
    setDragOverrides((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    // Update the keyframe in the parent data so it persists visually
    const kf = data.keyframes.find((k) => k.id === id)
    if (kf) {
      kf.timestamp = newTimestamp
    }
    // Persist to YAML
    await updateKeyframeTimestamp({
      data: { projectName: data.projectName, keyframeId: id, newTimestamp },
    })
  }, [data])

  // Track boundary drag
  const handleTrackDividerDown = useCallback((e: React.MouseEvent) => {
    trackDragRef.current = { dragging: true, startY: e.clientY, startHeight: videoTrackHeight }
    e.preventDefault()
  }, [videoTrackHeight])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!trackDragRef.current.dragging) return
      const delta = e.clientY - trackDragRef.current.startY
      const newHeight = Math.max(MIN_VIDEO_HEIGHT, Math.min(MAX_VIDEO_HEIGHT, trackDragRef.current.startHeight + delta))
      setVideoTrackHeight(newHeight)
    }
    const handleMouseUp = () => {
      if (trackDragRef.current.dragging) {
        trackDragRef.current.dragging = false
        localStorage.setItem(VIDEO_HEIGHT_KEY, String(videoTrackHeight))
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [videoTrackHeight])

  // Keep playhead in view
  useEffect(() => {
    if (!scrollRef.current || !isPlaying) return
    const el = scrollRef.current
    const playheadX = currentTime * pxPerSec
    const viewLeft = el.scrollLeft
    const viewRight = viewLeft + el.clientWidth
    if (playheadX < viewLeft || playheadX > viewRight - 50) {
      el.scrollLeft = playheadX - 100
    }
  }, [currentTime, pxPerSec, isPlaying])

  return (
    <div className="h-full flex">
      {/* Main timeline area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Preview + controls */}
        <div className="flex items-center gap-4 px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
          <div className="w-32 h-18 bg-gray-800 rounded overflow-hidden shrink-0">
            {currentKeyframe?.hasSelectedImage ? (
              <img
                src={`/api/files/${data.projectName}/selected_keyframes/${currentKeyframe.id}.png`}
                alt={currentKeyframe.id}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">
                No image
              </div>
            )}
          </div>

          <button
            onClick={handlePlayPause}
            className="w-8 h-8 flex items-center justify-center bg-gray-800 hover:bg-gray-700 rounded transition-colors"
          >
            {isPlaying ? '⏸' : '▶'}
          </button>

          <div className="text-sm font-mono text-gray-400">
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>

          <div className="text-xs text-gray-600 ml-auto">
            Zoom: {pxPerSec.toFixed(0)}px/s (Ctrl+scroll)
          </div>
        </div>

        {/* Timeline tracks */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-x-auto overflow-y-hidden relative"
          onWheel={handleWheel}
        >
          <div style={{ width: Math.max(totalWidth, 800), minHeight: '100%' }} className="relative flex flex-col">
            {/* Time ruler */}
            <TimeRuler duration={duration} pxPerSec={pxPerSec} />

            {/* Video track */}
            <div
              className="relative cursor-pointer shrink-0"
              style={{ height: videoTrackHeight }}
              onClick={handleTrackClick}
            >
              <div className="absolute left-0 top-0 px-2 py-1 text-[10px] text-gray-600 uppercase tracking-wider z-10 bg-gray-950/80">
                Video
              </div>
              <VideoTrack
                keyframes={keyframes}
                pxPerSec={pxPerSec}
                projectName={data.projectName}
                selectedId={selectedKeyframe?.id ?? null}
                onKeyframeClick={handleKeyframeClick}
                onKeyframeDrag={handleKeyframeDrag}
                onKeyframeDragEnd={handleKeyframeDragEnd}
                scrollRef={scrollRef}
              />
            </div>

            {/* Draggable divider */}
            <div
              className="h-1.5 cursor-row-resize hover:bg-blue-500/50 active:bg-blue-500 bg-gray-800 transition-colors shrink-0 relative z-20"
              onMouseDown={handleTrackDividerDown}
            />

            {/* Audio track */}
            <div
              className="flex-1 relative cursor-pointer min-h-[80px]"
              onClick={handleTrackClick}
            >
              <div className="absolute left-0 top-0 px-2 py-1 text-[10px] text-gray-600 uppercase tracking-wider z-10 bg-gray-950/80">
                Audio
              </div>
              {data.audioFile && (
                <AudioTrack
                  audioUrl={`/api/files/${data.projectName}/${data.audioFile}`}
                  pxPerSec={pxPerSec}
                  onTimeUpdate={setCurrentTime}
                  onDurationChange={setDuration}
                  onPlayingChange={setIsPlaying}
                  seekRef={seekFnRef}
                  playPauseRef={playPauseFnRef}
                />
              )}
            </div>

            {/* Playhead overlay */}
            <Playhead currentTime={currentTime} pxPerSec={pxPerSec} />
          </div>
        </div>
      </div>

      {/* Side panel */}
      {selectedKeyframe && (
        <KeyframePanel
          keyframe={selectedKeyframe}
          projectName={data.projectName}
          onClose={() => setSelectedKeyframe(null)}
        />
      )}
    </div>
  )
}

function TimeRuler({ duration, pxPerSec }: { duration: number; pxPerSec: number }) {
  const marks: { time: number; label: string }[] = []

  let interval = 60
  if (pxPerSec > 15) interval = 30
  if (pxPerSec > 30) interval = 10
  if (pxPerSec > 60) interval = 5
  if (pxPerSec > 120) interval = 1

  for (let t = 0; t <= duration; t += interval) {
    marks.push({ time: t, label: formatTime(t) })
  }

  return (
    <div className="h-5 border-b border-gray-800 relative bg-gray-950 shrink-0">
      {marks.map((m) => (
        <div
          key={m.time}
          className="absolute top-0 h-full flex items-end"
          style={{ left: m.time * pxPerSec }}
        >
          <div className="w-px h-2 bg-gray-700" />
          <span className="text-[9px] text-gray-600 ml-1 whitespace-nowrap">{m.label}</span>
        </div>
      ))}
    </div>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
