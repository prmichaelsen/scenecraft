import { useState, useRef, useCallback, useEffect } from 'react'
import type { KeyframeWithTime } from './Timeline'
import { updateKeyframePrompt, generateKeyframeCandidates, selectKeyframes } from '@/routes/project/$name/editor'
import { autoSave } from '@/lib/version-client'
import { beatlabFileUrl } from '@/lib/beatlab-client'
import type { useBeatlabSocket } from '@/hooks/useBeatlabSocket'

const STORAGE_KEY = 'beatlab-keyframe-panel-width'
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240
const MAX_WIDTH = 800

type KeyframePanelProps = {
  keyframe: KeyframeWithTime
  projectName: string
  onClose: () => void
  onDelete: () => void
  socket: ReturnType<typeof useBeatlabSocket>
}

export function KeyframePanel({ keyframe, projectName, onClose, onDelete, socket }: KeyframePanelProps) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parseInt(stored, 10))) : DEFAULT_WIDTH
  })
  const [tab, setTab] = useState<'details' | 'candidates'>('details')
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
        localStorage.setItem(STORAGE_KEY, String(width))
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [width])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(width))
  }, [width])

  const kf = keyframe

  return (
    <div className="relative flex shrink-0" style={{ width }}>
      {/* Drag handle */}
      <div
        className="w-1 cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500 transition-colors shrink-0"
        onMouseDown={handleMouseDown}
      />

      {/* Panel content */}
      <div className="flex-1 bg-gray-900 border-l border-gray-800 overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 sticky top-0 bg-gray-900 z-10 shrink-0">
          <div className="text-sm font-medium">{kf.id}</div>
          <div className="flex items-center gap-4">
            <button
              onClick={onDelete}
              className="text-xs text-red-500/70 hover:text-red-400 transition-colors"
              title="Delete keyframe (move to bin)"
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
        <div className="flex border-b border-gray-800 shrink-0">
          <button
            onClick={() => setTab('details')}
            className={`flex-1 text-xs py-2 transition-colors ${tab === 'details' ? 'text-gray-200 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-400'}`}
          >
            Details
          </button>
          <button
            onClick={() => setTab('candidates')}
            className={`flex-1 text-xs py-2 transition-colors ${tab === 'candidates' ? 'text-gray-200 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-400'}`}
          >
            Candidates{kf.candidates.length > 0 ? ` (${kf.candidates.length})` : ''}
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'details' ? (
            <DetailsTab kf={kf} projectName={projectName} />
          ) : (
            <CandidatesTab kf={kf} projectName={projectName} socket={socket} />
          )}
        </div>
      </div>
    </div>
  )
}

