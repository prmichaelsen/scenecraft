import { useState, useCallback, useEffect } from 'react'
import { StillPicker } from './KeyframePanel'
import { beatlabFileUrl, type AudioEvent, type AudioDescription, fetchSectionSettings, postSectionSettings } from '@/lib/beatlab-client'
import {
  suggestKeyframePrompts,
  addKeyframe,
  setBaseImage,
  generateKeyframeCandidates,
  deleteKeyframe,
  selectKeyframes,
  secondsToTimestamp,
} from '@/routes/project/$name/editor'
import { useJobState, useJobContext } from '@/contexts/JobStateContext'

type EventSuggestion = {
  eventIndex: number
  event: AudioEvent
  prompt: string
  keyframeId: string | null
  candidates: string[]
  selectedCandidate: number | null
  status: 'prompt-only' | 'creating' | 'generating' | 'candidates-ready' | 'inserted' | 'discarded'
}

type Props = {
  section: AudioDescription
  audioEvents: AudioEvent[]
  projectName: string
  onKeyframeInserted: () => void
}

const STEM_DOT_COLORS: Record<string, string> = {
  kick: 'bg-red-400',
  snare: 'bg-blue-400',
  hh: 'bg-gray-400',
  crash: 'bg-yellow-400',
  ride: 'bg-green-400',
  bass: 'bg-orange-400',
  vocals: 'bg-purple-400',
}

export function KeyframeSuggestPanel({ section, audioEvents, projectName, onKeyframeInserted }: Props) {
  const [selectedStill, setSelectedStill] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<EventSuggestion[]>([])
  const [generatingPrompts, setGeneratingPrompts] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Load persisted settings on mount
  useEffect(() => {
    fetchSectionSettings(projectName, section.label).then((settings) => {
      if (settings.still) setSelectedStill(settings.still)
      if (settings.suggestions && settings.suggestions.length > 0) {
        setSuggestions(
          settings.suggestions.map((r) => ({
            eventIndex: r.eventIndex,
            event: audioEvents[r.eventIndex],
            prompt: r.prompt,
            keyframeId: null,
            candidates: [],
            selectedCandidate: null,
            status: 'prompt-only' as const,
          }))
        )
      }
    }).finally(() => setLoaded(true))
  }, [projectName, section.label])

  // Persist still selection
  const handleStillSelect = useCallback((stillName: string) => {
    setSelectedStill(stillName)
    postSectionSettings(projectName, section.label, { still: stillName }).catch(() => {})
  }, [projectName, section.label])

  const updateSuggestion = useCallback((index: number, updates: Partial<EventSuggestion>) => {
    setSuggestions((prev) => prev.map((s, i) => (i === index ? { ...s, ...updates } : s)))
  }, [])

  const handleGeneratePrompts = useCallback(async () => {
    if (!selectedStill) return
    setGeneratingPrompts(true)
    setError(null)
    try {
      const result = await suggestKeyframePrompts({
        data: {
          projectName,
          sectionLabel: section.label,
          sectionContent: section.content,
          events: audioEvents.map((ev) => ({
            time: ev.time,
            effect: ev.effect,
            intensity: ev.intensity,
            stem_source: ev.stem_source,
          })),
          baseStillName: selectedStill,
        },
      })
      setSuggestions(
        result.suggestions.map((r) => ({
          eventIndex: r.eventIndex,
          event: audioEvents[r.eventIndex],
          prompt: r.prompt,
          keyframeId: null,
          candidates: [],
          selectedCandidate: null,
          status: 'prompt-only' as const,
        }))
      )
    } catch (e) {
      setError(`Failed to generate prompts: ${e}`)
    } finally {
      setGeneratingPrompts(false)
    }
  }, [projectName, section, audioEvents, selectedStill])

  // Phase 1: Still selection
  if (!selectedStill) {
    return (
      <div>
        <div className="px-3 pt-3 text-[10px] text-gray-500 uppercase tracking-wider mb-1">
          Step 1: Choose Base Image
        </div>
        <StillPicker projectName={projectName} onSelect={handleStillSelect} />
      </div>
    )
  }

  // Phase 2: Generate prompts
  if (suggestions.length === 0) {
    return (
      <div className="p-3 space-y-3">
        <SelectedStillPreview
          stillName={selectedStill}
          projectName={projectName}
          onClear={() => setSelectedStill(null)}
        />
        <button
          onClick={handleGeneratePrompts}
          disabled={generatingPrompts}
          className="w-full text-xs bg-teal-600 hover:bg-teal-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2 px-3 rounded transition-colors"
        >
          {generatingPrompts
            ? 'Generating prompts...'
            : `Generate Prompts (${audioEvents.length} events)`}
        </button>
        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>
    )
  }

  // Phase 3: Show suggestions
  return (
    <div className="p-3 space-y-3">
      <SelectedStillPreview
        stillName={selectedStill}
        projectName={projectName}
        onClear={() => {
          setSelectedStill(null)
          setSuggestions([])
        }}
      />
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">
        Suggestions ({suggestions.length})
      </div>
      {suggestions.map((s, idx) => (
        <EventSuggestionRow
          key={idx}
          suggestion={s}
          projectName={projectName}
          selectedStill={selectedStill}
          sectionLabel={section.label}
          onUpdate={(updates) => updateSuggestion(idx, updates)}
          onKeyframeInserted={onKeyframeInserted}
        />
      ))}
    </div>
  )
}

