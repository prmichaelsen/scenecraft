import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { Transition } from '@/routes/project/$name/editor'
import { updateTransitionAction, updateMeta, generateTransitionAction, enhanceTransitionAction, generateTransitionCandidates, selectTransitions } from '@/routes/project/$name/editor'
import { beatlabFileUrl, fetchPool, postAssignPoolVideo, fetchBin, postUpdateTransitionRemap, type PoolEntry, type TransitionBinEntry } from '@/lib/beatlab-client'
import { autoSave } from '@/lib/version-client'
import { invalidateEntry } from '@/lib/frame-cache'
import { useJobState, useJobContext } from '@/contexts/JobStateContext'

const STORAGE_KEY = 'beatlab-side-panel-width'
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240

type AudioDescription = { sectionIndex: number; label: string; startTime: number; endTime: number; content: string }
type KfWithTime = { id: string; timestamp: string; timeSeconds: number }

type TransitionPanelProps = {
  transition: Transition
  projectName: string
  motionPrompt: string
  audioDescriptions: AudioDescription[]
  keyframes: KfWithTime[]
  onClose: () => void
  onDelete: () => void
  onDataChange: () => void
}

export function TransitionPanel({
  transition,
  projectName,
  motionPrompt,
  audioDescriptions,
  keyframes,
  onClose,
  onDelete,
  onDataChange,
}: TransitionPanelProps) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? Math.max(MIN_WIDTH, parseInt(stored, 10)) : DEFAULT_WIDTH
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
      const newWidth = Math.max(MIN_WIDTH, startWidth.current + delta)
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

  const [tab, setTab] = useState<'details' | 'candidates' | 'browse' | 'bench'>('details')
  const tr = transition
  const totalCandidates = Object.values(tr.candidates).reduce((sum, arr) => sum + arr.length, 0)

  // Resolve the section description for this transition
  const sectionDescription = (() => {
    const fromKf = keyframes.find((k) => k.id === tr.from)
    const toKf = keyframes.find((k) => k.id === tr.to)
    if (!fromKf || !toKf || audioDescriptions.length === 0) return null
    const midTime = (fromKf.timeSeconds + toKf.timeSeconds) / 2
    return audioDescriptions.find((s) => midTime >= s.startTime && midTime <= s.endTime) ?? null
  })()

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
              onClick={async () => {
                try {
                  const { postAddToBench } = await import('@/lib/beatlab-client')
                  await postAddToBench(projectName, 'transition', tr.id)
                } catch (e) { console.error('Bench failed:', e) }
              }}
              className="text-xs text-green-500/70 hover:text-green-400 transition-colors"
              title="Add to bench for quick access"
            >
              Bench
            </button>
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
                <Field label="Remap" value={`${tr.remap.method} (${tr.remap.target_duration.toFixed(1)}s)`} />
              </div>

              {/* Time remap curve editor */}
              <div className="px-3 py-3 border-b border-gray-800">
                <CurveEditor transition={tr} projectName={projectName} />
              </div>

              {/* Action prompt */}
              <div className="px-3 py-3 border-b border-gray-800">
                <ActionPromptEditor transition={tr} projectName={projectName} sectionDescription={sectionDescription} />
              </div>

              {/* Motion prompt (global) */}
              <div className="px-3 py-3">
                <MotionPromptEditor projectName={projectName} motionPrompt={motionPrompt} />
              </div>

              {/* Section description */}
              <SectionDescription transition={tr} audioDescriptions={audioDescriptions} keyframes={keyframes} />
            </>
          ) : tab === 'candidates' ? (
            <CandidatesTab transition={tr} projectName={projectName} />
          ) : tab === 'browse' ? (
            <BrowseTab transition={tr} projectName={projectName} onAssigned={() => {
              transition.hasSelectedVideo = true
              setTab('candidates')
              onDataChange()
            }} />
          ) : (
            <BenchTab transition={tr} projectName={projectName} onAssigned={() => {
              transition.hasSelectedVideo = true
              setTab('candidates')
              onDataChange()
            }} onSeek={onDataChange} />
          )}
        </div>
      </div>
    </div>
  )
}

