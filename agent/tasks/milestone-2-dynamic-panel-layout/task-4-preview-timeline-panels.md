# Task 4: Extract Preview and Timeline Panels

**Milestone**: [M2 - Dynamic Panel Layout](../../milestones/milestone-2-dynamic-panel-layout.md)  
**Design Reference**: [Dynamic Panel Layout](../../design/local.dynamic-panel-layout.md)  
**Estimated Time**: 6-8 hours  
**Dependencies**: [Task 3: EditorLayout Shell](task-3-editor-layout-shell.md)  
**Status**: Not Started  

---

## Objective

Extract the video preview (BeatEffectPreview canvas) and timeline tracks (ruler, marker track, video tracks, audio track, FX track, etc.) from Timeline.tsx into standalone dockview panel components. This is the largest extraction — Timeline.tsx is ~2400 lines.

---

## Context

Timeline.tsx currently contains everything: preview, controls bar, timeline tracks, playhead, and all panel rendering. This task splits it into:
- `PreviewPanel.tsx` — video preview canvas + BeatEffectPreview
- `TimelinePanel.tsx` — controls bar + scrollable timeline tracks + playhead

State that's shared between preview and timeline (currentTime, playback, selected items) needs to live in the EditorLayout context or be passed via dockview params.

---

## Steps

### 1. Identify Shared State

Audit Timeline.tsx for state used by both preview and timeline:
- `currentTime`, `isPlaying`, `playbackRate` (playback)
- `selectedKeyframe`, `selectedTransition`, `selectedEffect` (selection)
- `data` (EditorData from route loader)
- Frame cache refs, audio element ref

### 2. Create Shared Editor Context

Create `useEditorState` hook/context that holds shared state. Both PreviewPanel and TimelinePanel consume this context.

### 3. Extract PreviewPanel

Move the preview area (BeatEffectPreview, preview canvas, transition preview) into `src/components/editor/PreviewPanel.tsx`. Register as dockview component.

### 4. Extract TimelinePanel

Move controls bar, time ruler, all track components, playhead overlay, and scroll container into `src/components/editor/TimelinePanel.tsx`. Register as dockview component.

### 5. Remove Extracted Code from Timeline.tsx

Timeline.tsx should become thin — just re-exports or gets deleted entirely if all code moves to EditorLayout + panel components.

### 6. Verify Playback Works

Play/pause, scrubbing, keyboard shortcuts, and preview rendering must all work across the panel boundary.

---

## Verification

- [ ] Preview renders in its own dockview panel
- [ ] Timeline tracks render in their own dockview panel
- [ ] Play/pause controls the preview and timeline in sync
- [ ] Scrubbing (click ruler, drag playhead) works
- [ ] Keyboard shortcuts (space for play/pause, arrow keys) work
- [ ] Preview resizes correctly when panel is resized
- [ ] No duplicate state or broken refs

---

**Next Task**: [Task 5: Migrate property panels](task-5-property-panels.md)  
**Related Design Docs**: [local.dynamic-panel-layout.md](../../design/local.dynamic-panel-layout.md)  
