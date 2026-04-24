# Task 137: TrackType Contribution Point (Frontend)

**Milestone**: [M17 - Track Contribution Point and Light Show Plugin](../../milestones/milestone-17-track-contribution-point-and-light-show-plugin.md)
**Design Reference**: [local.track-contribution-point-and-light-show-plugin.md § Part 1](../../design/local.track-contribution-point-and-light-show-plugin.md)
**Estimated Time**: 8 hours
**Dependencies**: task-136 (needs `type` column on `tracks`)
**Status**: Not Started

---

## Objective

Add `registerTrackType` to the frontend `PluginHost`. Extract the existing video and audio track rendering into built-in registrations. Refactor `Timeline.tsx` to dispatch per-track rendering via the registry instead of hardcoded `if`/`else` blocks.

---

## Context

`Timeline.tsx:2574-2689` and `:2729-2823` currently render video and audio tracks via hardcoded loops. Adding a third track type today means adding a third block. The contribution point inverts this: track types register their renderer, Timeline iterates tracks and dispatches by type.

API validation is explicit: three consumers (video, audio, light_show) implement `TrackTypeContribution` at M17. The interface is defined by those three real use cases, not by one plugin plus two exceptions.

---

## Steps

### 1. Define `TrackTypeContribution` in `src/lib/plugin-host.ts`

```ts
export interface TrackRendererProps {
  track: Track
  pxPerSec: number
  scrollLeft: number
  viewportWidth: number
  currentTime: number
  onSelect?: (trackId: string) => void
  // additional shared row props from current Timeline
}

export interface TrackInspectorProps {
  track: Track
  onSave: (patch: Partial<Track>) => void
}

export interface TrackTypeContribution {
  id: string                                // 'video', 'audio', 'light_show'
  label: string                             // "Video", "Audio", "Light Show"
  icon?: React.ReactNode
  Renderer: React.FC<TrackRendererProps>
  Inspector?: React.FC<TrackInspectorProps>
  HeaderActions?: React.FC<{ track: Track }>
  onAdd?: (projectName: string) => Promise<Track>
  sortHint?: number                         // default ordering vs. other types in "Add Track" menu
  defaultHeight?: number                    // default row height in px
}
```

Add to `PluginHost`:
- `_trackTypes: Map<string, TrackTypeContribution>`
- `registerTrackType(contribution, context?): Disposable` — push to map, return dispose fn that removes
- `getTrackType(id): TrackTypeContribution | null`
- `listTrackTypes(): TrackTypeContribution[]` — sorted by `sortHint` ascending

### 2. Extract `VideoTrackType`

New file: `src/components/editor/tracks/VideoTrackType.ts`

Export a `VideoTrackType: TrackTypeContribution` object. `Renderer` wraps the existing `VideoTrack.tsx` + `TransitionTrack.tsx` composition. `Inspector` wraps the video-specific slice of `TrackSettingsPanel` (blend mode + chroma-key + base_opacity). `onAdd` calls the existing `postAddTrack` with `type='video'`.

```ts
export const VideoTrackType: TrackTypeContribution = {
  id: 'video',
  label: 'Video',
  Renderer: VideoTrackRenderer,   // wraps VideoTrack + TransitionTrack
  Inspector: VideoTrackInspector,
  onAdd: (projectName) => postAddTrack(projectName, { type: 'video' }),
  sortHint: 10,
  defaultHeight: 80,
}
```

### 3. Extract `AudioTrackType`

New file: `src/components/editor/tracks/AudioTrackType.ts`

Same shape. `Renderer` wraps `AudioLane.tsx`. `Inspector` wraps the audio portion of `TrackSettingsPanel` (volume curve). `onAdd` calls `postAddTrack` with `type='audio'`.

```ts
export const AudioTrackType: TrackTypeContribution = {
  id: 'audio',
  label: 'Audio',
  Renderer: AudioTrackRenderer,
  Inspector: AudioTrackInspector,
  onAdd: (projectName) => postAddTrack(projectName, { type: 'audio' }),
  sortHint: 20,
  defaultHeight: 60,
}
```

### 4. Register built-ins at editor bootstrap

In `EditorPanelLayout.tsx` or a bootstrap file, import and call:

```ts
PluginHost.registerTrackType(VideoTrackType)
PluginHost.registerTrackType(AudioTrackType)
```

These are "system" registrations — no plugin context, never disposed.

### 5. Refactor `Timeline.tsx` render loop

Replace the hardcoded loops (~lines 2574-2689 for video, ~2729-2823 for audio) with a single dispatching loop:

