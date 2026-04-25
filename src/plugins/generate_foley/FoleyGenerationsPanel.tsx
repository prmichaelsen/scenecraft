import { useState, useEffect, useCallback, useMemo, type DragEvent } from 'react'
import { useEditorState } from '@/components/editor/EditorStateContext'
import { useCurrentTime } from '@/components/editor/CurrentTimeContext'
import {
  runFoleyGeneration,
  fetchFoleyGenerations,
  retryFoleyGeneration,
  subscribeFoleyJob,
} from './generate-foley-client'
import type {
  FoleyMode,
  GenerateFoleyRequest,
  GenerationListItem,
} from './types'

const DURATION_PRESETS = [
  { label: 'Burst', value: 2, description: '~0.5–2s — single event (gunshot, slam, break)' },
  { label: 'Sequence', value: 8, description: '~2–8s — short phrase (footsteps, crowd)' },
  { label: 'Ambience', value: 30, description: '~8–30s — continuous bed (rain, wind, traffic)' },
] as const

type DurationPreset = typeof DURATION_PRESETS[number]['label'] | 'Custom'

export function FoleyGenerationsPanel() {
  const { selectedTransition, selectedAudioClipId, projectName } = useEditorState()
  const { currentTime } = useCurrentTime()

  // Derive selected candidate (first tr_candidate for the transition)
  const selectedCandidate = selectedTransition?.candidates?.[0] ?? null

  // Mode inference
  const mode: FoleyMode = selectedTransition && selectedCandidate ? 'v2fx' : 't2fx'
  const showAmbiguityBanner = !!selectedTransition && !selectedCandidate

  // Form state
  const [prompt, setPrompt] = useState('')
  const [durationPreset, setDurationPreset] = useState<DurationPreset>('Burst')
  const [durationSlider, setDurationSlider] = useState(2)
  const [inSeconds, setInSeconds] = useState<number | null>(null)
  const [outSeconds, setOutSeconds] = useState<number | null>(null)
  const [negativePrompt, setNegativePrompt] = useState('music')
  const [cfgStrength, setCfgStrength] = useState(4.5)
  const [seed, setSeed] = useState<string>('')
  const [generating, setGenerating] = useState(false)

  // Run history
  const [generations, setGenerations] = useState<GenerationListItem[]>([])
  const [loadingGenerations, setLoadingGenerations] = useState(false)

  // Clear in/out when selection changes
  useEffect(() => {
    setInSeconds(null)
    setOutSeconds(null)
  }, [selectedTransition?.id, selectedCandidate?.id])

  // Fetch generations on mount + selection change
  const fetchGenerations = useCallback(async () => {
    if (!projectName) return
    setLoadingGenerations(true)
    try {
      const { generations } = await fetchFoleyGenerations(projectName, {
        entityType: selectedTransition ? 'transition' : undefined,
        entityId: selectedTransition?.id,
        limit: 50,
      })
      setGenerations(generations)
    } catch {
      // silent fail
    } finally {
      setLoadingGenerations(false)
    }
  }, [projectName, selectedTransition?.id])

  useEffect(() => { fetchGenerations() }, [fetchGenerations])

  // Duration from preset
  useEffect(() => {
    const preset = DURATION_PRESETS.find((p) => p.label === durationPreset)
    if (preset) setDurationSlider(preset.value)
  }, [durationPreset])

  // In/out handlers with most-recent-click-wins rule
  const handleSetIn = () => {
    const t = currentTime
    if (outSeconds !== null && outSeconds <= t) {
      setOutSeconds(null)
    }
    setInSeconds(t)
  }

  const handleSetOut = () => {
    const t = currentTime
    if (inSeconds !== null && inSeconds >= t) {
      setInSeconds(null)
    }
    setOutSeconds(t)
  }

  const handleClear = () => {
    setInSeconds(null)
    setOutSeconds(null)
  }

  // Range derived duration for v2fx
  const rangeDuration = inSeconds !== null && outSeconds !== null
    ? Math.round((outSeconds - inSeconds) * 100) / 100
    : null

  // Generate button gating
  const canGenerate = mode === 't2fx'
    || (mode === 'v2fx' && inSeconds !== null && outSeconds !== null
        && outSeconds > inSeconds && (outSeconds - inSeconds) <= 30)

  const generateDisabledReason = (() => {
    if (mode === 'v2fx') {
      if (inSeconds === null) return 'Set in-point'
      if (outSeconds === null) return 'Set out-point'
      if (outSeconds <= inSeconds) return 'Out must be > In'
      if ((outSeconds - inSeconds) > 30) return 'Range exceeds 30s limit'
    }
    return null
  })()

  // Generate
  const handleGenerate = async () => {
    if (!projectName || !canGenerate) return
    setGenerating(true)
    try {
      const request: GenerateFoleyRequest = {
        prompt: prompt || undefined,
        negative_prompt: negativePrompt || undefined,
        cfg_strength: cfgStrength,
        seed: seed ? parseInt(seed, 10) : undefined,
        count: 1,
      }

      if (mode === 't2fx') {
        request.duration_seconds = durationSlider
      } else {
        request.source_candidate_id = selectedCandidate!.id
        request.source_in_seconds = inSeconds!
        request.source_out_seconds = outSeconds!
        request.entity_type = 'transition'
        request.entity_id = selectedTransition!.id
      }

      const result = await runFoleyGeneration(projectName, request)
      if (result.error) {
        console.error('Foley generation error:', result.error)
        return
      }

      // Subscribe to job events for live status updates
      const unsub = subscribeFoleyJob(projectName, result.job_id, (event) => {
        if (event.type === 'job_completed' || event.type === 'job_failed') {
          fetchGenerations()
          unsub()
        }
      })

      // Optimistic: add pending generation to list
      fetchGenerations()
    } catch (err) {
      console.error('Failed to generate foley:', err)
    } finally {
      setGenerating(false)
    }
  }

  // Retry
  const handleRetry = async (generationId: string) => {
    if (!projectName) return
    try {
      const result = await retryFoleyGeneration(projectName, generationId)
      if (!result.error) {
        const unsub = subscribeFoleyJob(projectName, result.job_id, (event) => {
          if (event.type === 'job_completed' || event.type === 'job_failed') {
            fetchGenerations()
            unsub()
          }
        })
      }
      fetchGenerations()
    } catch (err) {
      console.error('Retry failed:', err)
    }
  }

  // Drag handler for completed pool_segments
  const handleDragStart = (e: DragEvent, poolSegmentId: string, poolPath: string, durationSec: number) => {
    e.dataTransfer.setData(
      'application/x-scenecraft-stem',
      JSON.stringify({
        pool_segment_id: poolSegmentId,
        pool_path: poolPath,
        stem_type: 'foley',
        variant_kind: 'foley',
        duration_seconds: durationSec,
      }),
    )
    e.dataTransfer.effectAllowed = 'copy'
  }

  const formatTime = (s: number) => {
    const min = Math.floor(s / 60)
    const sec = s % 60
    return `${min}:${sec.toFixed(1).padStart(4, '0')}`
  }

  return (
    <div className="flex flex-col h-full bg-gray-950 text-gray-200 text-sm overflow-y-auto">
      <div className="p-3 border-b border-gray-800">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Foley Generator
          <span className="ml-2 text-[10px] font-normal normal-case text-gray-600">
            {mode === 'v2fx' ? 'Video-conditioned' : 'Text-only'}
          </span>
        </div>

        {/* Ambiguity banner */}
        {showAmbiguityBanner && (
          <div className="mb-3 p-2 rounded bg-yellow-900/30 border border-yellow-700/50 text-yellow-200 text-xs">
            Transition selected but has no candidate. Generating text-only foley to the pool.
          </div>
        )}

        {/* Prompt */}
        <div className="mb-3">
          <textarea
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-orange-500/60"
            rows={2}
            placeholder={mode === 'v2fx'
              ? '(optional) describe the sound to steer the model'
              : 'footsteps on gravel, door slam, glass breaking...'}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        {/* Duration (t2fx only) */}
        {mode === 't2fx' && (
          <div className="mb-3">
            <div className="flex gap-1 mb-1.5">
              {DURATION_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={`text-[10px] px-2 py-1 rounded transition-colors ${
                    durationPreset === p.label
                      ? 'bg-orange-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                  }`}
                  title={p.description}
                  onClick={() => setDurationPreset(p.label)}
                >
                  {p.label} ({p.value}s)
                </button>
              ))}
              <button
                className={`text-[10px] px-2 py-1 rounded transition-colors ${
                  durationPreset === 'Custom'
                    ? 'bg-orange-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
                onClick={() => setDurationPreset('Custom')}
              >
                Custom
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={30}
                step={0.5}
                value={durationSlider}
                onChange={(e) => {
                  setDurationSlider(parseFloat(e.target.value))
                  setDurationPreset('Custom')
                }}
                className="flex-1 accent-orange-500"
              />
              <span className="text-[10px] text-gray-500 w-8 text-right">{durationSlider}s</span>
            </div>
          </div>
        )}

        {/* In/Out range (v2fx only) */}
        {mode === 'v2fx' && (
          <div className="mb-3 p-2 rounded bg-gray-900 border border-gray-800">
            <div className="text-[10px] text-gray-500 mb-1.5">Source range</div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-500">In</span>
              <span className="font-mono text-orange-300">
                {inSeconds !== null ? formatTime(inSeconds) : '—'}
              </span>
              <span className="text-gray-600">→</span>
              <span className="text-gray-500">Out</span>
              <span className="font-mono text-orange-300">
                {outSeconds !== null ? formatTime(outSeconds) : '—'}
              </span>
              {rangeDuration !== null && (
                <span className="text-gray-600 ml-auto">({rangeDuration}s)</span>
              )}
            </div>
            <div className="flex gap-1.5 mt-2">
              <button
                className="text-[10px] px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors"
                onClick={handleSetIn}
              >
                Set in
              </button>
              <button
                className="text-[10px] px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors"
                onClick={handleSetOut}
              >
                Set out
              </button>
              <button
                className="text-[10px] px-2 py-1 rounded bg-gray-800 text-gray-500 hover:bg-gray-700 transition-colors"
                onClick={handleClear}
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {/* Advanced params */}
        <details className="mb-3">
          <summary className="text-[10px] text-gray-600 cursor-pointer hover:text-gray-400">
            Advanced
          </summary>
          <div className="mt-2 space-y-2">
            <div>
              <label className="text-[10px] text-gray-500">Negative prompt</label>
              <input
                type="text"
                className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500/60"
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-[10px] text-gray-500">CFG strength</label>
                <input
                  type="number"
                  step={0.5}
                  min={1}
                  max={20}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500/60"
                  value={cfgStrength}
                  onChange={(e) => setCfgStrength(parseFloat(e.target.value))}
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-gray-500">Seed</label>
                <input
                  type="text"
                  placeholder="random"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500/60"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                />
              </div>
            </div>
          </div>
        </details>

        {/* Generate button */}
        <button
          className={`w-full py-2 rounded text-xs font-semibold transition-colors ${
            canGenerate && !generating
              ? 'bg-orange-600 hover:bg-orange-500 text-white'
              : 'bg-gray-800 text-gray-600 cursor-not-allowed'
          }`}
          disabled={!canGenerate || generating}
          onClick={handleGenerate}
          title={generateDisabledReason ?? (generating ? 'Generating...' : 'Generate foley')}
        >
          {generating ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {/* Run history */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-3 pt-2">
          <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">
            Recent generations
          </div>
          {loadingGenerations && generations.length === 0 && (
            <div className="text-[10px] text-gray-600">Loading...</div>
          )}
          {!loadingGenerations && generations.length === 0 && (
            <div className="text-[10px] text-gray-600">No generations yet</div>
          )}
          {generations.map((gen) => (
            <RunCard
              key={gen.id}
              generation={gen}
              onRetry={handleRetry}
              onDragStart={handleDragStart}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// --- RunCard sub-component ------------------------------------------------

function RunCard({
  generation: gen,
  onRetry,
  onDragStart,
}: {
  generation: GenerationListItem
  onRetry: (id: string) => void
  onDragStart: (e: DragEvent, poolSegmentId: string, poolPath: string, duration: number) => void
}) {
  const statusColor = {
    pending: 'text-yellow-400',
    running: 'text-blue-400',
    completed: 'text-green-400',
    failed: 'text-red-400',
  }[gen.status]

  const statusIcon = {
    pending: '⏳',
    running: '⏳',
    completed: '✓',
    failed: '✗',
  }[gen.status]

  return (
    <div className="mb-2 p-2 rounded bg-gray-900/50 border border-gray-800 text-xs">
      <div className="flex items-center gap-2 mb-1">
        <span className={`font-mono ${statusColor}`}>{statusIcon}</span>
        <span className="text-gray-500 text-[10px]">{gen.mode}</span>
        {gen.prompt && (
          <span className="truncate text-gray-300 flex-1" title={gen.prompt}>
            {gen.prompt}
          </span>
        )}
        {!gen.prompt && <span className="text-gray-600 flex-1 italic">no prompt</span>}
      </div>

      {gen.duration_seconds != null && (
        <div className="text-[10px] text-gray-600">
          {gen.duration_seconds}s
          {gen.source_in_seconds != null && gen.source_out_seconds != null && (
            <span className="ml-2">
              [{gen.source_in_seconds.toFixed(1)}–{gen.source_out_seconds.toFixed(1)}]
            </span>
          )}
        </div>
      )}

      {gen.error && (
        <div className="mt-1 text-[10px] text-red-400/80 break-words">
          {gen.error}
        </div>
      )}

      {/* Completed: show drag handle for each track */}
      {gen.status === 'completed' && gen.tracks.map((track) => (
        <div
          key={track.pool_segment_id}
          className="mt-1.5 flex items-center gap-2 p-1.5 rounded bg-orange-900/20 border border-orange-800/40 cursor-grab active:cursor-grabbing"
          draggable
          onDragStart={(e) => onDragStart(
            e,
            track.pool_segment_id,
            track.pool_path ?? '',
            track.duration_seconds ?? 0,
          )}
          title="Drag to an audio track"
        >
          <span className="text-orange-400 text-[10px]">≡</span>
          <span className="text-orange-200 text-[10px] truncate flex-1">
            {track.pool_path?.split('/').pop() ?? track.pool_segment_id.slice(0, 8)}
          </span>
          {track.duration_seconds != null && (
            <span className="text-[10px] text-orange-400/60">{track.duration_seconds.toFixed(1)}s</span>
          )}
        </div>
      ))}

      {/* Retry button for failed + completed */}
      {(gen.status === 'failed' || gen.status === 'completed') && (
        <button
          className="mt-1.5 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
          onClick={() => onRetry(gen.id)}
        >
          Retry
        </button>
      )}
    </div>
  )
}
