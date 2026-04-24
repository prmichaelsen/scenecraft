# Task 132: MusicGenerationsPanel

**Milestone**: [M16](../../milestones/milestone-16-music-generation-plugin.md)
**Spec**: `agent/specs/local.music-generation-plugin.md` — R26-R36 (panel + form + context filter + credits), R50-R51 (failed card + retry), R29-R30 (Reuse)
**Estimated Time**: 6 hours
**Dependencies**: task-131 (plugin module + client)
**Status**: Not Started

---

## Objective

Ship `MusicGenerationsPanel.tsx` as a plain React component registered via `host.registerPanel`. Everything from the spec's panel mock lands here: run form, run history with cards, context-aware filtering, Reuse + Retry, permanent credits counter.

---

## File

Create: `scenecraft/src/plugins/generate-music/MusicGenerationsPanel.tsx`

---

## Steps

### 1. Component shell

```typescript
export function MusicGenerationsPanel(): JSX.Element {
  const { projectName } = useEditorData()
  const { selectedAudioClipId, selectedTransitionId } = useEditorState()

  const selectionContext = resolveSelectionContext(selectedAudioClipId, selectedTransitionId)
  const [showAll, setShowAll] = useState(false)
  const filter = showAll || !selectionContext ? null : selectionContext

  const generations = useGenerations(projectName, filter)
  const credits = useCredits(projectName)

  useMusicGenerationEvents(projectName, () => {
    generations.refetch()
    credits.refetch()
  })

  return (
    <div className="h-full flex flex-col">
      <PanelHeader credits={credits.value} contextLabel={filter ? describeContext(filter) : 'all'} />
      <RunForm projectName={projectName} selectionContext={selectionContext} credits={credits.value} />
      <RunList generations={generations.value} onRetry={...} onReuse={...} />
      {selectionContext && (
        <button onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Filter to selection' : 'Show all'}
        </button>
      )}
    </div>
  )
}
```

### 2. Form (R31-R33)

All fields always visible:

- Action radio: `Auto` (default) / `Custom`
- Style textarea (placeholder: "e.g. dark cinematic synth pad")
- Lyrics textarea (still visible under Custom, but ignored if instrumental=1)
- Instrumental checkbox (default: checked)
- Gender radio: male / female / unset (default: unset)
- Model select: `MFV2.0` (default, only option in MVP)
- Title input (optional, max 80 chars)

Header:
- If `selectionContext` is an audio_clip → "Generating for <clip name>"
- If `selectionContext` is a transition → "Generating for <transition label>"
- If no context → no header (implicit "no context")
- `Clear context` button visible when context is set (R33)

Generate button:
- Disabled when credits ≤ 0 (R36); disabled tooltip: `"Out of credits. Please contact your administrator"`
- On click: POST to `runGeneration()`; on success, form stays filled (for easy re-run with tweaks)

### 3. Field-filter-at-send

Critical: Build the REST payload by filtering fields per action (R13):

```typescript
function buildPayload(form: FormState, selectionContext: Context | null): RunPayload {
  const base = {
    action: form.action,
    style: form.style,
    instrumental: form.instrumental ? 1 : 0,
    model: form.model,
    entity_type: selectionContext?.type ?? null,
    entity_id: selectionContext?.id ?? null,
  }
  if (form.action === 'custom') {
    const lyrics = form.instrumental ? undefined : form.lyrics
    return { ...base, lyrics, title: form.title || undefined, gender: form.gender || undefined }
  }
  return { ...base, gender: form.gender || undefined }
}
```

Fields that aren't in the action's payload are omitted, not sent as null (spec R13 explicit).

### 4. Run list (R28, R50)

```
┌ 2026-04-23 15:01 · Custom · MFV2.0 · ✓ completed ──────────┐
│ ◉ tr: T-0047                                    [⟳ Reuse]  │
│ ▶ "Neon Midnight" (song 1)   2:47   [drag]                 │
│ ▶ "Neon Midnight" (song 2)   2:52   [drag]                 │
└────────────────────────────────────────────────────────────┘
```

