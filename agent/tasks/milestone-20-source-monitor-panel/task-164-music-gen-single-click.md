# Task 164: Music Gen Panel — Single-Click Row → setSource

**Milestone**: [M20](../../milestones/milestone-20-source-monitor-panel.md)
**Spec**: `agent/specs/local.source-monitor-panel.md` — R40, R41
**Design Reference**: [Source Monitor Panel](../../design/local.source-monitor-panel.md)
**Estimated Time**: 1 hour
**Dependencies**: task-163 (`useSourceMonitor` exists)
**Status**: Not Started

---

## Objective

Wire the music gen panel's per-track row click to load that track into the source monitor. The existing inline `▶` PoolAudioPlayButton STAYS — quick-listen and source-monitor detail view coexist. Clicking the inline button starts inline playback ONLY (does NOT also load into source monitor).

---

## Files

Modify:
- `src/plugins/generate-music/MusicGenerationsPanel.tsx`
- `src/plugins/generate-music/__tests__/MusicGenerationsPanel.render.test.tsx`

---

## Steps

### 1. Wire row-click in `RunCard`

In the `RunCard` component, find the per-track row container (currently a `div` with the drag handle inside `gen.tracks.map((tr, i) => ...)`). Add an `onClick` handler:

```tsx
const { setSource } = useSourceMonitor()

<div
  key={tr.pool_segment_id}
  draggable
  onDragStart={...}
  onClick={() => setSource({
    kind: 'audio',
    path: tr.pool_path,
    label: tr.song_title || `song ${i + 1}`,
    poolSegmentId: tr.pool_segment_id,
  })}
  className="flex items-center gap-2 text-[11px] px-1 py-0.5 bg-gray-900/60 rounded cursor-grab"
>
  <PoolAudioPlayButton ... />  {/* unchanged */}
  ...
</div>
```

### 2. Stop event propagation on inline ▶

The existing `PoolAudioPlayButton` already calls `e.stopPropagation()` on its toggle (added during M16). Verify this is in place; if not, add it. Without `stopPropagation`, clicking ▶ would also trigger the row's setSource handler.

### 3. Tests

`MusicGenerationsPanel.render.test.tsx` — add:

- `single-click on track row calls setSource with audio + poolSegmentId` — assert `useSourceMonitor().source` matches `{kind: 'audio', path, label, poolSegmentId}`.
- `clicking inline ▶ does NOT load into source monitor` — assert `setSource` NOT called when only the inline button is clicked.

---

## Verification

- [ ] Single-click on a generated track row loads the track into the source monitor (waveform renders, transport works)
- [ ] Inline ▶ click starts playback inline; source monitor state unchanged
- [ ] Existing buildPayload, Reuse, Retry, drag-to-timeline behaviors all unchanged (regression check)
- [ ] All MusicGenerationsPanel vitest tests pass
- [ ] `npx tsc --noEmit` clean