function ActionPromptEditor({ transition, projectName, sectionDescription }: { transition: Transition; projectName: string; sectionDescription: AudioDescription | null }) {
  const jobCtx = useJobContext()
  const entityKey = `tr:${transition.id}:action`
  const job = useJobState(entityKey)

  const [action, setAction] = useState(transition.action)
  const [useGlobal, setUseGlobal] = useState(transition.useGlobalPrompt)
  const [useSectionDesc, setUseSectionDesc] = useState(!!sectionDescription)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setAction(transition.action)
    setUseGlobal(transition.useGlobalPrompt)
  }, [transition.id, transition.action, transition.useGlobalPrompt])

  // Apply completed job result (persists across panel switches)
  useEffect(() => {
    if (job?.status === 'completed' && job.result) {
      const res = job.result as { action?: string }
      if (res?.action) {
        setAction(res.action)
        transition.action = res.action
        // Auto-save the generated action
        updateTransitionAction({
          data: { projectName, transitionId: transition.id, action: res.action, useGlobalPrompt: useGlobal },
        })
      }
      jobCtx.consumeResult(entityKey)
    }
  }, [job?.status, job?.result])

  const [generating, setGenerating] = useState(false)

  const save = useCallback(async () => {
    setSaving(true)
    await updateTransitionAction({
      data: { projectName, transitionId: transition.id, action, useGlobalPrompt: useGlobal },
    })
    transition.action = action
    transition.useGlobalPrompt = useGlobal
    setSaving(false)
  }, [action, useGlobal, transition, projectName])

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    try {
      const result = await generateTransitionAction({
        data: { projectName, transitionId: transition.id, sectionContext: useSectionDesc && sectionDescription ? sectionDescription.content : undefined },
      })
      if (result.action) {
        setAction(result.action)
        transition.action = result.action
        updateTransitionAction({
          data: { projectName, transitionId: transition.id, action: result.action, useGlobalPrompt: useGlobal },
        })
      }
    } catch (e) {
      console.error('Generate action failed:', e)
    } finally {
      setGenerating(false)
    }
  }, [projectName, transition, useGlobal, useSectionDesc, sectionDescription])

  const handleEnhance = useCallback(async () => {
    if (!action) return
    setGenerating(true)
    try {
      const result = await enhanceTransitionAction({
        data: { projectName, transitionId: transition.id, action, sectionContext: useSectionDesc && sectionDescription ? sectionDescription.content : undefined },
      })
      if (result.action) {
        setAction(result.action)
        transition.action = result.action
        updateTransitionAction({
          data: { projectName, transitionId: transition.id, action: result.action, useGlobalPrompt: useGlobal },
        })
      }
    } catch (e) {
      console.error('Enhance action failed:', e)
    } finally {
      setGenerating(false)
    }
  }, [projectName, transition, action, useGlobal, useSectionDesc, sectionDescription])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Action Prompt</div>
        <div className="flex items-center gap-2">
          {action && (
            <button
              onClick={handleEnhance}
              disabled={generating || saving}
              className="text-[10px] text-blue-400 hover:text-blue-300 disabled:text-gray-600 transition-colors"
            >
              {generating ? '...' : 'Enhance'}
            </button>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating || saving}
            className="text-[10px] text-orange-400 hover:text-orange-300 disabled:text-gray-600 transition-colors"
          >
            {generating ? 'Generating...' : action ? 'Regenerate' : 'Generate'}
          </button>
        </div>
      </div>

      <textarea
        ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
        value={action}
        onChange={(e) => { setAction(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px' }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() }
          if (e.key === 'Escape') { setAction(transition.action) }
        }}
        onBlur={save}
        className="w-full bg-gray-800 text-sm text-gray-300 rounded p-2 border border-gray-700 focus:border-orange-500 focus:outline-none resize-none leading-relaxed overflow-hidden"
        disabled={saving || generating}
        placeholder={generating ? 'Analyzing keyframe images with Claude...' : 'Enter a transition action prompt...'}
      />
      <div className="text-[9px] text-gray-600">
        {action ? 'Ctrl+Enter to save, Esc to revert. ' : ''}Sent to Veo for video generation.
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={useGlobal}
          onChange={(e) => {
            setUseGlobal(e.target.checked)
            setSaving(true)
            updateTransitionAction({
              data: { projectName, transitionId: transition.id, action, useGlobalPrompt: e.target.checked },
            }).then(() => {
              transition.useGlobalPrompt = e.target.checked
              setSaving(false)
            })
          }}
          className="rounded border-gray-600 bg-gray-800 text-orange-500 focus:ring-orange-500"
        />
        <span className="text-xs text-gray-400">Append global motion prompt</span>
      </label>

      {sectionDescription && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={useSectionDesc}
            onChange={(e) => setUseSectionDesc(e.target.checked)}
            className="rounded border-gray-600 bg-gray-800 text-orange-500 focus:ring-orange-500"
          />
          <span className="text-xs text-gray-400">Include section description in generation</span>
        </label>
      )}
    </div>
  )
}

