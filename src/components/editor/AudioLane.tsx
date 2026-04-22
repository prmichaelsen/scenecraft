import { memo } from 'react'
import type { AudioTrack, AudioClip } from '@/lib/audio-client'
import { AudioWaveform } from './AudioWaveform'
import { useEditorState } from './EditorStateContext'
import { useContextMenu } from '@/contexts/ContextMenuContext'
import { Wand2, Trash2, VolumeX, Volume2 } from 'lucide-react'

type AudioLaneProps = {
  projectName: string
  track: AudioTrack
  pxPerSec: number
  height?: number
  /** IDs currently in the Timeline's audio-clip multi-selection set. */
  selectedIds?: Set<string>
  /**
   * Click handler override. When provided, `AudioClipBlock` calls this with
   * the clip and shiftKey instead of the context's setSelectedAudioClipId.
   * Timeline uses this to implement additive shift-click across the mixed
   * selection (kfs + trs + audio clips).
   */
  onClipClick?: (clip: AudioClip, shiftKey: boolean) => void
  /**
   * Called when the user picks "Align waveforms" from an audio clip's
   * right-click menu. `clipIds` is the current multi-selection set (the
   * right-clicked clip is guaranteed to be in it — AudioClipBlock promotes
   * an unselected clip into selection on right-click).
   */
  onRequestAlignWaveforms?: (clipIds: string[]) => void
  /** Called when the user picks "Delete" from the menu. */
  onRequestDeleteClip?: (clipId: string) => void
  /**
   * Called when the user picks "Mute" / "Unmute" from the menu.
   * `clipIds` is the batch to toggle (includes the right-clicked clip even if
   * not already in selection). `muted` is the TARGET state — `true` means
   * "mute all of these", `false` means "unmute all of these".
   */
  onRequestToggleMute?: (clipIds: string[], muted: boolean) => void
  /**
   * Body-drag: mousedown on a clip body begins a drag gesture tracked by
   * Timeline. AudioLane just exposes the hook; drag state lives in Timeline
   * so multi-clip drags spanning lanes stay coherent.
   */
  onClipMouseDown?: (clip: AudioClip, e: React.MouseEvent) => void
  /**
   * Optimistic drag offset (seconds) applied to clips currently in the drag
   * set. Driven by Timeline; AudioClipBlock shifts via CSS transform so no
   * server roundtrip happens per-frame.
   */
  dragOffsetSeconds?: number
  /**
   * Vertical lane delta for the drag (number of lanes to move down). Each
   * dragged clip translates by `trackDelta * laneHeight` pixels on Y so the
   * user sees exactly which audio lane the drop will land on.
   */
  dragTrackDelta?: number
  /** IDs currently being drag-moved (for optimistic CSS transform). */
  draggingIds?: Set<string>
}

/**
 * Single audio track row. Renders each clip as a positioned block on a
 * horizontal timeline scaled by pxPerSec, with a canvas waveform overlay.
 */
export const AudioLane = memo(function AudioLane({ projectName, track, pxPerSec, height = 56, selectedIds, onClipClick, onRequestAlignWaveforms, onRequestDeleteClip, onRequestToggleMute, onClipMouseDown, dragOffsetSeconds = 0, dragTrackDelta = 0, draggingIds }: AudioLaneProps) {
  const clips = track.clips ?? []
  const dimmed = track.muted || !track.enabled
  const { selectedAudioTrackId, setSelectedAudioTrackId } = useEditorState()
  const selected = selectedAudioTrackId === track.id

  return (
    <div
      data-audio-track-id={track.id}
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
        <AudioClipBlock
          key={c.id}
          projectName={projectName}
          clip={c}
          pxPerSec={pxPerSec}
          laneHeight={height}
          isInMultiSelect={selectedIds?.has(c.id) ?? false}
          selectedIds={selectedIds}
          onClipClick={onClipClick}
          onRequestAlignWaveforms={onRequestAlignWaveforms}
          onRequestDeleteClip={onRequestDeleteClip}
          onRequestToggleMute={onRequestToggleMute}
          onClipMouseDown={onClipMouseDown}
          dragOffsetPx={(draggingIds?.has(c.id) ? dragOffsetSeconds : 0) * pxPerSec}
          dragOffsetPy={(draggingIds?.has(c.id) ? dragTrackDelta : 0) * height}
        />
      ))}
    </div>
  )
})

type AudioClipBlockProps = {
  projectName: string
  clip: AudioClip
  pxPerSec: number
  laneHeight: number
  isInMultiSelect: boolean
  selectedIds?: Set<string>
  onClipClick?: (clip: AudioClip, shiftKey: boolean) => void
  onRequestAlignWaveforms?: (clipIds: string[]) => void
  onRequestDeleteClip?: (clipId: string) => void
  onRequestToggleMute?: (clipIds: string[], muted: boolean) => void
  onClipMouseDown?: (clip: AudioClip, e: React.MouseEvent) => void
  /** Optimistic drag X offset in px applied via CSS transform. Zero when not dragging. */
  dragOffsetPx?: number
  /** Optimistic drag Y offset in px (for cross-lane drag). Zero when dragging within source lane. */
  dragOffsetPy?: number
}

