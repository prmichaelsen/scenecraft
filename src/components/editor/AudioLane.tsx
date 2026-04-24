import { memo, useState, useRef, useEffect } from 'react'
import type { AudioTrack, AudioClip } from '@/lib/audio-client'
import { AudioWaveform } from './AudioWaveform'
import { useEditorState } from './EditorStateContext'
import { useContextMenu } from '@/contexts/ContextMenuContext'
import { Wand2, Trash2, VolumeX, Volume2, Pencil, ArrowUp, ArrowDown } from 'lucide-react'
import { TrackHeaderPill } from './TrackHeaderPill'

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
   * Toggle mute / solo on the track itself (not on a clip). Wired to the
   * Mute / Solo buttons in the lane header.
   */
  onUpdateTrack?: (trackId: string, update: { muted?: boolean; solo?: boolean; name?: string }) => void
  /**
   * Called when the user picks "Delete track…" from the header context menu,
   * or when the header menu's Move Up / Move Down items are chosen. Timeline
   * owns the track-level actions so all tracks can be reordered/deleted in
   * a single place.
   */
  onRequestDeleteTrack?: (trackId: string) => void
  /**
   * Reorder callback fired on header drag-drop. `draggedTrackId` is the
   * track the user picked up; `targetTrackId` is the track being dropped on;
   * `position` is `'before'` if released on the top half of the target and
   * `'after'` if released on the bottom half. Timeline computes the full
   * reordered id array and POSTs it.
   */
  onRequestReorderTracks?: (draggedTrackId: string, targetTrackId: string, position: 'before' | 'after') => void
  /**
   * Move Up / Move Down fallback items in the header context menu. Timeline
   * wires these to the same `postReorderAudioTracks` call the drag path uses
   * — swap with neighbouring track. `undefined` hides the item (e.g. there's
   * no track above the first one).
   */
  onRequestMoveUp?: (trackId: string) => void
  onRequestMoveDown?: (trackId: string) => void
  /**
   * Body-drag: mousedown on a clip body begins a drag gesture tracked by
   * Timeline. AudioLane just exposes the hook; drag state lives in Timeline
   * so multi-clip drags spanning lanes stay coherent.
   */
  onClipMouseDown?: (clip: AudioClip, e: React.MouseEvent) => void
  /**
   * Edge-trim: mousedown on a 6px hit zone at the left or right of a clip
   * begins a resize gesture. Timeline owns the state.
   *   - left edge  → adjusts source_offset + start_time together (trims
   *                  content from the start; clip duration shrinks from left)
   *   - right edge → adjusts end_time only (clip duration shrinks from right)
   */
  onClipTrimMouseDown?: (clip: AudioClip, edge: 'left' | 'right', e: React.MouseEvent) => void
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
  /**
   * Optimistic trim preview — when set, every block whose clip.id is in
   * `clipIds` renders its edge adjusted live so the user sees the new
   * boundary before release. For a single-clip trim the set has one entry;
   * for a multi-clip ripple trim it's the full batch.
   */
  trimPreview?: { clipIds: Set<string>; edge: 'left' | 'right'; offsetSeconds: number }
  /**
   * Task 125: optimistic extraction ghosts for this lane. Rendered as
   * striped "generating audio…" placeholder blocks while the backend
   * extracts + auto-links audio from a just-dropped pool video. Owner
   * (Timeline) filters the global ghost map down to entries whose trackId
   * matches this lane. Empty array → no ghosts rendered.
   */
  ghosts?: Array<{ startTime: number; endTime: number }>
  /**
   * Audio-clip ids to paint with a yellow "linked-to-selected" glow — used
   * for cross-highlighting when the currently-selected transition links to
   * clips on this lane (Task 124). Distinct from the "selected" ring.
   */
  highlightedIds?: Set<string>
  /**
   * Task 123 — drop of a pool audio asset from the Bin onto this lane.
   * `startTime` is the time under the cursor at drop; the backend creates a
   * standalone (unlinked) clip sized to the segment's duration.
   */
  onDropPoolAudio?: (trackId: string, startTime: number, poolPath: string) => void
  /**
   * M11 task-104b — drop of an audio-isolation stem from AudioIsolationsPanel.
   * AudioLane parses the `application/x-scenecraft-stem` payload and computes
   * the cursor time; the parent (Timeline) runs the overlap resolution +
   * batch-ops POST since it owns the refresh pipeline. `existingClips` is
   * this lane's current clip snapshot so the parent can feed it into
   * `resolveOverlapsWithSplit` without re-fetching.
   */
  onDropStem?: (
    trackId: string,
    startTime: number,
    stem: StemDropPayload,
    existingClips: AudioClip[],
  ) => void
  /** Optional amplitude meter rendered at the far right of the track
   *  header pill. Caller owns the analyser wiring — AudioLane just forwards
   *  the ReactNode into `TrackHeaderPill.meter`. */
  headerMeter?: React.ReactNode
  /**
   * When true, the inline sticky-left header wrapper (draggable reorder
   *  zone + rename + M/S/meter pill + context menu) is NOT rendered. The
   *  lane renders only its clip body + drop zones. Used by the split-column
   *  timeline layout where the track header lives in a dedicated left
   *  column instead of floating over the clips.
   */
  headerless?: boolean
}

