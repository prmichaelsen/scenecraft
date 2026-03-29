import { useState, useRef, useCallback, useEffect } from 'react'
import type { Transition } from '@/routes/project/$name/editor'
import { updateTransitionAction, updateMeta, generateTransitionAction, generateTransitionCandidates, selectTransitions } from '@/routes/project/$name/editor'
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
  const [action, setAction] = useState(transition.action)
  const [useGlobal, setUseGlobal] = useState(transition.useGlobalPrompt)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    setAction(transition.action)
    setUseGlobal(transition.useGlobalPrompt)
  }, [transition.id, transition.action, transition.useGlobalPrompt])

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
        data: { projectName, transitionId: transition.id },
      })
      if (result.action) {
        setAction(result.action)
        transition.action = result.action
      }
    } finally {
      setGenerating(false)
    }
  }, [projectName, transition])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Action Prompt</div>
        <button
          onClick={handleGenerate}
          disabled={generating || saving}
          className="text-[10px] text-orange-400 hover:text-orange-300 disabled:text-gray-600 transition-colors"
        >
          {generating ? 'Generating...' : action ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {action ? (
        <textarea
          value={action}
          onChange={(e) => setAction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              save()
            }
            if (e.key === 'Escape') {
              setAction(transition.action)
            }
          }}
          onBlur={save}
          className="w-full bg-gray-800 text-sm text-gray-300 rounded p-2 border border-gray-700 focus:border-orange-500 focus:outline-none resize-y min-h-[80px] leading-relaxed"
          disabled={saving || generating}
        />
      ) : (
        <div className="text-sm text-gray-500 italic bg-gray-800/50 rounded p-2">
          {generating ? 'Analyzing keyframe images with Claude...' : 'No action prompt yet. Click Generate to create one from the keyframe images.'}
        </div>
      )}
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
  const [generating, setGenerating] = useState(false)
  const [jobStatus, setJobStatus] = useState('')
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

  const handleGenerate = useCallback(async () => {
    if (!transition.action) {
      alert('Generate an action prompt first (Details tab) before generating video candidates.')
      return
    }
    setGenerating(true)
    setJobStatus('Starting...')

    const result = await generateTransitionCandidates({
      data: { projectName, transitionId: transition.id, count: 1 },
    })

    if (result.jobId) {
      const unsub = socket.subscribeJob(result.jobId, (msg) => {
        if (msg.type === 'job_progress') {
          setJobStatus(`${msg.completed}/${msg.total} videos generated`)
        } else if (msg.type === 'job_completed') {
          const res = msg.result as { candidates?: Record<string, string[]> }
          if (res?.candidates) {
            setCandidates(res.candidates)
            transition.candidates = res.candidates
          }
          setGenerating(false)
          setJobStatus('')
          autoSave(projectName, `Generated ${transition.id} video candidates`)
          unsub()
        } else if (msg.type === 'job_failed') {
          setJobStatus(`Failed: ${msg.error}`)
          setGenerating(false)
          unsub()
        }
      })
    } else {
      if (result.candidates) {
        setCandidates(result.candidates)
        transition.candidates = result.candidates
      }
      setGenerating(false)
      setJobStatus('')
    }
  }, [projectName, transition, socket])

  const handleSelect = useCallback(async (slotKey: string, variantIndex: number) => {
    setSelecting(true)
    const selectionKey = `${transition.id}_${slotKey}`
    try {
      await selectTransitions({
        data: { projectName, selections: { [selectionKey]: variantIndex } },
      })
      setSelectedMap((prev) => ({ ...prev, [slotKey]: variantIndex }))
      // Invalidate old frame cache entry (old variant key)
      const oldVariant = selectedMap[slotKey] ?? 'none'
      invalidateEntry(`tr:${transition.id}:${slotKey}:v${oldVariant}`)
      autoSave(projectName, `Selected ${transition.id} ${slotKey} v${variantIndex}`)
    } finally {
      setSelecting(false)
    }
  }, [projectName, transition.id])

  const slotKeys = Object.keys(candidates).sort()
  const totalVideos = slotKeys.reduce((sum, k) => sum + candidates[k].length, 0)

  return (
    <div className="p-2 space-y-3">
      {/* Generate button */}
      <button
        onClick={handleGenerate}
        disabled={generating}
        className="w-full text-xs bg-orange-600 hover:bg-orange-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2 rounded transition-colors"
      >
        {generating ? 'Generating with Veo...' : totalVideos > 0 ? 'Generate More Videos' : 'Generate Video Candidates'}
      </button>
      {generating && (
        <div className="text-[10px] text-gray-500 text-center">
          {jobStatus || 'Starting Veo 3.1 generation...'}
        </div>
      )}

      {/* Candidates by slot */}
      {slotKeys.length === 0 && !generating ? (
        <div className="text-center text-sm text-gray-600 py-4">
          No video candidates yet.
        </div>
      ) : (
        slotKeys.map((slotKey) => (
          <div key={slotKey}>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
              {slotKey.replace('_', ' ')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {candidates[slotKey].map((videoPath, idx) => {
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
          </div>
        ))
      )}
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
