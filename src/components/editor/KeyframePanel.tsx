import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { KeyframeWithTime } from './Timeline'
import { updateKeyframePrompt, generateKeyframeCandidates, selectKeyframes, setBaseImage } from '@/routes/project/$name/editor'
import { autoSave } from '@/lib/version-client'
import { beatlabFileUrl, fetchDirectoryListing, type FileEntry } from '@/lib/beatlab-client'
import { invalidateEntry } from '@/lib/frame-cache'
import { CandidateModal } from './TransitionPanel'
import { useJobState, useJobContext } from '@/contexts/JobStateContext'

const STORAGE_KEY = 'beatlab-side-panel-width'
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240

type KeyframePanelProps = {
  keyframe: KeyframeWithTime
  projectName: string
  onClose: () => void
  onDelete: () => void
  onDuplicate: () => void
  onDataChange: () => void
}

export function KeyframePanel({ keyframe, projectName, onClose, onDelete, onDuplicate, onDataChange }: KeyframePanelProps) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? Math.max(MIN_WIDTH, parseInt(stored, 10)) : DEFAULT_WIDTH
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
      const newWidth = Math.max(MIN_WIDTH, startWidth.current + delta)
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
              onClick={onDuplicate}
              className="text-xs text-blue-500/70 hover:text-blue-400 transition-colors"
              title="Duplicate keyframe halfway to next"
            >
              Duplicate
            </button>
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
            <CandidatesTab kf={kf} projectName={projectName} />
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
  const [hasImage, setHasImage] = useState(kf.hasSelectedImage)

  // Sync when keyframe changes
  useEffect(() => {
    setPromptText(kf.prompt)
    setEditingPrompt(false)
    setHasImage(kf.hasSelectedImage)
  }, [kf.id, kf.prompt, kf.hasSelectedImage])

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
      {/* Image or base image picker */}
      {hasImage ? (
        <div className="p-3">
          <img
            src={beatlabFileUrl(projectName, `selected_keyframes/${kf.id}.png`)}
            alt={kf.id}
            className="w-full rounded"
          />
        </div>
      ) : (
        <BaseImagePicker keyframeId={kf.id} projectName={projectName} onSet={() => { kf.hasSelectedImage = true; setHasImage(true) }} />
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
                ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
                value={promptText}
                onChange={(e) => { setPromptText(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px' }}
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
                className="w-full bg-gray-800 text-sm text-gray-300 rounded p-2 border border-gray-700 focus:border-blue-500 focus:outline-none resize-none leading-relaxed overflow-hidden"
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

function CandidatesTab({ kf, projectName }: { kf: KeyframeWithTime; projectName: string }) {
  const jobCtx = useJobContext()
  const entityKey = `kf:${kf.id}:candidates`
  const job = useJobState(entityKey)

  const [candidates, setCandidates] = useState(kf.candidates)

  useEffect(() => {
    setCandidates(kf.candidates)
  }, [kf.id, kf.candidates])

  // Apply completed job result
  useEffect(() => {
    if (job?.status === 'completed' && job.result) {
      const res = job.result as { candidates?: string[] }
      if (res?.candidates) {
        setCandidates(res.candidates)
        kf.candidates = res.candidates
      }
      jobCtx.consumeResult(entityKey)
      autoSave(projectName, `Generated ${kf.id} candidates`)
    }
  }, [job?.status, job?.result])

  const generating = job?.status === 'in_progress'
  const jobStatus = job?.detail || ''
  const COUNT_OPTIONS = [1, 2, 3, 4] as const
  const [generationCount, setGenerationCount] = useState<number>(4)

  const handleGenerate = useCallback(async () => {
    if (!kf.prompt) {
      alert('Add a prompt to this keyframe first (Details tab) before generating candidates.')
      return
    }

    try {
      const result = await generateKeyframeCandidates({
        data: { projectName, keyframeId: kf.id, count: generationCount },
      })

      if (result.jobId) {
        jobCtx.startJob(entityKey, result.jobId)
      } else {
        if (result.candidates) {
          setCandidates(result.candidates)
          kf.candidates = result.candidates
        }
      }
    } catch (e) {
      console.error('Generate candidates failed:', e)
      alert(`Failed to generate candidates: ${e}`)
    }
  }, [projectName, kf, jobCtx, entityKey, generationCount])

  const [selectedIdx, setSelectedIdx] = useState<number | null>(() => {
    return typeof kf.selected === 'number' ? kf.selected : null
  })
  const [selecting, setSelecting] = useState(false)
  const [showModal, setShowModal] = useState(false)

  const handleSelect = useCallback(async (variantNum: number) => {
    console.log(`[KeyframePanel] selecting ${kf.id} variant ${variantNum}`)
    setSelecting(true)
    try {
      await selectKeyframes({
        data: { projectName, selections: { [kf.id]: variantNum } },
      })
      console.log(`[KeyframePanel] selected ${kf.id} v${variantNum} OK`)
      setSelectedIdx(variantNum)
      kf.selected = variantNum
      // Invalidate frame cache so preview + video track update
      invalidateEntry(`kf:${kf.id}`)
      kf.hasSelectedImage = true
      autoSave(projectName, `Selected ${kf.id} candidate v${variantNum}`)
      onDataChange()
    } catch (e) {
      console.error(`[KeyframePanel] select failed:`, e)
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
      {/* Count selector */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider shrink-0 w-14">Count</span>
        <div className="flex gap-0.5 flex-1">
          {COUNT_OPTIONS.map((c) => (
            <button
              key={c}
              onClick={() => setGenerationCount(c)}
              className={`flex-1 text-[10px] py-1 rounded transition-colors ${generationCount === c ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

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

      {candidates.length > 0 && (
        <div className="flex justify-end">
          <button
            onClick={() => setShowModal(true)}
            className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
          >
            Expand
          </button>
        </div>
      )}
      {showModal && createPortal(
        <CandidateModal
          title={`${kf.id} — Keyframe Candidates`}
          groups={{ [kf.id]: candidates.map((c) => {
            const parts = c.split('/')
            const projectIdx = parts.indexOf('.beatlab_work')
            return projectIdx >= 0 ? parts.slice(projectIdx + 2).join('/') : c
          }) }}
          selectedMap={{ [kf.id]: selectedIdx }}
          disabled={selecting}
          projectName={projectName}
          mediaType="image"
          onSelect={(_groupKey, variantIndex) => handleSelect(variantIndex)}
          onClose={() => setShowModal(false)}
        />,
        document.body,
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

// Module-level stills cache: projectName -> { entries, blobUrls }
const stillsCache = new Map<string, { entries: FileEntry[]; blobs: Map<string, string> }>()
const stillsLoading = new Set<string>()

export function preloadStills(projectName: string): Promise<{ entries: FileEntry[]; blobs: Map<string, string> }> {
  if (stillsCache.has(projectName)) return Promise.resolve(stillsCache.get(projectName)!)
  if (stillsLoading.has(projectName)) {
    return new Promise((resolve) => {
      const check = () => {
        if (stillsCache.has(projectName)) resolve(stillsCache.get(projectName)!)
        else setTimeout(check, 100)
      }
      check()
    })
  }
  stillsLoading.add(projectName)
  return fetchDirectoryListing(projectName, 'assets/stills')
    .then(async (entries) => {
      const imageEntries = entries.filter((e) => !e.isDirectory && /\.(png|jpg|jpeg|webp)$/i.test(e.name))
      const blobs = new Map<string, string>()
      await Promise.all(imageEntries.map(async (entry) => {
        try {
          const res = await fetch(beatlabFileUrl(projectName, `assets/stills/${entry.name}`))
          const blob = await res.blob()
          blobs.set(entry.name, URL.createObjectURL(blob))
        } catch {}
      }))
      const cached = { entries: imageEntries, blobs }
      stillsCache.set(projectName, cached)
      stillsLoading.delete(projectName)
      return cached
    })
    .catch(() => {
      stillsLoading.delete(projectName)
      return { entries: [], blobs: new Map() }
    })
}

export function StillPicker({ projectName, onSelect, disabled, selectedStill }: {
  projectName: string
  onSelect: (stillName: string) => void
  disabled?: boolean
  selectedStill?: string | null
}) {
  const [stills, setStills] = useState<FileEntry[]>(() => stillsCache.get(projectName)?.entries || [])
  const [blobs, setBlobs] = useState<Map<string, string>>(() => stillsCache.get(projectName)?.blobs || new Map())
  const [loading, setLoading] = useState(!stillsCache.has(projectName))

  useEffect(() => {
    preloadStills(projectName).then((cached) => {
      setStills(cached.entries)
      setBlobs(cached.blobs)
      setLoading(false)
    })
  }, [projectName])

  if (loading) return <div className="p-3 text-[10px] text-gray-600">Loading stills...</div>
  if (stills.length === 0) return <div className="p-3 text-[10px] text-gray-600">No stills in assets/stills/</div>

  return (
    <div className="p-3 space-y-1">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">Select Base Image</div>
      <div className="grid grid-cols-2 gap-1">
        {stills.map((still) => (
          <button
            key={still.name}
            onClick={() => onSelect(still.name)}
            disabled={disabled}
            className={`relative rounded overflow-hidden border-2 transition-colors disabled:opacity-50 ${selectedStill === still.name ? 'border-teal-500' : 'border-transparent hover:border-blue-500'}`}
          >
            <img
              src={blobs.get(still.name) || beatlabFileUrl(projectName, `assets/stills/${still.name}`)}
              alt={still.name}
              className="w-full aspect-video object-cover"
            />
            <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5">
              <span className="text-[8px] text-gray-300">{still.name.replace(/\.\w+$/, '')}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function BaseImagePicker({ keyframeId, projectName, onSet }: { keyframeId: string; projectName: string; onSet: () => void }) {
  const [setting, setSetting] = useState(false)

  const handleSelect = useCallback(async (stillName: string) => {
    setSetting(true)
    try {
      await setBaseImage({ data: { projectName, keyframeId, stillName } })
      onSet()
    } finally {
      setSetting(false)
    }
  }, [projectName, keyframeId, onSet])

  return <StillPicker projectName={projectName} onSelect={handleSelect} disabled={setting} />
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{label}</div>
      <div className="text-sm text-gray-300">{value}</div>
    </div>
  )
}
