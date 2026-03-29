import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { Transition } from '@/routes/project/$name/editor'
import { updateTransitionAction, updateMeta, generateTransitionAction, generateTransitionCandidates, selectTransitions, generateSlotKeyframeCandidates, selectSlotKeyframes } from '@/routes/project/$name/editor'
import { beatlabFileUrl } from '@/lib/beatlab-client'
import { autoSave } from '@/lib/version-client'
import { invalidateEntry } from '@/lib/frame-cache'
import type { useBeatlabSocket } from '@/hooks/useBeatlabSocket'

const STORAGE_KEY = 'beatlab-transition-panel-width'
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240
const MAX_WIDTH = 800

type TransitionPanelProps = {
  transition: Transition
  projectName: string
  motionPrompt: string
  onClose: () => void
  onDelete: () => void
  socket: ReturnType<typeof useBeatlabSocket>
}

export function TransitionPanel({
  transition,
  projectName,
  motionPrompt,
  onClose,
  onDelete,
  socket,
}: TransitionPanelProps) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parseInt(stored, 10))) : DEFAULT_WIDTH
  })
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    e.preventDefault()
  }, [width])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = startX.current - e.clientX
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth.current + delta))
      setWidth(newWidth)
    }
    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false
        setWidth((current) => {
          localStorage.setItem(STORAGE_KEY, String(current))
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

  const [tab, setTab] = useState<'details' | 'candidates'>('details')
  const tr = transition
  const totalCandidates = Object.values(tr.candidates).reduce((sum, arr) => sum + arr.length, 0)

  return (
    <div className="relative flex shrink-0" style={{ width }}>
      {/* Drag handle */}
      <div
        className="w-1 cursor-col-resize hover:bg-orange-500/50 active:bg-orange-500 transition-colors shrink-0"
        onMouseDown={handleMouseDown}
      />

      <div className="flex-1 bg-gray-900 border-l border-gray-800 overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 sticky top-0 bg-gray-900 z-10 shrink-0">
          <div className="text-sm font-medium text-orange-300">{tr.id}</div>
          <div className="flex items-center gap-4">
            <button
              onClick={onDelete}
              className="text-xs text-red-500/70 hover:text-red-400 transition-colors"
              title="Delete transition (move to bin)"
            >
              Delete
            </button>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Tabs */}
        <TabBar tab={tab} setTab={setTab} candidateCount={totalCandidates} />

        <div className="flex-1 overflow-y-auto">
          {tab === 'details' ? (
            <>
              {/* Metadata */}
              <div className="px-3 py-3 space-y-3 border-b border-gray-800">
                <Field label="From → To" value={`${tr.from} → ${tr.to}`} />
                <Field label="Duration" value={`${tr.durationSeconds.toFixed(1)}s`} />
                <Field label="Slots" value={String(tr.slots)} />
                <Field label="Remap" value={`${tr.remap.method} (${tr.remap.target_duration.toFixed(1)}s)`} />
              </div>

              {/* Action prompt */}
              <div className="px-3 py-3 border-b border-gray-800">
                <ActionPromptEditor transition={tr} projectName={projectName} />
              </div>

              {/* Motion prompt (global) */}
              <div className="px-3 py-3">
                <MotionPromptEditor projectName={projectName} motionPrompt={motionPrompt} />
              </div>
            </>
          ) : (
            <CandidatesTab transition={tr} projectName={projectName} socket={socket} />
          )}
        </div>
      </div>
    </div>
  )
}