function SectionDescription({ transition, audioDescriptions, keyframes }: { transition: Transition; audioDescriptions: AudioDescription[]; keyframes: KfWithTime[] }) {
  // Find the transition's midpoint time
  const fromKf = keyframes.find((k) => k.id === transition.from)
  const toKf = keyframes.find((k) => k.id === transition.to)
  if (!fromKf || !toKf || audioDescriptions.length === 0) return null

  const midTime = (fromKf.timeSeconds + toKf.timeSeconds) / 2
  const section = audioDescriptions.find((s) => midTime >= s.startTime && midTime <= s.endTime)
  if (!section) return null

  return (
    <div className="px-3 py-3 border-t border-gray-800">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{section.label}</div>
      <div className="text-[11px] text-gray-400 leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap">
        {section.content.replace(/\*\*/g, '').replace(/\*Time\*:.*\n?/, '').trim()}
      </div>
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
        ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
        value={motion}
        onChange={(e) => { setMotion(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px' }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() }
        }}
        placeholder="e.g. Slow camera drift, dreamy bokeh..."
        className="w-full bg-gray-800 text-xs text-gray-400 rounded p-2 border border-gray-700 focus:border-gray-500 focus:outline-none resize-none leading-relaxed overflow-hidden"
        disabled={saving}
      />
      <div className="text-[9px] text-gray-600">Appended as "Camera and motion: ..." to every transition with the checkbox enabled</div>
    </div>
  )
}

function TabBar({ tab, setTab, candidateCount }: { tab: string; setTab: (t: 'details' | 'candidates' | 'browse' | 'bench') => void; candidateCount: number }) {
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
      <button
        onClick={() => setTab('browse')}
        className={`flex-1 text-xs py-2 transition-colors ${tab === 'browse' ? 'text-gray-200 border-b-2 border-green-500' : 'text-gray-500 hover:text-gray-400'}`}
      >
        Browse
      </button>
      <button
        onClick={() => setTab('bench')}
        className={`flex-1 text-xs py-2 transition-colors ${tab === 'bench' ? 'text-gray-200 border-b-2 border-yellow-500' : 'text-gray-500 hover:text-gray-400'}`}
      >
        Bench
      </button>
    </div>
  )
}

