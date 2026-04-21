import { useRef, useState, useCallback, useEffect, memo } from 'react'
import { createPortal } from 'react-dom'
import type { KeyframeWithTime } from './Timeline'
import type { Transition } from '@/routes/project/$name/editor'
import { postMoveTransitions } from '@/lib/scenecraft-client'

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
  onTrimChange?: () => void
  onRetryRender?: (tr: Transition) => void
  onDropVideo?: (transitionId: string, poolPath: string, sourceTransitionId?: string) => void
  renderProgress?: Record<string, number>
  scrollLeft: number
  viewportWidth: number
  isActiveTrack?: boolean
}

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
  onBoundaryDrag,
  onBoundaryDragEnd,
  onRemapChange,
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
  const dragState = useRef<{ dragging: boolean; keyframeId: string; transitionId: string; otherKfTime: number; startX: number; startTime: number; minTime: number; maxTime: number } | null>(null)
  const didDrag = useRef(false)

  // Body-drag (move) gesture state — ref-based to avoid per-mousemove re-renders
  const bodyDragState = useRef<BodyDragState | null>(null)
  const [ghost, setGhost] = useState<GhostState | null>(null)
  const ghostRafRef = useRef<number | null>(null)
  const lastGhostRef = useRef<GhostState | null>(null)

  const handleEdgeDown = useCallback((e: React.MouseEvent, keyframeId: string, transitionId: string, otherKfTime: number, currentTime: number, minTime: number, maxTime: number) => {
    e.stopPropagation()
    e.preventDefault()
    dragState.current = { dragging: true, keyframeId, transitionId, otherKfTime, startX: e.clientX, startTime: currentTime, minTime, maxTime }
    didDrag.current = false

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragState.current?.dragging) return
      const deltaX = ev.clientX - dragState.current.startX
      if (Math.abs(deltaX) > 2) didDrag.current = true
      const newTime = Math.max(dragState.current.minTime, Math.min(dragState.current.maxTime, dragState.current.startTime + deltaX / pxPerSec))
      onBoundaryDrag?.(dragState.current.keyframeId, newTime)
    }

    const handleMouseUp = (ev: MouseEvent) => {
      if (didDrag.current && dragState.current) {
        const deltaX = ev.clientX - dragState.current.startX
        const newTime = Math.max(dragState.current.minTime, Math.min(dragState.current.maxTime, dragState.current.startTime + deltaX / pxPerSec))
        console.log(`[TransitionTrack] mouseUp ${dragState.current.keyframeId}: startTime=${dragState.current.startTime.toFixed(2)} deltaX=${deltaX} pxPerSec=${pxPerSec} rawTime=${(dragState.current.startTime + deltaX / pxPerSec).toFixed(2)} clampedTime=${newTime.toFixed(2)} min=${dragState.current.minTime.toFixed(2)} max=${dragState.current.maxTime.toFixed(2)}`)
        onBoundaryDragEnd?.(dragState.current.keyframeId, newTime)
        // Compute new timeline duration and update remap
        const newDuration = Math.abs(newTime - dragState.current.otherKfTime)
        onRemapChange?.(dragState.current.transitionId, newDuration)
        // Swallow the synthetic click that would otherwise bubble to parent handlers
        // (e.g., track onClick that seeks the playhead)
        const stopClick = (ce: MouseEvent) => {
          ce.stopPropagation()
          document.removeEventListener('click', stopClick, true)
        }
        document.addEventListener('click', stopClick, true)
      }
      dragState.current = null
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [pxPerSec, onBoundaryDrag, onBoundaryDragEnd, onRemapChange])

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

        // Find neighboring keyframes for drag bounds
        const sortedKfs = [...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds)
        const fromIdx = sortedKfs.findIndex((k) => k.id === tr.from)
        const toIdx = sortedKfs.findIndex((k) => k.id === tr.to)

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

            {/* Duration label above transition bar */}
            {width > 30 && (
              <div className="absolute bottom-3 left-0 right-0 flex items-center justify-center pointer-events-none">
                <span className="text-[8px] font-mono text-gray-600">{timelineDur.toFixed(2)}s</span>
              </div>
            )}

            {/* Transition bar */}
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
              {/* Left edge drag handle — only interactive on active track */}
              {isActiveTrack !== false && (
                <div
                  className="absolute top-0 left-0 w-2 h-full cursor-col-resize hover:bg-orange-500/40 pointer-events-auto z-10"
                  onMouseDown={(e) => {
                    const prevKf = fromIdx > 0 ? sortedKfs[fromIdx - 1] : null
                    handleEdgeDown(e, tr.from, tr.id, toKf.timeSeconds, fromKf.timeSeconds, prevKf ? prevKf.timeSeconds + 0.1 : 0, toKf.timeSeconds - 0.1)
                  }}
                />
              )}

              {/* Right edge drag handle — only interactive on active track */}
              {isActiveTrack !== false && (
                <div
                  className="absolute top-0 right-0 w-2 h-full cursor-col-resize hover:bg-orange-500/40 pointer-events-auto z-10"
                  onMouseDown={(e) => {
                    const nextKf = toIdx < sortedKfs.length - 1 ? sortedKfs[toIdx + 1] : null
                    handleEdgeDown(e, tr.to, tr.id, fromKf.timeSeconds, toKf.timeSeconds, fromKf.timeSeconds + 0.1, nextKf ? nextKf.timeSeconds - 0.1 : (duration || Infinity))
                  }}
                />
              )}

              {/* Label */}
              {width > 50 && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className={`text-[7px] font-mono truncate px-1 ${isSelected ? 'text-orange-300' : 'text-gray-500'}`}>
                    {tr.id}{speed && speed !== '1.00' ? ` ${speed}x` : ''}
                  </span>
                </div>
              )}
            </div>

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