function ActionPromptEditor({ transition, projectName }: { transition: Transition; projectName: string }) {
  const isMultiSlot = transition.slots > 1
  const [action, setAction] = useState(transition.action)
  const [slotActions, setSlotActions] = useState<string[]>(() =>
    transition.slotActions.length > 0 ? [...transition.slotActions] : Array(transition.slots).fill('')
  )
  const [useGlobal, setUseGlobal] = useState(transition.useGlobalPrompt)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    setAction(transition.action)
    setSlotActions(transition.slotActions.length > 0 ? [...transition.slotActions] : Array(transition.slots).fill(''))
    setUseGlobal(transition.useGlobalPrompt)
  }, [transition.id, transition.action, transition.slotActions, transition.useGlobalPrompt, transition.slots])

  const save = useCallback(async () => {
    setSaving(true)
    await updateTransitionAction({
      data: {
        projectName,
        transitionId: transition.id,
        action: isMultiSlot ? (slotActions[0] || action) : action,
        useGlobalPrompt: useGlobal,
        slotActions: isMultiSlot ? slotActions : undefined,
      },
    })
    transition.action = isMultiSlot ? (slotActions[0] || action) : action
    if (isMultiSlot) transition.slotActions = [...slotActions]
    transition.useGlobalPrompt = useGlobal
    setSaving(false)
  }, [action, slotActions, useGlobal, transition, projectName, isMultiSlot])

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    try {
      const result = await generateTransitionAction({
        data: { projectName, transitionId: transition.id },
      })
      if (result.action) {
        setAction(result.action)
        transition.action = result.action
      }
      if (result.slotActions?.length) {
        setSlotActions(result.slotActions)
        transition.slotActions = result.slotActions
      }
    } finally {
      setGenerating(false)
    }
  }, [projectName, transition])

  const updateSlotAction = useCallback((idx: number, value: string) => {
    setSlotActions((prev) => { const next = [...prev]; next[idx] = value; return next })
  }, [])

  const hasAnyAction = isMultiSlot ? slotActions.some(Boolean) : !!action

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">
          {isMultiSlot ? 'Slot Action Prompts' : 'Action Prompt'}
        </div>
        <button
          onClick={handleGenerate}
          disabled={generating || saving}
          className="text-[10px] text-orange-400 hover:text-orange-300 disabled:text-gray-600 transition-colors"
        >
          {generating ? 'Generating...' : hasAnyAction ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {isMultiSlot ? (
        // Per-slot prompts
        <div className="space-y-2">
          {slotActions.map((sa, idx) => (
            <div key={idx}>
              <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-0.5">Slot {idx}</div>
              <textarea
                value={sa}
                onChange={(e) => updateSlotAction(idx, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() }
                  if (e.key === 'Escape') { setSlotActions(transition.slotActions.length > 0 ? [...transition.slotActions] : Array(transition.slots).fill('')) }
                }}
                onBlur={save}
                className="w-full bg-gray-800 text-xs text-gray-300 rounded p-2 border border-gray-700 focus:border-orange-500 focus:outline-none resize-y min-h-[60px] leading-relaxed"
                disabled={saving || generating}
                placeholder={generating ? 'Generating...' : `Describe what happens in slot ${idx}...`}
              />
            </div>
          ))}
        </div>
      ) : (
        // Single action prompt
        <textarea
          value={action}
          onChange={(e) => setAction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() }
            if (e.key === 'Escape') { setAction(transition.action) }
          }}
          onBlur={save}
          className="w-full bg-gray-800 text-sm text-gray-300 rounded p-2 border border-gray-700 focus:border-orange-500 focus:outline-none resize-y min-h-[80px] leading-relaxed"
          disabled={saving || generating}
          placeholder={generating ? 'Analyzing keyframe images with Claude...' : 'Enter a transition action prompt...'}
        />
      )}
      <div className="text-[9px] text-gray-600">
        {hasAnyAction ? 'Ctrl+Enter to save, Esc to revert. ' : ''}Sent to Veo for video generation.
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={useGlobal}
          onChange={(e) => {
            setUseGlobal(e.target.checked)
            setSaving(true)
            updateTransitionAction({
              data: { projectName, transitionId: transition.id, action, useGlobalPrompt: e.target.checked, slotActions: isMultiSlot ? slotActions : undefined },
            }).then(() => {
              transition.useGlobalPrompt = e.target.checked
              setSaving(false)
            })
          }}
          className="rounded border-gray-600 bg-gray-800 text-orange-500 focus:ring-orange-500"
        />
        <span className="text-xs text-gray-400">Append global motion prompt</span>
      </label>
    </div>
  )
}

