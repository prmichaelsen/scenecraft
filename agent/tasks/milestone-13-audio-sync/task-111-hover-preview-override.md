# Task 111: Hover-Driven Preview Override

**Milestone**: [M13 - Audio Sync Tab](../../milestones/milestone-13-audio-sync.md)
**Design Reference**: [local.audio-sync.md](../../design/local.audio-sync.md)
**Estimated Time**: 3 hours
**Dependencies**: Task 110 (AudioSyncTab scaffold with hover hooks exposed)
**Status**: Not Started

---

## Objective

Wire the two hover targets on an Audio Sync card to the render preview:
- Hover the `from v{d}` chip → raw source candidate plays
- Hover the card body → lipsynced output plays
- Release (mouseleave) → preview snaps back to the playhead frame

No new rendering pipeline — the preview already renders the playhead frame by default. Hover pushes a transient override source; release pops it.

Implements in the render preview panel and `LazyVideoCard`.

---

## Steps

### 1. Preview panel override state

Locate the render preview panel (inspect `src/components/editor/` — likely `PreviewPanel` or similar). Expose a small API via a Jotai atom, context ref, or direct prop drilling (match the existing preview-source model):

```typescript
// Preview source model: one default (playhead frame) + optional override.
type PreviewOverride = { kind: 'candidate'; poolSegmentId: string } | null
```

When `override` is set, the preview renders that pool_segment's media (using the same machinery that renders selected candidates today). When `override` is `null`, the preview renders the playhead frame (current default behavior).

The override is NOT persisted and NOT synced over WS — it's a local ephemeral state for hover.

### 2. Hover handlers on LazyVideoCard

Extend `LazyVideoCard` (added in Task 110) with:

```typescript
type LazyVideoCardProps = {
  // ... existing
  onChipHover?: (poolSegmentId: string | null) => void  // null on mouseleave
  onCardHover?: (poolSegmentId: string | null) => void
  // Source IDs for the two hover targets
  chipPoolSegmentId?: string  // the raw source (for variants) or undefined (for raws)
  cardPoolSegmentId: string   // the card's own pool_segment
}
```

- On `mouseenter` of the chip element: fire `onChipHover(chipPoolSegmentId)`
- On `mouseenter` of the card body: fire `onCardHover(cardPoolSegmentId)`
- On `mouseleave` of each: fire the respective callback with `null`

### 3. AudioSyncTab wires the handlers

In `AudioSyncTab`:

```typescript
const setPreviewOverride = useSetPreviewOverride()  // from the preview panel API

// On card:
<LazyVideoCard
  ...
  chipPoolSegmentId={variant.derivedFrom ?? undefined}
  cardPoolSegmentId={variant.id}
  onChipHover={(id) => setPreviewOverride(id ? { kind: 'candidate', poolSegmentId: id } : null)}
  onCardHover={(id) => setPreviewOverride(id ? { kind: 'candidate', poolSegmentId: id } : null)}
/>
```

If the chip and card overlap (chip is inside card) and both mouseenter fire, the chip's handler wins (last-writer on DOM event order; acceptable).

### 4. Release discipline

Safety: if the Audio Sync tab unmounts while an override is active, clear it on cleanup:

```typescript
useEffect(() => {
  return () => setPreviewOverride(null)
}, [])
```

### 5. Tests

- Vitest with `@testing-library/react`:
  - Mouseenter chip → `setPreviewOverride` called with the source pool_segment_id
  - Mouseenter card body → `setPreviewOverride` called with the card's own pool_segment_id
  - Mouseleave → called with `null`
  - Tab unmount → called with `null` (cleanup)
- Preview panel unit test: when `override` is set, renders the override media; when null, renders the playhead frame (use a snapshot or ref inspection)

---

## Verification

- [ ] Hovering the `from v{d}` chip on a variant card plays the raw source in the render preview
- [ ] Hovering the card body plays the lipsynced output in the render preview
- [ ] Moving the mouse off the card snaps the preview back to the playhead frame
- [ ] Switching tabs while hovered clears the override (preview returns to playhead)
- [ ] No visual flicker between hover-on and hover-off transitions
- [ ] No regression in the preview panel's default (playhead) rendering when the Audio Sync tab is not active
