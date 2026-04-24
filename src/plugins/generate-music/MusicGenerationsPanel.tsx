/**
 * MusicGenerationsPanel — form + run list for the generate-music plugin.
 *
 * UX contract from spec (agent/specs/local.music-generation-plugin.md):
 *   - All form fields always visible (R31-R33); the action radio decides
 *     which ones get serialized at send time (R13), not which render.
 *   - Context filter: when an audio_clip or transition is selected, the
 *     run list filters to that entity's runs. "Show all" escape hatch
 *     toggles the filter off. The form uses the same selection for its
 *     entity_type/entity_id by default, with a Clear-context chip to drop it.
 *   - Credits counter is always visible in the header. Out-of-credits
 *     disables the Generate button with a "contact admin" tooltip.
 *   - Reuse prefills the form with the generation's OWN entity context,
 *     not the current editor selection (spec R29-R30).
 *   - Retry calls the backend directly (no form prefill); backend copies
 *     params and sets reused_from.
 *   - Music is net-new audio (not an extraction), so track-row drags
 *     ride the pool-audio drop path — `application/x-scenecraft-pool-path`
 *     with the pool_path string — the same mime the Bin uses. Purple
 *     clip color comes from pool_segments.variant_kind='music' at render
 *     time, not from the drop payload (see src/lib/audio-clip-styling.ts).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useEditorState } from '@/components/editor/EditorStateContext'

import {
  getCredits,
  listGenerations,
  retryGeneration,
  runGeneration,
  useMusicGenerationEvents,
} from './generate-music-client'
import type {
  CreditsResponse,
  Generation,
  GenerationAction,
  GenerationGender,
  RunPayload,
} from './types'

type SelectionContext =
  | { type: 'audio_clip'; id: string }
  | { type: 'transition'; id: string }
  | null

type FormState = {
  action: GenerationAction
  style: string
  lyrics: string
  title: string
  instrumental: boolean
  gender: GenerationGender
  model: string
}

const DEFAULT_FORM: FormState = {
  action: 'auto',
  style: '',
  lyrics: '',
  title: '',
  instrumental: true,
  gender: '',
  model: 'MFV2.0',
}

/**
 * Build the REST payload, filtering fields per action (spec R13). Fields
 * that aren't part of the action's payload are omitted — not sent as
 * null — so the backend's optional-handling sees them as "not provided."
 */
export function buildPayload(form: FormState, ctx: SelectionContext): RunPayload {
  const base: RunPayload = {
    action: form.action,
    style: form.style,
    instrumental: form.instrumental ? 1 : 0,
    model: form.model,
    entity_type: ctx?.type ?? null,
    entity_id: ctx?.id ?? null,
  }
  if (form.action === 'custom') {
    if (!form.instrumental && form.lyrics.trim()) {
      base.lyrics = form.lyrics
    }
    if (form.title.trim()) base.title = form.title
    if (form.gender) base.gender = form.gender
  } else {
    // action === 'auto' — lyrics + title are never sent; gender may be.
    if (form.gender) base.gender = form.gender
  }
  return base
}

function describeContext(ctx: SelectionContext): string {
  if (!ctx) return ''
  return ctx.type === 'audio_clip' ? `clip ${ctx.id}` : `transition ${ctx.id}`
}

type PanelProps = {
  projectName?: string
}