function SelectedStillPreview({
  stillName,
  projectName,
  onClear,
}: {
  stillName: string
  projectName: string
  onClear: () => void
}) {
  return (
    <div className="flex items-center gap-2 bg-gray-800 rounded p-2">
      <img
        src={beatlabFileUrl(projectName, `assets/stills/${stillName}`)}
        alt={stillName}
        className="w-12 h-8 object-cover rounded"
      />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Base Image</div>
        <div className="text-xs text-gray-300 truncate">{stillName.replace(/\.\w+$/, '')}</div>
      </div>
      <button
        onClick={onClear}
        className="text-gray-500 hover:text-gray-300 text-sm"
        title="Change base image"
      >
        &times;
      </button>
    </div>
  )
}

function EventSuggestionRow({
  suggestion: s,
  projectName,
  selectedStill,
  sectionLabel,
  onUpdate,
  onKeyframeInserted,
}: {
  suggestion: EventSuggestion
  projectName: string
  selectedStill: string
  sectionLabel: string
  onUpdate: (updates: Partial<EventSuggestion>) => void
  onKeyframeInserted: () => void
}) {
  const jobCtx = useJobContext()
  const entityKey = s.keyframeId ? `suggest:${s.keyframeId}:candidates` : ''
  const job = useJobState(entityKey || '__none__')
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [promptDraft, setPromptDraft] = useState(s.prompt)

  // Handle job completion or failure
  useEffect(() => {
    if (job?.status === 'completed' && job.result) {
      const res = job.result as { candidates?: string[] }
      if (res?.candidates) {
        onUpdate({ candidates: res.candidates, status: 'candidates-ready' })
      }
      jobCtx.consumeResult(entityKey)
    } else if (job?.status === 'failed') {
      onUpdate({ status: 'prompt-only' })
      jobCtx.consumeResult(entityKey)
    }
  }, [job?.status, job?.result, entityKey, jobCtx, onUpdate])

  const handleGenerate = useCallback(async () => {
    onUpdate({ status: 'creating' })
    try {
      const ts = secondsToTimestamp(s.event.time)
      const kfResult = await addKeyframe({
        data: { projectName, timestamp: ts, section: sectionLabel, prompt: s.prompt },
      })
      const keyframeId = kfResult.keyframe?.id || kfResult.keyframeId || kfResult.id
      onUpdate({ keyframeId, status: 'generating' })

      await setBaseImage({ data: { projectName, keyframeId, stillName: selectedStill } })

      const genResult = await generateKeyframeCandidates({
        data: { projectName, keyframeId, count: 1 },
      })
      if (genResult.jobId) {
        jobCtx.startJob(`suggest:${keyframeId}:candidates`, genResult.jobId)
      } else if (genResult.candidates) {
        onUpdate({ candidates: genResult.candidates, status: 'candidates-ready' })
      }
    } catch (e) {
      onUpdate({ status: 'prompt-only' })
      alert(`Generation failed: ${e}`)
    }
  }, [s.event.time, s.prompt, projectName, sectionLabel, selectedStill, jobCtx, onUpdate])

  const handleKeep = useCallback(
    async (variantNum: number) => {
      if (!s.keyframeId) return
      try {
        await selectKeyframes({ data: { projectName, selections: { [s.keyframeId]: variantNum } } })
        onUpdate({ status: 'inserted', selectedCandidate: variantNum })
        onKeyframeInserted()
      } catch (e) {
        alert(`Select failed: ${e}`)
      }
    },
    [s.keyframeId, projectName, onUpdate, onKeyframeInserted]
  )

  const handleDiscard = useCallback(async () => {
    if (s.keyframeId) {
      try {
        await deleteKeyframe({ data: { projectName, keyframeId: s.keyframeId } })
      } catch {}
    }
    onUpdate({ status: 'discarded', keyframeId: null, candidates: [], selectedCandidate: null })
  }, [s.keyframeId, projectName, onUpdate])

  if (s.status === 'discarded') return null
  if (s.status === 'inserted') {
    return (
      <div className="bg-teal-900/20 border border-teal-800/30 rounded p-2">
        <div className="flex items-center gap-2 text-xs text-teal-400">
          <div className={`w-2 h-2 rounded-full shrink-0 ${STEM_DOT_COLORS[s.event.stem_source] || 'bg-gray-500'}`} />
          <span className="font-mono">{s.event.time.toFixed(2)}s</span>
          <span className="text-teal-300">Inserted</span>
        </div>
      </div>
    )
  }

  const generating = s.status === 'creating' || s.status === 'generating'
  const jobProgress = job?.status === 'in_progress' ? job.detail : ''

  return (
    <div className="bg-gray-800/50 border border-gray-700/50 rounded p-2 space-y-2">
      {/* Event header */}
      <div className="flex items-center gap-2 text-xs">
        <div className={`w-2 h-2 rounded-full shrink-0 ${STEM_DOT_COLORS[s.event.stem_source] || 'bg-gray-500'}`} />
        <span className="font-mono text-gray-500">{s.event.time.toFixed(2)}s</span>
        <span className="text-gray-400">
          {s.event.stem_source}/{s.event.effect}
        </span>
        <span className="ml-auto text-gray-500">{(s.event.intensity * 100).toFixed(0)}%</span>
      </div>

      {/* Prompt */}
      {editingPrompt ? (
        <div className="space-y-1">
          <textarea
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            className="w-full text-xs bg-gray-900 text-gray-300 border border-gray-700 rounded p-1.5 resize-none"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                onUpdate({ prompt: promptDraft })
                setEditingPrompt(false)
              }
              if (e.key === 'Escape') {
                setPromptDraft(s.prompt)
                setEditingPrompt(false)
              }
            }}
          />
          <div className="flex gap-1">
            <button
              onClick={() => {
                onUpdate({ prompt: promptDraft })
                setEditingPrompt(false)
              }}
              className="text-[10px] text-teal-400 hover:text-teal-300"
            >
              Save
            </button>
            <button
              onClick={() => {
                setPromptDraft(s.prompt)
                setEditingPrompt(false)
              }}
              className="text-[10px] text-gray-500 hover:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div
          className="text-xs text-gray-300 cursor-pointer hover:text-gray-100 transition-colors"
          onClick={() => setEditingPrompt(true)}
          title="Click to edit prompt"
        >
          {s.prompt}
        </div>
      )}

      {/* Actions */}
      {s.status === 'prompt-only' && (
        <button
          onClick={handleGenerate}
          className="w-full text-[10px] bg-teal-700 hover:bg-teal-600 text-white py-1.5 rounded transition-colors"
        >
          Generate Candidates
        </button>
      )}

      {generating && (
        <div className="text-[10px] text-gray-500 animate-pulse">
          {s.status === 'creating' ? 'Creating keyframe...' : `Generating... ${jobProgress}`}
        </div>
      )}

      {/* Candidates grid */}
      {s.status === 'candidates-ready' && s.candidates.length > 0 && (
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-1">
            {s.candidates.map((path, ci) => {
              const variantNum = ci + 1
              return (
                <button
                  key={ci}
                  onClick={() => handleKeep(variantNum)}
                  className="relative rounded overflow-hidden border-2 border-transparent hover:border-teal-500 transition-colors"
                  title={`Keep variant ${variantNum}`}
                >
                  <img
                    src={beatlabFileUrl(projectName, path)}
                    alt={`v${variantNum}`}
                    className="w-full aspect-video object-cover"
                  />
                  <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5">
                    <span className="text-[8px] text-gray-300">v{variantNum}</span>
                  </div>
                </button>
              )
            })}
          </div>
          <button
            onClick={handleDiscard}
            className="w-full text-[10px] text-gray-500 hover:text-red-400 py-1 transition-colors"
          >
            Discard
          </button>
        </div>
      )}
    </div>
  )
}