function CandidatesTab({ transition, projectName }: { transition: Transition; projectName: string }) {
  const jobCtx = useJobContext()
  const entityKey = `tr:${transition.id}:video`
  const job = useJobState(entityKey)

  const [selecting, setSelecting] = useState(false)
  const [candidates, setCandidates] = useState(() => {
    console.log(`[CandidatesTab] init ${transition.id}: ${transition.candidates.length} candidates`, transition.candidates)
    return transition.candidates
  })
  const [selectedVariant, setSelectedVariant] = useState<number | null>(
    typeof transition.selected === 'number' ? transition.selected : null
  )
  const [showModal, setShowModal] = useState(false)

  // Video generation duration — closest of [4, 6, 8] to transition duration
  const DURATION_OPTIONS = [4, 6, 8] as const
  const [generationDuration, setGenerationDuration] = useState<number>(() => {
    const dur = transition.durationSeconds
    return DURATION_OPTIONS.reduce((best, opt) => Math.abs(opt - dur) < Math.abs(best - dur) ? opt : best, 8)
  })
  const COUNT_OPTIONS = [1, 2, 3, 4] as const
  const [generationCount, setGenerationCount] = useState<number>(4)

  useEffect(() => {
    setCandidates(transition.candidates)
  }, [transition.id, transition.candidates])

  // Apply completed job result (works even if panel was unmounted during generation)
  useEffect(() => {
    if (job?.status === 'completed' && job.result) {
      console.log('[CandidatesTab] job completed, result:', job.result)
      const res = job.result as { candidates?: Record<string, string[]> }
      const newCandidates = res?.candidates?.['slot_0'] || Object.values(res?.candidates || {})[0] || []
      console.log('[CandidatesTab] extracted candidates:', newCandidates)
      if (newCandidates.length > 0) {
        setCandidates(newCandidates)
        transition.candidates = newCandidates
      }
      jobCtx.consumeResult(entityKey)
      autoSave(projectName, `Generated ${transition.id} video candidates`)
    }
  }, [job?.status, job?.result])

  const generating = job?.status === 'in_progress'
  const jobStatus = job?.detail || ''

  const handleGenerate = useCallback(async () => {
    if (!transition.action) {
      alert('Generate an action prompt first (Details tab) before generating video candidates.')
      return
    }

    try {
      const result = await generateTransitionCandidates({
        data: { projectName, transitionId: transition.id, count: generationCount, duration: generationDuration },
      })
      console.log('[TransitionPanel] generate result:', result)

      if (result.jobId) {
        jobCtx.startJob(entityKey, result.jobId)
      } else {
        const newCandidates = result.candidates?.['slot_0'] || Object.values(result.candidates || {})[0] || []
        if (newCandidates.length > 0) {
          setCandidates(newCandidates)
          transition.candidates = newCandidates
        }
      }
    } catch (e) {
      console.error('Generate transition candidates failed:', e)
      alert(`Failed to generate: ${e}`)
    }
  }, [projectName, transition, jobCtx, entityKey, generationCount, generationDuration])

  const handleSelect = useCallback(async (variantIndex: number) => {
    setSelecting(true)
    const selectionKey = `${transition.id}_slot_0`
    try {
      await selectTransitions({
        data: { projectName, selections: { [selectionKey]: variantIndex } },
      })
      const oldVariant = selectedVariant ?? 'none'
      invalidateEntry(`tr:${transition.id}:v${oldVariant}`)
      invalidateEntry(`tr:${transition.id}:v${variantIndex}`)
      setSelectedVariant(variantIndex)
      transition.selected = variantIndex
      transition.hasSelectedVideo = true
      autoSave(projectName, `Selected ${transition.id} v${variantIndex}`)
    } finally {
      setSelecting(false)
    }
  }, [projectName, transition.id, selectedVariant])

  return (
    <div className="p-2 space-y-3">
      {/* Generation settings */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider shrink-0 w-14">Duration</span>
          <div className="flex gap-0.5 flex-1">
            {DURATION_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setGenerationDuration(d)}
                className={`flex-1 text-[10px] py-1 rounded transition-colors ${generationDuration === d ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
              >
                {d}s
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider shrink-0 w-14">Count</span>
          <div className="flex gap-0.5 flex-1">
            {COUNT_OPTIONS.map((c) => (
              <button
                key={c}
                onClick={() => setGenerationCount(c)}
                className={`flex-1 text-[10px] py-1 rounded transition-colors ${generationCount === c ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Generate button + refresh */}
      <div className="flex items-center justify-between">
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex-1 text-xs bg-orange-600 hover:bg-orange-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2 rounded transition-colors"
        >
          {generating ? (jobStatus || 'Generating with Veo...') : candidates.length > 0 ? 'Generate More' : 'Generate Video'}
        </button>
        <button
          onClick={async () => {
            try {
              const { fetchDirectoryListing } = await import('@/lib/beatlab-client')
              const files = await fetchDirectoryListing(projectName, `transition_candidates/${transition.id}/slot_0`)
              const newCandidates = files
                .filter((f: { name: string; isDirectory: boolean }) => !f.isDirectory && f.name.endsWith('.mp4'))
                .map((f: { name: string }) => `transition_candidates/${transition.id}/slot_0/${f.name}`)
                .sort()
              console.log('[CandidatesTab] refresh got', newCandidates.length, 'candidates')
              setCandidates(newCandidates)
              transition.candidates = newCandidates
            } catch (e) { console.error('Refresh failed:', e) }
          }}
          className="ml-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors px-1"
          title="Refresh candidates from server"
        >
          ↻
        </button>
        {candidates.length > 0 && (
          <button
            onClick={() => setShowModal(true)}
            className="ml-1 text-[10px] text-orange-400 hover:text-orange-300 transition-colors"
          >
            Expand
          </button>
        )}
      </div>

      {showModal && createPortal(
        <CandidateModal
          title={`${transition.id} — Video Candidates`}
          groups={{ videos: candidates }}
          selectedMap={{ videos: selectedVariant }}
          disabled={selecting}
          projectName={projectName}
          mediaType="video"
          onSelect={(_groupKey, variantIndex) => handleSelect(variantIndex)}
          onClose={() => setShowModal(false)}
        />,
        document.body,
      )}

      {/* Candidates grid */}
      {candidates.length === 0 && !generating ? (
        <div className="text-center text-sm text-gray-600 py-4">No video candidates yet.</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {[...candidates].sort((a, b) => {
            const na = parseInt(a.match(/v(\d+)\./)?.[1] || '0', 10)
            const nb = parseInt(b.match(/v(\d+)\./)?.[1] || '0', 10)
            return na - nb
          }).map((videoPath) => {
            const filename = videoPath.split('/').pop() || ''
            const variantNum = parseInt(filename.match(/v(\d+)\./)?.[1] || '0', 10)
            const label = filename || `v${variantNum}`
            const isSelected = selectedVariant === variantNum
            return (
              <LazyVideoCard
                key={videoPath}
                videoPath={videoPath}
                projectName={projectName}
                label={label}
                isSelected={isSelected}
                disabled={selecting}
                onSelect={() => handleSelect(variantNum)}
              />
            )
          })}
        </div>
      )}
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
              {[...groups[groupKey]].sort((a, b) => {
                const na = parseInt(a.match(/v(\d+)\./)?.[1] || '0', 10)
                const nb = parseInt(b.match(/v(\d+)\./)?.[1] || '0', 10)
                return na - nb
              }).map((filePath) => {
                const vMatch = filePath.match(/v(\d+)\./)
                const variantNum = vMatch ? parseInt(vMatch[1], 10) : 0
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

function CurveEditor({ transition, projectName }: { transition: Transition; projectName: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [points, setPoints] = useState<[number, number][]>(() =>
    transition.remap.curve_points || [[0, 0], [1, 1]]
  )
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  // Logical size — canvas backing pixels scale with devicePixelRatio
  const W = 240
  const H = 150
  const PAD = 12

  // Convert normalized [0-1, 0-1] to logical canvas coords
  const toCanvas = (x: number, y: number): [number, number] => [
    PAD + x * (W - 2 * PAD),
    H - PAD - y * (H - 2 * PAD),
  ]
  const fromCanvas = (cx: number, cy: number): [number, number] => [
    Math.max(0, Math.min(1, (cx - PAD) / (W - 2 * PAD))),
    Math.max(0, Math.min(1, (H - PAD - cy) / (H - 2 * PAD))),
  ]

  // Convert mouse event to logical canvas coords (accounts for CSS scaling)
  const mouseToCanvas = (e: React.MouseEvent): [number, number] | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return [
      (e.clientX - rect.left) * (W / rect.width),
      (e.clientY - rect.top) * (H / rect.height),
    ]
  }

  // Draw the curve (scale for devicePixelRatio for crisp rendering)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.clearRect(0, 0, W, H)

    // Background
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, W, H)

    // Grid
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 0.5
    for (let i = 0; i <= 4; i++) {
      const [x, y] = toCanvas(i / 4, i / 4)
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, H - PAD); ctx.stroke()
    }

    // Linear reference (diagonal)
    ctx.strokeStyle = '#555'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    const [lx0, ly0] = toCanvas(0, 0)
    const [lx1, ly1] = toCanvas(1, 1)
    ctx.moveTo(lx0, ly0)
    ctx.lineTo(lx1, ly1)
    ctx.stroke()
    ctx.setLineDash([])

    // Curve
    ctx.strokeStyle = '#f97316'
    ctx.lineWidth = 2
    ctx.beginPath()
    const sorted = [...points].sort((a, b) => a[0] - b[0])
    for (let i = 0; i < sorted.length; i++) {
      const [cx, cy] = toCanvas(sorted[i][0], sorted[i][1])
      if (i === 0) ctx.moveTo(cx, cy)
      else ctx.lineTo(cx, cy)
    }
    ctx.stroke()

    // Control points
    for (let i = 0; i < sorted.length; i++) {
      const [cx, cy] = toCanvas(sorted[i][0], sorted[i][1])
      ctx.beginPath()
      ctx.arc(cx, cy, 5, 0, Math.PI * 2)
      ctx.fillStyle = i === 0 || i === sorted.length - 1 ? '#666' : '#f97316'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }, [points])

  const save = useCallback(async (newPoints: [number, number][]) => {
    setSaving(true)
    const sorted = [...newPoints].sort((a, b) => a[0] - b[0])
    const method = sorted.length > 2 ? 'curve' : 'linear'
    try {
      await postUpdateTransitionRemap(
        projectName, transition.id, transition.remap.target_duration,
        method, method === 'curve' ? sorted : undefined,
      )
      transition.remap.method = method
      transition.remap.curve_points = method === 'curve' ? sorted : undefined
    } catch (e) {
      console.error('Save curve failed:', e)
    } finally {
      setSaving(false)
    }
  }, [projectName, transition])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = mouseToCanvas(e)
    if (!pos) return
    const [cx, cy] = pos

    // Check if clicking an existing point
    const sorted = [...points].sort((a, b) => a[0] - b[0])
    for (let i = 0; i < sorted.length; i++) {
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(cx - px, cy - py) < 10) {
        if (i === 0 || i === sorted.length - 1) return // Can't drag endpoints
        setDraggingIdx(i)
        return
      }
    }

    // Click on empty space — add a point
    const [nx, ny] = fromCanvas(cx, cy)
    const newPoints: [number, number][] = [...points, [nx, ny]]
    newPoints.sort((a, b) => a[0] - b[0])
    setPoints(newPoints)
    save(newPoints)
  }, [points, save])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (draggingIdx === null) return
    const pos = mouseToCanvas(e)
    if (!pos) return
    const [nx, ny] = fromCanvas(pos[0], pos[1])

    setPoints((prev) => {
      const sorted = [...prev].sort((a, b) => a[0] - b[0])
      // Constrain X between neighbors
      const minX = sorted[draggingIdx - 1]?.[0] ?? 0
      const maxX = sorted[draggingIdx + 1]?.[0] ?? 1
      sorted[draggingIdx] = [Math.max(minX + 0.01, Math.min(maxX - 0.01, nx)), ny]
      return sorted
    })
  }, [draggingIdx])

  const handleMouseUp = useCallback(() => {
    if (draggingIdx !== null) {
      setDraggingIdx(null)
      save(points)
    }
  }, [draggingIdx, points, save])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const pos = mouseToCanvas(e)
    if (!pos) return
    const [cx, cy] = pos

    const sorted = [...points].sort((a, b) => a[0] - b[0])
    for (let i = 1; i < sorted.length - 1; i++) {
      const [px, py] = toCanvas(sorted[i][0], sorted[i][1])
      if (Math.hypot(cx - px, cy - py) < 10) {
        const newPoints = sorted.filter((_, j) => j !== i)
        setPoints(newPoints)
        save(newPoints)
        return
      }
    }
  }, [points, save])

  const handleReset = useCallback(() => {
    const defaultPoints: [number, number][] = [[0, 0], [1, 1]]
    setPoints(defaultPoints)
    save(defaultPoints)
  }, [save])

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Time Remap</div>
        <button
          onClick={handleReset}
          disabled={saving || points.length <= 2}
          className="text-[10px] text-gray-500 hover:text-gray-300 disabled:text-gray-700 transition-colors"
        >
          Reset
        </button>
      </div>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="w-full rounded border border-gray-700 cursor-crosshair"
        style={{ width: '100%', height: 'auto', aspectRatio: `${W} / ${H}` }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      />
      <div className="text-[9px] text-gray-600">
        Click to add point. Drag to adjust. Double-click to remove. {points.length > 2 ? `${points.length - 2} control points` : 'Linear'}
      </div>
    </div>
  )
}

