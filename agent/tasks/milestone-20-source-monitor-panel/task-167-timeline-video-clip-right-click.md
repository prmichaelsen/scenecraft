# Task 167: Timeline Video Clip Right-Click → "Open Source in Source Monitor" via ContextMenuProvider

**Milestone**: [M20](../../milestones/milestone-20-source-monitor-panel.md)
**Spec**: `agent/specs/local.source-monitor-panel.md` — R46, R53
**Design Reference**: [Source Monitor Panel](../../design/local.source-monitor-panel.md)
**Estimated Time**: 3 hours
**Dependencies**: task-163 (`useSourceMonitor` exists)
**Status**: Not Started

---

## Objective

Add a right-click menu entry "Open source in source monitor" to timeline video clips (transitions in the keyframe/transition surface). Resolution MUST go through the data model (`tr.selected → pool_segments.pool_path`), NOT through the runtime cache at `selected_transitions/<tr_id>_slot_0.mp4`. Wire via the existing `ContextMenuProvider` subscription pattern (R53), not by extending `Timeline.tsx`'s `onContextMenu` handler inline.

---

## Files

Modify:
- `src/contexts/ContextMenuContext.tsx` (or wherever the provider lives) — verify it supports per-entity-kind subscriptions; extend if not
- `src/components/editor/Timeline.tsx` — emit context-menu events through the provider for transitions (verify existing wiring; minimal change if already done)
- `src/components/editor/SourceMonitorPanel.tsx` (or new helper module) — register the right-click subscription on mount

Create (if needed):
- `src/components/editor/__tests__/TimelineVideoClipRightClick.test.tsx` — integration test

---

## Steps

### 1. Verify ContextMenuProvider supports entity-kind subscriptions

Check the existing `ContextMenuProvider` (referenced in `EditorPanelLayout.tsx`). It already powers right-click menus on Timeline; verify there's a way for non-Timeline code to register menu entries against an entity kind (e.g., `'transition'`, `'pool_segment'`).

If no such API exists, add one:

```ts
// in ContextMenuContext.tsx
type ContextMenuEntry = {
  id: string                              // unique within (entityKind, id) namespace
  label: string
  enabled: (entity: any) => boolean
  onSelect: (entity: any) => void
}

contextMenu.registerEntry(entityKind: string, entry: ContextMenuEntry): Disposable
```

### 2. Register the right-click entry

On source-monitor activation (or in `SourceMonitorProvider`'s mount):

```ts
const { setSource } = useSourceMonitor()
const { registerEntry } = useContextMenu()

useEffect(() => {
  return registerEntry('transition', {
    id: 'open-source-in-source-monitor',
    label: 'Open source in source monitor',
    enabled: (tr) => !!resolveSelectedSegmentId(tr),  // R39 — disable if tr.selected is null/empty
    onSelect: (tr) => openTransitionSource(tr, setSource),
  })
}, [setSource, registerEntry])
```

### 3. Resolution helper

```ts
function resolveSelectedSegmentId(tr: Transition): string | null {
  // tr.selected may be a string (single id) or an array (slot 0 = displayed)
  if (Array.isArray(tr.selected)) {
    return tr.selected[0] ?? null
  }
  return tr.selected ?? null
}

async function openTransitionSource(tr: Transition, setSource: (s: SourceMonitorSource | null) => void) {
  const segId = resolveSelectedSegmentId(tr)
  if (!segId) return
  const segment = await fetchPoolSegment(projectName, segId)  // existing API
  if (!segment) return
  setSource({
    kind: 'video',
    path: segment.pool_path,           // pool/segments/<uuid>.<ext>
    label: tr.label || segment.label || basename(segment.pool_path),
    poolSegmentId: segment.id,
    metadata: {
      transitionId: tr.id,
      trim_in: tr.trim_in,
      trim_out: tr.trim_out,
    },
  })
}
```

Important: the resolved `path` MUST come from `pool_segments.pool_path` (the data row), NOT from `selected_transitions/<tr_id>_slot_0.mp4` (the runtime render cache). Going through the cache ties previews to a render artifact and breaks if the cache is stale or missing.

### 4. Trim metadata is informational only

The trim_in / trim_out fields are passed in `metadata` but the source monitor does NOT auto-set `inPoint` / `outPoint` to those values. The user marks their own range from the source monitor's transport.

### 5. Tests

`TimelineVideoClipRightClick.test.tsx`:
- Build a fake transition `tr_42` with `selected = "ps_99"`, `trim_in = 5`, `trim_out = 12`, `label = "intro"`.
- Build a fake pool_segment `ps_99` with `pool_path = "pool/segments/abc.mp4"`, `label = "raw_intro"`.
- Right-click → "Open source in source monitor":
  - `setSource` called with `kind: 'video'`, `path: "pool/segments/abc.mp4"`, `poolSegmentId: "ps_99"`, `label: "intro"`, `metadata: { transitionId: "tr_42", trim_in: 5, trim_out: 12 }`.
  - `useSourceMonitor().inPoint === null`, `useSourceMonitor().outPoint === null` (markers NOT auto-set from trim metadata).
- Build `tr_43` with `selected = null` → assert menu item rendered disabled.

---

## Verification

- [ ] Right-click a video clip on the timeline → "Open source in source monitor" appears
- [ ] Click it → source monitor activates, loads the video; path is `pool/segments/<uuid>...`, NOT `selected_transitions/...`
- [ ] Trim metadata is informational only; no in/out markers appear from the trim values
- [ ] When `tr.selected` is null, the menu item is disabled
- [ ] All tests pass
- [ ] `npx tsc --noEmit` clean
- [ ] No regressions in existing right-click menu items for transitions
