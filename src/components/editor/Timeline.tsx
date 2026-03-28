import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import type { EditorData, Keyframe, Transition, Beat, Section } from '@/routes/project/$name/editor'
import { updateKeyframeTimestamp, secondsToTimestamp, addKeyframe, deleteKeyframe, deleteTransition } from '@/routes/project/$name/editor'
import { AudioTrack } from './AudioTrack'
import { beatlabFileUrl } from '@/lib/beatlab-client'
import { VideoTrack } from './VideoTrack'
import { TransitionTrack } from './TransitionTrack'
import { Playhead } from './Playhead'
import { KeyframePanel } from './KeyframePanel'
import { BinPanel } from './BinPanel'
import { TransitionPanel } from './TransitionPanel'
import { BeatEffectPreview } from './BeatEffectPreview'
import { ImportDialog } from './ImportDialog'

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

const PREVIEW_HEIGHT_KEY = 'beatlab-preview-height'
const DEFAULT_PREVIEW_HEIGHT = 180
const MIN_PREVIEW_HEIGHT = 80
const MAX_PREVIEW_HEIGHT = 500

export function Timeline({ data }: { data: EditorData }) {
  const router = useRouter()
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [pxPerSec, setPxPerSec] = useState(20)
  const [isPlaying, setIsPlaying] = useState(false)
  const [selectedKeyframe, setSelectedKeyframe] = useState<KeyframeWithTime | null>(null)
  const [selectedTransition, setSelectedTransition] = useState<Transition | null>(null)
  const [showBin, setShowBin] = useState(false)
  const [showImport, setShowImport] = useState(false)
  // Drag overrides: keyframeId -> overridden timeSeconds (during drag only)
  const [dragOverrides, setDragOverrides] = useState<Record<string, number>>({})
  const [videoTrackHeight, setVideoTrackHeight] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_VIDEO_HEIGHT
    const stored = localStorage.getItem(VIDEO_HEIGHT_KEY)
    return stored ? Math.max(MIN_VIDEO_HEIGHT, Math.min(MAX_VIDEO_HEIGHT, parseInt(stored, 10))) : DEFAULT_VIDEO_HEIGHT
  })
  const [previewHeight, setPreviewHeight] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_PREVIEW_HEIGHT
    const stored = localStorage.getItem(PREVIEW_HEIGHT_KEY)
    return stored ? Math.max(MIN_PREVIEW_HEIGHT, Math.min(MAX_PREVIEW_HEIGHT, parseInt(stored, 10))) : DEFAULT_PREVIEW_HEIGHT
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  const seekFnRef = useRef<((time: number) => void) | null>(null)
  const playPauseFnRef = useRef<(() => void) | null>(null)
  const trackDragRef = useRef<{ dragging: boolean; startY: number; startHeight: number }>({ dragging: false, startY: 0, startHeight: 0 })
  const previewDragRef = useRef<{ dragging: boolean; startY: number; startHeight: number }>({ dragging: false, startY: 0, startHeight: 0 })

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
    setSelectedTransition(null)
  }, [])

  const handleTransitionClick = useCallback((tr: Transition) => {
    setSelectedTransition((prev) => prev?.id === tr.id ? null : tr)
    setSelectedKeyframe(null)
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

  const handleAddKeyframe = useCallback(async () => {
    const timestamp = secondsToTimestamp(currentTime)
    await addKeyframe({
      data: {
        projectName: data.projectName,
        timestamp,
        section: '',
        prompt: '',
      },
    })
    router.invalidate()
  }, [currentTime, data.projectName, router])

  const handleDeleteKeyframe = useCallback(async (id: string) => {
    await deleteKeyframe({ data: { projectName: data.projectName, keyframeId: id } })
    setSelectedKeyframe(null)
    router.invalidate()
  }, [data.projectName, router])

  const handleDeleteTransition = useCallback(async (id: string) => {
    await deleteTransition({ data: { projectName: data.projectName, transitionId: id } })
    setSelectedTransition(null)
    router.invalidate()
  }, [data.projectName, router])

  // Delete key shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selectedKeyframe && !(e.target as HTMLElement).closest('input, textarea')) {
        handleDeleteKeyframe(selectedKeyframe.id)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectedKeyframe, handleDeleteKeyframe])

  // Preview divider drag
  const handlePreviewDividerDown = useCallback((e: React.MouseEvent) => {
    previewDragRef.current = { dragging: true, startY: e.clientY, startHeight: previewHeight }
    e.preventDefault()
  }, [previewHeight])

  // Track boundary drag
  const handleTrackDividerDown = useCallback((e: React.MouseEvent) => {
    trackDragRef.current = { dragging: true, startY: e.clientY, startHeight: videoTrackHeight }
    e.preventDefault()
  }, [videoTrackHeight])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (previewDragRef.current.dragging) {
        const delta = e.clientY - previewDragRef.current.startY
        const newHeight = Math.max(MIN_PREVIEW_HEIGHT, Math.min(MAX_PREVIEW_HEIGHT, previewDragRef.current.startHeight + delta))
        setPreviewHeight(newHeight)
        return
      }
      if (!trackDragRef.current.dragging) return
      const delta = e.clientY - trackDragRef.current.startY
      const newHeight = Math.max(MIN_VIDEO_HEIGHT, Math.min(MAX_VIDEO_HEIGHT, trackDragRef.current.startHeight + delta))
      setVideoTrackHeight(newHeight)
    }
    const handleMouseUp = () => {
      if (previewDragRef.current.dragging) {
        previewDragRef.current.dragging = false
        setPreviewHeight((current) => {
          localStorage.setItem(PREVIEW_HEIGHT_KEY, String(current))
          return current
        })
      }
      if (trackDragRef.current.dragging) {
        trackDragRef.current.dragging = false
        setVideoTrackHeight((current) => {
          localStorage.setItem(VIDEO_HEIGHT_KEY, String(current))
          return current
        })
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea')) return

      if (e.code === 'Space') {
        e.preventDefault()
        playPauseFnRef.current?.()
      }

      // Arrow keys: navigate between keyframes
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        const sorted = [...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds)
        if (e.key === 'ArrowRight') {
          const next = sorted.find((kf) => kf.timeSeconds > currentTime + 0.1)
          if (next) {
            seekFnRef.current?.(next.timeSeconds)
            setSelectedKeyframe(next)
          }
        } else {
          const prev = [...sorted].reverse().find((kf) => kf.timeSeconds < currentTime - 0.1)
          if (prev) {
            seekFnRef.current?.(prev.timeSeconds)
            setSelectedKeyframe(prev)
          }
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [keyframes, currentTime])

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
        {/* Preview */}
        <div
          className="bg-gray-950 flex items-center justify-center shrink-0 overflow-hidden"
          style={{ height: previewHeight }}
        >
          <div className="h-full aspect-video bg-gray-800 rounded overflow-hidden">
            {currentKeyframe?.hasSelectedImage ? (
              <BeatEffectPreview
                src={beatlabFileUrl(data.projectName, `selected_keyframes/${currentKeyframe.id}.png`)}
                beats={data.beats}
                currentTime={currentTime}
                isPlaying={isPlaying}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm">
                No image
              </div>
            )}
          </div>
        </div>

        {/* Preview/tracks divider */}
        <div
          className="h-1.5 cursor-row-resize hover:bg-blue-500/50 active:bg-blue-500 bg-gray-800 transition-colors shrink-0 relative z-20"
          onMouseDown={handlePreviewDividerDown}
        />

        {/* Controls bar */}
        <div className="flex items-center gap-4 px-4 py-1.5 bg-gray-900 border-b border-gray-800 shrink-0">
          <button
            onClick={handlePlayPause}
            className="w-8 h-8 flex items-center justify-center bg-gray-800 hover:bg-gray-700 rounded transition-colors"
          >
            {isPlaying ? '⏸' : '▶'}
          </button>

          <div className="text-sm font-mono text-gray-400">
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>

          {/* Add keyframe at playhead */}
          <button
            onClick={handleAddKeyframe}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-2 py-1 rounded transition-colors"
            title="Add keyframe at playhead position"
          >
            + Keyframe
          </button>

          <button
            onClick={() => setShowBin((prev) => !prev)}
            className={`text-xs px-2 py-1 rounded transition-colors ${showBin ? 'bg-blue-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}
            title="Show deleted keyframes bin"
          >
            Bin
          </button>

          <button
            onClick={() => setShowImport(true)}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-2 py-1 rounded transition-colors"
            title="Import images/videos from filesystem"
          >
            Import
          </button>

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
            <TimeRuler duration={duration} pxPerSec={pxPerSec} onClick={handleTrackClick} />

            {/* Video track */}
            <div
              className="relative cursor-pointer shrink-0"
              style={{ height: videoTrackHeight }}
              onClick={handleTrackClick}
            >
              <div className="absolute left-0 top-0 px-2 py-1 text-[10px] text-gray-600 uppercase tracking-wider z-10 bg-gray-950/80">
                Video
              </div>
              {/* Section color bands */}
              <SectionBands sections={data.sections} pxPerSec={pxPerSec} />
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
              <TransitionTrack
                transitions={data.transitions}
                keyframes={keyframes}
                pxPerSec={pxPerSec}
                selectedId={selectedTransition?.id ?? null}
                onTransitionClick={handleTransitionClick}
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
              {/* Beat markers */}
              <BeatMarkers beats={data.beats} pxPerSec={pxPerSec} />
              {data.audioFile && (
                <AudioTrack
                  audioUrl={beatlabFileUrl(data.projectName, data.audioFile)}
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
            <Playhead
              currentTime={currentTime}
              pxPerSec={pxPerSec}
              duration={duration}
              onSeek={(time) => seekFnRef.current?.(time)}
            />
          </div>
        </div>
      </div>

      {/* Side panel */}
      {selectedKeyframe && !showBin && !selectedTransition && (
        <KeyframePanel
          keyframe={selectedKeyframe}
          projectName={data.projectName}
          onClose={() => setSelectedKeyframe(null)}
          onDelete={() => handleDeleteKeyframe(selectedKeyframe.id)}
        />
      )}

      {/* Transition panel */}
      {selectedTransition && !showBin && !selectedKeyframe && (
        <TransitionPanel
          transition={selectedTransition}
          projectName={data.projectName}
          motionPrompt={data.meta.motionPrompt}
          onClose={() => setSelectedTransition(null)}
          onDelete={() => handleDeleteTransition(selectedTransition.id)}
        />
      )}

      {/* Bin panel */}
      {showBin && (
        <BinPanel
          projectName={data.projectName}
          onClose={() => setShowBin(false)}
          onRestore={() => router.invalidate()}
        />
      )}

      {/* Import dialog */}
      {showImport && (
        <ImportDialog
          projectName={data.projectName}
          onClose={() => setShowImport(false)}
          onImported={() => router.invalidate()}
        />
      )}
    </div>
  )
}

function TimeRuler({ duration, pxPerSec, onClick }: { duration: number; pxPerSec: number; onClick?: (e: React.MouseEvent) => void }) {
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
    <div className="h-5 border-b border-gray-800 relative bg-gray-950 shrink-0 cursor-pointer" onClick={onClick}>
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

function BeatMarkers({ beats, pxPerSec }: { beats: Beat[]; pxPerSec: number }) {
  if (beats.length === 0) return null

  // Only render visible beats (skip rendering thousands of off-screen markers)
  // At low zoom levels, thin out to avoid overwhelming the DOM
  const step = pxPerSec < 10 ? 4 : pxPerSec < 20 ? 2 : 1

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {beats.map((beat, i) => {
        if (i % step !== 0) return null
        const x = beat.time * pxPerSec
        const opacity = 0.1 + beat.intensity * 0.3
        return (
          <div
            key={i}
            className="absolute top-0 h-full"
            style={{ left: x, width: 1, backgroundColor: `rgba(59, 130, 246, ${opacity})` }}
          />
        )
      })}
    </div>
  )
}

const SECTION_COLORS: Record<string, string> = {
  verse: 'rgba(59, 130, 246, 0.08)',
  chorus: 'rgba(168, 85, 247, 0.12)',
  drop: 'rgba(239, 68, 68, 0.12)',
  bridge: 'rgba(34, 197, 94, 0.08)',
  intro: 'rgba(107, 114, 128, 0.06)',
  outro: 'rgba(107, 114, 128, 0.06)',
  buildup: 'rgba(245, 158, 11, 0.10)',
  low_energy: 'rgba(59, 130, 246, 0.05)',
  high_energy: 'rgba(239, 68, 68, 0.08)',
  mid_energy: 'rgba(168, 85, 247, 0.06)',
}

function SectionBands({ sections, pxPerSec }: { sections: Section[]; pxPerSec: number }) {
  if (sections.length === 0) return null

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {sections.map((section, i) => {
        const x = section.start_time * pxPerSec
        const w = (section.end_time - section.start_time) * pxPerSec
        const color = SECTION_COLORS[section.type] || SECTION_COLORS[section.label] || 'rgba(107, 114, 128, 0.04)'
        return (
          <div
            key={i}
            className="absolute top-0 h-full"
            style={{ left: x, width: w, backgroundColor: color }}
          >
            {w > 40 && (
              <span className="absolute bottom-0.5 right-1 text-[7px] text-gray-600 truncate max-w-full">
                {section.label}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
