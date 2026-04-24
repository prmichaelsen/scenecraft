# Task 147: FoleyGenerationsPanel

**Milestone**: [M18](../../milestones/milestone-18-foley-generation-plugin.md)
**Design Reference**: [`local.foley-generation-plugin.md`](../../design/local.foley-generation-plugin.md) — "Frontend panel contract"
**Clarification**: [`clarification-12-foley-generation-plugin.md`](../../clarifications/clarification-12-foley-generation-plugin.md) — Items 2 (mode UX), 3 (in/out), 8 (params)
**Estimated Time**: 8 hours
**Dependencies**: task-146 (frontend plugin module)
**Status**: Not Started

---

## Objective

Build `FoleyGenerationsPanel`, the plain-React panel that is both kickoff form and run-history view. Selection-aware mode dispatch, Set-in/Set-out state machine with most-recent-click-wins invalidation, parameter form, run cards, and drag handles that emit pool_segment drag payloads.

---

## Context

This is the most UI-heavy task in the milestone. Matches the M16 `MusicGenerationsPanel` shape but adds:
- A second mode (v2fx) selected implicitly by editor selection state
- A warning banner for the ambiguous case (transition selected, no candidate)
- Set-in/Set-out state machine with invalidation rules
- Hidden duration slider in v2fx mode

---

## Steps

### 1. Component signature

```typescript
// scenecraft/src/plugins/generate-foley/FoleyGenerationsPanel.tsx

export function FoleyGenerationsPanel() {
  // no props — reads selection + job state from context
}
```

### 2. Selection state reading

```typescript
const { selectedTransition, selectedCandidate } = useEditorSelection();
const mode: FoleyMode =
  selectedTransition && selectedCandidate ? 'v2fx' : 't2fx';
const showAmbiguityBanner = selectedTransition && !selectedCandidate;
```

### 3. Form state

```typescript
interface PanelState {
  prompt: string;
  durationPreset: 'burst' | 'sequence' | 'ambience' | 'custom';
  durationSlider: number;  // 1..30 seconds
  inSeconds: number | null;
  outSeconds: number | null;
  negativePrompt: string;         // default 'music'
  cfgStrength: number;            // default 4.5
  seed: number | null;
}
```

Duration presets map to default slider values:
- Burst → 2s
- Sequence → 8s
- Ambience → 30s
- Custom → last slider value

### 4. In/out state machine (v2fx only)

Set-in button handler:
```typescript
function handleSetIn() {
  const t = playhead.currentTime;
  if (state.outSeconds !== null && state.outSeconds <= t) {
    // new in >= existing out: clear out, preserve new in
    setState({ inSeconds: t, outSeconds: null });
  } else {
    setState({ inSeconds: t });
  }
}
```

Set-out button handler:
```typescript
function handleSetOut() {
  const t = playhead.currentTime;
  if (state.inSeconds !== null && state.inSeconds >= t) {
    // new out <= existing in: clear in, preserve new out
    setState({ inSeconds: null, outSeconds: t });
  } else {
    setState({ outSeconds: t });
  }
}
```

Clear button:
```typescript
function handleClear() {
  setState({ inSeconds: null, outSeconds: null });
}
```

When selection changes (tr or candidate), clear in/out:
```typescript
useEffect(() => {
  setState({ inSeconds: null, outSeconds: null });
}, [selectedTransition?.id, selectedCandidate?.id]);
```

### 5. Generate button gating

```typescript
const canGenerate =
  (mode === 't2fx') ||
  (mode === 'v2fx' && state.inSeconds !== null && state.outSeconds !== null &&
   state.outSeconds > state.inSeconds &&
   (state.outSeconds - state.inSeconds) <= 30);
```

Disabled tooltip:
- t2fx, prompt empty → "Enter a prompt" (but prompt is technically optional; decide based on final UX — likely keep enabled)
- v2fx, no in → "Set in-point"
- v2fx, no out → "Set out-point"
- v2fx, range > 30s → "Range exceeds 30s limit"

### 6. Request assembly

```typescript
function handleGenerate() {
  const request: GenerateFoleyRequest = {
    prompt: state.prompt,
    negative_prompt: state.negativePrompt || undefined,
    cfg_strength: state.cfgStrength,
    seed: state.seed ?? undefined,
    count: 1,
  };

  if (mode === 't2fx') {
    request.duration_seconds = state.durationSlider;
  } else {
    request.source_candidate_id = selectedCandidate!.id;
    request.source_in_seconds = state.inSeconds!;
    request.source_out_seconds = state.outSeconds!;
    request.entity_type = 'transition';
    request.entity_id = selectedTransition!.id;
    // duration derived server-side from (out - in) after pre-trim
  }

  const result = await generateFoleyClient.run(request);
  generateFoleyClient.subscribeToJobEvents(result.job_id, handleJobEvent);
}
```