const browseBlobCache = new Map<string, string>()

function BenchTab({ transition, projectName, onAssigned, onSeek }: { transition: Transition; projectName: string; onAssigned: () => void; onSeek: () => void }) {
  const [items, setItems] = useState<import('@/lib/beatlab-client').BenchItem[]>([])
  const [loading, setLoading] = useState(true)
  const [assigning, setAssigning] = useState(false)

  useEffect(() => {
    import('@/lib/beatlab-client').then(({ fetchBench }) =>
      fetchBench(projectName).then(setItems)
    ).finally(() => setLoading(false))
  }, [projectName])

  const handleAssign = useCallback(async (sourcePath: string) => {
    setAssigning(true)
    try {
      await postAssignPoolVideo(projectName, transition.id, sourcePath)
      autoSave(projectName, `Assigned bench video to ${transition.id}`)
      const oldVariant = transition.selected ?? 'none'
      invalidateEntry(`tr:${transition.id}:v${oldVariant}`)
      transition.hasSelectedVideo = true
      onAssigned()
    } catch (e) {
      console.error('Assign from bench failed:', e)
    } finally {
      setAssigning(false)
    }
  }, [projectName, transition, onAssigned])

  const handleRemove = useCallback(async (benchId: string) => {
    try {
      const { postRemoveFromBench } = await import('@/lib/beatlab-client')
      await postRemoveFromBench(projectName, benchId)
      setItems((prev) => prev.filter((i) => i.id !== benchId))
    } catch (e) {
      console.error('Remove from bench failed:', e)
    }
  }, [projectName])

  if (loading) return <div className="p-4 text-center text-sm text-gray-600">Loading...</div>

  const trItems = items.filter((i) => i.type === 'transition')

  if (trItems.length === 0) {
    return <div className="p-4 text-center text-sm text-gray-600">No benched transitions. Click "Bench" on a transition to add it here.</div>
  }

  return (
    <div className="p-2 space-y-2">
      {trItems.map((item) => (
        <div key={item.id} className="bg-gray-800/50 rounded p-2 space-y-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BrowseVideoCard
                path={item.sourcePath}
                label={item.label}
                projectName={projectName}
                disabled={assigning}
                onAssign={() => handleAssign(item.sourcePath)}
              />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-gray-500">{item.usageCount} uses</span>
            <button
              onClick={() => handleRemove(item.id)}
              className="text-[9px] text-red-400/60 hover:text-red-400"
            >
              Remove
            </button>
          </div>
          {item.usages.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {item.usages.map((u) => (
                <button
                  key={u.entityId}
                  className="text-[8px] bg-gray-700 text-yellow-300 px-1 py-0.5 rounded hover:bg-gray-600"
                  title={`Jump to ${u.entityId}`}
                  onClick={onSeek}
                >
                  {u.timestamp}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function BrowseTab({ transition, projectName, onAssigned }: { transition: Transition; projectName: string; onAssigned: () => void }) {
  const [poolSegments, setPoolSegments] = useState<PoolEntry[]>([])
  const [binTransitions, setBinTransitions] = useState<TransitionBinEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [assigning, setAssigning] = useState(false)

  useEffect(() => {
    Promise.all([
      fetchPool(projectName).catch(() => ({ keyframes: [], segments: [] })),
      fetchBin(projectName).catch(() => ({ bin: [], transitionBin: [] })),
    ]).then(([poolData, binData]) => {
      setPoolSegments(poolData.segments || [])
      setBinTransitions(binData.transitionBin || [])
    }).finally(() => setLoading(false))
  }, [projectName])

  const handleAssign = useCallback(async (poolPath: string) => {
    setAssigning(true)
    try {
      const result = await postAssignPoolVideo(projectName, transition.id, poolPath)
      // Invalidate frame cache so the new video gets decoded
      const oldVariant = transition.selected ?? 'none'
      invalidateEntry(`tr:${transition.id}:v${oldVariant}`)
      if (result.variant) {
        invalidateEntry(`tr:${transition.id}:v${result.variant}`)
        transition.selected = result.variant
      }
      transition.hasSelectedVideo = true
      autoSave(projectName, `Assigned pool video to ${transition.id}`)
      onAssigned()
    } catch (e) {
      console.error('Assign failed:', e)
      alert(`Assign failed: ${e}`)
    } finally {
      setAssigning(false)
    }
  }, [projectName, transition.id])

  if (loading) return <div className="p-4 text-center text-sm text-gray-600">Loading...</div>

  return (
    <div className="p-2 space-y-3">
      {/* Pool videos */}
      {poolSegments.length > 0 && (
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
            Pool ({poolSegments.length})
          </div>
          <div className="grid grid-cols-2 gap-1">
            {poolSegments.map((entry) => (
              <BrowseVideoCard
                key={entry.name}
                path={entry.path}
                label={entry.name}
                projectName={projectName}
                disabled={assigning}
                onAssign={() => handleAssign(entry.path)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Binned transitions */}
      {binTransitions.length > 0 && (
        <div>
          <div className="text-[10px] text-red-400/60 uppercase tracking-wider mb-1">
            Deleted Transitions ({binTransitions.length})
          </div>
          <div className="grid grid-cols-2 gap-1">
            {binTransitions.map((entry) => (
              <BrowseVideoCard
                key={entry.id}
                path={`selected_transitions/${entry.id}_slot_0.mp4`}
                label={`${entry.id} (${entry.from}→${entry.to})`}
                projectName={projectName}
                disabled={assigning}
                onAssign={() => handleAssign(`selected_transitions/${entry.id}_slot_0.mp4`)}
              />
            ))}
          </div>
        </div>
      )}

      {poolSegments.length === 0 && binTransitions.length === 0 && (
        <div className="p-4 text-center text-sm text-gray-600">No videos available</div>
      )}
    </div>
  )
}

function BrowseVideoCard({ path, label, projectName, disabled, onAssign }: {
  path: string; label: string; projectName: string; disabled: boolean; onAssign: () => void
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => browseBlobCache.get(path) ?? null)
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const url = beatlabFileUrl(projectName, path)

  useEffect(() => {
    if (!hovered || blobUrl || loading) return
    setLoading(true)
    fetch(url)
      .then((res) => res.blob())
      .then((blob) => {
        const bu = URL.createObjectURL(blob)
        browseBlobCache.set(path, bu)
        setBlobUrl(bu)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [hovered, blobUrl, loading, url, path])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (hovered) el.play().catch(() => {})
    else { el.pause(); el.currentTime = 0 }
  }, [hovered, blobUrl])

  return (
    <div
      className={`relative rounded overflow-hidden bg-gray-800 group cursor-pointer border-2 border-transparent hover:border-green-500 transition-colors ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onAssign}
    >
      {blobUrl ? (
        <video
          ref={videoRef}
          src={blobUrl}
          className="w-full aspect-video object-cover"
          muted loop playsInline preload="metadata"
        />
      ) : (
        <div className="w-full aspect-video flex items-center justify-center">
          <span className="text-[9px] text-gray-500 font-mono">{loading ? '...' : label.slice(0, 20)}</span>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1 py-0.5">
        <div className="text-[7px] text-gray-300 truncate">{label}</div>
      </div>
      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="text-xs bg-green-600/90 text-white px-2 py-1 rounded">Assign</span>
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
