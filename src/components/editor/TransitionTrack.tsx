import { useRef, useState, useCallback, useEffect, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import type { KeyframeWithTime } from './Timeline'
import type { Transition } from '@/routes/project/$name/editor'
import { postUpdateTransitionTrim, postClipTrimEdge, postMoveTransitions, type Track } from '@/lib/scenecraft-client'
import { TransitionFilmstrip } from './TransitionFilmstrip'

/**
 * OverlapPreview — live, non-destructive preview of what a body-drag would do
 * to EXISTING transitions on the target track(s).
 *
 * Classification mirrors the backend's four overlap cases (see T95):
 *   A) fully inside drop span      → target is consumed (soft-deleted on commit)
 *   B) straddles drop's new_from   → target is trimmed; its RIGHT portion (from
 *                                    boundaryX to target's right edge) would be
 *                                    consumed. boundaryX = drop's new_from.
 *   C) straddles drop's new_to     → target is trimmed; its LEFT portion (from
 *                                    target's left edge to boundaryX) would be
 *                                    consumed. boundaryX = drop's new_to.
 *   D) drop lands fully inside the target → the target is split into two pieces
 *                                    with the dropped clip in the middle. leftX
 *                                    / rightX are the two split lines.
 *
 * All x-coordinates are in timeline pixels (time * pxPerSec), consistent with
 * how TransitionTrack positions its transition bars.
 */
export type OverlapPreview = {
  consumedIds: string[]
  trimmedLeftIds: Array<{ id: string; boundaryX: number }>
  trimmedRightIds: Array<{ id: string; boundaryX: number }>
  splitInsideIds: Array<{ id: string; leftX: number; rightX: number }>
}

/**
 * GhostOverflow — counts of "New track" rows to preview above / below the
 * existing track stack during a body-drag. Published by the drag-initiating
 * TransitionTrack so Timeline can render the dashed rows.
 */
export type GhostOverflow = {
  topCount: number
  bottomCount: number
}

type TransitionTrackProps = {
  transitions: Transition[]
  keyframes: KeyframeWithTime[]
  // Full project-level lists used by body-drag for multi-clip (multi-track) ghost
  // rendering + per-clip source-track-index lookup. For single-track rendering
  // the primary `transitions`/`keyframes` props are still used.
  allTransitions?: Transition[]
  allKeyframes?: KeyframeWithTime[]
  // Sorted tracks (same order as rendered in Timeline). Index into this list is
  // the row position used for trackDelta arithmetic.
  tracks?: Track[]
  // Height of a single track row in px — used to offset ghost rects vertically
  // by `trackDelta * trackRowHeight`.
  trackRowHeight?: number
  // Target-track highlight callback — during a body-drag, TransitionTrack reports
  // which track IDs would receive a dropped clip so Timeline can tint those rows.
  onTargetTracksChange?: (ids: Set<string> | null) => void
  // Per-mousemove overlap preview — the drag-initiating TransitionTrack computes
  // what would happen to existing transitions on the target track(s) and publishes
  // it so Timeline can render overlays on every matching TransitionTrack.
  onOverlapPreviewChange?: (preview: OverlapPreview | null) => void
  // Auto-create-track overflow — how many "New track" dashed rows to render
  // above / below the existing stack because trackDelta has pushed some clips
  // out of the existing track range.
  onGhostOverflowChange?: (overflow: GhostOverflow | null) => void
  // Overlap preview passed down from Timeline (same payload as published via
  // onOverlapPreviewChange). Each TransitionTrack renders the slice that
  // matches its own `transitions`.
  overlapPreview?: OverlapPreview | null
  pxPerSec: number
  selectedId: string | null
  duration: number
  projectName?: string
  onTransitionClick: (tr: Transition, shiftKey?: boolean) => void
  selectedIds?: Set<string>
  onBoundaryDrag?: (keyframeId: string, newTimeSeconds: number) => void
  onBoundaryDragEnd?: (keyframeId: string, newTimeSeconds: number) => void
  onRemapChange?: (transitionId: string, targetDuration: number) => void
  onTrimChange?: () => void  // called after a trim drag persists so parent can refresh
  /**
   * Fires after a successful body-drag commit (M10). Timeline uses it to
   * carry selected audio clips along with the dragged transitions by the
   * same timeDelta. `draggedTransitionIds` lets the caller skip clips that
   * are linked to one of these transitions — propagation via `update_keyframe`
   * already shifts linked-audio clips, so a manual shift would double-move.
   */
  onAfterBodyDrag?: (opts: { timeDelta: number; trackDelta: number; draggedTransitionIds: string[] }) => void
  onRetryRender?: (tr: Transition) => void
  onDropVideo?: (transitionId: string, poolPath: string, sourceTransitionId?: string) => void
  renderProgress?: Record<string, number>
  scrollLeft: number
  viewportWidth: number
  isActiveTrack?: boolean
}

// Formats a timestamp back into the scenecraft "M:SS.XX" shape. The backend's
// parse accepts this same form.
function secondsToTs(s: number): string {
  const safe = Math.max(0, s)
  const m = Math.floor(safe / 60)
  const secs = safe - m * 60
  return `${m}:${secs.toFixed(2).padStart(5, '0')}`
}

/**
 * Boundary-zone classification. Each shared keyframe between two transitions is
 * a "boundary" with three hover sub-zones:
 *   <]  trim-out the LEFT clip only (creates gap on shrink)
 *   <|> rolling edit — shared kf moves, both trims adjust
 *   [>  trim-in the RIGHT clip only (creates gap on shrink)
 */
type BoundaryZone = 'trim-out' | 'roll' | 'trim-in'

// Per-clip snapshot captured at drag-start — used to render the multi-clip
// ghost composite and to compute per-clip commit payloads.
type DraggedClipInfo = {
  id: string
  fromTimeSeconds: number
  toTimeSeconds: number
  widthPx: number
  sourceTrackIndex: number
}

// Active body-drag gesture state (kept in ref to avoid re-renders on every mousemove)
type BodyDragState = {
  primaryTrId: string
  draggedIds: string[]              // all clips in the gesture (1 if primary not in selection)
  clips: DraggedClipInfo[]          // snapshots for ghost/offset math, in same order as draggedIds
  primary: DraggedClipInfo          // the clip under mousedown (source of truth for offsets)
  startX: number
  startY: number
  mode: 'move' | 'copy'
  locked: boolean                   // true once movement threshold crossed
  numTracks: number                 // existing track count at drag start — used for overflow detection
  // Previous-frame memo keys — skip recompute when nothing relevant changed.
  lastTimeDelta: number
  lastTrackDelta: number
}

// Ghost preview position + metadata (state, rendered by React)
type GhostState = {
  cursorX: number
  cursorY: number
  timeDelta: number                 // clamped so from + delta >= 0
  trackDelta: number                // UNCLAMPED — values outside [0, numTracks-1] trigger auto-create preview rows
  mode: 'move' | 'copy'
  clips: DraggedClipInfo[]          // snapshot at drag-start (pinned so ghost doesn't flicker)
  primary: DraggedClipInfo
  targetTrackName: string           // e.g. "Track 2" — resolved on mousemove; "New track" when out of range
  overflow: GhostOverflow           // # of dashed "new track" rows above / below
  // Counts for tooltip suffixes — computed from the overlap preview.
  consumedCount: number
  splitCount: number                // trimmedLeft + trimmedRight + splitInside
}

export const TransitionTrack = memo(function TransitionTrack({
  transitions,
  keyframes,
  allTransitions,
  allKeyframes,
  tracks,
  trackRowHeight,
  onTargetTracksChange,
  onOverlapPreviewChange,
  onGhostOverflowChange,
  overlapPreview,
  pxPerSec,
  selectedId,
  onTransitionClick,
  selectedIds,
  onBoundaryDrag: _onBoundaryDrag,
  onBoundaryDragEnd: _onBoundaryDragEnd,
  onRemapChange: _onRemapChange,
  onTrimChange,
  onAfterBodyDrag,
  onRetryRender,
  onDropVideo,
  renderProgress,
  duration,
  projectName,
  scrollLeft,
  viewportWidth,
  isActiveTrack,
}: TransitionTrackProps) {
  const kfMap = new Map(keyframes.map((kf) => [kf.id, kf]))
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const didDrag = useRef(false)

  // Boundary map: for each shared kf between two transitions, who's on each side?
  const boundaryMap = useMemo(() => {
    const m = new Map<string, { leftTr?: Transition; rightTr?: Transition }>()
    for (const tr of transitions) {
      const from = m.get(tr.from) ?? {}
      from.rightTr = tr
      m.set(tr.from, from)
      const to = m.get(tr.to) ?? {}
      to.leftTr = tr
      m.set(tr.to, to)
    }
    return m
  }, [transitions])

  // Live drag preview state — applied as CSS overrides while a trim drag is active.
  // Keyed by kf_id since a drag moves a specific kf's timestamp.
  const [dragPreview, setDragPreview] = useState<{
    zone: BoundaryZone
    kfId: string
    newKfTime: number
    leftTrimOut?: number
    rightTrimIn?: number
    tooltip: string
  } | null>(null)

  // Body-drag (move) gesture state — ref-based to avoid per-mousemove re-renders
  const bodyDragState = useRef<BodyDragState | null>(null)
  const [ghost, setGhost] = useState<GhostState | null>(null)
  const ghostRafRef = useRef<number | null>(null)
  const lastGhostRef = useRef<GhostState | null>(null)

  /**
   * Start a clip-boundary drag. `zone` picks the behavior:
   *   'trim-out' — <] on left clip's right edge
   *   'roll'     — <|> at the shared boundary
   *   'trim-in'  — [> on right clip's left edge
   *
   * All three converge on the same mousemove/mouseup plumbing; the zone just
   * decides which fields get computed and persisted.
   */
  const handleBoundaryDown = useCallback((
    e: React.MouseEvent,
    zone: BoundaryZone,
    boundaryKf: KeyframeWithTime,
    leftTr: Transition | undefined,
    rightTr: Transition | undefined,
  ) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startTime = boundaryKf.timeSeconds
    // Modifier mode is captured at mousedown and held for the whole gesture.
    // Shift → ripple (trim + shift downstream to close/open gap).
    // Cmd/Ctrl → time remap (move kf only, adjacent trs' factors change).
    const isRipple = e.shiftKey
    const isRemap = e.metaKey || e.ctrlKey
    didDrag.current = false

    // Compute bounds so we don't drag past neighboring kfs or past source-video extents.
    const sortedKfs = [...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds)
    const idx = sortedKfs.findIndex((k) => k.id === boundaryKf.id)
    const prevKf = idx > 0 ? sortedKfs[idx - 1] : null
    const nextKf = idx < sortedKfs.length - 1 ? sortedKfs[idx + 1] : null

    // Source-based bounds (trim_in/out must stay within the source videos)
    let minTime = prevKf ? prevKf.timeSeconds + 0.1 : 0
    let maxTime = nextKf ? nextKf.timeSeconds - 0.1 : (duration || Infinity)

    // For trim-out on left clip: right boundary can't go past where trim_out would
    // exceed source_video_duration. Convert source-seconds back to timeline-seconds
    // using the current time-remap factor (timeline_duration / clip_duration).
    if (zone === 'trim-out' && leftTr) {
      const trimIn = leftTr.trimIn || 0
      const trimOut = leftTr.trimOut ?? leftTr.sourceVideoDuration ?? null
      const srcDur = leftTr.sourceVideoDuration
      if (trimOut != null && srcDur != null) {
        const clipDur = trimOut - trimIn
        const fromTime = kfMap.get(leftTr.from)?.timeSeconds ?? startTime
        const timelineDur = startTime - fromTime
        if (clipDur > 0 && timelineDur > 0) {
          const speed = clipDur / timelineDur  // > 1 = fast playback
          // max delta in seconds of timeline = (srcDur - trimOut) / speed
          const maxExtend = (srcDur - trimOut) / Math.max(speed, 0.001)
          maxTime = Math.min(maxTime, startTime + maxExtend)
        }
      }
    }
    // For trim-in on right clip: left boundary can't pull trim_in below 0.
    if (zone === 'trim-in' && rightTr) {
      const trimIn = rightTr.trimIn || 0
      const trimOut = rightTr.trimOut ?? rightTr.sourceVideoDuration ?? null
      if (trimOut != null) {
        const toTime = kfMap.get(rightTr.to)?.timeSeconds ?? startTime
        const timelineDur = toTime - startTime
        const clipDur = trimOut - trimIn
        if (clipDur > 0 && timelineDur > 0) {
          const speed = clipDur / timelineDur
          const maxRetreat = trimIn / Math.max(speed, 0.001)
          minTime = Math.max(minTime, startTime - maxRetreat)
        }
      }
    }

    const handleMouseMove = (ev: MouseEvent) => {
      const deltaX = ev.clientX - startX
      if (Math.abs(deltaX) > 2) didDrag.current = true
      const rawTime = startTime + deltaX / pxPerSec
      const newKfTime = Math.max(minTime, Math.min(maxTime, rawTime))
      const delta = newKfTime - startTime

      // Compute trim updates per zone
      let leftTrimOut: number | undefined
      let rightTrimIn: number | undefined
      const parts: string[] = []

      if ((zone === 'trim-out' || zone === 'roll') && leftTr) {
        const fromTime = kfMap.get(leftTr.from)?.timeSeconds ?? 0
        const oldTimelineDur = Math.max(0.001, startTime - fromTime)
        const oldTrimIn = leftTr.trimIn || 0
        const oldTrimOut = leftTr.trimOut ?? leftTr.sourceVideoDuration ?? oldTimelineDur
        const oldClipDur = oldTrimOut - oldTrimIn
        const speed = oldClipDur / oldTimelineDur
        // New trim_out = trim_in + (new timeline duration) * speed
        const newTimelineDur = newKfTime - fromTime
        leftTrimOut = oldTrimIn + newTimelineDur * speed
        parts.push(`L out=${leftTrimOut.toFixed(2)}s`)
      }
      if ((zone === 'trim-in' || zone === 'roll') && rightTr) {
        const toTime = kfMap.get(rightTr.to)?.timeSeconds ?? 0
        const oldTimelineDur = Math.max(0.001, toTime - startTime)
        const oldTrimIn = rightTr.trimIn || 0
        const oldTrimOut = rightTr.trimOut ?? rightTr.sourceVideoDuration ?? oldTimelineDur
        const oldClipDur = oldTrimOut - oldTrimIn
        const speed = oldClipDur / oldTimelineDur
        // New trim_in such that the right clip preserves its trim_out but shifts in-point by the delta.
        rightTrimIn = oldTrimIn + delta * speed
        parts.push(`R in=${rightTrimIn.toFixed(2)}s`)
      }

      const zoneLabel = zone === 'trim-out' ? '<]' : zone === 'roll' ? '<|>' : '[>'
      const modLabel = isRipple ? ' ⇔ripple' : isRemap ? ' ↔⚡remap' : ''
      setDragPreview({
        zone,
        kfId: boundaryKf.id,
        newKfTime,
        leftTrimOut,
        rightTrimIn,
        tooltip: `${zoneLabel}${modLabel} Δ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}s · ${parts.join(' · ')}`,
      })
    }

    const handleMouseUp = async (ev: MouseEvent) => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)

      if (!didDrag.current) {
        setDragPreview(null)
        return
      }

      // Read the latest preview state directly from the setter so we don't
      // race React's async state update.
      const deltaX = ev.clientX - startX
      const rawTime = startTime + deltaX / pxPerSec
      const newKfTime = Math.max(minTime, Math.min(maxTime, rawTime))
      const delta = newKfTime - startTime

      try {
        if (!projectName) {
          console.error('[TransitionTrack] boundary drag commit missing projectName, skipping persist')
        } else if (isRemap) {
          // Cmd/Ctrl: time remap — move the boundary kf only, no trim changes.
          // Backend cascades duration_seconds on adjacent trs; their factors change naturally.
          const anchorTr = leftTr ?? rightTr
          if (anchorTr) {
            const isTo = anchorTr === leftTr  // for leftTr, the boundary is its to_kf
            await postUpdateTransitionTrim(projectName, {
              transitionId: anchorTr.id,
              ...(isTo
                ? { toKfTimestamp: secondsToTs(newKfTime) }
                : { fromKfTimestamp: secondsToTs(newKfTime) }),
            })
          }
        } else if (zone === 'trim-out' && leftTr) {
          // `<]` on leftTr's right edge. Preserve LEFT's factor; backend inserts
          // a gap (shrink) or advances the next tr's trim (extend) so the next
          // tr's factor is also preserved. Shift → ripple (shift downstream).
          const fromTime = kfMap.get(leftTr.from)?.timeSeconds ?? 0
          const oldTimelineDur = Math.max(0.001, startTime - fromTime)
          const oldTrimIn = leftTr.trimIn || 0
          const oldTrimOut = leftTr.trimOut ?? leftTr.sourceVideoDuration ?? oldTimelineDur
          const speed = (oldTrimOut - oldTrimIn) / oldTimelineDur
          const newTrimOut = oldTrimIn + (newKfTime - fromTime) * speed
          await postClipTrimEdge(projectName, {
            transitionId: leftTr.id,
            edge: 'right',
            newBoundaryTimestamp: secondsToTs(newKfTime),
            newTrim: newTrimOut,
            mode: isRipple ? 'ripple' : 'trim',
          })
        } else if (zone === 'trim-in' && rightTr) {
          // `[>` on rightTr's left edge. Preserve RIGHT's factor; backend inserts
          // a gap (shrink) or advances the previous tr's trim (extend). Shift → ripple.
          const toTime = kfMap.get(rightTr.to)?.timeSeconds ?? 0
          const oldTimelineDur = Math.max(0.001, toTime - startTime)
          const oldTrimIn = rightTr.trimIn || 0
          const oldTrimOut = rightTr.trimOut ?? rightTr.sourceVideoDuration ?? oldTimelineDur
          const speed = (oldTrimOut - oldTrimIn) / oldTimelineDur
          const newTrimIn = oldTrimIn + delta * speed
          await postClipTrimEdge(projectName, {
            transitionId: rightTr.id,
            edge: 'left',
            newBoundaryTimestamp: secondsToTs(newKfTime),
            newTrim: newTrimIn,
            mode: isRipple ? 'ripple' : 'trim',
          })
        } else if (zone === 'roll') {
          // Rolling edit: update both adjacent trs + move the shared kf.
          // (Shift on roll is treated as plain roll — ripple doesn't map to a symmetric edit.)
          const calls: Promise<unknown>[] = []
          if (leftTr) {
            const fromTime = kfMap.get(leftTr.from)?.timeSeconds ?? 0
            const oldTimelineDur = Math.max(0.001, startTime - fromTime)
            const oldTrimIn = leftTr.trimIn || 0
            const oldTrimOut = leftTr.trimOut ?? leftTr.sourceVideoDuration ?? oldTimelineDur
            const speed = (oldTrimOut - oldTrimIn) / oldTimelineDur
            const newTrimOut = oldTrimIn + (newKfTime - fromTime) * speed
            calls.push(postUpdateTransitionTrim(projectName, {
              transitionId: leftTr.id,
              trimOut: newTrimOut,
              toKfTimestamp: secondsToTs(newKfTime),
            }))
          }
          if (rightTr) {
            const toTime = kfMap.get(rightTr.to)?.timeSeconds ?? 0
            const oldTimelineDur = Math.max(0.001, toTime - startTime)
            const oldTrimIn = rightTr.trimIn || 0
            const oldTrimOut = rightTr.trimOut ?? rightTr.sourceVideoDuration ?? oldTimelineDur
            const speed = (oldTrimOut - oldTrimIn) / oldTimelineDur
            const newTrimIn = oldTrimIn + delta * speed
            calls.push(postUpdateTransitionTrim(projectName, {
              transitionId: rightTr.id,
              trimIn: newTrimIn,
              fromKfTimestamp: secondsToTs(newKfTime),
            }))
          }
          await Promise.all(calls)
        }
        onTrimChange?.()
      } catch (err) {
        console.error('trim drag persist failed:', err)
      } finally {
        setDragPreview(null)
      }

      // Swallow the synthetic click that would otherwise bubble up
      const stopClick = (ce: MouseEvent) => {
        ce.stopPropagation()
        document.removeEventListener('click', stopClick, true)
      }
      document.addEventListener('click', stopClick, true)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [pxPerSec, keyframes, duration, kfMap, projectName, onTrimChange])

  // Body-drag handler — mousedown on a transition bar's interior (NOT the boundary zones,
  // which call stopPropagation in their own onMouseDown).
  //
  // This is the M10 multi-clip + cross-track gesture:
  //   - If the clicked clip is in selectedIds, drag the whole selection (multi-clip).
  //   - Otherwise drag only the clicked clip.
  //   - On mousemove: Y-delta is hit-tested against Timeline's track rows
  //     (`[data-track-id]`) to derive a uniform trackDelta applied to every dragged clip.
  //   - trackDelta is clamped so no clip overflows the existing track range (Task 99
  //     removes this clamp and adds auto-create-track previews).
  //   - Mouseup commits a single postMoveTransitions call for the entire batch.
  const handleBodyDown = useCallback(
    (e: React.MouseEvent, tr: Transition, fromT: number, toT: number) => {
      // Only left-button drags
      if (e.button !== 0) return
      // Don't call e.preventDefault or e.stopPropagation here — we want a plain click
      // (no movement) to still reach the onClick handler.
      const mode: 'move' | 'copy' = (e.metaKey || e.ctrlKey) ? 'copy' : 'move'

      // Resolve the set of clips participating in this gesture.
      const inSelection = !!(selectedIds && selectedIds.has(tr.id))
      const draggedIdSet = inSelection ? new Set(selectedIds!) : new Set([tr.id])

      // Resolve source track index per clip via the `tracks` prop. We also need
      // fromTime/toTime/width per clip, looked up from allTransitions + allKeyframes
      // (falls back to the same-track lists passed in the primary props).
      const trackList = tracks ?? []
      const trackIndexById = new Map(trackList.map((t, i) => [t.id, i]))
      const allTrs = allTransitions ?? transitions
      const allKfs = allKeyframes ?? keyframes
      const kfTimeById = new Map(allKfs.map((k) => [k.id, k.timeSeconds]))

      const clips: DraggedClipInfo[] = []
      for (const id of draggedIdSet) {
        const t = allTrs.find((x) => x.id === id)
        if (!t) continue
        const fts = kfTimeById.get(t.from)
        const tts = kfTimeById.get(t.to)
        if (fts == null || tts == null) continue
        const srcIdx = trackIndexById.get(t.trackId) ?? 0
        clips.push({
          id: t.id,
          fromTimeSeconds: fts,
          toTimeSeconds: tts,
          widthPx: (tts - fts) * pxPerSec,
          sourceTrackIndex: srcIdx,
        })
      }
      // Primary = the clicked clip. Guaranteed present (we just looked it up from allTrs).
      const primary = clips.find((c) => c.id === tr.id) ?? {
        id: tr.id,
        fromTimeSeconds: fromT,
        toTimeSeconds: toT,
        widthPx: (toT - fromT) * pxPerSec,
        sourceTrackIndex: trackIndexById.get(tr.trackId) ?? 0,
      }
      // Guarantee primary is in clips (single-clip drag when not in selection)
      if (!clips.some((c) => c.id === primary.id)) clips.push(primary)

      const numTracks = Math.max(1, trackList.length)

      bodyDragState.current = {
        primaryTrId: tr.id,
        draggedIds: Array.from(draggedIdSet),
        clips,
        primary,
        startX: e.clientX,
        startY: e.clientY,
        mode,
        locked: false,
        numTracks,
        lastTimeDelta: Number.NaN,
        lastTrackDelta: Number.NaN,
      }
      didDrag.current = false

      const commitGhost = (next: GhostState) => {
        lastGhostRef.current = next
        if (ghostRafRef.current != null) return
        ghostRafRef.current = requestAnimationFrame(() => {
          ghostRafRef.current = null
          if (lastGhostRef.current) setGhost(lastGhostRef.current)
        })
      }

      const cleanup = () => {
        bodyDragState.current = null
        if (ghostRafRef.current != null) {
          cancelAnimationFrame(ghostRafRef.current)
          ghostRafRef.current = null
        }
        lastGhostRef.current = null
        setGhost(null)
        document.body.style.cursor = ''
        onTargetTracksChange?.(null)
        onOverlapPreviewChange?.(null)
        onGhostOverflowChange?.(null)
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.removeEventListener('keydown', onKeyDown)
      }

      const computeTimeDelta = (clientX: number) => {
        const st = bodyDragState.current
        if (!st) return 0
        const rawDelta = (clientX - st.startX) / pxPerSec
        // Clamp so new_from >= 0 across ALL dragged clips:
        //   for every clip: fromTime + delta >= 0 => delta >= -fromTime
        //   => delta >= -min(fromTime)  (tighter bound across the batch)
        const minFrom = st.clips.reduce((m, c) => Math.min(m, c.fromTimeSeconds), Infinity)
        return Math.max(-minFrom, rawDelta)
      }

      // Hit-test cursor Y against the rendered track rows. Returns the row index
      // (position in `tracks`) under the cursor, or null if the cursor isn't over
      // any track. Walks up from elementFromPoint looking for [data-track-id].
      const hitTestTrackIndex = (clientX: number, clientY: number): number | null => {
        if (typeof document === 'undefined') return null
        let el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
        while (el) {
          const id = el.getAttribute?.('data-track-id')
          if (id) {
            const idx = trackIndexById.get(id)
            return idx ?? null
          }
          el = el.parentElement
        }
        return null
      }

      // Unclamped: trackDelta can push clips past the top/bottom of the stack,
      // which triggers the "New track" auto-create preview rows (T99). The
      // backend's autoCreateTracks flag makes this just work on commit.
      const computeTrackDelta = (clientX: number, clientY: number): number => {
        const st = bodyDragState.current
        if (!st) return 0
        const hit = hitTestTrackIndex(clientX, clientY)
        // If cursor isn't over a track row, clamp to the nearest valid row.
        // We still want to allow overflow when the cursor IS over a row-adjacent
        // area above/below the stack — detect via the cursor Y relative to the
        // track container. For simplicity, when no hit is found we hold the
        // primary's source track (0 delta).
        if (hit == null) return 0
        return hit - st.primary.sourceTrackIndex
      }

      // Compute the overlap preview + ghost overflow for the current drop params.
      // Scans allTransitions for items on each target track that overlap a dropped
      // clip's new [new_from, new_to] span, classifying per the four overlap cases.
      // Returns null when nothing is worth rendering (no locked drag yet, etc.).
      const computePreviewAndOverflow = (
        draggedIdSet: Set<string>,
        timeDelta: number,
        trackDelta: number,
      ): { preview: OverlapPreview; overflow: GhostOverflow } => {
        const preview: OverlapPreview = {
          consumedIds: [],
          trimmedLeftIds: [],
          trimmedRightIds: [],
          splitInsideIds: [],
        }
        // Overflow — how many rows past the top / bottom of the stack do we need?
        // Each dragged clip's target row = sourceTrackIndex + trackDelta; if < 0
        // that's negative overflow (top), if >= numTracks that's positive (bottom).
        let topOverflow = 0
        let bottomOverflow = 0
        for (const c of bodyDragState.current!.clips) {
          const ti = c.sourceTrackIndex + trackDelta
          if (ti < 0) topOverflow = Math.max(topOverflow, -ti)
          else if (ti >= numTracks) bottomOverflow = Math.max(bottomOverflow, ti - numTracks + 1)
        }
        const overflow: GhostOverflow = { topCount: topOverflow, bottomCount: bottomOverflow }

        // Build a track-id → all-active-transitions-on-that-track map ONCE per frame,
        // excluding the dragged clips themselves.
        const kfTimeById = new Map(allKfs.map((k) => [k.id, k.timeSeconds]))
        const byTrack = new Map<string, Transition[]>()
        for (const t of allTrs) {
          if (draggedIdSet.has(t.id)) continue
          if (t.hidden) continue
          const arr = byTrack.get(t.trackId) ?? []
          arr.push(t)
          byTrack.set(t.trackId, arr)
        }

        const EPS = 0.001
        for (const c of bodyDragState.current!.clips) {
          const ti = c.sourceTrackIndex + trackDelta
          // Landing on a new (auto-created) track — no existing trs to overlap with.
          if (ti < 0 || ti >= numTracks) continue
          const targetTrack = trackList[ti]
          if (!targetTrack) continue
          const newFrom = c.fromTimeSeconds + timeDelta
          const newTo = c.toTimeSeconds + timeDelta
          if (newTo <= newFrom) continue

          const existing = byTrack.get(targetTrack.id) ?? []
          for (const other of existing) {
            const oFrom = kfTimeById.get(other.from)
            const oTo = kfTimeById.get(other.to)
            if (oFrom == null || oTo == null) continue
            // No overlap
            if (oTo <= newFrom + EPS || oFrom >= newTo - EPS) continue

            // Case A: target fully inside [newFrom, newTo] → consumed
            if (oFrom >= newFrom - EPS && oTo <= newTo + EPS) {
              preview.consumedIds.push(other.id)
              continue
            }
            // Case D: drop fully inside target → two split lines
            if (newFrom > oFrom + EPS && newTo < oTo - EPS) {
              preview.splitInsideIds.push({
                id: other.id,
                leftX: newFrom * pxPerSec,
                rightX: newTo * pxPerSec,
              })
              continue
            }
            // Case B: drop's new_from lands inside target (straddles left edge of drop)
            //   → target's RIGHT portion (from newFrom to oTo) is consumed
            if (newFrom > oFrom + EPS && newFrom < oTo - EPS) {
              preview.trimmedLeftIds.push({
                id: other.id,
                boundaryX: newFrom * pxPerSec,
              })
              continue
            }
            // Case C: drop's new_to lands inside target (straddles right edge of drop)
            //   → target's LEFT portion (from oFrom to newTo) is consumed
            if (newTo > oFrom + EPS && newTo < oTo - EPS) {
              preview.trimmedRightIds.push({
                id: other.id,
                boundaryX: newTo * pxPerSec,
              })
              continue
            }
          }
        }
        return { preview, overflow }
      }

      const onMouseMove = (ev: MouseEvent) => {
        const st = bodyDragState.current
        if (!st) return
        const dx = ev.clientX - st.startX
        const dy = ev.clientY - st.startY
        if (!st.locked) {
          if (Math.hypot(dx, dy) < 4) return
          st.locked = true
          didDrag.current = true
          document.body.style.cursor = 'grabbing'
        }
        const timeDelta = computeTimeDelta(ev.clientX)
        const trackDelta = computeTrackDelta(ev.clientX, ev.clientY)
        const targetTrackIdx = st.primary.sourceTrackIndex + trackDelta
        const targetTrackName =
          targetTrackIdx < 0 || targetTrackIdx >= numTracks
            ? 'New track'
            : trackList[targetTrackIdx]?.name || `Track ${targetTrackIdx + 1}`

        // Publish target-track set for Timeline to tint. Only trs landing on an
        // EXISTING track count for tinting; new-track-overflow clips tint nothing
        // (the dashed rows convey their own affordance).
        if (onTargetTracksChange) {
          const targetIds = new Set<string>()
          for (const c of st.clips) {
            const ti = c.sourceTrackIndex + trackDelta
            if (ti < 0 || ti >= numTracks) continue
            const id = trackList[ti]?.id
            if (id) targetIds.add(id)
          }
          onTargetTracksChange(targetIds)
        }

        // Memoized overlap + overflow compute — only runs when drop params change.
        const draggedIdSet = new Set(st.draggedIds)
        const changed = timeDelta !== st.lastTimeDelta || trackDelta !== st.lastTrackDelta
        let consumedCount = 0
        let splitCount = 0
        let overflow: GhostOverflow = { topCount: 0, bottomCount: 0 }
        if (changed) {
          st.lastTimeDelta = timeDelta
          st.lastTrackDelta = trackDelta
          const { preview, overflow: ov } = computePreviewAndOverflow(draggedIdSet, timeDelta, trackDelta)
          overflow = ov
          consumedCount = preview.consumedIds.length
          splitCount = preview.trimmedLeftIds.length + preview.trimmedRightIds.length + preview.splitInsideIds.length
          onOverlapPreviewChange?.(preview)
          onGhostOverflowChange?.(overflow)
        } else {
          // Reuse last computed counts — cheap: re-derive from lastGhostRef so
          // the tooltip counts stay stable across pure mouse-jitter frames.
          const last = lastGhostRef.current
          if (last) {
            consumedCount = last.consumedCount
            splitCount = last.splitCount
            overflow = last.overflow
          }
        }

        commitGhost({
          cursorX: ev.clientX,
          cursorY: ev.clientY,
          timeDelta,
          trackDelta,
          mode: st.mode,
          clips: st.clips,
          primary: st.primary,
          targetTrackName,
          overflow,
          consumedCount,
          splitCount,
        })
      }

      const onMouseUp = async (ev: MouseEvent) => {
        const st = bodyDragState.current
        if (!st) { cleanup(); return }
        const wasLocked = st.locked
        if (!wasLocked) {
          // No drag occurred — let the normal click handler fire.
          cleanup()
          return
        }

        const timeDelta = computeTimeDelta(ev.clientX)
        const trackDelta = computeTrackDelta(ev.clientX, ev.clientY)
        const draggedIds = [...st.draggedIds]
        const mode = st.mode

        // Clear visuals immediately; keep didDrag=true so the synthetic click is swallowed.
        cleanup()

        // Swallow the synthetic click that follows mouseup on the bar.
        const stopClick = (ce: MouseEvent) => {
          ce.stopPropagation()
          document.removeEventListener('click', stopClick, true)
        }
        document.addEventListener('click', stopClick, true)

        if (Math.abs(timeDelta) < 0.01 && trackDelta === 0) {
          // No net movement — skip backend call.
          return
        }
        if (!projectName) {
          console.error('[TransitionTrack] body-drag commit missing projectName, skipping move')
          return
        }
        try {
          await postMoveTransitions(projectName, {
            mode,
            trackDelta,
            timeDeltaSeconds: timeDelta,
            transitionIds: draggedIds,
            autoCreateTracks: true,
          })
          // Give the parent a chance to move selected audio clips by the
          // same timeDelta BEFORE refreshing. Linked clips auto-shift via
          // update_keyframe propagation; the callback filters those out.
          onAfterBodyDrag?.({ timeDelta, trackDelta, draggedTransitionIds: draggedIds })
          onTrimChange?.()
        } catch (err) {
          console.error('[TransitionTrack] postMoveTransitions failed:', err)
        }
      }

      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          // Cancel: clear state, no backend call.
          ev.preventDefault()
          ev.stopPropagation()
          // Preserve didDrag so the upcoming click (if any) is swallowed.
          cleanup()
        }
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      document.addEventListener('keydown', onKeyDown)
    },
    [pxPerSec, projectName, onTrimChange, selectedIds, tracks, allTransitions, allKeyframes, transitions, keyframes, onTargetTracksChange, onOverlapPreviewChange, onGhostOverflowChange],
  )

  // Safety: release document-level cursor override if the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      if (bodyDragState.current) {
        document.body.style.cursor = ''
      }
      if (ghostRafRef.current != null) {
        cancelAnimationFrame(ghostRafRef.current)
      }
    }
  }, [])

  const BUFFER_PX = 300

  return (
    <div className="absolute inset-0 pointer-events-none overflow-visible">
      {/* Live drag preview — blue line at new kf position + tooltip */}
      {dragPreview && (() => {
        const x = dragPreview.newKfTime * pxPerSec
        if (x < scrollLeft - BUFFER_PX || x > scrollLeft + viewportWidth + BUFFER_PX) return null
        const color = dragPreview.zone === 'roll' ? 'bg-purple-400' : 'bg-cyan-400'
        return (
          <>
            <div
              className={`absolute top-0 bottom-0 w-0.5 ${color} pointer-events-none z-40 shadow-[0_0_8px_rgba(56,189,248,0.6)]`}
              style={{ left: x }}
            />
            <div
              className="absolute bottom-full mb-1 bg-gray-900 text-xs text-white font-mono px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none border border-gray-700"
              style={{ left: x + 8 }}
            >
              {dragPreview.tooltip}
            </div>
          </>
        )
      })()}
      {transitions.map((tr) => {
        const fromKf = kfMap.get(tr.from)
        const toKf = kfMap.get(tr.to)
        if (!fromKf || !toKf) return null

        const x = fromKf.timeSeconds * pxPerSec + 3
        const endX = toKf.timeSeconds * pxPerSec
        const width = endX - x
        if (width <= 0) return null
        // Viewport culling
        if (endX < scrollLeft - BUFFER_PX || x > scrollLeft + viewportWidth + BUFFER_PX) return null

        const isSelected = tr.id === selectedId || (selectedIds?.has(tr.id) ?? false)
        const hasCandidates = Object.values(tr.candidates).some((arr) => arr.length > 0)

        // Compute speed for display
        const timelineDur = toKf.timeSeconds - fromKf.timeSeconds
        const speed = tr.durationSeconds > 0 && timelineDur > 0 ? (tr.durationSeconds / timelineDur).toFixed(2) : null

        return (
          <div
            key={tr.id}
            className={`absolute top-0 h-full pointer-events-none group ${isSelected ? 'z-20' : 'z-10'}`}
            style={{ left: x, width }}
          >
            {/* Render progress bar */}
            {renderProgress?.[tr.id] != null && (() => {
              const p = renderProgress[tr.id] ?? 0
              const done = p >= 1
              return (
                <div
                  className={`absolute top-0 left-0 right-0 h-6 ${done ? 'bg-sky-900/30' : 'bg-red-900/30'} rounded overflow-hidden pointer-events-auto cursor-pointer shadow-[0_2px_4px_rgba(0,0,0,0.3)]`}
                  onClick={(e) => { e.stopPropagation(); onRetryRender?.(tr) }}
                  title="Click to retry frame decode"
                >
                  <div
                    className={`h-full rounded transition-[width] duration-200 ${done ? 'bg-sky-400/50 shadow-[0_0_6px_rgba(56,189,248,0.4)]' : 'bg-red-500/50 shadow-[0_0_6px_rgba(239,68,68,0.4)]'}`}
                    style={{ width: `${p * 100}%` }}
                  />
                </div>
              )
            })()}

            {/* Filmstrip — frame thumbnails along long clips when zoom permits.
                Sits behind the duration label and the bar; no pointer-events
                so it doesn't interfere with trim/click interactions. */}
            {projectName && (
              <div className="absolute top-0 left-0 right-0 bottom-3">
                <TransitionFilmstrip
                  projectName={projectName}
                  transition={tr}
                  blockWidth={width}
                />
              </div>
            )}

            {/* Duration label above transition bar */}
            {width > 30 && (
              <div className="absolute bottom-3 left-0 right-0 flex items-center justify-center pointer-events-none z-10">
                <span className="text-[8px] font-mono text-gray-600 bg-gray-900/60 px-1 rounded">{timelineDur.toFixed(2)}s</span>
              </div>
            )}

            {/* Transition bar — body interior initiates move/copy body-drag gesture */}
            <div
              className={`absolute bottom-0 left-0 right-0 h-3 rounded-t-sm pointer-events-auto transition-colors border-t ${
                isActiveTrack !== false ? 'cursor-grab' : 'cursor-pointer'
              } ${
                dropTarget === tr.id
                  ? 'bg-green-500/30 border-green-500/60 ring-1 ring-green-500'
                  : tr.hidden
                    ? `bg-yellow-500/10 hover:bg-yellow-500/15 border-yellow-500/20 border-dashed ${isSelected ? 'ring-1 ring-yellow-500' : ''}`
                    : `bg-orange-500/15 hover:bg-orange-500/25 border-orange-500/30 ${isSelected ? 'ring-1 ring-orange-500' : ''}`
              }`}
              onMouseDown={(e) => {
                // Body-drag only initiates on active tracks; skip on inactive.
                if (isActiveTrack === false) return
                // The boundary zones below stopPropagation in their own handlers,
                // so this fires only when mousedown lands on the bar interior.
                handleBodyDown(e, tr, fromKf.timeSeconds, toKf.timeSeconds)
              }}
              onClick={(e) => {
                if (didDrag.current) { didDrag.current = false; return }
                e.stopPropagation()
                onTransitionClick(tr, e.shiftKey)
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/x-scenecraft-pool-path')) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                  setDropTarget(tr.id)
                }
              }}
              onDragLeave={() => setDropTarget((prev) => prev === tr.id ? null : prev)}
              onDrop={(e) => {
                e.preventDefault()
                setDropTarget(null)
                const poolPath = e.dataTransfer.getData('application/x-scenecraft-pool-path')
                const sourceTrId = e.dataTransfer.getData('application/x-scenecraft-source-tr')
                if (poolPath && onDropVideo) {
                  onDropVideo(tr.id, poolPath, sourceTrId || undefined)
                }
              }}
            >
              {/* Label inside the bar */}
              {width > 50 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className={`text-[7px] font-mono truncate px-1 ${isSelected ? 'text-orange-300' : 'text-gray-500'}`}>
                    {tr.id}{speed && speed !== '1.00' ? ` ${speed}x` : ''}
                  </span>
                </div>
              )}
            </div>

            {/* Overlap preview overlays — rendered during a body-drag to show what
                would happen to THIS transition if the drop committed. All are
                pointer-events-none so they don't interfere with trim/click handlers.
                Coordinates in overlapPreview are absolute timeline px (time * pxPerSec);
                we subtract this wrapper's `x` to translate into local coords. */}
            {overlapPreview && (() => {
              if (overlapPreview.consumedIds.includes(tr.id)) {
                // Case A: fully consumed — red tint over the whole bar
                return (
                  <div
                    className="absolute bottom-0 left-0 right-0 h-3 rounded-t-sm bg-red-500/25 ring-1 ring-red-500/60 pointer-events-none z-30"
                  />
                )
              }
              const trimLeft = overlapPreview.trimmedLeftIds.find((e) => e.id === tr.id)
              if (trimLeft) {
                // Case B: drop's new_from falls inside this tr → right portion
                // from boundaryX to tr's right edge is consumed.
                const localLeft = Math.max(0, trimLeft.boundaryX - x)
                return (
                  <div
                    className="absolute bottom-0 h-3 rounded-tr-sm bg-red-500/25 ring-1 ring-red-500/60 pointer-events-none z-30"
                    style={{ left: localLeft, right: 0 }}
                  />
                )
              }
              const trimRight = overlapPreview.trimmedRightIds.find((e) => e.id === tr.id)
              if (trimRight) {
                // Case C: drop's new_to falls inside this tr → left portion
                // from tr's left edge to boundaryX is consumed.
                const localRight = Math.max(0, trimRight.boundaryX - x)
                return (
                  <div
                    className="absolute bottom-0 left-0 h-3 rounded-tl-sm bg-red-500/25 ring-1 ring-red-500/60 pointer-events-none z-30"
                    style={{ width: localRight }}
                  />
                )
              }
              const splitInside = overlapPreview.splitInsideIds.find((e) => e.id === tr.id)
              if (splitInside) {
                // Case D: drop lands fully inside this tr → two split lines.
                const localL = splitInside.leftX - x
                const localR = splitInside.rightX - x
                return (
                  <>
                    <div
                      className="absolute bottom-0 h-3 w-0.5 bg-blue-400 shadow-[0_0_4px_rgba(96,165,250,0.8)] pointer-events-none z-30"
                      style={{ left: localL }}
                    />
                    <div
                      className="absolute bottom-0 h-3 w-0.5 bg-blue-400 shadow-[0_0_4px_rgba(96,165,250,0.8)] pointer-events-none z-30"
                      style={{ left: localR }}
                    />
                  </>
                )
              }
              return null
            })()}

            {/* Boundary zone handles — siblings of the bar so they span the full track height.
                Invisible by default; tint + glyph appear on hover. These stopPropagation
                in handleBoundaryDown so the body-drag onMouseDown above doesn't fire. */}
            {/* [> trim-in — at left edge of this tr */}
            {isActiveTrack !== false && (
              <div
                className="absolute top-0 left-0 h-full cursor-w-resize hover:bg-cyan-400/50 hover:border-l-2 hover:border-cyan-400/80 pointer-events-auto z-20 flex items-start justify-center group/trim-in"
                style={{ width: '8px' }}
                title="[> Trim in (this clip)"
                onMouseDown={(e) => {
                  const leftTr = boundaryMap.get(tr.from)?.leftTr
                  handleBoundaryDown(e, 'trim-in', fromKf, leftTr, tr)
                }}
              >
                <span className="text-[8px] font-mono text-cyan-100 leading-none mt-0.5 pointer-events-none select-none opacity-0 group-hover/trim-in:opacity-100">[</span>
              </div>
            )}

            {/* <] trim-out — just inside right edge */}
            {isActiveTrack !== false && (
              <div
                className="absolute top-0 h-full cursor-e-resize hover:bg-cyan-400/50 hover:border-r-2 hover:border-cyan-400/80 pointer-events-auto z-20 flex items-start justify-center group/trim-out"
                style={{ right: '5px', width: '8px' }}
                title="<] Trim out (this clip)"
                onMouseDown={(e) => {
                  const rightTr = boundaryMap.get(tr.to)?.rightTr
                  handleBoundaryDown(e, 'trim-out', toKf, tr, rightTr)
                }}
              >
                <span className="text-[8px] font-mono text-cyan-100 leading-none mt-0.5 pointer-events-none select-none opacity-0 group-hover/trim-out:opacity-100">]</span>
              </div>
            )}

            {/* <|> rolling edit — centered on right boundary; only when neighbor exists */}
            {isActiveTrack !== false && boundaryMap.get(tr.to)?.rightTr && (
              <div
                className="absolute top-0 h-full cursor-ew-resize hover:bg-purple-400/70 pointer-events-auto z-30 flex items-start justify-center group/roll"
                style={{ right: '-2px', width: '5px' }}
                title="<|> Rolling edit (move shared boundary)"
                onMouseDown={(e) => {
                  const rightTr = boundaryMap.get(tr.to)?.rightTr
                  handleBoundaryDown(e, 'roll', toKf, tr, rightTr)
                }}
              >
                <span className="text-[8px] font-mono text-purple-100 leading-none mt-0.5 pointer-events-none select-none opacity-0 group-hover/roll:opacity-100">|</span>
              </div>
            )}

            {/* Hover tooltip */}
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-gray-800 text-xs text-gray-300 px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none">
              {tr.id}: {tr.from} → {tr.to} ({timelineDur.toFixed(2)}s on timeline, {tr.durationSeconds.toFixed(2)}s video)
              {speed && <span className="text-orange-400 ml-1">{speed}x</span>}
              {hasCandidates && <span className="text-orange-400 ml-1">{Object.values(tr.candidates).reduce((s, a) => s + a.length, 0)} videos</span>}
            </div>
          </div>
        )
      })}
      {/* Body-drag ghost preview — fixed-positioned at cursor bottom-right (cursor.x+4, cursor.y+4).
          Multi-clip ghosts are composited relative to the primary clip's ghost: each rect is
          offset by (clip.fromTime - primary.fromTime) * pxPerSec horizontally and
          (clip.sourceTrackIndex - primary.sourceTrackIndex) * trackRowHeight vertically, plus
          a shared trackDelta * trackRowHeight vertical shift for the cross-track portion.
          Copy mode (Cmd/Ctrl at mousedown) renders a green tint + a `+` badge on the primary. */}
      {ghost && typeof document !== 'undefined' && createPortal(
        (() => {
          const rowHeight = trackRowHeight ?? 96
          const primaryFrom = ghost.primary.fromTimeSeconds
          const primarySrcIdx = ghost.primary.sourceTrackIndex
          const verticalShift = ghost.trackDelta * rowHeight
          const originX = ghost.cursorX + 4
          const originY = ghost.cursorY + 4
          // Tooltip values
          const startT = primaryFrom + ghost.timeDelta
          const endT = ghost.primary.toTimeSeconds + ghost.timeDelta
          const fmt = (s: number) => {
            const safe = Math.max(0, s)
            const m = Math.floor(safe / 60)
            const secs = safe - m * 60
            return `${m}:${secs.toFixed(2).padStart(5, '0')}`
          }
          const isCopy = ghost.mode === 'copy'
          const deltaLabel = `${isCopy ? '📋 ' : ''}Δ${ghost.timeDelta >= 0 ? '+' : ''}${ghost.timeDelta.toFixed(2)}s`
          const nClips = ghost.clips.length
          // Pluralized clip/copy label — "3 clips" for move, "+3 copies" (or "+1 copy") for copy mode.
          let clipsSuffix = ''
          if (isCopy) clipsSuffix = ` · +${nClips} ${nClips === 1 ? 'copy' : 'copies'}`
          else if (nClips > 1) clipsSuffix = ` · ${nClips} clips`
          const consumedSuffix = ghost.consumedCount > 0 ? ` · ${ghost.consumedCount} consumed` : ''
          const splitSuffix = ghost.splitCount > 0 ? ` · ${ghost.splitCount} split` : ''
          const newTracks = ghost.overflow.topCount + ghost.overflow.bottomCount
          const newTracksSuffix = newTracks > 0 ? ` · +${newTracks} new track${newTracks > 1 ? 's' : ''}` : ''
          const primaryBase = isCopy
            ? 'bg-green-500/30 border-green-500'
            : 'bg-orange-500/30 border-orange-500'
          return (
            <>
              {ghost.clips.map((c) => {
                const offsetX = (c.fromTimeSeconds - primaryFrom) * pxPerSec
                const offsetY = (c.sourceTrackIndex - primarySrcIdx) * rowHeight + verticalShift
                const isPrimary = c.id === ghost.primary.id
                return (
                  <div
                    key={c.id}
                    className={`pointer-events-none fixed z-50 rounded-t-sm border ${primaryBase} ${isPrimary ? 'ring-1 ring-white/40' : ''}`}
                    style={{
                      left: originX + offsetX,
                      top: originY + offsetY,
                      width: c.widthPx,
                      height: 12,
                      opacity: 0.5,
                    }}
                  >
                    {/* Copy-mode + badge — only on the primary ghost, top-left corner */}
                    {isPrimary && isCopy && (
                      <div
                        className="absolute flex items-center justify-center rounded-full bg-green-500 text-white shadow-[0_0_4px_rgba(34,197,94,0.8)]"
                        style={{ left: -6, top: -6, width: 16, height: 16 }}
                      >
                        <Plus size={12} strokeWidth={3} />
                      </div>
                    )}
                  </div>
                )
              })}
              {/* Tooltip — top-left corner of primary ghost, offset (8, -20) so it sits above */}
              <div
                className="pointer-events-none fixed z-50 bg-gray-900 text-xs text-white font-mono px-2 py-1 rounded shadow-lg whitespace-nowrap border border-gray-700"
                style={{ left: originX + 8, top: originY - 20 }}
              >
                {fmt(startT)} → {fmt(endT)} · {ghost.targetTrackName} · {deltaLabel}{clipsSuffix}{consumedSuffix}{splitSuffix}{newTracksSuffix}
              </div>
            </>
          )
        })(),
        document.body,
      )}
    </div>
  )
})
