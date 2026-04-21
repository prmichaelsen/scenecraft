import { useRef, useState, useCallback, useEffect, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import type { KeyframeWithTime } from './Timeline'
import type { Transition } from '@/routes/project/$name/editor'
import { postUpdateTransitionTrim, postClipTrimEdge, postMoveTransitions } from '@/lib/scenecraft-client'
import { TransitionFilmstrip } from './TransitionFilmstrip'

type TransitionTrackProps = {
  transitions: Transition[]
  keyframes: KeyframeWithTime[]
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

// Active body-drag gesture state (kept in ref to avoid re-renders on every mousemove)
type BodyDragState = {
  trId: string
  trWidth: number        // px width of the dragged clip
  fromTimeSeconds: number
  toTimeSeconds: number
  startX: number
  startY: number
  mode: 'move' | 'copy'
  locked: boolean        // true once movement threshold crossed
}

// Ghost preview position + metadata (state, rendered by React)
type GhostState = {
  cursorX: number
  cursorY: number
  width: number
  timeDelta: number      // clamped so from + delta >= 0
  mode: 'move' | 'copy'
}

export const TransitionTrack = memo(function TransitionTrack({
  transitions,
  keyframes,
  pxPerSec,
  selectedId,
  onTransitionClick,
  selectedIds,
  onBoundaryDrag: _onBoundaryDrag,
  onBoundaryDragEnd: _onBoundaryDragEnd,
  onRemapChange: _onRemapChange,
  onTrimChange,
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
  const handleBodyDown = useCallback(
    (e: React.MouseEvent, tr: Transition, fromT: number, toT: number) => {
      // Only left-button drags
      if (e.button !== 0) return
      // Don't call e.preventDefault or e.stopPropagation here — we want a plain click
      // (no movement) to still reach the onClick handler.
      const mode: 'move' | 'copy' = (e.metaKey || e.ctrlKey) ? 'copy' : 'move'
      const trWidth = (toT - fromT) * pxPerSec
      bodyDragState.current = {
        trId: tr.id,
        trWidth,
        fromTimeSeconds: fromT,
        toTimeSeconds: toT,
        startX: e.clientX,
        startY: e.clientY,
        mode,
        locked: false,
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
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.removeEventListener('keydown', onKeyDown)
      }

      const computeTimeDelta = (clientX: number) => {
        const st = bodyDragState.current
        if (!st) return 0
        const rawDelta = (clientX - st.startX) / pxPerSec
        // Clamp: new_from = fromT + delta >= 0  =>  delta >= -fromT
        return Math.max(-st.fromTimeSeconds, rawDelta)
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
        commitGhost({
          cursorX: ev.clientX,
          cursorY: ev.clientY,
          width: st.trWidth,
          timeDelta,
          mode: st.mode,
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
        const trId = st.trId
        const mode = st.mode

        // Clear visuals immediately; keep didDrag=true so the synthetic click is swallowed.
        cleanup()

        // Swallow the synthetic click that follows mouseup on the bar.
        const stopClick = (ce: MouseEvent) => {
          ce.stopPropagation()
          document.removeEventListener('click', stopClick, true)
        }
        document.addEventListener('click', stopClick, true)

        if (Math.abs(timeDelta) < 0.01) {
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
            trackDelta: 0,
            timeDeltaSeconds: timeDelta,
            transitionIds: [trId],
            autoCreateTracks: true,
          })
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
    [pxPerSec, projectName, onTrimChange],
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
      {/* Body-drag ghost preview — fixed-positioned at cursor bottom-right (cursor.x+4, cursor.y+4) */}
      {ghost && typeof document !== 'undefined' && createPortal(
        <div
          className="pointer-events-none fixed z-50 bg-orange-500/30 border border-orange-500 rounded-t-sm"
          style={{
            left: ghost.cursorX + 4,
            top: ghost.cursorY + 4,
            width: ghost.width,
            height: 12,
            opacity: 0.5,
          }}
        />,
        document.body,
      )}
    </div>
  )
})
