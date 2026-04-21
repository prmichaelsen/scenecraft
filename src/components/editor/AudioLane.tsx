import { memo } from 'react'
import type { AudioTrack, AudioClip } from '@/lib/audio-client'
import { AudioWaveform } from './AudioWaveform'
import { useEditorState } from './EditorStateContext'

type AudioLaneProps = {
  projectName: string
  track: AudioTrack
  pxPerSec: number
  height?: number
}

/**
 * Single audio track row. Renders each clip as a positioned block on a
 * horizontal timeline scaled by pxPerSec, with a canvas waveform overlay.
 */
export const AudioLane = memo(function AudioLane({ projectName, track, pxPerSec, height = 56 }: AudioLaneProps) {
  const clips = track.clips ?? []
  const dimmed = track.muted || !track.enabled
  const { selectedAudioTrackId, setSelectedAudioTrackId } = useEditorState()
  const selected = selectedAudioTrackId === track.id

  return (
    <div
      className={`relative border-b border-gray-800/70 ${dimmed ? 'opacity-50' : ''} ${selected ? 'ring-1 ring-cyan-500/60' : ''}`}
      style={{ height }}
      onClick={(e) => {
        // Clicks on empty lane area select the track; clicks on clips stop propagation below
        e.stopPropagation()
        setSelectedAudioTrackId(track.id)
      }}
    >
      {/* Track header — sticky so it stays visible during horizontal scroll */}
      <div className="sticky left-0 z-10 flex items-center gap-2 px-2 h-full w-fit pointer-events-none">
        <span className="text-[9px] text-gray-500 uppercase tracking-wider">
          A{track.display_order + 1}
        </span>
        <span className="text-[10px] text-gray-400 truncate max-w-[120px]">
          {track.name}
        </span>
        {track.muted && <span className="text-[9px] text-red-400/80">muted</span>}
      </div>

      {/* Clips */}
      {clips.map((c) => (
        <AudioClipBlock key={c.id} projectName={projectName} clip={c} pxPerSec={pxPerSec} laneHeight={height} />
      ))}
    </div>
  )
})

type AudioClipBlockProps = {
  projectName: string
  clip: AudioClip
  pxPerSec: number
  laneHeight: number
}

function AudioClipBlock({ projectName, clip, pxPerSec, laneHeight }: AudioClipBlockProps) {
  const left = clip.start_time * pxPerSec
  const width = Math.max(2, (clip.end_time - clip.start_time) * pxPerSec)
  const durationSeconds = clip.end_time - clip.start_time
  // Clip block sits with 4px vertical inset from the lane — same as the
  // absolute top-1 bottom-1 below (1px=4px because tailwind scale).
  const blockHeight = Math.max(0, laneHeight - 8)
  const { selectedAudioClipId, setSelectedAudioClipId } = useEditorState()
  const selected = selectedAudioClipId === clip.id

  return (
    <div
      className={`absolute top-1 bottom-1 rounded-sm overflow-hidden border bg-cyan-900/30 hover:bg-cyan-900/50 transition-colors ${
        selected ? 'border-cyan-300 ring-1 ring-cyan-300/60' : 'border-cyan-700/60'
      } ${clip.muted ? 'opacity-40' : ''} cursor-pointer`}
      style={{ left, width }}
      title={`${clip.source_path} · ${durationSeconds.toFixed(2)}s`}
      onClick={(e) => {
        e.stopPropagation()
        setSelectedAudioClipId(clip.id)
      }}
    >
      <AudioWaveform
        projectName={projectName}
        clipId={clip.id}
        width={width}
        height={blockHeight}
        durationSeconds={durationSeconds}
      />
      {width > 48 && (
        <div className="absolute bottom-0.5 left-1 text-[9px] font-mono text-cyan-300/80 truncate max-w-[calc(100%-8px)] pointer-events-none z-10">
          {clip.id.replace(/^audio_clip_/, '')}
        </div>
      )}
    </div>
  )
}
