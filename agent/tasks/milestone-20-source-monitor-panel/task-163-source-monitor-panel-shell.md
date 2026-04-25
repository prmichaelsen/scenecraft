# Task 163: Source Monitor Panel Shell + Context

**Milestone**: [M20](../../milestones/milestone-20-source-monitor-panel.md)
**Spec**: `agent/specs/local.source-monitor-panel.md` — R1-R28, R37-R39, R47-R52 (panel registration, context API, transport, markers, recent sources, Reveal Properties, Space, runtime guard, revealPanel)
**Design Reference**: [Source Monitor Panel](../../design/local.source-monitor-panel.md)
**Estimated Time**: 6 hours
**Dependencies**: None (foundational task — all other M20 tasks stack on this)
**Status**: Not Started

---

## Objective

Build the foundational source-monitor panel infrastructure: React context, panel component, registration in `EditorPanelLayout`, transport, in/out markers, recent-sources stack, missing-file state, focus-scoped Space shortcut, runtime kind validation, and the new `revealPanel(panelId)` method on `PanelLayoutHandle`. This is the foundation that tasks 164-168 wire into.

---

## Files

Create:
- `src/components/editor/SourceMonitorContext.tsx` — `useSourceMonitor()` hook + provider
- `src/components/editor/SourceMonitorPanel.tsx` — render shell
- `src/components/editor/__tests__/SourceMonitorContext.test.ts` — context-state tests
- `src/components/editor/__tests__/SourceMonitorPanel.test.tsx` — render tests

Modify:
- `src/components/panel-layout/types.ts` — add `revealPanel(panelId: string): void` to `PanelLayoutHandle`
- `src/components/panel-layout/PanelLayout.tsx` — implement `revealPanel` handling already-active / inactive-tab / removed cases
- `src/components/editor/EditorPanelLayout.tsx` — register `source-monitor` panel; add to default preview-panel-group; wrap children in `SourceMonitorProvider`

---

## Steps

### 1. `SourceMonitorContext.tsx`

```ts
export type SourceMonitorSource =
  | { kind: 'audio'; path: string; label: string; poolSegmentId: string; metadata?: Record<string, unknown> }
  | { kind: 'video'; path: string; label: string; poolSegmentId?: string; metadata?: Record<string, unknown> }

export type SourceMonitorContextValue = {
  source: SourceMonitorSource | null
  recentSources: SourceMonitorSource[]
  setSource: (s: SourceMonitorSource | null) => void
  clearSource: () => void
  playing: boolean
  currentTime: number
  duration: number
  play: () => void
  pause: () => void
  seek: (seconds: number) => void
  inPoint: number | null
  outPoint: number | null
  markIn: () => void
  markOut: () => void
  clearMarks: () => void
}
```

Behavior:
- `setSource` — runtime kind guard (R50): if `s !== null && s.kind !== 'audio' && s.kind !== 'video'`, `console.warn` + return; do NOT mutate.
- On valid `setSource`, push previous source onto `recentSources` (LIFO, dedup by path, cap 10 — R23-R25).
- Reset transport state: `currentTime=0`, `duration=0`, `playing=false`, `inPoint=null`, `outPoint=null`.
- `markIn` / `markOut` / `clearMarks` no-op when `source === null` OR `duration <= 0` (R22).
- `markIn` clamped to `[0, duration]`; if existing `outPoint < new inPoint`, clear `outPoint` (R17, R19).
- `markOut` symmetric.
- On project switch (`projectName` change via parent prop), call `clearSource()` and reset stack (R28).

### 2. `SourceMonitorPanel.tsx`

Layout (per spec ASCII at "Panel rendering" section):
- Header: label + recent-sources dropdown + "Reveal properties" button (disabled if `source.poolSegmentId` undefined).
- Media area:
    - `source === null` → empty state "Select a media item to preview" (R10).
    - `source.kind === 'video'` → `<video src={url} />` (R8). Listen to `loadedmetadata` for `duration`, `timeupdate` for `currentTime`, `error` for missing-file state (R11).
    - `source.kind === 'audio'` → `<audio>` element + waveform via existing `AudioWaveform`-style component fed from `/api/projects/:name/pool/:seg_id/peaks` using `source.poolSegmentId` (R9). Same event listeners.
- Transport strip: play/pause button, scrub bar with `[I]` `[O]` notches, timecode in `M:SS.f / M:SS.f` format using `Timeline.tsx`'s `fmtTimestamp` formula (R14), mark-in/mark-out/clear-marks buttons, volume slider for audio.
- Bind `Space` keyup to `play/pause` toggle ONLY when the panel root has `:focus-within` (R49).

URL resolver: `${API_URL}/api/projects/${encodeURIComponent(projectName)}/files/${path.split('/').map(encodeURIComponent).join('/')}` (R8).

### 3. `PanelLayoutHandle.revealPanel(panelId)` (R51, R52)

Three-case handling:
1. Panel is the active tab in some group → no-op.
2. Panel is a tab but not active → activate it.
3. Panel is not in the layout at all → re-add to last-known group (from workspace-view) or to the source-monitor's group as fallback, then activate.

After case 3, layout auto-saves via existing `saveWorkspaceView('_autosave_v3', ...)` so the re-add survives reload.

### 4. `EditorPanelLayout.tsx` updates

- Add `'source-monitor': { component: SourceMonitorPanelComponent, title: 'Source Monitor' }` to the `panels` registry.
- Default layout: change `preview-group` from `tabs: ['preview']` to `tabs: ['preview', 'source-monitor'], activeTab: 'preview'`.
- Wrap the `PanelLayout` children with `<SourceMonitorProvider projectName={data.projectName}>` (sibling-level to `PreviewProvider`, `EditorStateProvider`).
- After `setSource` is called with non-null, call `panelLayoutRef.current?.activateTab?.('source-monitor')` (R3). NEVER auto-activate on `setSource(null)` (R4).

### 5. Tests

`SourceMonitorContext.test.ts` (vitest, no DOM):
- `setSource pushes previous to recent` (R23)
- `setSource dedupes by path` (R24)
- `setSource caps recent at 10` (R25)
- `setSource null clears source` (R47)
- `setSource invalid kind warns and no-ops` (R50)
- `markIn no-op when source null OR duration <= 0` (R22)
- `markIn clamps to duration` (R17)
- `markOut before markIn clears markIn` (R19, symmetric)
- `clearMarks zeros both` (R20)
- `project switch clears source + recent` (R28)

`SourceMonitorPanel.test.tsx` (vitest + happy-dom):
- `empty state when source null` (R10)
- `video source mounts <video>` (R8)
- `audio source mounts <audio> + fetches peaks` (R9)
- `missing-file shows source unavailable` (R11)
- `transport play/pause toggles state` (R12)
- `timecode renders M:SS.f format with zero-padding` (R14)
- `Space toggles play/pause when panel is focused` (R49)
- `Space passes through when panel is not focused` (R49)
- `Reveal Properties disabled when no poolSegmentId` (R39)
- `revealPanel handles all three Properties states` (R51)

---

## Verification

- [ ] `agent/index/local.main.yaml` weighted entry for the source-monitor spec is loadable and not stale
- [ ] All listed files created at the listed paths
- [ ] All tests pass via `npx vitest run src/components/editor/__tests__/SourceMonitor*.test.*`
- [ ] `npx tsc --noEmit` reports no new errors in the new files
- [ ] Manual smoke: load a project, open the source-monitor tab, verify empty state renders
- [ ] No backend changes required (no engine repo edits)
