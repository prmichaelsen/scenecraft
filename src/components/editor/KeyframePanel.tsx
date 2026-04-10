import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { KeyframeWithTime } from './Timeline'
import { updateKeyframePrompt, generateKeyframeCandidates, generateKeyframeVariations, escalateKeyframe, selectKeyframes, setBaseImage, suggestKeyframePrompts, enhanceKeyframePrompt } from '@/routes/project/$name/editor'
import { autoSave } from '@/lib/version-client'
import { beatlabFileUrl, fetchDirectoryListing, fetchPool, fetchBin, type FileEntry, type AudioEvent, type AudioDescription, type PoolEntry, type BinEntry } from '@/lib/beatlab-client'
import { invalidateEntry, preloadKeyframeImage } from '@/lib/frame-cache'
import { CandidateModal } from './TransitionPanel'
import { useJobState, useJobContext } from '@/contexts/JobStateContext'

const STORAGE_KEY = 'beatlab-side-panel-width'
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240

// Persist tab + scroll across panel switches
let _lastKfTab: 'details' | 'candidates' | 'bench' | 'browse' = 'details'
let _lastKfScroll: number = 0

type KeyframePanelProps = {
  keyframe: KeyframeWithTime
  projectName: string
  onClose: () => void
  onDelete: () => void
  onDuplicate: () => void
  onMoveLeft: () => void
  onMoveRight: () => void
  onUnlink: (side: 'both' | 'left' | 'right') => void
  onDataChange: () => void
  audioDescriptions?: AudioDescription[]
  audioEvents?: AudioEvent[]
  initialPromptRoster?: import('@/lib/beatlab-client').PromptRosterEntry[]
}

export function KeyframePanel({ keyframe, projectName, onClose, onDelete, onDuplicate, onMoveLeft, onMoveRight, onUnlink, onDataChange, audioDescriptions, audioEvents, initialPromptRoster }: KeyframePanelProps) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? Math.max(MIN_WIDTH, parseInt(stored, 10)) : DEFAULT_WIDTH
  })
  const [tab, setTabRaw] = useState<'details' | 'candidates' | 'bench' | 'browse'>(_lastKfTab)
  const setTab = useCallback((t: 'details' | 'candidates' | 'bench' | 'browse') => { _lastKfTab = t; setTabRaw(t) }, [])
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Restore scroll position on mount
  useEffect(() => {
    if (scrollContainerRef.current && _lastKfScroll > 0) {
      scrollContainerRef.current.scrollTop = _lastKfScroll
    }
  }, [])

  // Save scroll position on unmount
  useEffect(() => {
    const el = scrollContainerRef.current
    return () => { if (el) _lastKfScroll = el.scrollTop }
  }, [])
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
      <div ref={scrollContainerRef} className="flex-1 bg-gray-900 border-l border-gray-800 overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 sticky top-0 bg-gray-900 z-10 shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              onClick={onMoveLeft}
              className="text-sm text-gray-500 hover:text-gray-200 transition-colors px-1"
              title="Swap with previous keyframe"
            >&larr;</button>
            <span className="text-sm font-medium">{kf.id}</span>
            <button
              onClick={onMoveRight}
              className="text-sm text-gray-500 hover:text-gray-200 transition-colors px-1"
              title="Swap with next keyframe"
            >&rarr;</button>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-0.5 border border-gray-700 rounded overflow-hidden">
              <button
                onClick={() => onUnlink('left')}
                className="text-[10px] text-yellow-600 hover:text-yellow-400 hover:bg-gray-800 px-1.5 py-0.5 transition-colors"
                title="Unlink left (remove incoming transition)"
              >&#x2939;</button>
              <button
                onClick={() => onUnlink('both')}
                className="text-[10px] text-yellow-600 hover:text-yellow-400 hover:bg-gray-800 px-1.5 py-0.5 border-x border-gray-700 transition-colors"
                title="Unlink both sides"
              >&#x2194;</button>
              <button
                onClick={() => onUnlink('right')}
                className="text-[10px] text-yellow-600 hover:text-yellow-400 hover:bg-gray-800 px-1.5 py-0.5 transition-colors"
                title="Unlink right (remove outgoing transition)"
              >&#x293A;</button>
            </div>
            <button
              onClick={onDuplicate}
              className="text-xs text-blue-500/70 hover:text-blue-400 transition-colors"
              title="Duplicate keyframe halfway to next"
            >
              Dup
            </button>
            <button
              onClick={onDelete}
              className="text-xs text-red-500/70 hover:text-red-400 transition-colors"
              title="Delete keyframe (move to bin)"
            >
              Del
            </button>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 text-lg leading-none"
              title="Close panel"
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
            title="Keyframe metadata and prompt"
          >
            Details
          </button>
          <button
            onClick={() => setTab('candidates')}
            className={`flex-1 text-xs py-2 transition-colors ${tab === 'candidates' ? 'text-gray-200 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-400'}`}
            title="Generated image candidates"
          >
            Candidates{kf.candidates.length > 0 ? ` (${kf.candidates.length})` : ''}
          </button>
          <button
            onClick={() => setTab('browse')}
            className={`flex-1 text-xs py-2 transition-colors ${tab === 'browse' ? 'text-gray-200 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-400'}`}
            title="Browse pool and bin images to assign"
          >
            Browse
          </button>
          <button
            onClick={() => setTab('bench')}
            className={`flex-1 text-xs py-2 transition-colors ${tab === 'bench' ? 'text-gray-200 border-b-2 border-green-500' : 'text-gray-500 hover:text-gray-400'}`}
            title="Saved keyframe images for reuse"
          >
            Bench
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'details' ? (
            <DetailsTab kf={kf} projectName={projectName} audioDescriptions={audioDescriptions} audioEvents={audioEvents} onDataChange={onDataChange} initialPromptRoster={initialPromptRoster} />
          ) : tab === 'candidates' ? (
            <CandidatesTab kf={kf} projectName={projectName} onDataChange={onDataChange} />
          ) : tab === 'browse' ? (
            <BrowseTab kf={kf} projectName={projectName} onDataChange={onDataChange} />
          ) : (
            <BenchTab kf={kf} projectName={projectName} onDataChange={onDataChange} />
          )}
        </div>
      </div>
    </div>
  )
}