function MotionPromptEditor({ projectName, motionPrompt }: { projectName: string; motionPrompt: string }) {
  const [motion, setMotion] = useState(motionPrompt)
  const [saving, setSaving] = useState(false)

  const save = useCallback(async () => {
    setSaving(true)
    await updateMeta({ data: { projectName, fields: { motion_prompt: motion } } })
    setSaving(false)
  }, [motion, projectName])

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">Global Motion Prompt</div>
      <textarea
        value={motion}
        onChange={(e) => setMotion(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() }
        }}
        placeholder="e.g. Slow camera drift, dreamy bokeh..."
        className="w-full bg-gray-800 text-xs text-gray-400 rounded p-2 border border-gray-700 focus:border-gray-500 focus:outline-none resize-y min-h-[40px] leading-relaxed"
        disabled={saving}
      />
      <div className="text-[9px] text-gray-600">Appended as "Camera and motion: ..." to every transition with the checkbox enabled</div>
    </div>
  )
}

function TabBar({ tab, setTab, candidateCount }: { tab: string; setTab: (t: 'details' | 'candidates') => void; candidateCount: number }) {
  return (
    <div className="flex border-b border-gray-800 shrink-0">
      <button
        onClick={() => setTab('details')}
        className={`flex-1 text-xs py-2 transition-colors ${tab === 'details' ? 'text-gray-200 border-b-2 border-orange-500' : 'text-gray-500 hover:text-gray-400'}`}
      >
        Details
      </button>
      <button
        onClick={() => setTab('candidates')}
        className={`flex-1 text-xs py-2 transition-colors ${tab === 'candidates' ? 'text-gray-200 border-b-2 border-orange-500' : 'text-gray-500 hover:text-gray-400'}`}
      >
        Videos{candidateCount > 0 ? ` (${candidateCount})` : ''}
      </button>
    </div>
  )
}