function DetailsTab({ kf, projectName }: { kf: KeyframeWithTime; projectName: string }) {
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [promptText, setPromptText] = useState(kf.prompt)
  const [saving, setSaving] = useState(false)

  // Sync when keyframe changes
  useEffect(() => {
    setPromptText(kf.prompt)
    setEditingPrompt(false)
  }, [kf.id, kf.prompt])

  const savePrompt = useCallback(async () => {
    if (promptText === kf.prompt) {
      setEditingPrompt(false)
      return
    }
    setSaving(true)
    await updateKeyframePrompt({
      data: { projectName, keyframeId: kf.id, prompt: promptText },
    })
    kf.prompt = promptText
    setSaving(false)
    setEditingPrompt(false)
  }, [promptText, kf, projectName])

  return (
    <>
      {/* Image */}
      {kf.hasSelectedImage && (
        <div className="p-3">
          <img
            src={beatlabFileUrl(projectName, `selected_keyframes/${kf.id}.png`)}
            alt={kf.id}
            className="w-full rounded"
          />
        </div>
      )}

      {/* Metadata */}
      <div className="px-3 pb-4 space-y-3">
        <Field label="Timestamp" value={kf.timestamp} />
        <Field label="Section" value={kf.section} />

        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider">Prompt</div>
            {!editingPrompt && (
              <button
                onClick={() => setEditingPrompt(true)}
                className="text-[10px] text-blue-500 hover:text-blue-400"
              >
                Edit
              </button>
            )}
          </div>
          {editingPrompt ? (
            <div className="space-y-1">
              <textarea
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    savePrompt()
                  }
                  if (e.key === 'Escape') {
                    setPromptText(kf.prompt)
                    setEditingPrompt(false)
                  }
                }}
                onBlur={savePrompt}
                autoFocus
                className="w-full bg-gray-800 text-sm text-gray-300 rounded p-2 border border-gray-700 focus:border-blue-500 focus:outline-none resize-y min-h-[80px] leading-relaxed"
                disabled={saving}
              />
              <div className="text-[9px] text-gray-600">Ctrl+Enter to save, Esc to cancel</div>
            </div>
          ) : (
            <div
              className="text-sm text-gray-300 leading-relaxed cursor-pointer hover:bg-gray-800/50 rounded p-1 -m-1 transition-colors"
              onClick={() => setEditingPrompt(true)}
            >
              {kf.prompt || <span className="text-gray-600 italic">No prompt</span>}
            </div>
          )}
        </div>

        {kf.selected !== null && (
          <Field
            label="Selected"
            value={typeof kf.selected === 'number' ? `Candidate #${kf.selected}` : String(kf.selected)}
          />
        )}

        {kf.context && (
          <>
            {kf.context.mood && <Field label="Mood" value={kf.context.mood} />}
            {kf.context.energy && <Field label="Energy" value={kf.context.energy} />}
            {kf.context.visual_direction && (
              <div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Visual Direction</div>
                <div className="text-sm text-gray-300">{kf.context.visual_direction}</div>
              </div>
            )}
            {kf.context.instruments.length > 0 && (
              <div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Instruments</div>
                <div className="flex flex-wrap gap-1">
                  {kf.context.instruments.map((inst) => (
                    <span key={inst} className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">
                      {inst}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {kf.context.motifs.length > 0 && (
              <div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Motifs</div>
                <div className="flex flex-wrap gap-1">
                  {kf.context.motifs.map((m) => (
                    <span key={m} className="text-xs bg-purple-900/40 text-purple-300 px-1.5 py-0.5 rounded font-mono">
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {kf.context.details && (
              <div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Details</div>
                <div className="text-xs text-gray-400 leading-relaxed whitespace-pre-wrap">{kf.context.details}</div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}

function CandidatesTab({ kf, projectName, socket }: { kf: KeyframeWithTime; projectName: string; socket: ReturnType<typeof useBeatlabSocket> }) {
  const [generating, setGenerating] = useState(false)
  const [jobStatus, setJobStatus] = useState('')
  const [candidates, setCandidates] = useState(kf.candidates)

  useEffect(() => {
    setCandidates(kf.candidates)
  }, [kf.id, kf.candidates])

  const handleGenerate = useCallback(async () => {
    if (!kf.prompt) {
      alert('Add a prompt to this keyframe first (Details tab) before generating candidates.')
      return
    }
    setGenerating(true)
    setJobStatus('Starting...')

    const result = await generateKeyframeCandidates({
      data: { projectName, keyframeId: kf.id },
    })

    if (result.jobId) {
      // Subscribe to WebSocket for progress
      const unsub = socket.subscribeJob(result.jobId, (msg) => {
        if (msg.type === 'job_progress') {
          setJobStatus(`${msg.completed}/${msg.total} generated`)
        } else if (msg.type === 'job_completed') {
          const res = msg.result as { candidates?: string[] }
          if (res?.candidates) {
            setCandidates(res.candidates)
            kf.candidates = res.candidates
          }
          setGenerating(false)
          setJobStatus('')
          autoSave(projectName, `Generated ${kf.id} candidates`)
          unsub()
        } else if (msg.type === 'job_failed') {
          setJobStatus(`Failed: ${msg.error}`)
          setGenerating(false)
          unsub()
        }
      })
    } else {
      // Fallback: no jobId (old server), treat result as final
      if (result.candidates) {
        setCandidates(result.candidates)
        kf.candidates = result.candidates
      }
      setGenerating(false)
      setJobStatus('')
    }
  }, [projectName, kf, socket])

  const [selectedIdx, setSelectedIdx] = useState<number | null>(() => {
    return typeof kf.selected === 'number' ? kf.selected : null
  })
  const [selecting, setSelecting] = useState(false)

  const handleSelect = useCallback(async (variantNum: number) => {
    setSelecting(true)
    try {
      await selectKeyframes({
        data: { projectName, selections: { [kf.id]: variantNum } },
      })
      setSelectedIdx(variantNum)
      kf.selected = variantNum
      autoSave(projectName, `Selected ${kf.id} candidate v${variantNum}`)
    } finally {
      setSelecting(false)
    }
  }, [projectName, kf])

  // Extract variant number from path like ".../v1.png" or ".../styled_003.png"
  function variantLabel(path: string): string {
    const match = path.match(/v(\d+)\.png$/)
    if (match) return `v${match[1]}`
    const styledMatch = path.match(/styled_([^/]+)\.png$/)
    if (styledMatch) return styledMatch[1]
    return path.split('/').pop() || path
  }

  function isSelected(idx: number): boolean {
    return selectedIdx === idx + 1
  }

  return (
    <div className="p-2 space-y-2">
      <button
        onClick={handleGenerate}
        disabled={generating}
        className="w-full text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2 rounded transition-colors"
      >
        {generating ? 'Generating with Imagen...' : candidates.length > 0 ? 'Generate More' : 'Generate Candidates'}
      </button>
      {generating && (
        <div className="text-[10px] text-gray-500 text-center">
          {jobStatus || 'Generating styled image candidates...'}
        </div>
      )}

      {candidates.length === 0 && !generating ? (
        <div className="text-center text-sm text-gray-600 py-4">
          No candidates yet. Add a prompt and click Generate.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {candidates.map((candidatePath, idx) => {
            const selected = isSelected(idx)
            const variantNum = idx + 1
            // Convert .beatlab_work/project/path to beatlab API file URL
            const parts = candidatePath.split('/')
            const projectIdx = parts.indexOf('.beatlab_work')
            const relativePath = projectIdx >= 0 ? parts.slice(projectIdx + 2).join('/') : candidatePath
            const imgUrl = beatlabFileUrl(projectName, relativePath)

            return (
              <div
                key={candidatePath}
                className={`relative rounded overflow-hidden border-2 cursor-pointer transition-colors ${selected ? 'border-blue-500' : 'border-transparent hover:border-gray-600'} ${selecting ? 'opacity-50 pointer-events-none' : ''}`}
                onClick={() => handleSelect(variantNum)}
              >
                <img
                  src={imgUrl}
                  alt={variantLabel(candidatePath)}
                  className="w-full aspect-video object-cover"
                  loading="lazy"
                />
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-300 font-mono">
                      {variantLabel(candidatePath)}
                    </span>
                    {selected && (
                      <span className="text-[9px] bg-blue-500 text-white px-1 rounded">
                        selected
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
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
