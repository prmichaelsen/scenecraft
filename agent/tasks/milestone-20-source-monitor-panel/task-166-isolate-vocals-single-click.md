# Task 166: Isolate Vocals — Single-Click Stem Row → setSource (keep inline ▶)

**Milestone**: [M20](../../milestones/milestone-20-source-monitor-panel.md)
**Spec**: `agent/specs/local.source-monitor-panel.md` — R44, R45
**Design Reference**: [Source Monitor Panel](../../design/local.source-monitor-panel.md)
**Estimated Time**: 1 hour
**Dependencies**: task-163 (`useSourceMonitor` exists)
**Status**: Not Started

---

## Objective

Wire single-click on an isolate-vocals stem row to load it into the source monitor. The existing inline `PoolAudioPlayButton` STAYS (mirrors music gen — quick-listen + detail view coexist; harmonized 2026-04-25). Clicking the inline button starts inline playback only; does NOT also load into source monitor.

---

## Files

Modify:
- `src/plugins/isolate_vocals/AudioIsolationsPanel.tsx`
- `src/plugins/isolate_vocals/__tests__/` (add a test file if missing — `AudioIsolationsPanel.test.tsx`)

---

## Steps

### 1. Wire row-click

In the stem row component, add an `onClick` handler that calls `setSource`:

```tsx
const { setSource } = useSourceMonitor()

<div
  key={stem.id}
  onClick={() => setSource({
    kind: 'audio',
    path: stem.pool_path,
    label: stem.label || `${stem.kind} stem`,
    poolSegmentId: stem.id,
  })}
  className="..."
>
  <PoolAudioPlayButton projectName={projectName} poolPath={stem.pool_path} />
  ...
</div>
```

### 2. Stop event propagation on inline ▶

Verify `PoolAudioPlayButton` calls `e.stopPropagation()` on its toggle (likely already in place from earlier work). If not, add it.

### 3. KEEP the inline ▶

Per harmonization (clarification-13 Q 5.3.1, updated 2026-04-25): do NOT remove the inline button. Both panels (music gen + isolate vocals) keep the same dual affordance.

### 4. Tests

`AudioIsolationsPanel.test.tsx`:
- `single-click on stem row calls setSource with audio + poolSegmentId`
- `inline ▶ button is still present in the DOM` (negative-of-removal regression guard)
- `clicking inline ▶ does NOT load into source monitor`

---

## Verification

- [ ] Single-click on a stem row loads the stem into source monitor
- [ ] Inline ▶ button still renders on each stem row
- [ ] Inline ▶ click plays the stem inline; source monitor unchanged
- [ ] Drag-to-timeline (if implemented) still works
- [ ] All isolate-vocals tests pass
- [ ] `npx tsc --noEmit` clean
