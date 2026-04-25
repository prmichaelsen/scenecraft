# Task 165: Bin Panel — Single-Click Pool Item → setSource

**Milestone**: [M20](../../milestones/milestone-20-source-monitor-panel.md)
**Spec**: `agent/specs/local.source-monitor-panel.md` — R42, R43
**Design Reference**: [Source Monitor Panel](../../design/local.source-monitor-panel.md)
**Estimated Time**: 2 hours
**Dependencies**: task-163 (`useSourceMonitor` exists)
**Status**: Not Started

---

## Objective

Wire single-click on a Bin pool item to load it into the source monitor. Existing hover-preview behavior in the program-preview panel stays unchanged. Existing drag-to-timeline behavior stays unchanged. Click must be distinguishable from drag-start (mouse-movement threshold ~5px) so dragging doesn't also trigger setSource.

---

## Files

Modify:
- `src/components/editor/BinPanel.tsx`
- `src/components/editor/__tests__/BinPanel.test.tsx` (or create if missing)

---

## Steps

### 1. Determine source kind from pool segment

Bin pool items can be audio OR video. The `pool_segments` row's `pool_path` extension is the cheapest signal:
- `.mp3 / .wav / .ogg / .m4a / .flac` → `kind: 'audio'`
- `.mp4 / .mov / .webm / .avi` → `kind: 'video'`

Helper:

```tsx
function inferKind(poolPath: string): 'audio' | 'video' | null {
  const ext = poolPath.toLowerCase().split('.').pop() || ''
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio'
  if (['mp4', 'mov', 'webm', 'avi'].includes(ext)) return 'video'
  return null  // unknown → don't load
}
```

For audio items, `poolSegmentId` is REQUIRED per R7 — pass `segment.id`.

### 2. Wire click handler

On the Bin item row's `onClick`:

```tsx
const { setSource } = useSourceMonitor()

const onItemClick = (segment: PoolSegment) => {
  const kind = inferKind(segment.pool_path)
  if (!kind) return  // unknown ext — silent skip
  setSource({
    kind,
    path: segment.pool_path,
    label: segment.label || basename(segment.pool_path),
    poolSegmentId: segment.id,
  })
}
```

### 3. Click vs. drag distinction

Drag-and-drop is already wired on Bin items. The browser's drag gesture fires `dragstart` after a small mouse-movement threshold; below that, it's a click.

Standard pattern: don't add the click handler at the same DOM level as the drag — track mousedown/mouseup and check movement delta. Or rely on the browser's natural behavior:
- If user mousedown → mouseup without moving more than 5px → click fires (setSource).
- If user mousedown → moves > 5px → dragstart fires; click does NOT fire.

The browser handles this distinction automatically when you have both `onClick` and `draggable={true}` on the same element. Verify behavior; if click fires after a drag, add a `useDragAwareClick` helper.

### 4. Hover preview unchanged

The Bin currently shows hover-previews in the program-preview panel. That logic stays untouched — mouse-enter/leave handlers continue to fire as today. R43 explicitly preserves this.

### 5. Tests

`BinPanel.test.tsx`:
- `single-click audio pool item calls setSource with kind='audio' + poolSegmentId`
- `single-click video pool item calls setSource with kind='video' + poolSegmentId`
- `unknown extension does not call setSource`
- `dragging does not also fire setSource` (simulate drag gesture, assert setSource NOT called)
- `hover behavior unchanged` (mouseenter still triggers existing preview-panel handler)

---

## Verification

- [ ] Single-click on an audio Bin item → source monitor loads it (waveform renders)
- [ ] Single-click on a video Bin item → source monitor loads it (`<video>` element)
- [ ] Drag still drops to timeline (existing behavior preserved)
- [ ] Hover-preview in program-preview panel still works
- [ ] All BinPanel tests pass
- [ ] `npx tsc --noEmit` clean