### 7. Run history

Fetch on mount + on every `job_completed` event:
```typescript
const { generations, refetch } = useQuery(
  () => generateFoleyClient.list({
    entityType: selectedTransition ? 'transition' : undefined,
    entityId: selectedTransition?.id,
  }),
);
```

Render as a newest-first list of cards. Each card shows:
- Status badge (pending/running/completed/failed) with icon
- Mode badge (t2fx / v2fx)
- Prompt (truncated to ~60 chars, full on hover)
- Duration / range summary
- Retry button (enabled for failed + completed states)
- Drag handle on the output pool_segment (completed state only)
- Error message (failed state only, with "prediction charged" flag if applicable)

### 8. Drag handle

```typescript
function handleDragStart(e: DragEvent, poolSegmentId: string) {
  e.dataTransfer.setData(
    'application/x-scenecraft-stem',
    JSON.stringify({
      pool_segment_id: poolSegmentId,
      stem_type: 'foley',
      variant_kind: 'foley',
    }),
  );
}
```

Timeline drop logic (existing) consumes this payload and creates an `audio_clips` row on the target lane.

### 9. Layout sketch

```
┌─ Foley Generator ─────────────────────────────┐
│ [warning banner if tr-no-cand]                │
│                                               │
│ Prompt:  [footsteps on gravel_____________]   │
│                                               │
│ ── t2fx only ─────────────────                │
│ Duration:  [Burst][Sequence][Ambience][Custom]│
│            [●──○──○] 2s                       │
│                                               │
│ ── v2fx only ─────────────────                │
│ Range: In 0:12.3 → Out 0:20.1 (7.8s)          │
│ [ Set in ] [ Set out ] [ Clear ]              │
│                                               │
│ Advanced:                                     │
│   Negative: [music____________________]       │
│   CFG:      [───●───] 4.5                     │
│   Seed:     [random________]                  │
│                                               │
│ [ Generate ]                                  │
│                                               │
│ ── Recent generations ────────────────        │
│ ● completed  v2fx  "door slam"  2s  [⋮]       │
│ ● completed  t2fx  "footsteps"  2s  [⋮]       │
│ ○ failed     v2fx  "glass break"    [retry]   │
│                                               │
└───────────────────────────────────────────────┘
```

### 10. Tests

- Selection state: nothing selected → t2fx, tr+cand → v2fx, tr alone → t2fx + banner
- Set-in after existing out: `out <= new_in` clears out
- Set-out before existing in: `in >= new_out` clears in
- Selection change clears in/out
- Generate disabled until valid state
- Request assembly for t2fx vs. v2fx routes correctly
- Drag payload serializes correctly
- Run history refetches on `job_completed` event

---

## Verification

- [ ] Panel renders in `PanelRegistry` as `foley-generations`
- [ ] Selection-driven mode dispatch works (three states)
- [ ] Warning banner shows only when transition selected without candidate
- [ ] Set-in/Set-out buttons capture playhead time correctly
- [ ] Most-recent-click-wins invalidation rule fires as specified
- [ ] Clear button resets both in/out
- [ ] Selection change clears in/out
- [ ] Duration presets set the slider correctly; Custom preserves slider value
- [ ] Duration slider hidden in v2fx mode
- [ ] Generate button disabled with correct tooltips when invalid
- [ ] Run history shows all generations newest-first
- [ ] When transition is selected, history filters to that transition's generations
- [ ] Drag handle on completed runs emits the correct payload
- [ ] Failed runs show error message with "prediction charged" flag when applicable
- [ ] Retry button creates a new run visible in the list

---

## Expected Output

```
scenecraft/src/plugins/generate-foley/
├── FoleyGenerationsPanel.tsx     (new)
├── components/                   (new — sub-components)
│   ├── ParamForm.tsx
│   ├── InOutControls.tsx
│   ├── RunCard.tsx
│   └── WarningBanner.tsx
└── hooks/
    ├── useInOutRange.ts
    └── useFoleyGenerations.ts

scenecraft/tests/plugins/generate-foley/
└── test_panel.spec.tsx           (new)
```

---

## Notes

- This is UI-dense. Split into sub-components aggressively. No monolithic `FoleyGenerationsPanel.tsx`.
- Match M16's `MusicGenerationsPanel` file naming/layout conventions for consistency.
- No vitest setup exists in scenecraft frontend yet — install it as part of this task if tests are authored. Don't ask.

---

**Next Task**: [task-148](task-148-chat-tool.md) — generate_foley chat tool