/** Shape of the `application/x-scenecraft-stem` drag payload. Mirrored by
 *  the AudioIsolationsPanel's `StemDragPayload`. */
export type StemDropPayload = {
  pool_segment_id: string
  pool_path: string
  stem_type: 'vocal' | 'background'
  duration_seconds: number
  source_label: string
}

/**
 * Single audio track row. Renders each clip as a positioned block on a
 * horizontal timeline scaled by pxPerSec, with a canvas waveform overlay.
 */
export const AudioLane = memo(function AudioLane({ projectName, track, pxPerSec, height = 56, selectedIds, onClipClick, onRequestAlignWaveforms, onRequestDeleteClip, onRequestToggleMute, onUpdateTrack, onRequestDeleteTrack, onRequestReorderTracks, onRequestMoveUp, onRequestMoveDown, onClipMouseDown, onClipTrimMouseDown, dragOffsetSeconds = 0, dragTrackDelta = 0, draggingIds, trimPreview, ghosts, highlightedIds, onDropPoolAudio, onDropStem, headerMeter, headerless = false }: AudioLaneProps) {
  const clips = track.clips ?? []
  const dimmed = track.muted
  const { selectedAudioTrackId, setSelectedAudioTrackId } = useEditorState()
  const selected = selectedAudioTrackId === track.id
  const { show: showContextMenu } = useContextMenu()

  // Inline rename — swap the name <span> for an <input> on double-click.
  // Commits on Enter / blur; reverts on Escape.
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(track.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Keep the draft in sync when the underlying track name changes while
    // we're not editing (e.g. server push, or a different refreshTimeline
    // arriving).
    if (!renaming) setNameDraft(track.name)
  }, [track.name, renaming])

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renaming])

  const commitRename = () => {
    const next = nameDraft.trim()
    setRenaming(false)
    if (!next || next === track.name) {
      setNameDraft(track.name)
      return
    }
    onUpdateTrack?.(track.id, { name: next })
  }

  const cancelRename = () => {
    setNameDraft(track.name)
    setRenaming(false)
  }

  // HTML5 drag-reorder — only the sticky header area is `draggable`, so
  // lane-body interactions (clip move/trim) are untouched. `dropIndicator`
  // paints a 2px cyan bar on the edge the drop will insert against.
  const [dropIndicator, setDropIndicator] = useState<'before' | 'after' | null>(null)

  const openHeaderMenu = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    showContextMenu(e, [
      {
        id: 'rename',
        label: 'Rename',
        icon: Pencil,
        onClick: () => setRenaming(true),
      },
      ...(onRequestMoveUp ? [{
        id: 'move-up' as const,
        label: 'Move up',
        icon: ArrowUp,
        onClick: () => onRequestMoveUp(track.id),
      }] : []),
      ...(onRequestMoveDown ? [{
        id: 'move-down' as const,
        label: 'Move down',
        icon: ArrowDown,
        onClick: () => onRequestMoveDown(track.id),
      }] : []),
      { divider: true, id: 'd1' },
      {
        id: 'delete-track',
        label: 'Delete track…',
        icon: Trash2,
        danger: true,
        onClick: onRequestDeleteTrack ? () => onRequestDeleteTrack(track.id) : undefined,
        disabled: !onRequestDeleteTrack,
      },
    ])
  }

  const [poolDropActive, setPoolDropActive] = useState(false)

  return (
    <div
      data-audio-track-id={track.id}
      className={`relative border-b border-gray-800/70 ${dimmed ? 'opacity-50' : ''} ${selected ? 'ring-1 ring-cyan-500/60' : ''} ${poolDropActive ? 'bg-cyan-500/10' : ''}`}
      style={{ height }}
      onClick={(e) => {
        // Clicks on empty lane area select the track; clicks on clips stop propagation below
        e.stopPropagation()
        setSelectedAudioTrackId(track.id)
      }}
      onDragOver={(e) => {
        // Accept pool-audio drops (Task 123) + stem drops from
        // AudioIsolationsPanel (M11 task-104b). Both use the same visual
        // affordance. Skip any other drag types so track-reorder still
        // works on the header.
        const types = e.dataTransfer.types
        const isPool = types.includes('application/x-scenecraft-pool-path')
        const isStem = types.includes('application/x-scenecraft-stem')
        if (!isPool && !isStem) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!poolDropActive) setPoolDropActive(true)
      }}
      onDragLeave={() => setPoolDropActive(false)}
      onDrop={(e) => {
        setPoolDropActive(false)
        const stemRaw = e.dataTransfer.getData('application/x-scenecraft-stem')
        const poolPath = e.dataTransfer.getData('application/x-scenecraft-pool-path')
        if (!stemRaw && !poolPath) return
        e.preventDefault()
        e.stopPropagation()
        // Resolve x → timeline seconds using the nearest horizontally-scrollable
        // ancestor, since the lane is laid out inside the timeline scroller.
        const rect = e.currentTarget.getBoundingClientRect()
        let scrollLeft = 0
        let node: HTMLElement | null = e.currentTarget.parentElement
        while (node) {
          if (node.scrollWidth > node.clientWidth) { scrollLeft = node.scrollLeft; break }
          node = node.parentElement
        }
        const startTime = Math.max(0, (e.clientX - rect.left + scrollLeft) / pxPerSec)

        if (stemRaw && onDropStem) {
          try {
            const payload = JSON.parse(stemRaw) as StemDropPayload
            onDropStem(track.id, startTime, payload, clips)
          } catch (err) {
            console.error('[AudioLane] bad stem payload:', err)
          }
          return
        }
        if (poolPath && onDropPoolAudio) {
          onDropPoolAudio(track.id, startTime, poolPath)
        }
      }}
    >
      {!headerless && (
      <>
      {/* Track header — sticky so it stays visible during horizontal scroll.
          The wrapper is a drop TARGET (for reorder); the drag SOURCE is a
          narrower handle inside the pill (the `A{n}` prefix) so HTML5 drag
          doesn't eat click events on the M/S buttons.
          The outer div stays transparent + full-height so it preserves its
          drop / context-menu hit area; the inner pill gets the
          translucent background + blur so ONLY the label/buttons row is
          tinted (mirrors the Align-Waveforms modal's `bg-black/50
          backdrop-blur-sm` look). */}
      <div
        className="sticky left-0 z-10 flex items-center gap-2 px-2 h-full w-fit"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/x-audio-track-id')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const rect = e.currentTarget.getBoundingClientRect()
          setDropIndicator(e.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
        }}
        onDragLeave={() => setDropIndicator(null)}
        onDrop={(e) => {
          const draggedId = e.dataTransfer.getData('application/x-audio-track-id')
          setDropIndicator(null)
          if (!draggedId || draggedId === track.id) return
          e.preventDefault()
          e.stopPropagation()
          const rect = e.currentTarget.getBoundingClientRect()
          const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
          onRequestReorderTracks?.(draggedId, track.id, position)
        }}
        onContextMenu={openHeaderMenu}
      >
        {dropIndicator === 'before' && (
          <div className="absolute -top-px left-0 right-0 h-[2px] bg-cyan-400 pointer-events-none z-20" />
        )}
        {dropIndicator === 'after' && (
          <div className="absolute -bottom-px left-0 right-0 h-[2px] bg-cyan-400 pointer-events-none z-20" />
        )}

        <TrackHeaderPill
          // `draggable` lives on the prefix badge only — NOT on the wrapper —
          // because an HTML5-draggable ancestor eats click events on any
          // descendant the user even slightly moves during mousedown→mouseup,
          // which was silently swallowing M/S button clicks.
          prefix={
            <span
              className="cursor-grab active:cursor-grabbing text-[9px] text-gray-500 uppercase tracking-wider select-none"
              title="Drag to reorder track"
              draggable
              onDragStart={(e) => {
                e.stopPropagation()
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('application/x-audio-track-id', track.id)
                e.dataTransfer.setData('text/plain', track.id)
              }}
            >
              A{track.display_order + 1}
            </span>
          }
          label={renaming ? (
            <input
              ref={inputRef}
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') commitRename()
                else if (e.key === 'Escape') cancelRename()
              }}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              // Prevent the surrounding draggable header from starting a drag
              // when the user clicks into the input to edit.
              draggable={false}
              onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
              className="text-[10px] text-gray-200 bg-gray-900 border border-cyan-600/70 rounded px-1 py-0 focus:outline-none focus:border-cyan-400 max-w-[120px]"
            />
          ) : track.name}
          labelTitle="Double-click to rename"
          onLabelDoubleClick={(e) => {
            e.stopPropagation()
            setRenaming(true)
          }}
          muted={track.muted}
          onMuteToggle={(e) => {
            e.stopPropagation()
            onUpdateTrack?.(track.id, { muted: !track.muted })
          }}
          solo={track.solo}
          onSoloToggle={(e) => {
            e.stopPropagation()
            onUpdateTrack?.(track.id, { solo: !track.solo })
          }}
          meter={headerMeter}
        />
      </div>
      </>
      )}

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
          onClipTrimMouseDown={onClipTrimMouseDown}
          dragOffsetPx={(draggingIds?.has(c.id) ? dragOffsetSeconds : 0) * pxPerSec}
          dragOffsetPy={(draggingIds?.has(c.id) ? dragTrackDelta : 0) * height}
          trimPreview={trimPreview && trimPreview.clipIds.has(c.id) ? { edge: trimPreview.edge, offsetSeconds: trimPreview.offsetSeconds } : undefined}
          isHighlighted={highlightedIds?.has(c.id) ?? false}
        />
      ))}

      {/* Extraction ghosts (Task 125) — striped placeholders shown while
          the backend extracts + links audio from a just-dropped video.
          Rendered above clips (z-30) so they are visible even when the
          real clip lands but animation is still settling. Each ghost is
          removed by Timeline once the real linked clip appears in
          localAudioTracks, or after a 10s safety timeout. */}
      {ghosts && ghosts.map((g, i) => {
        const left = g.startTime * pxPerSec
        const width = Math.max(2, (g.endTime - g.startTime) * pxPerSec)
        return (
          <div
            key={`ghost-${i}-${g.startTime}-${g.endTime}`}
            className="absolute top-1 bottom-1 rounded-sm border border-dashed border-cyan-400 pointer-events-none z-30 animate-pulse flex items-center justify-center overflow-hidden"
            style={{
              left,
              width,
              backgroundImage:
                'repeating-linear-gradient(45deg, rgba(34, 211, 238, 0.12) 0 6px, rgba(34, 211, 238, 0.22) 6px 12px)',
            }}
            title="Extracting and linking audio from the dropped video…"
          >
            <span className="text-[9px] font-medium text-cyan-200/90 truncate px-1">
              generating audio…
            </span>
          </div>
        )
      })}
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
  onClipTrimMouseDown?: (clip: AudioClip, edge: 'left' | 'right', e: React.MouseEvent) => void
  /** Optimistic drag X offset in px applied via CSS transform. Zero when not dragging. */
  dragOffsetPx?: number
  /** Optimistic drag Y offset in px (for cross-lane drag). Zero when dragging within source lane. */
  dragOffsetPy?: number
  /**
   * Optimistic trim preview: when set, the block's edge shifts live until
   * commit. AudioLane hands this down only for clips in the ripple batch.
   */
  trimPreview?: { edge: 'left' | 'right'; offsetSeconds: number }
  /**
   * Task 124 cross-highlight — when true, paint a yellow "linked-to-selected"
   * glow. Only visible when the block isn't already selected.
   */
  isHighlighted?: boolean
}