function AudioClipBlock({ projectName, clip, pxPerSec, laneHeight, isInMultiSelect, selectedIds, onClipClick, onRequestAlignWaveforms, onRequestDeleteClip, onRequestToggleMute, onClipMouseDown, dragOffsetPx = 0, dragOffsetPy = 0 }: AudioClipBlockProps) {
  const left = clip.start_time * pxPerSec
  const width = Math.max(2, (clip.end_time - clip.start_time) * pxPerSec)
  const durationSeconds = clip.end_time - clip.start_time
  // Clip block sits with 4px vertical inset from the lane — same as the
  // absolute top-1 bottom-1 below (1px=4px because tailwind scale).
  const blockHeight = Math.max(0, laneHeight - 8)
  const { selectedAudioClipId, setSelectedAudioClipId } = useEditorState()
  const selected = selectedAudioClipId === clip.id || isInMultiSelect
  const { show: showContextMenu } = useContextMenu()

  const isDragging = dragOffsetPx !== 0 || dragOffsetPy !== 0
  return (
    <div
      className={`absolute top-1 bottom-1 rounded-sm overflow-hidden border bg-cyan-900/30 hover:bg-cyan-900/50 ${isDragging ? '' : 'transition-colors'} ${
        selected ? 'border-cyan-300 ring-1 ring-cyan-300/60' : 'border-cyan-700/60'
      } ${clip.muted ? 'opacity-40' : ''} ${isDragging ? 'cursor-grabbing opacity-80 shadow-lg z-40' : 'cursor-pointer'}`}
      style={{
        left,
        width,
        // Layer Y ahead of X so the dragged block clears its source lane
        // (otherwise it's clipped by the lane's overflow).
        transform: isDragging ? `translate(${dragOffsetPx}px, ${dragOffsetPy}px)` : undefined,
        overflow: isDragging ? 'visible' : undefined,
        // During drag, let mouse events fall through so elementFromPoint
        // reads the target lane under the cursor instead of picking up this
        // translated block (whose DOM ancestor is still the SOURCE lane,
        // causing trackDelta to flicker between target and source).
        pointerEvents: isDragging ? 'none' : undefined,
      }}
      title={`${clip.source_path} · ${durationSeconds.toFixed(2)}s`}
      onMouseDown={(e) => {
        // Left button only; primary drag gesture. Selection updates happen on
        // the subsequent click event (Timeline swallows that click if a drag
        // actually fired).
        if (e.button === 0 && onClipMouseDown) onClipMouseDown(clip, e)
      }}
      onClick={(e) => {
        e.stopPropagation()
        if (onClipClick) onClipClick(clip, e.shiftKey)
        else setSelectedAudioClipId(clip.id)
      }}
      onContextMenu={(e) => {
        e.stopPropagation()
        // Promote the right-clicked clip into the multi-select set (if not
        // already there). We build the alignable set eagerly so the menu
        // gating reflects post-promotion selection state.
        const baseSet = selectedIds ?? new Set<string>()
        // Batch IDs include the right-clicked clip even if it wasn't in the
        // multi-selection (selection-promote pattern). Same target for both
        // align and mute so right-clicking unambiguously acts on "this clip
        // + anything else you had selected".
        const batchIds = baseSet.has(clip.id) ? Array.from(baseSet) : [...Array.from(baseSet), clip.id]
        const canAlign = batchIds.length >= 2 && !!onRequestAlignWaveforms
        const canMute = !!onRequestToggleMute
        // Target mute state = !clip.muted (toggle based on the clicked clip's
        // state). If user right-clicked a muted clip in a batch that has
        // both muted + unmuted, "Unmute" here unmutes everything; likewise
        // vice versa.
        const targetMuted = !clip.muted
        const multi = batchIds.length > 1
        const muteLabel = clip.muted
          ? (multi ? `Unmute ${batchIds.length} clips` : 'Unmute')
          : (multi ? `Mute ${batchIds.length} clips` : 'Mute')
        showContextMenu(e, [
          {
            id: 'toggle-mute',
            label: muteLabel,
            icon: clip.muted ? Volume2 : VolumeX,
            onClick: canMute ? () => onRequestToggleMute?.(batchIds, targetMuted) : undefined,
            disabled: !canMute,
          },
          {
            id: 'align-waveforms',
            label: canAlign
              ? `Align waveforms (${batchIds.length} clips)`
              : 'Align waveforms',
            icon: Wand2,
            onClick: canAlign ? () => onRequestAlignWaveforms?.(batchIds) : undefined,
            disabled: !canAlign,
          },
          { divider: true, id: 'd1' },
          {
            id: 'delete-clip',
            label: 'Delete audio clip',
            icon: Trash2,
            danger: true,
            shortcut: '⌫',
            onClick: onRequestDeleteClip ? () => onRequestDeleteClip(clip.id) : undefined,
            disabled: !onRequestDeleteClip,
          },
        ])
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
