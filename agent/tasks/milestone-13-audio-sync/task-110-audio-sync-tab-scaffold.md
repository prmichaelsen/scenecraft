# Task 110: AudioSyncTab Scaffold + Form

**Milestone**: [M13 - Audio Sync Tab](../../milestones/milestone-13-audio-sync.md)
**Design Reference**: [local.audio-sync.md](../../design/local.audio-sync.md)
**Estimated Time**: 6 hours
**Dependencies**: Task 109 (types + rank helpers)
**Status**: Not Started

---

## Objective

Build the Audio Sync tab shell: inline generate form at top, grid of lipsync takes below. Generate button calls a stubbed client function (live wiring lands in Task 112). Hover handlers are added in Task 111.

Implements in `scenecraft/src/components/editor/AudioSyncTab.tsx` and `TransitionPanel.tsx`.

---

## Steps

### 1. Tab registration in `TransitionPanel.tsx`

Add a new tab slot in the existing tabs list, between `candidates` and `browse`:

```
details · candidates · audio-sync · browse · bench
```

Render `<AudioSyncTab transition={transition} />` when that tab is active.

### 2. AudioSyncTab component

`src/components/editor/AudioSyncTab.tsx`:

```typescript
export function AudioSyncTab({ transition }: { transition: Transition }) {
  const variants = useMemo(
    () => transition.candidateDetails.filter(c => c.variantKind === 'lipsync'),
    [transition.candidateDetails],
  )
  const rawTakes = useMemo(
    () => transition.candidateDetails.filter(c => c.variantKind == null),
    [transition.candidateDetails],
  )
  return (
    <div>
      <GenerateForm transition={transition} rawTakes={rawTakes} />
      <VariantGrid variants={variants} allCandidates={transition.candidateDetails} />
    </div>
  )
}
```

### 3. GenerateForm

Mirrors the Candidates tab's generation section layout:

Fields:
- **Source candidate** picker — dropdown of `rawTakes` showing `from v{d}` labels; default to the first raw or currently-selected candidate
- **Mode toggle** — segmented control: `Script (TTS)` / `Audio (S2S)`
- **Voice** dropdown — stubbed empty array for now (Task 113 populates); include a placeholder with a real voice_id constant (`21m00Tcm4TlvDq8ikWAM` / Rachel) so submit works in dev
- **Script textarea** — visible in TTS mode
- **Audio input** — visible in S2S mode; `<input type="file" accept="audio/*">` plus an optional "pick from audio pool" button (stub for now)
- **Generate** button — disabled until required fields present; on click, calls `generateLipsync()` (stubbed; Task 112 wires it)

Form state in local component state (no need for a store).

### 4. VariantGrid

2-column grid mirroring the Candidates tab layout. Each cell renders a `LazyVideoCard` for the variant.

Props on `LazyVideoCard` for variants:
- `derivedFromLabel: string` (e.g. `from v2`) — computed via `rankOfSource(variant, allCandidates)`
- `onChipHover?(payload)` / `onCardHover?(payload)` — wired in Task 111 (pass no-ops here)
- Action menu: **Resync** (stubbed; Task 112 wires), **Bench**, overflow (Pool, Extend — reuse existing where applicable)
- Click → standard select (`selectTransitions({ tr_id, slot, pool_segment_id: variant.id })`)

`LazyVideoCard` needs a small extension:
- New prop `derivedFromLabel?: string` → renders a chip overlaid on the thumbnail (top-left corner; styled like existing badges)
- Keep the existing selection-border behavior

### 5. Empty state

When `variants.length === 0`:

```
🎙 No Audio Sync takes yet
   Pick a source candidate, voice, and script — then Generate.
```

### 6. Tests

- Vitest: component renders with a mix of raws and variants; grid shows only variants; form fields present in both modes
- Toggling the mode swaps the script textarea for the audio input
- Submit is disabled until required fields are present
- Snapshot the `from v{d}` chip rendering

---

## Verification

- [ ] Audio Sync tab appears in `TransitionPanel` between Candidates and Browse
- [ ] Form renders all fields; mode toggle swaps Script ↔ Audio inputs
- [ ] Generate button disabled until required fields are present (dev voice placeholder OK)
- [ ] Grid renders only variants (`variantKind === 'lipsync'`)
- [ ] Each card shows a `from v{d}` chip reflecting the rank of its `derivedFrom` source
- [ ] Empty state renders when there are no variants
- [ ] Clicking a variant card selects it (sets `transitions.selected[slot]`)
- [ ] `LazyVideoCard` still renders correctly in the Candidates tab (no regression)