function AudioClipBlock({ projectName, clip, pxPerSec, laneHeight, isInMultiSelect, selectedIds, onClipClick, onRequestAlignWaveforms, onRequestDeleteClip, onRequestToggleMute, onClipMouseDown, onClipTrimMouseDown, dragOffsetPx = 0, dragOffsetPy = 0, trimPreview, isHighlighted = false }: AudioClipBlockProps) {
  // Apply trim preview to the block's CSS left+width so the user sees the
  // new boundary in real time. Left-edge drag moves the left edge; right-
  // edge drag moves the right edge. Underlying clip data isn't touched
  // until mouseup commits.
  let baseStart = clip.start_time
  let baseEnd = clip.end_time
  if (trimPreview) {
    if (trimPreview.edge === 'left') baseStart += trimPreview.offsetSeconds
    else baseEnd += trimPreview.offsetSeconds
  }
  const left = baseStart * pxPerSec
  const width = Math.max(2, (baseEnd - baseStart) * pxPerSec)
  const durationSeconds = Math.max(0, baseEnd - baseStart)
  // Clip block sits with 4px vertical inset from the lane — same as the
  // absolute top-1 bottom-1 below (1px=4px because tailwind scale).
  const blockHeight = Math.max(0, laneHeight - 8)
  const { selectedAudioClipId, setSelectedAudioClipId } = useEditorState()
  const selected = selectedAudioClipId === clip.id || isInMultiSelect
  const { show: showContextMenu } = useContextMenu()
  // Cross-highlight (Task 124): yellow glow only when highlighted AND not
  // already selected — keeps the "selected" and "linked-to-selected" states
  // visually distinct.
  const showHighlight = isHighlighted && !selected

  const isDragging = dragOffsetPx !== 0 || dragOffsetPy !== 0
  return (
    <div
      className={`absolute top-1 bottom-1 rounded-sm overflow-hidden border bg-cyan-900/30 hover:bg-cyan-900/50 ${isDragging ? '' : 'transition-colors'} ${
        selected
          ? 'border-cyan-300 ring-1 ring-cyan-300/60'
          : showHighlight
            ? 'border-yellow-300/70 ring-2 ring-yellow-300/60 shadow-[0_0_12px_rgba(252,211,77,0.4)]'
            : 'border-cyan-700/60'
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
        <>
          <ClipLabel
            projectName={projectName}
            clip={clip}
          />
          {/* Short clip-id hash pinned to the bottom-left for quick visual
              identification across sessions — separate from the editable
              label above. */}
          <div className="absolute bottom-0.5 left-1 text-[9px] font-mono text-cyan-300/80 truncate max-w-[calc(100%-8px)] pointer-events-none z-10">
            {clip.id.replace(/^audio_clip_/, '')}
          </div>
        </>
      )}
      {/* Edge-trim hit zones — 6 px wide, full height. ew-resize cursor on
          hover; tinted cyan band appears during active trim drag.
          Positioned with z-20 so they stay hit-testable over the waveform
          canvas (which is z-index: auto inside the block). */}
      {onClipTrimMouseDown && width > 12 && (
        <>
          <div
            className="absolute top-0 bottom-0 left-0 w-[6px] cursor-ew-resize z-20 hover:bg-cyan-400/30"
            onMouseDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              onClipTrimMouseDown(clip, 'left', e)
            }}
            title="Trim clip start"
          />
          <div
            className="absolute top-0 bottom-0 right-0 w-[6px] cursor-ew-resize z-20 hover:bg-cyan-400/30"
            onMouseDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              onClipTrimMouseDown(clip, 'right', e)
            }}
            title="Trim clip end"
          />
        </>
      )}
    </div>
  )
}

/**
 * GarageBand-style clip label pinned to the top-left of the clip block.
 * Single click is swallowed so it doesn't interfere with selection gestures
 * in the parent clip block; double-click swaps the label for an inline input
 * that commits on blur or Enter (Escape reverts). Falls back to a basename
 * derived from `source_path` when `clip.label` is unset.
 */
function ClipLabel({ projectName, clip }: { projectName: string; clip: AudioClip }) {
  const derived = deriveClipLabel(clip)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(derived)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setDraft(derived)
  }, [derived, editing])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commit = async () => {
    const next = draft.trim()
    setEditing(false)
    // Treat empty input as "revert to derived" by persisting null.
    const nextLabelForServer: string | null = next === '' ? null : next
    // No-op when the trimmed value matches what we'd display today. Compares
    // against the effective label (stored or derived) so clearing a label
    // that already matches the derived name doesn't trigger a POST.
    const effectiveNow = clip.label ?? derived
    if ((nextLabelForServer ?? derived) === effectiveNow) return
    try {
      const { postUpdateAudioClip } = await import('@/lib/audio-client')
      await postUpdateAudioClip(projectName, clip.id, { label: nextLabelForServer })
    } catch (err) {
      console.error('Failed to update audio clip label:', err)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(derived)
            setEditing(false)
          }
          // Stop other hotkeys (delete/backspace, space, etc.) from reaching
          // the editor while the user is typing in this inline input.
          e.stopPropagation()
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className="absolute top-0.5 left-1 right-1 text-[10px] font-sans text-cyan-100 bg-cyan-950/80 border border-cyan-400/60 rounded-sm px-1 py-px z-20 outline-none"
        maxLength={120}
      />
    )
  }

  return (
    <div
      className="absolute top-0.5 left-1 text-[10px] font-sans font-medium text-cyan-100 drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)] truncate max-w-[calc(100%-8px)] z-10 select-none cursor-text"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      title="Double-click to rename"
    >
      {clip.label ?? derived}
    </div>
  )
}

function deriveClipLabel(clip: AudioClip): string {
  const src = clip.source_path || ''
  // Strip any path prefix; then strip a trailing extension.
  const base = src.split('/').pop() || src
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem || clip.id.replace(/^audio_clip_/, '')
}
