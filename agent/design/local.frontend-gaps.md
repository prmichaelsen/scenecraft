# Frontend Gaps: Remaining Editor Features

**Concept**: Narrative section editor, transition boundary dragging with remap, multi-slot transition preview, suppression zone editing, and auto-save points
**Created**: 2026-03-29
**Status**: Design Specification

---

## Overview

The beatlab-synthesizer editor has a functional timeline with keyframes, transitions, effects, bin, import, version history, and timeline switching. This document covers the remaining frontend features needed for a complete editing experience: editing musical analysis sections, dragging transition boundaries (with speed remap), previewing multi-slot transitions, creating/editing beat suppression zones, and auto-committing after expensive operations.

---

## Problem Statement

- **Musical sections are read-only**: Section data displays as color bands on the timeline but cannot be edited. Users must edit `narrative.yaml` by hand.
- **Transition duration is fixed**: Transition boundaries cannot be dragged to adjust duration. The `remap` field exists but has no UI for adjusting playback speed.
- **Multi-slot transitions have no UI**: Transitions with `slots > 1` have multiple video segments but the preview only plays `slot_0`. No way to view or select candidates for other slots.
- **Suppression zones have no editor**: The data model supports suppression zones (mute auto-beats in time ranges) and they render on the FX track, but there's no way to create, resize, or delete them.
- **No auto-save**: Expensive operations (generation, selection) don't auto-commit, so users can lose work if they forget to save a version.

---

## Solution

### Feature 1: Narrative Section Editor

A dedicated panel (or tab in an existing panel) for viewing and editing the musical analysis sections from `narrative.yaml`.

**UI**: New "Sections" tab accessible from the toolbar or as a side panel. Each section is an expandable card showing:

```
┌─ 1A: Ethereal Opening ──────────────────┐
│ Start: 0:00   End: 0:25                 │
│ Mood: dreamy, serene                    │
│ Energy: low                              │
│ Instruments: vocals, ethereal pads       │
│ Motifs: PAD-VERSE-1A                    │
│ Visual Direction: Slow, gentle...        │
│ Notes: [editable textarea]              │
│                                    [Save]│
└──────────────────────────────────────────┘
```

**Interactions**:
- Click a section card to expand/collapse
- Edit any field inline (text inputs for mood/energy, tag inputs for instruments/motifs)
- Notes is a multi-line textarea
- Save persists to `narrative.yaml` via `POST /narrative`
- Click a section's time range to seek the playhead there
- Color bands on the timeline highlight when hovering over the corresponding section card

**Data flow**: `EditorData.narrativeSections` → `NarrativeSectionPanel` → `POST /narrative` to save. The backend (already implemented) serves `GET /narrative` and `POST /narrative`.

### Feature 2: Transition Boundary Dragging

Dragging the edges of transition bars adjusts `duration_seconds` and `remap.target_duration`, which controls playback speed of the generated video.

**Behavior**:
- Drag the **left edge** of a transition bar → adjusts `from` keyframe's position (same as keyframe boundary drag, already implemented)
- Drag the **right edge** of a transition bar → moves the `to` keyframe, changing the transition's timeline duration
- The generated video duration stays fixed (Veo output is fixed-length). The `remap.target_duration` changes to match the new timeline span.
- Preview playback rate auto-adjusts: `playbackRate = videoDuration / newTimelineDuration`

**Visual feedback**:
- While dragging, show the current playback speed as a tooltip: `1.3x` or `0.7x`
- Color the transition bar differently when speed differs significantly from 1.0x (e.g., orange tint for >1.5x, blue tint for <0.5x)

**Persistence**: On drag end, update the transition's `remap.target_duration` via `POST /update-transition-action` or a new `POST /update-transition-remap` endpoint.

**Implementation approach**:
- Add edge drag handles to `TransitionTrack` (similar to `VideoTrack` edge handles)
- On drag, compute new `to` keyframe time
- Update both the keyframe timestamp and the transition's remap
- The `TransitionVideoPreview` already handles arbitrary playback rates

### Feature 3: Multi-Slot Transition Preview

Transitions with `slots > 1` have multiple sequential video segments. The preview should chain through them.

**Behavior**:
- For a 2-slot transition spanning 12s with two 6s videos:
  - 0-6s into the transition: play slot_0 video
  - 6-12s: play slot_1 video
- Each slot has its own candidates in the Videos tab
- The Videos tab groups candidates by slot (already done)
- The preview seamlessly chains between slot videos

**Implementation**:
- `TransitionVideoPreview` (or the unified `BeatEffectPreview`) determines which slot index to play based on `progress * numSlots`
- Compute per-slot progress: `slotProgress = (overallProgress * numSlots) % 1`
- Switch `videoSrc` when crossing slot boundaries
- Each slot can have different playback rates if their durations differ

### Feature 4: Suppression Zone Editing

Users need to create, resize, and delete suppression zones on the FX track to mute auto-detected beats in specific time ranges.

**UI**:
- **Create**: Hold Shift + drag on the FX track to create a suppression zone (red-tinted region)
- **Resize**: Drag the edges of an existing suppression zone
- **Delete**: Right-click or click a suppression zone + press Delete
- **Visual**: Suppression zones already render as red-tinted regions (implemented)

**Data model** (already defined):
```typescript
type BeatSuppression = {
  id: string
  from: number  // start time in seconds
  to: number    // end time in seconds
}
```

**Persistence**: Suppressions are stored in `beats.yaml` alongside user effects. The `POST /effects` endpoint already accepts `suppressions[]`.

### Feature 5: Auto-Save Points

Certain operations should auto-commit to the project's git repo to ensure save points exist without user intervention.