export function MusicGenerationsPanel({ projectName }: PanelProps) {
  // ── Selection context (editor state) ────────────────────────────────
  const { selectedAudioClipId, selectedTransition } = useEditorState()
  const editorContext: SelectionContext = useMemo(() => {
    if (selectedAudioClipId) return { type: 'audio_clip', id: selectedAudioClipId }
    if (selectedTransition?.id) return { type: 'transition', id: selectedTransition.id }
    return null
  }, [selectedAudioClipId, selectedTransition])

  // Override lets Reuse drop the current editor context in favor of the
  // generation's own entity binding. null means "no context"; undefined
  // means "defer to editor". The three states matter for `Clear context`.
  const [contextOverride, setContextOverride] = useState<SelectionContext | undefined>(undefined)
  const activeContext: SelectionContext = contextOverride !== undefined ? contextOverride : editorContext

  const [showAll, setShowAll] = useState(false)
  const filter: SelectionContext = showAll ? null : activeContext

  // ── Data ────────────────────────────────────────────────────────────
  const [generations, setGenerations] = useState<Generation[]>([])
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    if (!projectName) return
    setLoading(true)
    setError(null)
    try {
      const filterArg =
        filter?.type && filter?.id ? { entityType: filter.type, entityId: filter.id } : undefined
      const [gens, cr] = await Promise.all([
        listGenerations(projectName, filterArg),
        getCredits(projectName),
      ])
      setGenerations(gens)
      setCredits(cr)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [projectName, filter?.type, filter?.id])

  useEffect(() => { void refetch() }, [refetch])

  useMusicGenerationEvents(projectName || '', useCallback(() => {
    void refetch()
  }, [refetch]))

  // ── Form ────────────────────────────────────────────────────────────
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const outOfCredits = credits?.credits != null && credits.credits <= 0
  const canSubmit = !submitting && !outOfCredits && form.style.trim().length > 0

  async function onGenerate() {
    if (!projectName || !canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await runGeneration(projectName, buildPayload(form, activeContext))
      void refetch()
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  function onReuse(gen: Generation) {
    // Per spec R29-R30: Reuse adopts the generation's OWN entity context,
    // not the current editor selection. Explicit override (including null
    // if the original had no context) takes precedence over editor state.
    const reuseCtx: SelectionContext =
      gen.entity_type && gen.entity_id ? { type: gen.entity_type, id: gen.entity_id } : null
    setContextOverride(reuseCtx)
    setForm({
      action: gen.action,
      style: gen.style ?? '',
      lyrics: gen.lyrics ?? '',
      title: gen.title ?? '',
      instrumental: gen.instrumental === 1,
      gender: gen.gender ?? '',
      model: gen.model,
    })
  }

  async function onRetry(gen: Generation) {
    if (!projectName) return
    try {
      await retryGeneration(projectName, gen.id)
      void refetch()
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!projectName) {
    return <div className="p-3 text-xs text-gray-500">No project loaded.</div>
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col text-xs text-gray-200">
      <PanelHeader credits={credits} filter={filter} />

      <div className="border-b border-gray-700 p-3 space-y-2">
        <ContextLine
          activeContext={activeContext}
          editorContext={editorContext}
          onClear={() => setContextOverride(null)}
        />
        <RunForm form={form} setForm={setForm} />
        <div className="flex items-center gap-2">
          <button
            disabled={!canSubmit}
            onClick={() => void onGenerate()}
            title={outOfCredits ? 'Out of credits. Please contact your administrator.' : undefined}
            className="px-3 py-1 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white"
          >
            {submitting ? 'Generating…' : 'Generate'}
          </button>
          {submitError && <span className="text-red-400">{submitError}</span>}
        </div>
      </div>

      {error && <div className="px-3 py-2 text-red-400 border-b border-gray-800">{error}</div>}

      <div className="flex-1 overflow-auto p-3 space-y-2">
        {loading && generations.length === 0 && <div className="text-gray-500">Loading…</div>}
        {!loading && generations.length === 0 && (
          <div className="text-gray-500">No music generations yet.</div>
        )}
        {generations.map((gen) => (
          <RunCard key={gen.id} gen={gen} onReuse={onReuse} onRetry={onRetry} />
        ))}
      </div>

      {activeContext && (
        <div className="border-t border-gray-700 p-2">
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-[11px] text-gray-400 hover:text-gray-200"
          >
            {showAll ? `Filter to ${describeContext(activeContext)}` : 'Show all'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Subcomponents ────────────────────────────────────────────────────────

function PanelHeader({ credits, filter }: { credits: CreditsResponse | null; filter: SelectionContext }) {
  const creditsValue = credits?.credits
  const low = creditsValue != null && creditsValue <= 5
  const colorClass =
    creditsValue == null ? 'text-gray-400' : low ? 'text-red-400' : 'text-gray-300'
  return (
    <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between">
      <span className="font-semibold">
        Music Generations {filter && <span className="text-gray-500">· {describeContext(filter)}</span>}
      </span>
      <span className={colorClass} aria-label="credits">
        {creditsValue == null
          ? credits?.error || '— credits'
          : `${creditsValue} credits`}
      </span>
    </div>
  )
}

function ContextLine({
  activeContext,
  editorContext,
  onClear,
}: {
  activeContext: SelectionContext
  editorContext: SelectionContext
  onClear: () => void
}) {
  if (!activeContext) {
    return <div className="text-gray-500">No context. Generation will not be linked to an entity.</div>
  }
  const differs = editorContext?.id !== activeContext.id || editorContext?.type !== activeContext.type
  return (
    <div className="flex items-center gap-2 text-gray-400">
      <span>Generating for {describeContext(activeContext)}</span>
      <button
        onClick={onClear}
        className="px-1 text-[10px] border border-gray-600 rounded hover:bg-gray-700"
        title="Clear context (generation will not be linked to any entity)"
      >
        Clear context
      </button>
      {differs && <span className="text-[10px] text-gray-600">(from Reuse)</span>}
    </div>
  )
}

function RunForm({ form, setForm }: { form: FormState; setForm: (f: FormState) => void }) {
  const update = (patch: Partial<FormState>) => setForm({ ...form, ...patch })
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1">
          <input type="radio" name="action" checked={form.action === 'auto'} onChange={() => update({ action: 'auto' })} />
          Auto
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="action" checked={form.action === 'custom'} onChange={() => update({ action: 'custom' })} />
          Custom
        </label>
        <label className="flex items-center gap-1 ml-auto">
          <input type="checkbox" checked={form.instrumental} onChange={(e) => update({ instrumental: e.target.checked })} />
          Instrumental
        </label>
      </div>

      <textarea
        placeholder="Style — e.g. dark cinematic synth pad"
        value={form.style}
        onChange={(e) => update({ style: e.target.value })}
        className="w-full h-16 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs resize-none"
        maxLength={5000}
      />

      <textarea
        placeholder="Lyrics (ignored for Auto or Instrumental)"
        value={form.lyrics}
        onChange={(e) => update({ lyrics: e.target.value })}
        className="w-full h-16 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs resize-none disabled:opacity-40"
        disabled={form.action === 'auto' || form.instrumental}
      />

      <div className="flex items-center gap-3">
        <span className="text-gray-500">Gender:</span>
        {(['', 'male', 'female'] as const).map((g) => (
          <label key={g || 'unset'} className="flex items-center gap-1">
            <input type="radio" name="gender" checked={form.gender === g} onChange={() => update({ gender: g })} />
            {g || 'unset'}
          </label>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Title (optional, max 80)"
          value={form.title}
          onChange={(e) => update({ title: e.target.value.slice(0, 80) })}
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs"
          maxLength={80}
        />
        <select
          value={form.model}
          onChange={(e) => update({ model: e.target.value })}
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs"
        >
          <option value="MFV2.0">MFV2.0</option>
        </select>
      </div>
    </div>
  )
}

function RunCard({
  gen,
  onReuse,
  onRetry,
}: {
  gen: Generation
  onReuse: (gen: Generation) => void
  onRetry: (gen: Generation) => void
}) {
  const statusColor =
    gen.status === 'completed'
      ? 'text-green-400'
      : gen.status === 'failed'
        ? 'text-red-400'
        : 'text-amber-400'
  const contextLabel =
    gen.entity_type && gen.entity_id
      ? gen.entity_type === 'audio_clip'
        ? `◉ clip:${gen.entity_id}`
        : `◉ tr:${gen.entity_id}`
      : null
  return (
    <div className="border border-gray-700 rounded p-2 space-y-1">
      <div className="flex items-center justify-between text-[11px] text-gray-400">
        <span>
          {gen.created_at} · {gen.action} · {gen.model} · <span className={statusColor}>{gen.status}</span>
        </span>
        <span className="flex items-center gap-2">
          {gen.status === 'completed' && (
            <button
              onClick={() => onReuse(gen)}
              className="text-[10px] px-1 border border-gray-600 rounded hover:bg-gray-700"
            >
              ⟳ Reuse
            </button>
          )}
          {gen.status === 'failed' && (
            <button
              onClick={() => onRetry(gen)}
              className="text-[10px] px-1 border border-red-700 text-red-400 rounded hover:bg-red-900"
            >
              Retry
            </button>
          )}
        </span>
      </div>
      {contextLabel && <div className="text-[10px] text-gray-500">{contextLabel}</div>}
      <div className="text-gray-200 truncate" title={gen.style || ''}>
        {gen.style || <span className="italic text-gray-500">(no style)</span>}
      </div>
      {gen.error && <div className="text-red-400 text-[10px]">{gen.error}</div>}
      {gen.tracks.map((tr, i) => (
        <div
          key={tr.pool_segment_id}
          draggable
          onDragStart={(e) => {
            // Task-134 — music generations are net-new audio (not
            // extracted stems), so they ride the pool-audio drop path
            // the Bin uses, NOT `application/x-scenecraft-stem`.
            // AudioLane's onDropPoolAudio handler reads just the
            // pool_path string; the resulting clip's purple color comes
            // from pool_segments.variant_kind='music' at render time,
            // not from the drop payload.
            e.dataTransfer.setData('application/x-scenecraft-pool-path', tr.pool_path)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          className="flex items-center gap-2 text-[11px] px-1 py-0.5 bg-gray-900/60 rounded cursor-grab"
        >
          <span className="text-gray-500">▶</span>
          <span className="flex-1 truncate">{tr.song_title || `song ${i + 1}`}</span>
          <span className="text-gray-500">{tr.duration_seconds?.toFixed(0) ?? '?'}s</span>
          <span className="text-gray-600">⋮⋮</span>
        </div>
      ))}
    </div>
  )
}