Each card renders:
- Timestamp + action + model + status badge (✓ / ⏳ spinning / ✗)
- Context badge when `entity_type` is set (R28)
- `⟳ Reuse` button (completed rows only — R29)
- `Retry` button (failed rows only — R51)
- Track rows with ▶ play + duration + drag handle
- Error text (failed rows)

### 5. Reuse flow (R29-R30)

```typescript
function onReuse(gen: Generation) {
  setFormState({
    action: gen.action,
    style: gen.style ?? '',
    lyrics: gen.lyrics ?? '',
    title: gen.title ?? '',
    instrumental: gen.instrumental === 1,
    gender: gen.gender ?? '',
    model: gen.model,
  })
  setSelectionOverride(gen.entity_type ? { type: gen.entity_type, id: gen.entity_id! } : null)
}
```

Prefilling uses the generation's OWN context, NOT the current editor selection (per spec test `reuse-preserves-entity-context`).

### 6. Retry flow (R50-R51)

```typescript
async function onRetry(gen: Generation) {
  await retryGeneration(projectName, gen.id)
  generations.refetch()
}
```

Simpler than Reuse — no form prefill, direct call. Backend handles the param copy + `reused_from` wiring.

### 7. Credits header

Permanent display:

```
┌─ Music Generations ─ 237 credits ─────────┐
```

Or similar styling. Replaces the toast-style low-credit warning entirely (R34 + Q4.1 followup).

### 8. Track-row drag

See task-134 for the drag payload shape. Each track row has a drag handle; `onDragStart` emits the payload.

### 9. Tests

Vitest + happy-dom (scenecraft frontend doesn't have tests yet per memory — if installing vitest, do it here):

- `panel-renders-empty-state` — no generations → "No music generations yet" or similar
- `form-defaults` — Action=Auto, Instrumental=checked, Style empty (R32)
- `send-payload-auto-filters-fields` — submit with action=auto + lyrics filled → lyrics not in payload (R13)
- `send-payload-custom-includes-lyrics` — submit action=custom + instrumental=0 → lyrics in payload
- `instrumental-drops-lyrics` — action=custom + instrumental=1 + lyrics filled → lyrics not in payload
- `context-filter-active` — select transition → panel shows only matching runs
- `show-all-overrides-filter` — click "Show all" → all runs shown
- `reuse-prefills-form` — click Reuse → form state matches clicked row
- `reuse-preserves-entity-context` — Reuse of a tr-bound row keeps entity binding even if editor selection changed
- `retry-disabled-on-non-failed` — Retry button only appears on failed cards
- `out-of-credits-disables-generate` — credits=0 → button disabled with correct tooltip
- `context-badge-renders` — tr-bound card shows `◉ tr:` prefix
- `ws-completion-refetches` — fire a synthetic `job_completed` event → panel refetches

---

## Verification

- [ ] All form fields visible at all times
- [ ] Send payload filters fields per action
- [ ] Context-aware filtering works; "Show all" escape hatch works
- [ ] Reuse prefills with ORIGINAL context, not current selection
- [ ] Retry creates new row via backend
- [ ] Credits counter refreshes after each job completion
- [ ] Out-of-credits disables Generate with correct tooltip
- [ ] Status badges reflect current state
- [ ] HMR-safe: editing component doesn't duplicate panels

---

## Notes

- Follow scenecraft's existing panel component style (see `AudioPropertiesPanel.tsx`, `TransitionPanel.tsx`). Use tailwind classes consistent with the rest of the editor.
- Credit counter styling: small, unobtrusive, right-aligned in panel header. Red tint when ≤ 5 credits; neutral otherwise (soft warning is OUT of M16 per spec but the color cue is cheap).
- If `useGenerations` + `useCredits` don't exist as hooks, define them in `client.ts` (task-131) or inline them — either is fine.
- No confirmation modal on Generate; the form IS the confirmation (R46). Chat-tool path handles confirmation separately via elicitation.