**Operations that trigger auto-save**:
- After keyframe candidate selection (`select-keyframes`)
- After transition candidate selection (`select-transitions`)
- After generation completes (keyframe or transition candidates)
- After bulk import

**Implementation**:
- After the operation's API call returns success, fire `POST /version/commit` with message `auto: <operation description>`
- Don't block the UI on the commit — fire and forget
- Show a subtle toast/indicator: "Auto-saved: Selected kf_001 candidate"
- The Version History panel shows auto-saves with a distinct style (e.g., gray text, "auto" prefix)

**Not auto-saved** (too frequent, user should save manually):
- Keyframe/transition drag (timestamp changes)
- Prompt edits
- Effect placement

---

## Benefits

- **Complete editing workflow**: Every piece of project data is editable from the UI
- **Non-destructive speed adjustment**: Transition boundary dragging changes remap, not the generated video
- **Multi-slot support**: Full pipeline for complex transitions with intermediate keyframes
- **Fine-grained beat control**: Suppress auto-beats in sections where the detection is wrong
- **Safety net**: Auto-save after expensive operations prevents losing GPU-generated assets

---

## Trade-offs

- **Transition boundary dragging complexity**: Moving a transition edge also moves the adjacent keyframe. The cascade of position changes needs careful handling to avoid breaking other transitions.
- **Multi-slot video switching**: Seamless crossfade between slot videos would require WebGL blending. Initial implementation will be a hard cut between slots.
- **Auto-save commit frequency**: Too many auto-commits can clutter version history. Mitigated by: distinct "auto:" prefix, possible future "squash auto-saves" feature.
- **Suppression zone UX**: Shift+drag is discoverable only with a tooltip or documentation. Could add a "Add suppression" button as alternative.

---

## Dependencies

- **Backend (all implemented)**: `POST /narrative`, `GET /narrative`, `POST /version/commit`, `POST /effects`
- **Existing components**: `EffectsTrack` (suppression rendering), `BeatEffectPreview` (video playback), `TransitionTrack` (transition rendering), `VersionHistoryPanel` (commit UI)
- No new npm dependencies

---

## Testing Strategy

- **Narrative editor**: Edit a section's mood, save, reload — verify persistence
- **Transition boundary drag**: Drag right edge of tr_001, verify remap.target_duration changes, verify preview plays at new speed
- **Multi-slot**: Load a 2-slot transition, seek to second half, verify slot_1 video plays
- **Suppression zones**: Create zone via Shift+drag, verify auto-beats are muted in that range during preview playback
- **Auto-save**: Select a keyframe candidate, verify version history shows auto-commit

---

## Migration Path

1. **Phase 1 — Narrative section editor**: Build `NarrativeSectionPanel`, wire to `POST /narrative`
2. **Phase 2 — Transition boundary drag**: Add edge handles to `TransitionTrack`, update remap on drag end
3. **Phase 3 — Multi-slot preview**: Update `BeatEffectPreview` to chain slot videos
4. **Phase 4 — Suppression zone editing**: Add Shift+drag creation, edge resize, delete to `EffectsTrack`
5. **Phase 5 — Auto-save points**: Add fire-and-forget commit calls after expensive operations

---

## Key Design Decisions

### Narrative Editor

| Decision | Choice | Rationale |
|---|---|---|
| Location | Side panel tab or toolbar button | Consistent with KeyframePanel/TransitionPanel pattern |
| Edit granularity | Per-field inline editing | Quick edits without a full form modal |
| Sync with timeline | Click section → seek playhead | Natural connection between analysis and visual timeline |

### Transition Boundary Dragging

| Decision | Choice | Rationale |
|---|---|---|
| What moves | The adjacent keyframe | Transitions don't have independent start/end — they span between keyframes |
| Speed display | Tooltip during drag | Non-intrusive, shows exactly what the remap will be |
| Persistence | Update remap.target_duration | Existing field, already used by video preview playback rate |

### Multi-Slot Preview

| Decision | Choice | Rationale |
|---|---|---|
| Slot switching | Hard cut at slot boundary | Simple, correct; crossfade is a future enhancement |
| Slot determination | `Math.floor(progress * numSlots)` | Even distribution of timeline duration across slots |

### Suppression Zones

| Decision | Choice | Rationale |
|---|---|---|
| Creation gesture | Shift + drag on FX track | Distinct from double-click (add effect) and regular drag (reposition effect) |
| Deletion | Click + Delete key | Consistent with keyframe deletion |
| Storage | beats.yaml suppressions[] | Already defined, already persisted |

### Auto-Save

| Decision | Choice | Rationale |
|---|---|---|
| Trigger | After expensive operations only | Avoids commit spam from frequent edits |
| Blocking | Fire and forget | Don't slow down the UI for a safety-net commit |
| Message format | `auto: <description>` | Distinguishable from manual saves in version history |

---

## Future Considerations

- **Crossfade between transition slots**: WebGL blending at slot boundaries for seamless multi-slot playback
- **Section-aware keyframe generation**: Auto-generate keyframe prompts from narrative section analysis
- **Squash auto-saves**: Combine consecutive auto-commits into one in version history
- **Suppression zone presets**: "Suppress all beats in verses" based on section labels
- **Transition speed curves**: Non-linear remap (ease-in, ease-out) instead of linear speed change

---

**Status**: Design Specification
**Recommendation**: Implement Phase 1 (narrative editor) and Phase 2 (transition boundary drag) first — they have the most user impact
**Related Documents**: [local.keyframe-editor](local.keyframe-editor.md), [local.yaml-split](local.yaml-split.md), [local.project-versioning](local.project-versioning.md)