function CandidatesTab({ transition, projectName, socket }: { transition: Transition; projectName: string; socket: ReturnType<typeof useBeatlabSocket> }) {
  const [generatingSlots, setGeneratingSlots] = useState<Set<number>>(new Set())
  const [slotJobStatus, setSlotJobStatus] = useState<Record<number, string>>({})
  const [selecting, setSelecting] = useState(false)
  const [candidates, setCandidates] = useState(transition.candidates)
  const [selectedMap, setSelectedMap] = useState<Record<string, number>>(() => {
    // Build map from selected list: [slot_0_variant, slot_1_variant, ...]
    const map: Record<string, number> = {}
    transition.selected?.forEach((sel, i) => {
      if (typeof sel === 'number') map[`slot_${i}`] = sel
    })
    return map
  })

  useEffect(() => {
    setCandidates(transition.candidates)
  }, [transition.id, transition.candidates])

  const handleGenerate = useCallback(async (slotIndex: number) => {
    const slotAction = transition.slotActions?.[slotIndex]
    if (!slotAction && !transition.action) {
      alert('Generate an action prompt first (Details tab) before generating video candidates.')
      return
    }
    setGeneratingSlots((prev) => new Set(prev).add(slotIndex))
    setSlotJobStatus((prev) => ({ ...prev, [slotIndex]: 'Starting...' }))

    const result = await generateTransitionCandidates({
      data: { projectName, transitionId: transition.id, count: 1, slotIndex },
    })

    if (result.jobId) {
      const unsub = socket.subscribeJob(result.jobId, (msg) => {
        if (msg.type === 'job_progress') {
          const detail = msg.detail || `${msg.completed}/${msg.total} generated`
          setSlotJobStatus((prev) => ({ ...prev, [slotIndex]: detail }))
        } else if (msg.type === 'job_completed') {
          const res = msg.result as { candidates?: Record<string, string[]> }
          if (res?.candidates) {
            setCandidates(res.candidates)
            transition.candidates = res.candidates
          }
          setGeneratingSlots((prev) => { const next = new Set(prev); next.delete(slotIndex); return next })
          setSlotJobStatus((prev) => { const next = { ...prev }; delete next[slotIndex]; return next })
          autoSave(projectName, `Generated ${transition.id} slot_${slotIndex} video candidates`)
          unsub()
        } else if (msg.type === 'job_failed') {
          setSlotJobStatus((prev) => ({ ...prev, [slotIndex]: `Failed: ${msg.error}` }))
          setGeneratingSlots((prev) => { const next = new Set(prev); next.delete(slotIndex); return next })
          unsub()
        }
      })
    } else {
      if (result.candidates) {
        setCandidates(result.candidates)
        transition.candidates = result.candidates
      }
      setGeneratingSlots((prev) => { const next = new Set(prev); next.delete(slotIndex); return next })
      setSlotJobStatus((prev) => { const next = { ...prev }; delete next[slotIndex]; return next })
    }
  }, [projectName, transition, socket])

  const handleSelect = useCallback(async (slotKey: string, variantIndex: number) => {
    setSelecting(true)
    const selectionKey = `${transition.id}_${slotKey}`
    // Parse slot index from key like "slot_0"
    const slotIdx = parseInt(slotKey.replace('slot_', ''), 10)
    try {
      await selectTransitions({
        data: { projectName, selections: { [selectionKey]: variantIndex } },
      })
      setSelectedMap((prev) => ({ ...prev, [slotKey]: variantIndex }))
      // Invalidate old frame cache entry so it re-decodes from the new selected video
      const oldVariant = selectedMap[slotKey] ?? 'none'
      invalidateEntry(`tr:${transition.id}:${slotKey}:v${oldVariant}`)
      // Also invalidate the new key in case stale frames are cached for it
      invalidateEntry(`tr:${transition.id}:${slotKey}:v${variantIndex}`)
      // Update the transition's selected array so Timeline preload picks up the new variant
      if (!isNaN(slotIdx)) {
        if (!transition.selected) transition.selected = []
        while (transition.selected.length <= slotIdx) transition.selected.push(null)
        transition.selected[slotIdx] = variantIndex
        // Mark as having selected video
        if (!transition.hasSelectedVideos) transition.hasSelectedVideos = []
        while (transition.hasSelectedVideos.length <= slotIdx) transition.hasSelectedVideos.push(false)
        transition.hasSelectedVideos[slotIdx] = true
      }
      autoSave(projectName, `Selected ${transition.id} ${slotKey} v${variantIndex}`)
    } finally {
      setSelecting(false)
    }
  }, [projectName, transition.id, selectedMap])

  const [generatingSlotKfs, setGeneratingSlotKfs] = useState(false)
  const [slotKfStatus, setSlotKfStatus] = useState('')
  const [slotKfCandidates, setSlotKfCandidates] = useState<Record<string, string[]>>(transition.slotKeyframeCandidates || {})
  const [selectedSlotKfMap, setSelectedSlotKfMap] = useState<Record<string, number | null>>(transition.selectedSlotKeyframes || {})
  const [selectingSlotKf, setSelectingSlotKf] = useState(false)
  const [showSlotKfModal, setShowSlotKfModal] = useState(false)
  const [showVideosModal, setShowVideosModal] = useState(false)

  useEffect(() => {
    setSlotKfCandidates(transition.slotKeyframeCandidates || {})
    setSelectedSlotKfMap(transition.selectedSlotKeyframes || {})
  }, [transition.id, transition.slotKeyframeCandidates, transition.selectedSlotKeyframes])

  const handleGenerateSlotKeyframes = useCallback(async () => {
    setGeneratingSlotKfs(true)
    setSlotKfStatus('Generating intermediate keyframes...')
    const result = await generateSlotKeyframeCandidates({
      data: { projectName, transitionId: transition.id },
    })
    if (result.jobId) {
      const unsub = socket.subscribeJob(result.jobId, (msg) => {
        if (msg.type === 'job_progress') {
          setSlotKfStatus(msg.detail || `${msg.completed}/${msg.total} generated`)
        } else if (msg.type === 'job_completed') {
          const res = msg.result as { candidates?: Record<string, string[]> }
          if (res?.candidates) {
            setSlotKfCandidates(res.candidates)
            transition.slotKeyframeCandidates = res.candidates
          }
          setGeneratingSlotKfs(false)
          setSlotKfStatus('')
          unsub()
        } else if (msg.type === 'job_failed') {
          setSlotKfStatus(`Failed: ${msg.error}`)
          setGeneratingSlotKfs(false)
          unsub()
        }
      })
    } else {
      setGeneratingSlotKfs(false)
      setSlotKfStatus('')
    }
  }, [projectName, transition.id, socket])

  const handleSelectSlotKf = useCallback(async (slotKey: string, variantIndex: number) => {
    setSelectingSlotKf(true)
    try {
      await selectSlotKeyframes({
        data: { projectName, selections: { [slotKey]: variantIndex } },
      })
      setSelectedSlotKfMap((prev) => ({ ...prev, [slotKey]: variantIndex }))
      transition.selectedSlotKeyframes = { ...transition.selectedSlotKeyframes, [slotKey]: variantIndex }
      autoSave(projectName, `Selected ${slotKey} intermediate keyframe v${variantIndex}`)
    } finally {
      setSelectingSlotKf(false)
    }
  }, [projectName, transition])

  const isMultiSlot = transition.slots > 1
  const slotKeys = Object.keys(candidates).sort()
  const totalVideos = slotKeys.reduce((sum, k) => sum + candidates[k].length, 0)

  return (
    <div className="p-2 space-y-3">
      {/* Multi-slot: intermediate keyframe generation step */}
      {isMultiSlot && (
        <div className="bg-gray-800/50 rounded p-2 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider">Step 1: Intermediate Keyframes</div>
            {Object.keys(slotKfCandidates).length > 0 && (
              <button
                onClick={() => setShowSlotKfModal(true)}
                className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
              >
                Expand
              </button>
            )}
          </div>
          <div className="text-[10px] text-gray-400">
            This transition has {transition.slots} slots. Generate intermediate keyframe images before video candidates.
          </div>
          <button
            onClick={handleGenerateSlotKeyframes}
            disabled={generatingSlotKfs}
            className="w-full text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-1.5 rounded transition-colors"
          >
            {generatingSlotKfs ? slotKfStatus || 'Generating...' : Object.keys(slotKfCandidates).length > 0 ? 'Generate Additional Slot Keyframes' : 'Generate Slot Keyframes'}
          </button>

          {/* Slot keyframe candidate images */}
          {Object.keys(slotKfCandidates).sort().map((slotKey) => (
            <div key={slotKey} className="space-y-1">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider flex items-center gap-1">
                {slotKey.replace(/_/g, ' ')}
                {selectedSlotKfMap[slotKey] != null && <span className="text-green-400">&#10003;</span>}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {slotKfCandidates[slotKey].map((imgPath, idx) => {
                  const variantNum = idx + 1
                  const isSelected = selectedSlotKfMap[slotKey] === variantNum
                  return (
                    <div
                      key={imgPath}
                      onClick={() => !selectingSlotKf && handleSelectSlotKf(slotKey, variantNum)}
                      className={`relative rounded overflow-hidden border-2 cursor-pointer transition-colors ${
                        isSelected ? 'border-blue-500' : 'border-transparent hover:border-gray-600'
                      } ${selectingSlotKf ? 'opacity-50 pointer-events-none' : ''}`}
                    >
                      <img
                        src={beatlabFileUrl(projectName, imgPath)}
                        alt={`v${variantNum}`}
                        className="w-full aspect-video object-cover"
                        loading="lazy"
                      />
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-0.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-gray-300 font-mono">v{variantNum}</span>
                          {isSelected && (
                            <span className="text-[9px] bg-blue-500 text-white px-1 rounded">selected</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Slot keyframe candidate modal */}
      {showSlotKfModal && createPortal(
        <CandidateModal
          title={`${transition.id} — Intermediate Keyframes`}
          groups={slotKfCandidates}
          selectedMap={selectedSlotKfMap as Record<string, number | null>}
          disabled={selectingSlotKf}
          projectName={projectName}
          mediaType="image"
          onSelect={handleSelectSlotKf}
          onClose={() => setShowSlotKfModal(false)}
        />,
        document.body,
      )}

      {/* Video candidates header + expand */}
      {totalVideos > 0 && (
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">{isMultiSlot ? 'Step 2: Video Candidates' : 'Video Candidates'}</div>
          <button
            onClick={() => setShowVideosModal(true)}
            className="text-[10px] text-orange-400 hover:text-orange-300 transition-colors"
          >
            Expand
          </button>
        </div>
      )}
      {showVideosModal && createPortal(
        <CandidateModal
          title={`${transition.id} — Video Candidates`}
          groups={candidates}
          selectedMap={selectedMap as Record<string, number | null>}
          disabled={selecting}
          projectName={projectName}
          mediaType="video"
          onSelect={handleSelect}
          onClose={() => setShowVideosModal(false)}
        />,
        document.body,
      )}
      {/* Candidates by slot — each slot gets its own generate button */}
      {Array.from({ length: transition.slots }, (_, i) => i).map((slotIdx) => {
        const slotKey = `slot_${slotIdx}`
        const slotCandidates = candidates[slotKey] || []
        const isSlotGenerating = generatingSlots.has(slotIdx)
        return (
          <div key={slotKey} className="space-y-1">
            <div className="flex items-center justify-between">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">
                {slotKey.replace('_', ' ')}
              </div>
              <button
                onClick={() => handleGenerate(slotIdx)}
                disabled={isSlotGenerating}
                className="text-[10px] text-orange-400 hover:text-orange-300 disabled:text-gray-600 transition-colors"
              >
                {isSlotGenerating ? (slotJobStatus[slotIdx] || 'Generating...') : slotCandidates.length > 0 ? '+ Generate' : 'Generate'}
              </button>
            </div>
            {slotCandidates.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {slotCandidates.map((videoPath, idx) => {
                  const variantNum = idx + 1
                  const label = videoPath.split('/').pop() || `v${variantNum}`
                  const isSelected = selectedMap[slotKey] === variantNum
                  return (
                    <LazyVideoCard
                      key={videoPath}
                      videoPath={videoPath}
                      projectName={projectName}
                      label={label}
                      isSelected={isSelected}
                      disabled={selecting}
                      onSelect={() => handleSelect(slotKey, variantNum)}
                    />
                  )
                })}
              </div>
            ) : !isSlotGenerating ? (
              <div className="text-center text-[10px] text-gray-600 py-2">No candidates yet</div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export function CandidateModal({ title, groups, selectedMap, disabled, projectName, mediaType, onSelect, onClose }: {
  title: string
  groups: Record<string, string[]>
  selectedMap: Record<string, number | null>
  disabled: boolean
  projectName: string
  mediaType: 'image' | 'video'
  onSelect: (groupKey: string, variantIndex: number) => void
  onClose: () => void
}) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const accentColor = mediaType === 'video' ? 'orange' : 'blue'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/80" />
      <div
        className="relative bg-gray-900 w-screen h-screen overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className={`text-sm font-medium text-${accentColor}-300`}>{title}</div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">&times;</button>
        </div>

        {Object.keys(groups).sort().map((groupKey) => (
          <div key={groupKey} className="mb-6">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1">
              {groupKey.replace(/_/g, ' ')}
              {selectedMap[groupKey] != null && <span className="text-green-400">&#10003;</span>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {groups[groupKey].map((filePath, idx) => {
                const variantNum = idx + 1
                const isSelected = selectedMap[groupKey] === variantNum
                const label = filePath.split('/').pop() || `v${variantNum}`
                return (
                  <div
                    key={filePath}
                    onClick={() => !disabled && onSelect(groupKey, variantNum)}
                    className={`relative rounded-lg overflow-hidden border-2 cursor-pointer transition-colors ${
                      isSelected ? `border-${accentColor}-500` : 'border-transparent hover:border-gray-600'
                    } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    {mediaType === 'video' ? (
                      <ModalVideoCard videoPath={filePath} projectName={projectName} />
                    ) : (
                      <img
                        src={beatlabFileUrl(projectName, filePath)}
                        alt={label}
                        className="w-full aspect-video object-cover"
                      />
                    )}
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300 font-mono">{label}</span>
                        {isSelected && (
                          <span className={`text-[10px] bg-${accentColor}-500 text-white px-1.5 py-0.5 rounded`}>selected</span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ModalVideoCard({ videoPath, projectName }: { videoPath: string; projectName: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => videoBlobCache.get(videoPath) ?? null)
  const [hovered, setHovered] = useState(false)
  const url = beatlabFileUrl(projectName, videoPath)

  useEffect(() => {
    if (videoBlobCache.has(videoPath)) { setBlobUrl(videoBlobCache.get(videoPath)!); return }
    fetch(url).then((r) => r.blob()).then((b) => {
      const bu = URL.createObjectURL(b)
      videoBlobCache.set(videoPath, bu)
      setBlobUrl(bu)
    }).catch(() => {})
  }, [videoPath, url])

  return blobUrl ? (
    <video
      src={blobUrl}
      className="w-full aspect-video object-cover"
      muted loop playsInline preload="metadata"
      autoPlay={hovered}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      ref={(el) => {
        if (!el) return
        if (hovered) el.play().catch(() => {})
        else { el.pause(); el.currentTime = 0 }
      }}
    />
  ) : (
    <div className="w-full aspect-video bg-gray-800 flex items-center justify-center">
      <span className="text-[10px] text-gray-500">...</span>
    </div>
  )
}

const videoBlobCache = new Map<string, string>() // url -> blob URL

function LazyVideoCard({ videoPath, projectName, label, isSelected, disabled, onSelect }: {
  videoPath: string; projectName: string; label: string; isSelected: boolean; disabled: boolean; onSelect: () => void
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => videoBlobCache.get(videoPath) ?? null)
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState(false)
  const url = beatlabFileUrl(projectName, videoPath)

  // Download video once into a blob URL on first mount
  useEffect(() => {
    if (videoBlobCache.has(videoPath)) {
      setBlobUrl(videoBlobCache.get(videoPath)!)
      return
    }
    setLoading(true)
    fetch(url)
      .then((res) => res.blob())
      .then((blob) => {
        const bu = URL.createObjectURL(blob)
        videoBlobCache.set(videoPath, bu)
        setBlobUrl(bu)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [videoPath, url])

  return (
    <div
      className={`relative rounded overflow-hidden border-2 cursor-pointer transition-colors group ${
        isSelected ? 'border-orange-500' : 'border-transparent hover:border-gray-600'
      } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {blobUrl ? (
        <video
          src={blobUrl}
          className="w-full aspect-video object-cover"
          muted
          loop
          playsInline
          preload="metadata"
          autoPlay={hovered}
          ref={(el) => {
            if (!el) return
            if (hovered) el.play().catch(() => {})
            else { el.pause(); el.currentTime = 0 }
          }}
        />
      ) : (
        <div className="w-full aspect-video bg-gray-800 flex items-center justify-center">
          <span className="text-[10px] text-gray-500 font-mono">{loading ? '...' : label}</span>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-300 font-mono">{label}</span>
          {isSelected && (
            <span className="text-[9px] bg-orange-500 text-white px-1 rounded">selected</span>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{label}</div>
      <div className="text-sm text-gray-300">{value}</div>
    </div>
  )
}