```tsx
{sortedTracks.map((track) => {
  const typeDef = PluginHost.getTrackType(track.type)
  if (!typeDef) return <UnknownTrackRow key={track.id} track={track} />
  const Renderer = typeDef.Renderer
  return (
    <div key={track.id} style={{ height: typeDef.defaultHeight ?? 80 }}>
      <Renderer track={track} pxPerSec={pxPerSec} scrollLeft={scrollLeft} viewportWidth={viewportWidth} currentTime={currentTime} />
    </div>
  )
})}
```

`sortedTracks` now includes ALL tracks (video + audio + any plugin types) sorted by `display_order`. Audio and video no longer render in separate sections — they're interleaved by `display_order`, which matches the new unified schema.

### 6. Update "Add Track" button menu

Replace the hardcoded "Add Video Track" button with a menu populated from `PluginHost.listTrackTypes()`. Each entry shows `label` + `icon`; click invokes `typeDef.onAdd(projectName)`.

### 7. Update `TrackSettingsPanel` dispatch

The existing `TrackSettingsPanel` has hardcoded conditional UI (`if (blendMode === 'chroma-key')` etc.). Replace its body with dispatch to `typeDef.Inspector`:

```tsx
function TrackSettingsPanel({ track }) {
  const typeDef = PluginHost.getTrackType(track.type)
  if (!typeDef?.Inspector) return null
  const Inspector = typeDef.Inspector
  return <Inspector track={track} onSave={...} />
}
```

Common fields (name, mute, solo, hidden) stay in the panel shell, rendered above the type-specific inspector.

### 8. Handle unknown track types gracefully

`UnknownTrackRow` renders a greyed-out row with the track name + a note "Unknown track type: {type}. Plugin may be disabled." Users shouldn't crash if a plugin is removed and its tracks remain.

### 9. Update `scenecraft-client.ts` `Track` type

```ts
export type Track = {
  id: string
  type: string                      // 'video' | 'audio' | ... (plugin-extensible)
  name: string
  displayOrder: number
  muted: boolean
  solo: boolean
  hidden?: boolean
  // type-specific fields no longer on base Track — fetched via type-specific endpoints
}
```

Type-specific data (blend_mode, volume_curve, etc.) moves off the base `Track` type. Components needing it fetch from type-specific endpoints or compute via the track-type registration.

### 10. Tests

- `registerTrackType` + `getTrackType` + `listTrackTypes` sorting behavior
- Dispose behavior (removal from registry)
- Duplicate-id registration rejection
- Visual regression: pre/post refactor screenshots of Timeline with mixed video + audio tracks — identical
- "Add Track" menu shows video + audio

---

## Verification

- [ ] `TrackTypeContribution` interface + `registerTrackType` methods added to `PluginHost`
- [ ] `VideoTrackType` and `AudioTrackType` extracted into dedicated files
- [ ] Built-in registrations wired at editor bootstrap
- [ ] Timeline render loop dispatches via registry; no per-type hardcoded branches remain
- [ ] "Add Track" button menu populated from `listTrackTypes()`
- [ ] `TrackSettingsPanel` dispatches to type-specific Inspector
- [ ] Visual parity with pre-refactor Timeline (video tracks + audio tracks render identically)
- [ ] Unknown-type tracks render a fallback row without crashing
- [ ] Type discriminant propagates through client types
- [ ] Unit + visual regression tests pass

---

## Key Design Decisions

### Interface surface

| Decision | Choice | Rationale |
|---|---|---|
| Slot set | `id, label, icon?, Renderer, Inspector?, HeaderActions?, onAdd?, sortHint?, defaultHeight?` | Observed needs across video/audio/light_show; extensions opt-in via `?` |
| Renderer responsibility | Entire row content including track-specific sublayers (transitions, clips) | Per-type renderer knows its own sublayering (video has transitions, audio has clips) |
| Inspector | Optional; only rendered when type has type-specific properties | Common fields stay in the panel shell |
| Backend coupling | Only via `type` column on `tracks`; no Python `registerTrackType` needed | Python routing is handled by each plugin's own REST endpoints |

---

## Notes

- This is the most edited-file refactor in M17. Behavioral parity with pre-refactor is the acceptance bar.
- Ship video + audio registrations first, verify behavior, then extend with light_show (task 140).
- Visual regression tests rely on golden frames — record before starting, compare after.

---

**Next Task**: [task-138-light-show-backend-skeleton.md](./task-138-light-show-backend-skeleton.md)
**Related Design Docs**: [local.track-contribution-point-and-light-show-plugin.md](../../design/local.track-contribution-point-and-light-show-plugin.md)
