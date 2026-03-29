import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import type { EditorData, Keyframe, Transition, Beat, Section } from '@/routes/project/$name/editor'
import type { UserEffect, BeatSuppression, AudioEvent, EffectType } from '@/lib/beatlab-client'
import { updateKeyframeTimestamp, secondsToTimestamp, addKeyframe, deleteKeyframe, deleteTransition, saveEffects, updateTransitionRemap } from '@/routes/project/$name/editor'
import { AudioTrack } from './AudioTrack'
import { beatlabFileUrl } from '@/lib/beatlab-client'
import { VideoTrack } from './VideoTrack'
import { TransitionTrack } from './TransitionTrack'
import { Playhead } from './Playhead'
import { KeyframePanel, preloadStills } from './KeyframePanel'
import { BinPanel, type PoolSelection } from './BinPanel'
import { TransitionPanel } from './TransitionPanel'
import { BeatEffectPreview } from './BeatEffectPreview'
import { preloadTransition, preloadKeyframeImage, getFrameAtProgress, getFrames, isLoaded, isInMemory, getLoadProgress, setPreviewResolution, setKeyTimestamp, setPlayheadPosition, invalidateEntry } from '@/lib/frame-cache'
import { ImportDialog } from './ImportDialog'
import { EffectsTrack } from './EffectsTrack'
import { EffectEditor } from './EffectEditor'
import { VersionHistoryPanel } from './VersionHistoryPanel'
import { TimelineSwitcher } from './TimelineSwitcher'
import { NarrativeSectionPanel } from './NarrativeSectionPanel'
import { SettingsPanel } from './SettingsPanel'

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
  const [showVersions, setShowVersions] = useState(false)
  const [showSections, setShowSections] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [previewQuality, setPreviewQuality] = useState(data.previewQuality)
  const [userEffects, setUserEffects] = useState<UserEffect[]>(data.userEffects)
  const [suppressions, setSuppressions] = useState<BeatSuppression[]>(data.beatSuppressions)
  const [selectedSuppressionId, setSelectedSuppressionId] = useState<string | null>(null)
  const nextSupId = useRef(data.beatSuppressions.length + 1)
  const [selectedEffect, setSelectedEffect] = useState<UserEffect | null>(null)
  const [selectedEffectIds, setSelectedEffectIds] = useState<Set<string>>(new Set())
  const [poolSelection, setPoolSelection] = useState<PoolSelection | null>(null)
  const nextFxId = useRef(data.userEffects.length + 1)
  // Drag overrides: keyframeId -> overridden timeSeconds (during drag only)
  const [dragOverrides, setDragOverrides] = useState<Record<string, number>>({})
  const [videoTrackHeight, setVideoTrackHeight] = useState(DEFAULT_VIDEO_HEIGHT)
  const [previewHeight, setPreviewHeight] = useState(DEFAULT_PREVIEW_HEIGHT)
  // Viewport state for virtualized rendering
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(2000)

  // Restore persisted heights from localStorage after mount (SSR-safe)
  useEffect(() => {
    const storedVideo = localStorage.getItem(VIDEO_HEIGHT_KEY)
    if (storedVideo) setVideoTrackHeight(Math.max(MIN_VIDEO_HEIGHT, Math.min(MAX_VIDEO_HEIGHT, parseInt(storedVideo, 10))))
    const storedPreview = localStorage.getItem(PREVIEW_HEIGHT_KEY)
    if (storedPreview) setPreviewHeight(Math.max(MIN_PREVIEW_HEIGHT, Math.min(MAX_PREVIEW_HEIGHT, parseInt(storedPreview, 10))))
  }, [])

  // Preload stills for base image picker
  useEffect(() => { preloadStills(data.projectName) }, [data.projectName])

  // Measure viewport width for virtualization
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setViewportWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Compute canvas resolution from quality percentage and project resolution
  const canvasWidth = Math.round(data.meta.resolution[0] * previewQuality / 100)
  const canvasHeight = Math.round(data.meta.resolution[1] * previewQuality / 100)

  // Keep frame cache resolution in sync — called during render (not in effect)
  // so globals are set before any preload effects read dbKey()
  setPreviewResolution(canvasWidth, canvasHeight)
  const scrollRef = useRef<HTMLDivElement>(null)
  const seekFnRef = useRef<((time: number) => void) | null>(null)
  const playPauseFnRef = useRef<(() => void) | null>(null)
  const trackDragRef = useRef<{ dragging: boolean; startY: number; startHeight: number }>({ dragging: false, startY: 0, startHeight: 0 })
  const previewDragRef = useRef<{ dragging: boolean; startY: number; startHeight: number }>({ dragging: false, startY: 0, startHeight: 0 })

  const keyframes: KeyframeWithTime[] = data.keyframes.map((kf) => ({
    ...kf,
    timeSeconds: dragOverrides[kf.id] ?? parseTimestamp(kf.timestamp),
  }))

  // Use audio duration if available, otherwise estimate from keyframes
  const effectiveDuration = duration > 0 ? duration : (
    keyframes.length > 0 ? Math.max(...keyframes.map((kf) => kf.timeSeconds)) + 10 : 60
  )
  const totalWidth = effectiveDuration * pxPerSec

  const currentKeyframe = [...keyframes]
    .reverse()
    .find((kf) => kf.timeSeconds <= currentTime)

  // Find active transition at current time (if any with selected video)
  const kfMap = new Map(keyframes.map((kf) => [kf.id, kf]))
  const activeTransition = data.transitions.find((tr) => {
    const fromKf = kfMap.get(tr.from)
    const toKf = kfMap.get(tr.to)
    if (!fromKf || !toKf) return false
    if (!tr.hasSelectedVideo) return false
    return currentTime >= fromKf.timeSeconds && currentTime < toKf.timeSeconds
  })
  const activeTransitionFrom = activeTransition ? kfMap.get(activeTransition.from) : null
  const activeTransitionTo = activeTransition ? kfMap.get(activeTransition.to) : null

  // Preload keyframe images and transition videos near the playhead (±30s window).
  // Runs on time changes and data changes — avoids enqueuing hundreds of decodes at once.
  const PRELOAD_WINDOW = 30
  useEffect(() => {
    for (const kf of keyframes) {
      if (!kf.hasSelectedImage) continue
      if (Math.abs(kf.timeSeconds - currentTime) > PRELOAD_WINDOW) continue
      const key = `kf:${kf.id}`
      setKeyTimestamp(key, kf.timeSeconds)
      preloadKeyframeImage(key, beatlabFileUrl(data.projectName, `selected_keyframes/${kf.id}.png`))
    }

    for (const tr of data.transitions) {
      if (!tr.hasSelectedVideo) continue
      const fromKf = kfMap.get(tr.from)
      if (!fromKf || Math.abs(fromKf.timeSeconds - currentTime) > PRELOAD_WINDOW) continue
      const selectedVariant = tr.selected ?? 'none'
      const key = `tr:${tr.id}:v${selectedVariant}`
      setKeyTimestamp(key, fromKf.timeSeconds)
      if (!isInMemory(key)) {
        preloadTransition(key, beatlabFileUrl(data.projectName, `selected_transitions/${tr.id}_slot_0.mp4`))
      }
    }
  }, [currentTime, data.transitions, data.keyframes, data.projectName, canvasWidth, canvasHeight])

  // Update playhead position for proximity-based cache eviction
  useEffect(() => {
    setPlayheadPosition(currentTime)
  }, [currentTime])

  // Poll frame decode progress for render bars — unified map for both transitions and keyframes
  // Keys: tr_001, tr_002 (transition IDs) and kf_001, kf_002 (keyframe IDs) — no collisions
  const [renderProgress, setRenderProgress] = useState<Record<string, number>>({})
  const prevProgressRef = useRef<string>('')
  useEffect(() => {
    const update = () => {
      const progress: Record<string, number> = {}

      for (const tr of data.transitions) {
        if (!tr.hasSelectedVideo) continue
        const fromKf = kfMap.get(tr.from)
        if (fromKf && Math.abs(fromKf.timeSeconds - currentTime) > PRELOAD_WINDOW) continue
        const selectedVariant = tr.selected ?? 'none'
        const key = `tr:${tr.id}:v${selectedVariant}`
        const p = getLoadProgress(key)
        progress[tr.id] = p !== null ? p : isLoaded(key) ? 1 : 0
      }

      const serialized = JSON.stringify(progress)
      if (serialized !== prevProgressRef.current) {
        prevProgressRef.current = serialized
        setRenderProgress(progress)
      }
    }
    update()
    const interval = setInterval(update, 250)
    return () => clearInterval(interval)
  }, [data.transitions, keyframes])

  // Build adjacency lookup: which transition comes before/after each transition?
  const sortedTransitions = [...data.transitions]
    .filter((tr) => tr.hasSelectedVideo && kfMap.has(tr.from) && kfMap.has(tr.to))
    .sort((a, b) => kfMap.get(a.from)!.timeSeconds - kfMap.get(b.from)!.timeSeconds)

  // Map: keyframeId -> transition that ends at it (tr.to === kfId)
  const trEndingAt = new Map<string, Transition>()
  // Map: keyframeId -> transition that starts at it (tr.from === kfId)
  const trStartingAt = new Map<string, Transition>()
  for (const tr of sortedTransitions) {
    trEndingAt.set(tr.to, tr)
    trStartingAt.set(tr.from, tr)
  }

  // Get crossfade frame pair for smooth transitions at all boundaries
  const CROSSFADE_FRAMES = 4 // 4 frames each side = 8 frame overlap at 24fps (~333ms)
  const crossfadeData = (() => {
    if (!activeTransition || !activeTransitionFrom || !activeTransitionTo) {
      // No transition — show current keyframe from frame cache
      if (currentKeyframe) {
        const kfKey = `kf:${currentKeyframe.id}`
        const kfFrame = getFrameAtProgress(kfKey, 0)
        if (kfFrame) return { frameA: kfFrame, frameB: null, blendFactor: 0 }
      }
      return { frameA: null, frameB: null, blendFactor: 0 }
    }

    const tStart = activeTransitionFrom.timeSeconds
    const tEnd = activeTransitionTo.timeSeconds
    const progress = Math.max(0, Math.min(0.999, (currentTime - tStart) / (tEnd - tStart)))

    const selectedVariant = activeTransition.selected ?? 'none'
    const key = `tr:${activeTransition.id}:v${selectedVariant}`
    const entry = getFrames(key)
    const totalFrames = entry?.frames.length ?? 0
    const currentFrameIdx = totalFrames > 0
      ? Math.min(Math.floor(progress * totalFrames), totalFrames - 1)
      : 0
    const frameA = getFrameAtProgress(key, progress)

    // Crossfade at transition boundaries
    const xfade = Math.min(CROSSFADE_FRAMES, Math.floor(totalFrames / 2))
    if (xfade <= 0 || totalFrames === 0) {
      return { frameA, frameB: null, blendFactor: 0 }
    }

    // Transition start: crossfade from previous keyframe image (skip if previous is a transition — its end zone handles it)
    const prevTr = trEndingAt.get(activeTransition.from)
    if (!prevTr && currentFrameIdx < xfade) {
      const blend = currentFrameIdx / xfade
      const kfKey = `kf:${activeTransition.from}`
      return { frameA: getFrameAtProgress(kfKey, 0), frameB: frameA, blendFactor: blend }
    }

    // Transition end: crossfade to next transition's first frame or keyframe image
    if (currentFrameIdx >= totalFrames - xfade) {
      const blend = (currentFrameIdx - (totalFrames - xfade)) / xfade
      const nextTr = trStartingAt.get(activeTransition.to)
      if (nextTr) {
        const nextVariant = nextTr.selected ?? 'none'
        const nextKey = `tr:${nextTr.id}:v${nextVariant}`
        return { frameA, frameB: getFrameAtProgress(nextKey, 0), blendFactor: blend }
      }
      const kfKey = `kf:${activeTransition.to}`
      return { frameA, frameB: getFrameAtProgress(kfKey, 0), blendFactor: blend }
    }

    return { frameA, frameB: null, blendFactor: 0 }
  })()

  // Check if the active transition's frames are still loading
  const isTransitionLoading = (() => {
    if (!activeTransition || !activeTransitionFrom || !activeTransitionTo) return false
    const selectedVariant = activeTransition.selected ?? 'none'
    const key = `tr:${activeTransition.id}:v${selectedVariant}`
    return !isLoaded(key)
  })()

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const factor = e.deltaY > 0 ? 0.85 : 1.18
      const el = scrollRef.current
      if (el) {
        // Zoom around the playhead: keep playhead at the same viewport position
        const playheadX = currentTime * pxPerSec
        const viewportOffset = playheadX - el.scrollLeft
        const newPxPerSec = Math.max(0.1, pxPerSec * factor)
        const newPlayheadX = currentTime * newPxPerSec
        el.scrollLeft = newPlayheadX - viewportOffset
        setPxPerSec(newPxPerSec)
      } else {
        setPxPerSec((prev) => Math.max(0.1, prev * factor))
      }
    }
  }, [currentTime, pxPerSec])

  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (!scrollRef.current) return
      const rect = scrollRef.current.getBoundingClientRect()
      const scrollLeft = scrollRef.current.scrollLeft
      const clickX = e.clientX - rect.left + scrollLeft
      const time = clickX / pxPerSec
      if (time >= 0 && time <= effectiveDuration) {
        if (seekFnRef.current) {
          seekFnRef.current(time)
        } else {
          setCurrentTime(time)
        }
      }
    },
    [pxPerSec, effectiveDuration]
  )

  // Fallback time driver when audio isn't loaded yet
  const fallbackTimerRef = useRef<number>(0)
  const fallbackLastRef = useRef<number>(0)
  const usingFallbackTimer = useRef(false)

  // Stop fallback timer if audio takes over
  useEffect(() => {
    if (!isPlaying && usingFallbackTimer.current) {
      cancelAnimationFrame(fallbackTimerRef.current)
      usingFallbackTimer.current = false
    }
  }, [isPlaying])

  const handlePlayPause = useCallback(() => {
    if (playPauseFnRef.current) {
      // Cancel any running fallback timer since audio is in control
      if (usingFallbackTimer.current) {
        cancelAnimationFrame(fallbackTimerRef.current)
        usingFallbackTimer.current = false
      }
      playPauseFnRef.current()
    } else {
      // No audio loaded — toggle fallback timer
      if (isPlaying) {
        cancelAnimationFrame(fallbackTimerRef.current)
        usingFallbackTimer.current = false
        setIsPlaying(false)
      } else {
        fallbackLastRef.current = performance.now()
        usingFallbackTimer.current = true
        setIsPlaying(true)
        const tick = () => {
          const now = performance.now()
          const delta = (now - fallbackLastRef.current) / 1000
          fallbackLastRef.current = now
          setCurrentTime((prev) => {
            const next = prev + delta
            return next <= effectiveDuration ? next : prev
          })
          fallbackTimerRef.current = requestAnimationFrame(tick)
        }
        fallbackTimerRef.current = requestAnimationFrame(tick)
      }
    }
  }, [isPlaying, effectiveDuration])

  const closeAllPanels = useCallback(() => {
    setSelectedKeyframe(null)
    setSelectedTransition(null)
    setSelectedEffect(null)
    setSelectedEffectIds(new Set())
    setSelectedSuppressionId(null)
    setPoolSelection(null)
    setShowBin(false)
    setShowVersions(false)
    setShowSections(false)
    setShowSettings(false)
  }, [])

  const handleKeyframeClick = useCallback((kf: KeyframeWithTime) => {
    closeAllPanels()
    setSelectedKeyframe((prev) => prev?.id === kf.id ? null : kf)
  }, [closeAllPanels])

  const handleTransitionClick = useCallback((tr: Transition) => {
    closeAllPanels()
    setSelectedTransition((prev) => prev?.id === tr.id ? null : tr)
  }, [closeAllPanels])

  // Effects handlers
  const persistEffects = useCallback((effects: UserEffect[], supps: BeatSuppression[]) => {
    saveEffects({ data: { projectName: data.projectName, effects, suppressions: supps } })
  }, [data.projectName])

  const handleAddEffect = useCallback((time: number) => {
    closeAllPanels()
    const id = `fx_${String(nextFxId.current++).padStart(3, '0')}`
    const newEffect: UserEffect = { id, time, type: 'pulse', intensity: 0.8, duration: 0.2 }
    const updated = [...userEffects, newEffect].sort((a, b) => a.time - b.time)
    setUserEffects(updated)
    setSelectedEffect(newEffect)
    persistEffects(updated, suppressions)
  }, [userEffects, suppressions, persistEffects, closeAllPanels])

  const handleEffectClick = useCallback((fx: UserEffect, e?: { shiftKey?: boolean }) => {
    if (e?.shiftKey) {
      // Shift+click: toggle in multi-select
      setSelectedEffectIds((prev) => {
        const next = new Set(prev)
        if (next.has(fx.id)) next.delete(fx.id)
        else next.add(fx.id)
        return next
      })
      setSelectedEffect(fx)
      return
    }
    closeAllPanels()
    setSelectedEffect((prev) => prev?.id === fx.id ? null : fx)
    setSelectedEffectIds(new Set([fx.id]))
  }, [closeAllPanels])

  const handleEffectDrag = useCallback((id: string, newTime: number) => {
    setUserEffects((prev) => prev.map((fx) => fx.id === id ? { ...fx, time: newTime } : fx))
  }, [])

  const handleEffectDragEnd = useCallback((id: string, newTime: number) => {
    setUserEffects((prev) => {
      const newEffects = prev.map((fx) => fx.id === id ? { ...fx, time: newTime } : fx)
      persistEffects(newEffects, suppressions)
      return newEffects
    })
  }, [suppressions, persistEffects])

  const handleEffectUpdate = useCallback((updated: UserEffect) => {
    const newEffects = userEffects.map((fx) => fx.id === updated.id ? updated : fx)
    setUserEffects(newEffects)
    setSelectedEffect(updated)
    persistEffects(newEffects, suppressions)
  }, [userEffects, suppressions, persistEffects])

  const handleEffectDelete = useCallback((id: string) => {
    const newEffects = userEffects.filter((fx) => fx.id !== id)
    setUserEffects(newEffects)
    setSelectedEffect(null)
    persistEffects(newEffects, suppressions)
  }, [userEffects, suppressions, persistEffects])

  // Suppression handlers
  const handleAddSuppression = useCallback((from: number, to: number) => {
    const id = `sup_${String(nextSupId.current++).padStart(3, '0')}`
    const newSup: BeatSuppression = { id, from, to }
    const updated = [...suppressions, newSup]
    setSuppressions(updated)
    setSelectedSuppressionId(id)
    persistEffects(userEffects, updated)
  }, [suppressions, userEffects, persistEffects])

  const handleDeleteSuppression = useCallback((id: string) => {
    const updated = suppressions.filter((s) => s.id !== id)
    setSuppressions(updated)
    setSelectedSuppressionId(null)
    persistEffects(userEffects, updated)
  }, [suppressions, userEffects, persistEffects])

  const handleResizeSuppression = useCallback((id: string, from: number, to: number) => {
    const updated = suppressions.map((s) => s.id === id ? { ...s, from, to } : s)
    setSuppressions(updated)
    persistEffects(userEffects, updated)
  }, [suppressions, userEffects, persistEffects])

  const handleUpdateSuppressionTypes = useCallback((id: string, effectTypes: EffectType[] | undefined) => {
    const updated = suppressions.map((s) => {
      if (s.id !== id) return s
      const next = { ...s }
      if (effectTypes) next.effectTypes = effectTypes
      else delete next.effectTypes
      return next
    })
    setSuppressions(updated)
    persistEffects(userEffects, updated)
  }, [suppressions, userEffects, persistEffects])

  const handleSuppressionClick = useCallback((id: string) => {
    closeAllPanels()
    setSelectedSuppressionId((prev) => prev === id ? null : id)
  }, [closeAllPanels])

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
    try {
      await updateKeyframeTimestamp({
        data: { projectName: data.projectName, keyframeId: id, newTimestamp },
      })
    } catch (err) {
      console.error('[Timeline] Failed to persist keyframe timestamp:', id, newTimestamp, err)
    }
  }, [data])

  const handleAddKeyframe = useCallback(async () => {
    try {
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
    } catch (e) {
      console.error('Failed to add keyframe:', e)
    }
  }, [currentTime, data.projectName, router])

  const handleDeleteKeyframe = useCallback(async (id: string) => {
    await deleteKeyframe({ data: { projectName: data.projectName, keyframeId: id } })
    setSelectedKeyframe(null)
    router.invalidate()
  }, [data.projectName, router])

  const handleTransitionRemapChange = useCallback(async (transitionId: string, targetDuration: number) => {
    await updateTransitionRemap({ data: { projectName: data.projectName, transitionId, targetDuration } })
  }, [data.projectName])

  const handleDeleteTransition = useCallback(async (id: string) => {
    await deleteTransition({ data: { projectName: data.projectName, transitionId: id } })
    setSelectedTransition(null)
    router.invalidate()
  }, [data.projectName, router])

  const handleRetryRender = useCallback(async (tr: Transition) => {
    const selectedVariant = tr.selected ?? 'none'
    const key = `tr:${tr.id}:v${selectedVariant}`
    setRenderProgress((prev) => ({ ...prev, [tr.id]: 0 }))
    await invalidateEntry(key)
    preloadTransition(key, beatlabFileUrl(data.projectName, `selected_transitions/${tr.id}_slot_0.mp4`))
  }, [data.projectName])

  // Effect clipboard for copy/paste (supports multiple)
  const effectClipboard = useRef<UserEffect[]>([])

  // Delete key shortcut + Ctrl+C/V for effects
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea')) return

      if (e.key === 'Delete') {
        if (selectedKeyframe) handleDeleteKeyframe(selectedKeyframe.id)
        else if (selectedEffectIds.size > 0) {
          const remaining = userEffects.filter((fx) => !selectedEffectIds.has(fx.id))
          setUserEffects(remaining)
          setSelectedEffect(null)
          setSelectedEffectIds(new Set())
          persistEffects(remaining, suppressions)
        } else if (selectedEffect) {
          handleEffectDelete(selectedEffect.id)
        } else if (selectedSuppressionId) {
          handleDeleteSuppression(selectedSuppressionId)
        }
      }

      // Ctrl+C: copy selected effects
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedEffectIds.size > 0) {
        e.preventDefault()
        const selected = userEffects.filter((fx) => selectedEffectIds.has(fx.id))
        if (selected.length > 0) {
          // Store with times relative to the earliest selected effect
          const minTime = Math.min(...selected.map((fx) => fx.time))
          effectClipboard.current = selected.map((fx) => ({ ...fx, time: fx.time - minTime }))
        }
      }

      // Ctrl+V: paste effects at playhead
      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && effectClipboard.current.length > 0) {
        e.preventDefault()
        const newIds = new Set<string>()
        const pasted = effectClipboard.current.map((src) => {
          const id = `fx_${String(nextFxId.current++).padStart(3, '0')}`
          newIds.add(id)
          return { ...src, id, time: currentTime + src.time }
        })
        const updated = [...userEffects, ...pasted].sort((a, b) => a.time - b.time)
        setUserEffects(updated)
        setSelectedEffectIds(newIds)
        setSelectedEffect(pasted[0])
        persistEffects(updated, suppressions)
      }

      // Ctrl+A: select all effects
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && selectedEffect) {
        e.preventDefault()
        setSelectedEffectIds(new Set(userEffects.map((fx) => fx.id)))
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectedKeyframe, selectedEffect, selectedEffectIds, selectedSuppressionId, handleDeleteKeyframe, handleEffectDelete, handleDeleteSuppression, currentTime, userEffects, suppressions, persistEffects])

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
        handlePlayPause()
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
  }, [keyframes, currentTime, handlePlayPause])


  return (
    <div className="h-full flex">
      {/* Main timeline area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Preview */}
        <div
          className="bg-gray-950 flex items-center justify-center shrink-0 overflow-hidden"
          style={{ height: previewHeight }}
        >
          <div className="h-full aspect-video bg-gray-800 rounded overflow-hidden relative">
            {currentKeyframe?.hasSelectedImage || crossfadeData.frameA ? (
              <BeatEffectPreview
                src={currentKeyframe?.hasSelectedImage
                  ? beatlabFileUrl(data.projectName, `selected_keyframes/${currentKeyframe.id}.png`)
                  : ''}
                beats={data.beats}
                audioEvents={data.audioEvents}
                userEffects={userEffects}
                suppressions={suppressions}
                currentTime={currentTime}
                isPlaying={isPlaying}
                className="w-full h-full object-cover"
                canvasWidth={canvasWidth}
                canvasHeight={canvasHeight}
                transitionFrameA={crossfadeData.frameA}
                transitionFrameB={crossfadeData.frameB}
                blendFactor={crossfadeData.blendFactor}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm">
                No image
              </div>
            )}
            {isTransitionLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
                <span className="text-white/70 text-xs">Loading frames...</span>
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
            {formatTime(currentTime)} / {formatTime(effectiveDuration)}
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
            onClick={() => handleAddEffect(currentTime)}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-yellow-400/70 hover:text-yellow-300 px-2 py-1 rounded transition-colors"
            title="Add effect at playhead position"
          >
            + Effect
          </button>

          <button
            onClick={() => handleAddSuppression(currentTime, currentTime + 2)}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-red-400/70 hover:text-red-300 px-2 py-1 rounded transition-colors"
            title="Add suppression zone at playhead (2s default)"
          >
            + Suppress
          </button>

          {poolSelection && (
            <button
              onClick={async () => {
                try {
                  const { postInsertPoolItem } = await import('@/lib/beatlab-client')
                  await postInsertPoolItem(data.projectName, poolSelection.type, poolSelection.entry.path, currentTime)
                  setPoolSelection(null)
                  router.invalidate()
                } catch (e) {
                  console.error('Insert pool item failed:', e)
                  alert(`Insert failed: ${e}`)
                }
              }}
              className="text-xs bg-green-700 hover:bg-green-600 text-white px-2 py-1 rounded transition-colors animate-pulse"
              title={`Insert ${poolSelection.type} "${poolSelection.entry.name}" at playhead`}
            >
              Insert {poolSelection.type === 'keyframe' ? 'KF' : 'Video'}
            </button>
          )}

          <button
            onClick={() => { const was = showBin; closeAllPanels(); if (!was) setShowBin(true) }}
            className={`text-xs px-2 py-1 rounded transition-colors ${showBin ? 'bg-blue-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}
            title="Show deleted keyframes bin"
          >
            Bin
          </button>

          <button
            onClick={() => { closeAllPanels(); setShowImport(true) }}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-2 py-1 rounded transition-colors"
            title="Import images/videos from filesystem"
          >
            Import
          </button>

          <button
            onClick={() => { const was = showSections; closeAllPanels(); if (!was) setShowSections(true) }}
            className={`text-xs px-2 py-1 rounded transition-colors ${showSections ? 'bg-purple-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}
            title="Edit narrative sections"
          >
            Sections
          </button>

          <button
            onClick={() => { const was = showVersions; closeAllPanels(); if (!was) setShowVersions(true) }}
            className={`text-xs px-2 py-1 rounded transition-colors ${showVersions ? 'bg-green-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}
            title="Version history — save, restore, branch"
          >
            Versions
          </button>

          <TimelineSwitcher projectName={data.projectName} onSwitch={() => router.invalidate()} />

          <button
            onClick={() => { const was = showSettings; closeAllPanels(); if (!was) setShowSettings(true) }}
            className={`text-xs px-2 py-1 rounded transition-colors ${showSettings ? 'bg-gray-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}
            title="Project settings"
          >
            Settings
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
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
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
                scrollLeft={scrollLeft}
                viewportWidth={viewportWidth}
              />
              <TransitionTrack
                transitions={data.transitions}
                keyframes={keyframes}
                pxPerSec={pxPerSec}
                selectedId={selectedTransition?.id ?? null}
                onTransitionClick={handleTransitionClick}
                onBoundaryDrag={handleKeyframeDrag}
                onBoundaryDragEnd={handleKeyframeDragEnd}
                onRemapChange={handleTransitionRemapChange}
                onRetryRender={handleRetryRender}
                renderProgress={renderProgress}
                scrollLeft={scrollLeft}
                viewportWidth={viewportWidth}
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
              <BeatMarkers beats={data.beats} audioEvents={data.audioEvents} pxPerSec={pxPerSec} />
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

            {/* Effects track */}
            <div className="relative h-8 shrink-0 border-t border-gray-800 cursor-crosshair">
              <div className="absolute left-0 top-0 px-2 py-0.5 text-[10px] text-gray-600 uppercase tracking-wider z-10 bg-gray-950/80">
                FX
              </div>
              <EffectsTrack
                effects={userEffects}
                suppressions={suppressions}
                pxPerSec={pxPerSec}
                selectedEffectId={selectedEffect?.id ?? null}
                selectedEffectIds={selectedEffectIds}
                onEffectClick={handleEffectClick}
                onSelectEffectsInRange={(from: number, to: number) => {
                  const ids = new Set(userEffects.filter((fx) => fx.time >= from && fx.time <= to).map((fx) => fx.id))
                  setSelectedEffectIds(ids)
                  if (ids.size > 0) {
                    const first = userEffects.find((fx) => ids.has(fx.id))
                    if (first) setSelectedEffect(first)
                  }
                }}
                onAddEffect={handleAddEffect}
                onEffectDrag={handleEffectDrag}
                onEffectDragEnd={handleEffectDragEnd}
                onAddSuppression={handleAddSuppression}
                onDeleteSuppression={handleDeleteSuppression}
                onResizeSuppression={handleResizeSuppression}
                onUpdateSuppressionTypes={handleUpdateSuppressionTypes}
                selectedSuppressionId={selectedSuppressionId}
                onSuppressionClick={handleSuppressionClick}
                scrollLeft={scrollLeft}
                viewportWidth={viewportWidth}
              />
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
          key={selectedKeyframe.id}
          keyframe={selectedKeyframe}
          projectName={data.projectName}
          onClose={() => setSelectedKeyframe(null)}
          onDelete={() => handleDeleteKeyframe(selectedKeyframe.id)}
        />
      )}

      {/* Transition panel */}
      {selectedTransition && !showBin && !selectedKeyframe && (
        <TransitionPanel
          key={selectedTransition.id}
          transition={selectedTransition}
          projectName={data.projectName}
          motionPrompt={data.meta.motionPrompt}
          audioDescriptions={data.audioDescriptions}
          keyframes={keyframes}
          onClose={() => setSelectedTransition(null)}
          onDelete={() => handleDeleteTransition(selectedTransition.id)}
        />
      )}

      {/* Bin panel */}
      {showBin && !showVersions && (
        <BinPanel
          projectName={data.projectName}
          onClose={() => setShowBin(false)}
          onRestore={() => router.invalidate()}
          poolSelection={poolSelection}
          onPoolSelect={setPoolSelection}
          activeKeyframes={data.keyframes.map((kf) => ({ id: kf.id, timestamp: kf.timestamp, section: kf.section, prompt: kf.prompt, hasSelectedImage: kf.hasSelectedImage }))}
          activeTransitions={data.transitions.map((tr) => ({ id: tr.id, from: tr.from, to: tr.to, durationSeconds: tr.durationSeconds, hasSelectedVideo: tr.hasSelectedVideo }))}
        />
      )}

      {/* Narrative sections panel */}
      {showSections && (
        <NarrativeSectionPanel
          sections={data.narrativeSections}
          projectName={data.projectName}
          onClose={() => setShowSections(false)}
          onSeek={(time) => {
            if (seekFnRef.current) seekFnRef.current(time)
            else setCurrentTime(time)
          }}
        />
      )}

      {/* Settings panel */}
      {showSettings && (
        <SettingsPanel
          data={data}
          projectName={data.projectName}
          onClose={() => setShowSettings(false)}
          onSave={() => router.invalidate()}
          onPreviewQualityChange={(q) => setPreviewQuality(q)}
        />
      )}

      {/* Version history panel */}
      {showVersions && !showSettings && (
        <VersionHistoryPanel
          projectName={data.projectName}
          onClose={() => setShowVersions(false)}
          onRestore={() => router.invalidate()}
        />
      )}

      {/* Effect editor side panel */}
      {selectedEffect && !selectedKeyframe && !selectedTransition && !showBin && !showVersions && !showSections && !showSettings && (
        <EffectEditor
          effect={selectedEffect}
          onUpdate={handleEffectUpdate}
          onDelete={handleEffectDelete}
          onClose={() => { setSelectedEffect(null); setSelectedEffectIds(new Set()) }}
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

const STEM_COLORS: Record<string, string> = {
  kick: '239, 68, 68',     // red
  snare: '59, 130, 246',   // blue
  hh: '156, 163, 175',     // gray
  crash: '245, 158, 11',   // amber
  ride: '168, 85, 247',    // purple
  bass: '34, 197, 94',     // green
  piano: '236, 72, 153',   // pink
  guitar: '251, 146, 60',  // orange
  other: '107, 114, 128',  // gray
}

function BeatMarkers({ beats, audioEvents, pxPerSec }: { beats: Beat[]; audioEvents?: AudioEvent[]; pxPerSec: number }) {
  // Prefer audio intelligence events over raw beats
  if (audioEvents && audioEvents.length > 0) {
    const step = pxPerSec < 10 ? 4 : pxPerSec < 20 ? 2 : 1
    return (
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {audioEvents.map((ev, i) => {
          if (i % step !== 0) return null
          const x = ev.time * pxPerSec
          const w = Math.max(ev.duration * pxPerSec, 1)
          const color = STEM_COLORS[ev.stem_source] || STEM_COLORS.other
          const opacity = 0.1 + ev.intensity * 0.35
          return (
            <div
              key={i}
              className="absolute top-0 h-full"
              style={{ left: x, width: w, backgroundColor: `rgba(${color}, ${opacity})` }}
            />
          )
        })}
      </div>
    )
  }

  if (beats.length === 0) return null

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
