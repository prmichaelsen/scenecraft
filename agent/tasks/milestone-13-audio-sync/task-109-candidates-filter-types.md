# Task 109: Candidates Tab Filter + CandidateDetail Types

**Milestone**: [M13 - Audio Sync Tab](../../milestones/milestone-13-audio-sync.md)
**Design Reference**: [local.audio-sync.md](../../design/local.audio-sync.md)
**Estimated Time**: 2 hours
**Dependencies**: Task 106 (backend surfaces `derivedFrom` + `variantKind`)
**Status**: Not Started

---

## Objective

Update frontend types and filter the existing Candidates tab so lipsync variants don't appear in the raw-take view. Variants live exclusively in the Audio Sync tab (built in Task 110).

Implements in `scenecraft/src/routes/project/$name/editor.tsx` and `src/components/editor/TransitionPanel.tsx`.

---

## Steps

### 1. Extend `CandidateDetail`

In `editor.tsx` (or wherever `CandidateDetail` is declared):

```typescript
type CandidateDetail = {
  // ... existing fields
  derivedFrom: string | null
  variantKind: 'lipsync' | null  // open-ended in future; narrow union for MVP
}
```

All existing consumers continue to work — the new fields default to `null`.

### 2. Filter Candidates tab

In `TransitionPanel.tsx`, at the point where `candidateDetails` is rendered in the Candidates tab, filter:

```typescript
const rawCandidates = useMemo(
  () => (transition?.candidateDetails ?? []).filter(c => c.variantKind == null),
  [transition?.candidateDetails],
)
```

Use `rawCandidates` in the existing candidate grid (replacing the current direct reference).

### 3. `from v{d}` rank computation (shared helper)

Live-computed rank utility — used by Task 110 too:

```typescript
function computeRankLabel(candidate: CandidateDetail, allCandidates: CandidateDetail[]): string {
  const rawTakes = [...allCandidates]
    .filter(c => c.variantKind == null)
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt))
  const idx = rawTakes.findIndex(c => c.id === candidate.id)
  return idx >= 0 ? `v${idx + 1}` : `v?`
}
```

Export from `src/lib/candidate-rank.ts` (new file) — both tabs consume it.

For a variant, pass the variant candidate's `derivedFrom` target to this function (i.e. look up the source and compute its rank):

```typescript
function rankOfSource(variant: CandidateDetail, all: CandidateDetail[]): string {
  if (!variant.derivedFrom) return 'v?'
  const source = all.find(c => c.id === variant.derivedFrom)
  return source ? computeRankLabel(source, all) : 'v?'
}
```

### 4. Tests

- Unit (Vitest): `computeRankLabel` orders by `addedAt` ASC and ignores variants
- Unit: `rankOfSource` returns the correct `v{d}` for a variant's source; returns `v?` when the source isn't in the list
- Snapshot/rendering: Candidates tab renders only the raw takes given a mixed candidate list

---

## Verification

- [ ] `CandidateDetail` type includes `derivedFrom` + `variantKind`
- [ ] Candidates tab shows only candidates with `variantKind == null`
- [ ] `computeRankLabel` + `rankOfSource` exported from a shared module
- [ ] No regression in the existing candidate grid (raw takes still render with the same order/styling)
- [ ] Rank helpers covered by unit tests