function DetailsTab({ kf, projectName, audioDescriptions, audioEvents, onDataChange, initialPromptRoster }: { kf: KeyframeWithTime; projectName: string; audioDescriptions?: AudioDescription[]; audioEvents?: AudioEvent[]; onDataChange: () => void; initialPromptRoster?: import('@/lib/beatlab-client').PromptRosterEntry[] }) {
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [promptText, setPromptText] = useState(kf.prompt)
  const [promptRoster, setPromptRoster] = useState<import('@/lib/beatlab-client').PromptRosterEntry[]>(initialPromptRoster || [])
  const [saving, setSaving] = useState(false)
  const [hasImage, setHasImage] = useState(kf.hasSelectedImage)
  const [generating, setGenerating] = useState(false)
  const [enhancing, setEnhancing] = useState(false)
  const [labelText, setLabelText] = useState(kf.label || '')

  // Sync when keyframe changes
  useEffect(() => {
    setPromptText(kf.prompt)
    setEditingPrompt(false)
    setHasImage(kf.hasSelectedImage)
    setLabelText(kf.label || '')
  }, [kf.id, kf.prompt, kf.hasSelectedImage, kf.label])

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

  // Find section content and nearest audio event for this keyframe
  const sectionDesc = audioDescriptions?.find((d) => d.label === kf.section)
  const sectionContent = sectionDesc?.content || ''
  const nearestEvent = audioEvents
    ?.filter((ev) => {
      if (!sectionDesc) return true
      return ev.time >= sectionDesc.startTime && ev.time <= sectionDesc.endTime
    })
    .reduce<AudioEvent | null>((best, ev) => {
      if (!best) return ev
      return Math.abs(ev.time - kf.timeSeconds) < Math.abs(best.time - kf.timeSeconds) ? ev : best
    }, null)

  const handleGeneratePrompt = useCallback(async () => {
    setGenerating(true)
    try {
      const event = nearestEvent || { time: kf.timeSeconds, effect: 'pulse', intensity: 0.8, stem_source: 'kick' }
      const result = await suggestKeyframePrompts({
        data: {
          projectName,
          sectionLabel: kf.section,
          sectionContent,
          events: [{ time: event.time, effect: event.effect, intensity: event.intensity, stem_source: event.stem_source }],
          baseStillName: '',
        },
      })
      if (result.suggestions.length > 0) {
        const newPrompt = result.suggestions[0].prompt
        setPromptText(newPrompt)
        // Auto-save
        await updateKeyframePrompt({ data: { projectName, keyframeId: kf.id, prompt: newPrompt } })
        kf.prompt = newPrompt
      }
    } catch (e) {
      alert(`Generate failed: ${e}`)
    } finally {
      setGenerating(false)
    }
  }, [projectName, kf, sectionContent, nearestEvent])

  const handleEnhancePrompt = useCallback(async () => {
    if (!promptText) {
      alert('Add a prompt first before enhancing.')
      return
    }
    setEnhancing(true)
    try {
      const event = nearestEvent || { time: kf.timeSeconds, effect: 'pulse', intensity: 0.8, stem_source: 'kick' }
      const result = await enhanceKeyframePrompt({
        data: {
          projectName,
          prompt: promptText,
          sectionContent,
          event: {
            time: event.time,
            effect: event.effect,
            intensity: event.intensity,
            stem_source: event.stem_source,
            rationale: 'rationale' in event ? (event as AudioEvent).rationale : undefined,
          },
        },
      })
      if (result.prompt) {
        setPromptText(result.prompt)
        await updateKeyframePrompt({ data: { projectName, keyframeId: kf.id, prompt: result.prompt } })
        kf.prompt = result.prompt
      }
    } catch (e) {
      alert(`Enhance failed: ${e}`)
    } finally {
      setEnhancing(false)
    }
  }, [projectName, kf, promptText, sectionContent, nearestEvent])

  return (
    <>
      {/* Image */}
      {hasImage && (
        <div className="p-3">
          <img
            src={`${beatlabFileUrl(projectName, `selected_keyframes/${kf.id}.png`)}?v=${kf.selected ?? 0}`}
            alt={kf.id}
            className="w-full rounded"
          />
        </div>
      )}
      {/* Base image picker — always available */}
      <BaseImagePicker keyframeId={kf.id} projectName={projectName} onSet={() => { kf.hasSelectedImage = true; setHasImage(true); invalidateEntry(`kf:${kf.id}`); onDataChange() }} />

      {/* Metadata */}
      <div className="px-3 pb-4 space-y-3">
        <Field label="Timestamp" value={kf.timestamp} />
        <Field label="Section" value={kf.section} />

        {/* Label + color */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Label</div>
            <input
              type="text"
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
              onBlur={async () => {
                if (labelText !== (kf.label || '')) {
                  kf.label = labelText
                  const { postUpdateKeyframeLabel } = await import('@/lib/beatlab-client')
                  await postUpdateKeyframeLabel(projectName, kf.id, labelText, kf.labelColor || '')
                  onDataChange()
                }
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              placeholder="Name this keyframe..."
              className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Color</div>
            <input
              type="color"
              value={kf.labelColor || '#9ca3af'}
              onChange={async (e) => {
                kf.labelColor = e.target.value
                const { postUpdateKeyframeLabel } = await import('@/lib/beatlab-client')
                postUpdateKeyframeLabel(projectName, kf.id, kf.label || '', e.target.value).catch(() => {})
                onDataChange()
              }}
              className="w-8 h-7 rounded border border-gray-700 cursor-pointer"
            />
          </div>
        </div>

        {/* Blend Mode + Opacity */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Blend Mode</div>
            <select
              value={kf.blendMode || ''}
              onChange={async (e) => {
                const val = e.target.value
                kf.blendMode = val
                const { postUpdateKeyframeStyle } = await import('@/lib/beatlab-client')
                await postUpdateKeyframeStyle(projectName, kf.id, { blendMode: val })
                onDataChange()
              }}
              className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700"
            >
              <option value="">Track default</option>
              <option value="normal">normal</option>
              <option value="multiply">multiply</option>
              <option value="screen">screen</option>
              <option value="overlay">overlay</option>
              <option value="difference">difference</option>
              <option value="add">add</option>
              <option value="soft-light">soft-light</option>
              <option value="chroma-key">chroma-key</option>
            </select>
          </div>
          <div className="w-20">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Opacity</div>
            <input
              type="number"
              min={0} max={1} step={0.05}
              value={kf.opacity != null ? kf.opacity : ''}
              placeholder="—"
              onChange={async (e) => {
                const v = e.target.value === '' ? null : parseFloat(e.target.value)
                kf.opacity = v
                const { postUpdateKeyframeStyle } = await import('@/lib/beatlab-client')
                await postUpdateKeyframeStyle(projectName, kf.id, { opacity: v })
                onDataChange()
              }}
              className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider">Prompt</div>
            {!editingPrompt && (
              <div className="flex gap-2">
                <button
                  onClick={handleGeneratePrompt}
                  disabled={generating || enhancing}
                  className="text-[10px] text-blue-400 hover:text-blue-300 disabled:text-gray-600 transition-colors"
                  title="Auto-generate a prompt from context"
                >
                  {generating ? 'Generating...' : 'Generate'}
                </button>
                <button
                  onClick={handleEnhancePrompt}
                  disabled={enhancing || generating || !promptText}
                  className="text-[10px] text-purple-400 hover:text-purple-300 disabled:text-gray-600 transition-colors"
                  title="Enhance the current prompt with AI"
                >
                  {enhancing ? 'Enhancing...' : 'Enhance'}
                </button>
                <button
                  onClick={() => setEditingPrompt(true)}
                  className="text-[10px] text-gray-500 hover:text-gray-400"
                  title="Edit prompt manually"
                >
                  Edit
                </button>
              </div>
            )}
          </div>
          {editingPrompt ? (
            <div className="space-y-1">
              {/* Prompt roster selector */}
              <div className="flex items-center gap-1">
                <select
                  className="flex-1 bg-gray-800 text-[10px] text-gray-400 border border-gray-700 rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
                  value=""
                  onChange={(e) => {
                    const entry = promptRoster.find((p) => p.id === e.target.value)
                    if (entry) setPromptText(entry.template)
                  }}
                >
                  <option value="">Insert from roster...</option>
                  {Object.entries(
                    promptRoster.reduce<Record<string, typeof promptRoster>>((acc, p) => {
                      (acc[p.category] = acc[p.category] || []).push(p)
                      return acc
                    }, {})
                  ).map(([cat, entries]) => (
                    <optgroup key={cat} label={cat}>
                      {entries.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </optgroup>
                  ))}
                </select>
                <button
                  onClick={async () => {
                    if (!promptText.trim()) { alert('Write a prompt first, then save it to the roster.'); return }
                    const name = prompt('Name for this prompt template:')
                    if (!name) return
                    const category = prompt('Category (e.g., general, style, composition):', 'general') || 'general'
                    const { postAddPromptRoster, fetchPromptRoster } = await import('@/lib/beatlab-client')
                    await postAddPromptRoster(projectName, name, promptText, category)
                    setPromptRoster(await fetchPromptRoster(projectName))
                  }}
                  className="text-[9px] text-blue-400 hover:text-blue-300 whitespace-nowrap"
                  title="Save current prompt to roster"
                >
                  + Save
                </button>
              </div>
              <textarea
                ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
                value={promptText}
                onChange={(e) => { setPromptText(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px' }}
                onBlur={() => savePrompt()}
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
              <div className="flex items-center justify-between text-[9px] text-gray-600">
                <span>Ctrl+Enter to save, Esc to cancel</span>
                {promptText && (
                  <button
                    onClick={async () => {
                      const name = window.prompt('Save prompt as:', promptText.slice(0, 40))
                      if (!name) return
                      const category = window.prompt('Category:', 'general') || 'general'
                      const { postAddPromptRoster, fetchPromptRoster } = await import('@/lib/beatlab-client')
                      await postAddPromptRoster(projectName, name, promptText, category)
                      setPromptRoster(await fetchPromptRoster(projectName))
                    }}
                    className="text-blue-400 hover:text-blue-300"
                  >
                    Save to roster
                  </button>
                )}
              </div>
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

function CandidatesTab({ kf, projectName, onDataChange }: { kf: KeyframeWithTime; projectName: string; onDataChange: () => void }) {
  const jobCtx = useJobContext()
  const entityKey = `kf:${kf.id}:candidates`
  const job = useJobState(entityKey)

  const [candidates, setCandidates] = useState(kf.candidates)

  useEffect(() => {
    setCandidates(kf.candidates)
  }, [kf.id, kf.candidates])

  // Refresh candidates from disk on mount (catches async generation results)
  useEffect(() => {
    fetch(`${import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'}/api/projects/${encodeURIComponent(projectName)}/keyframes`)
      .then((r) => r.json())
      .then((data) => {
        const fresh = (data.keyframes || []).find((k: { id: string }) => k.id === kf.id)
        if (fresh?.candidates?.length > 0 && fresh.candidates.length !== candidates.length) {
          const mapped = fresh.candidates.map((c: string | { path: string }) => typeof c === 'string' ? c : c.path).filter(Boolean)
          if (mapped.length > 0) setCandidates(mapped)
        }
      }).catch(() => {})
  }, [kf.id, projectName])

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
  const [refinementPrompt, setRefinementPrompt] = useState(kf.refinementPrompt || '')

  const handleGenerate = useCallback(async () => {
    if (!kf.prompt && !refinementPrompt) {
      alert('Add a prompt to this keyframe first (Details tab) or enter a refinement prompt.')
      return
    }

    try {
      const result = await generateKeyframeCandidates({
        data: { projectName, keyframeId: kf.id, count: generationCount, ...(refinementPrompt ? { refinementPrompt } : {}) },
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
  }, [projectName, kf, jobCtx, entityKey, generationCount, refinementPrompt])

  const [selectedIdx, setSelectedIdx] = useState<number | null>(() => {
    return typeof kf.selected === 'number' ? kf.selected : null
  })
  // Sync selectedIdx when kf data refreshes (e.g. after router.invalidate)
  useEffect(() => {
    if (typeof kf.selected === 'number') setSelectedIdx(kf.selected)
  }, [kf.id, kf.selected])
  const [selecting, setSelecting] = useState(false)
  const [showModal, setShowModal] = useState(false)

  const handleSelect = useCallback(async (variantNum: number) => {
    // Toggle: clicking the already-selected variant unselects it
    if (selectedIdx === variantNum) {
      setSelectedIdx(null)
      kf.selected = null
      kf.hasSelectedImage = false
      invalidateEntry(`kf:${kf.id}`)
      onDataChange()
      return
    }
    console.log(`[KeyframePanel] selecting ${kf.id} variant ${variantNum}`)
    setSelecting(true)
    try {
      await selectKeyframes({
        data: { projectName, selections: { [kf.id]: variantNum } },
      })
      console.log(`[KeyframePanel] selected ${kf.id} v${variantNum} OK`)
      setSelectedIdx(variantNum)
      kf.selected = variantNum
      // Invalidate frame cache and re-preload so preview + video track update
      invalidateEntry(`kf:${kf.id}`)
      preloadKeyframeImage(`kf:${kf.id}`, beatlabFileUrl(projectName, `selected_keyframes/${kf.id}.png`) + `?v=${variantNum}`)
      kf.hasSelectedImage = true
      autoSave(projectName, `Selected ${kf.id} candidate v${variantNum}`)
      onDataChange()
    } catch (e) {
      console.error(`[KeyframePanel] select failed:`, e)
    } finally {
      setSelecting(false)
    }
  }, [projectName, kf, selectedIdx, onDataChange])

  // Extract variant number from path like ".../v1.png" or ".../styled_003.png"
  function variantLabel(path: string): string {
    const match = path.match(/v(\d+)\.png$/)
    if (match) return `v${match[1]}`
    const styledMatch = path.match(/styled_([^/]+)\.png$/)
    if (styledMatch) return styledMatch[1]
    return path.split('/').pop() || path
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

      {/* Refinement prompt — generates from selected image instead of base still */}
      <div className="space-y-1">
        <textarea
          ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
          value={refinementPrompt}
          onChange={(e) => { setRefinementPrompt(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px' }}
          onBlur={async () => {
            const { postUpdateKeyframeStyle } = await import('@/lib/beatlab-client')
            postUpdateKeyframeStyle(projectName, kf.id, { refinementPrompt } as never)
          }}
          placeholder="Refinement prompt (optional) — generates from selected image..."
          className="w-full bg-gray-800 text-[11px] text-gray-400 rounded p-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none resize-none overflow-hidden leading-relaxed"
          rows={1}
        />
        {refinementPrompt && (
          <button
            onClick={async () => {
              try {
                setEnhancing(true)
                const result = await enhanceKeyframePrompt({ data: { projectName, keyframeId: kf.id, prompt: refinementPrompt, sectionContent: sectionContent || '', nearestEvent: nearestEvent || undefined } })
                if (result.enhanced) {
                  setRefinementPrompt(result.enhanced)
                  const { postUpdateKeyframeStyle } = await import('@/lib/beatlab-client')
                  postUpdateKeyframeStyle(projectName, kf.id, { refinementPrompt: result.enhanced } as never)
                }
              } catch (e) { alert(`Enhance failed: ${e}`) } finally { setEnhancing(false) }
            }}
            disabled={enhancing}
            className="text-[10px] text-blue-400/70 hover:text-blue-300 disabled:text-gray-600 transition-colors"
          >
            {enhancing ? 'Enhancing...' : 'Enhance refinement prompt'}
          </button>
        )}
      </div>

      <button
        onClick={handleGenerate}
        disabled={generating}
        className="w-full text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2 rounded transition-colors"
        title="Generate image candidates from the selected keyframe image"
      >
        {generating ? 'Generating with Imagen...' : refinementPrompt ? 'Refine Selected Image' : candidates.length > 0 ? 'Generate More' : 'Generate Candidates'}
      </button>

      <button
        onClick={async () => {
          if (!kf.prompt) { alert('Add a prompt first (Details tab).'); return }
          try {
            const result = await generateKeyframeCandidates({
              data: { projectName, keyframeId: kf.id, count: generationCount, freeform: true },
            })
            if (result.jobId) jobCtx.startJob(entityKey, result.jobId)
          } catch (e) { alert(`Freeform failed: ${e}`) }
        }}
        disabled={generating || !kf.prompt}
        className="w-full text-xs bg-green-700 hover:bg-green-600 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2 rounded transition-colors"
        title="Generate from prompt only, without using a base image"
      >
        {generating ? 'Generating...' : 'Freeform Generate (no base image)'}
      </button>

      <button
        onClick={async () => {
          try {
            const result = await generateKeyframeVariations({ data: { projectName, keyframeId: kf.id, count: generationCount } })
            if (result.jobId) jobCtx.startJob(entityKey, result.jobId)
          } catch (e) { alert(`Variations failed: ${e}`) }
        }}
        disabled={generating}
        className="w-full text-xs bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2 rounded transition-colors"
        title="Generate variations with AI-generated prompts"
      >
        {generating ? 'Generating...' : 'Generate Variations (AI prompts)'}
      </button>

      <button
        onClick={async () => {
          try {
            const result = await escalateKeyframe({ data: { projectName, keyframeId: kf.id, count: generationCount } })
            if (result.jobId) jobCtx.startJob(entityKey, result.jobId)
          } catch (e) { alert(`Escalate failed: ${e}`) }
        }}
        disabled={generating}
        className="w-full text-xs bg-orange-600 hover:bg-orange-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2 rounded transition-colors"
        title="Intensify the current image — push colors, contrast, drama to the extreme"
      >
        {generating ? 'Generating...' : 'Escalate (Intensify)'}
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
            title="View candidates in expanded grid"
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
          {[...candidates].sort((a, b) => {
            const na = parseInt(a.match(/v(\d+)\./)?.[1] || '0', 10)
            const nb = parseInt(b.match(/v(\d+)\./)?.[1] || '0', 10)
            return na - nb
          }).map((candidatePath) => {
            const vMatch = candidatePath.match(/v(\d+)\./)
            const variantNum = vMatch ? parseInt(vMatch[1], 10) : 0
            const selected = selectedIdx === variantNum
            // Convert .beatlab_work/project/path to beatlab API file URL
            const parts = candidatePath.split('/')
            const projectIdx = parts.indexOf('.beatlab_work')
            const relativePath = projectIdx >= 0 ? parts.slice(projectIdx + 2).join('/') : candidatePath
            const imgUrl = beatlabFileUrl(projectName, relativePath)

            return (
              <div
                key={candidatePath}
                className={`relative rounded overflow-hidden border-2 transition-colors group ${selected ? 'border-blue-500' : 'border-transparent hover:border-gray-600'} ${selecting ? 'opacity-50 pointer-events-none' : ''}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-beatlab-pool-path', relativePath)
                  e.dataTransfer.effectAllowed = 'copy'
                  const preview = e.currentTarget.cloneNode(true) as HTMLElement
                  preview.style.width = '120px'; preview.style.height = '68px'; preview.style.opacity = '0.85'
                  preview.style.borderRadius = '4px'; preview.style.overflow = 'hidden'
                  preview.style.position = 'absolute'; preview.style.top = '-9999px'
                  document.body.appendChild(preview)
                  e.dataTransfer.setDragImage(preview, -12, -8)
                  requestAnimationFrame(() => document.body.removeChild(preview))
                }}
              >
                <img
                  src={imgUrl}
                  alt={variantLabel(candidatePath)}
                  className="w-full aspect-video object-cover cursor-pointer"
                  loading="lazy"
                  onClick={(e) => { e.stopPropagation(); handleSelect(variantNum) }}
                  draggable={false}
                />
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-300 font-mono">
                      {variantLabel(candidatePath)}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          const url = `${import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'}/api/projects/${encodeURIComponent(projectName)}/save-as-still`
                          const res = await fetch(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sourcePath: relativePath }),
                          })
                          if (res.ok) {
                            const data = await res.json()
                            alert(`Saved as still: ${data.name}`)
                          }
                        }}
                        className="text-[8px] text-green-400/60 hover:text-green-400 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Save as reusable still for future generations"
                      >
                        still
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          const url = `${import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'}/api/projects/${encodeURIComponent(projectName)}/bench/add`
                          await fetch(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'keyframe', sourcePath: relativePath }),
                          })
                        }}
                        className="text-[8px] text-cyan-400/60 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Add to bench"
                      >
                        bench
                      </button>
                      {selected && (
                        <span className="text-[9px] bg-blue-500 text-white px-1 rounded">
                          selected
                        </span>
                      )}
                    </div>
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

function BrowseTab({ kf, projectName, onDataChange }: { kf: KeyframeWithTime; projectName: string; onDataChange: () => void }) {
  const [poolKeyframes, setPoolKeyframes] = useState<PoolEntry[]>([])
  const [binEntries, setBinEntries] = useState<BinEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [assigning, setAssigning] = useState(false)

  useEffect(() => {
    Promise.all([
      fetchPool(projectName).catch(() => ({ keyframes: [], segments: [] })),
      fetchBin(projectName).catch(() => ({ bin: [], transitionBin: [] })),
    ]).then(([poolData, binData]) => {
      setPoolKeyframes(poolData.keyframes || [])
      setBinEntries((binData.bin || []).filter((e: BinEntry) => e.hasSelectedImage))
    }).finally(() => setLoading(false))
  }, [projectName])

  const handleAssign = useCallback(async (stillName: string) => {
    setAssigning(true)
    try {
      const { postSetBaseImage } = await import('@/lib/beatlab-client')
      await postSetBaseImage(projectName, kf.id, stillName)
      kf.hasSelectedImage = true
      invalidateEntry(`kf:${kf.id}`)
      onDataChange()
    } catch (e) {
      console.error('Assign failed:', e)
      alert(`Assign failed: ${e}`)
    } finally {
      setAssigning(false)
    }
  }, [projectName, kf, onDataChange])

  if (loading) return <div className="p-4 text-center text-sm text-gray-600">Loading...</div>

  return (
    <div className="p-2 space-y-3">
      {/* Pool keyframes */}
      {poolKeyframes.length > 0 && (
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
            Pool ({poolKeyframes.length})
          </div>
          <div className="grid grid-cols-2 gap-1">
            {poolKeyframes.map((entry) => (
              <div
                key={entry.path}
                className={`relative rounded overflow-hidden border-2 border-transparent hover:border-blue-500 transition-colors group ${assigning ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}
                onClick={() => handleAssign(entry.name)}
              >
                <img
                  src={beatlabFileUrl(projectName, entry.path)}
                  alt={entry.name}
                  className="w-full aspect-video object-cover"
                  loading="lazy"
                  draggable={false}
                />
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
                  <div className="text-[10px] text-gray-300 truncate">{entry.name}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Binned keyframes with images */}
      {binEntries.length > 0 && (
        <div>
          <div className="text-[10px] text-red-400/60 uppercase tracking-wider mb-1">
            Deleted Keyframes ({binEntries.length})
          </div>
          <div className="grid grid-cols-2 gap-1">
            {binEntries.map((entry) => (
              <div
                key={entry.id}
                className={`relative rounded overflow-hidden border-2 border-transparent hover:border-blue-500 transition-colors group ${assigning ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}
                onClick={() => handleAssign(`${entry.id}.png`)}
              >
                <img
                  src={beatlabFileUrl(projectName, `selected_keyframes/${entry.id}.png`)}
                  alt={entry.id}
                  className="w-full aspect-video object-cover"
                  loading="lazy"
                  draggable={false}
                />
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
                  <div className="text-[10px] text-gray-300 truncate">{entry.id} @ {entry.timestamp}</div>
                  {entry.prompt && <div className="text-[9px] text-gray-500 truncate">{entry.prompt}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {poolKeyframes.length === 0 && binEntries.length === 0 && (
        <div className="p-4 text-center text-sm text-gray-600">No images available</div>
      )}
    </div>
  )
}

function BenchTab({ kf, projectName, onDataChange }: { kf: KeyframeWithTime; projectName: string; onDataChange: () => void }) {
  const [items, setItems] = useState<import('@/lib/beatlab-client').BenchItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    import('@/lib/beatlab-client').then(({ fetchBench }) =>
      fetchBench(projectName).then((all) => {
        setItems(all.filter((b) => b.type === 'keyframe'))
        setLoading(false)
      })
    ).catch(() => setLoading(false))
  }, [projectName])

  const handleBenchCurrent = useCallback(async () => {
    const { postAddToBench, fetchBench } = await import('@/lib/beatlab-client')
    await postAddToBench(projectName, 'keyframe', kf.id)
    const all = await fetchBench(projectName)
    setItems(all.filter((b) => b.type === 'keyframe'))
  }, [projectName, kf.id])

  const handleApply = useCallback(async (benchItem: import('@/lib/beatlab-client').BenchItem) => {
    // Copy the benched image as this keyframe's selected image
    const { postSetBaseImage } = await import('@/lib/beatlab-client')
    // The bench sourcePath is relative to the project — extract the still name or use assign
    // Use set-base-image if it's a still, otherwise we need a different approach
    // For benched keyframes, sourcePath is like "selected_keyframes/kf_XXX.png"
    const fileName = benchItem.sourcePath.split('/').pop() || ''
    await postSetBaseImage(projectName, kf.id, fileName)
    kf.hasSelectedImage = true
    invalidateEntry(`kf:${kf.id}`)
    onDataChange()
  }, [projectName, kf, onDataChange])

  const handleRemove = useCallback(async (benchId: string) => {
    const { postRemoveFromBench } = await import('@/lib/beatlab-client')
    await postRemoveFromBench(projectName, benchId)
    setItems((prev) => prev.filter((b) => b.id !== benchId))
  }, [projectName])

  if (loading) return <div className="p-4 text-center text-sm text-gray-600">Loading...</div>

  return (
    <div className="p-2 space-y-2">
      <button
        onClick={handleBenchCurrent}
        disabled={!kf.hasSelectedImage}
        className="w-full text-xs bg-green-700 hover:bg-green-600 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2 rounded transition-colors"
        title="Save the current keyframe image to the bench for reuse"
      >
        Bench Current Keyframe
      </button>

      {items.length === 0 ? (
        <div className="text-center text-sm text-gray-600 py-4">No keyframes in bench</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {items.map((item) => (
            <div key={item.id} className="relative rounded overflow-hidden border-2 border-transparent hover:border-green-500 transition-colors group">
              <img
                src={beatlabFileUrl(projectName, item.sourcePath)}
                alt={item.label || item.id}
                className="w-full aspect-video object-cover cursor-pointer"
                loading="lazy"
                onClick={() => handleApply(item)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-beatlab-pool-path', item.sourcePath)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
              />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
                <div className="text-[10px] text-gray-300 truncate">{item.label || item.sourcePath.split('/').pop()}</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); handleRemove(item.id) }}
                className="absolute top-1 right-1 text-red-400/60 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 rounded px-1"
                title="Remove from bench"
              >
                &times;
              </button>
            </div>
          ))}
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
