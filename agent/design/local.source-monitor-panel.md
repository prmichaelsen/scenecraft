# Source Monitor Panel

**Concept**: General-purpose preview surface for any `pool_segment` — audio (waveform) or video — with independent playhead, in/out markers for subclip drag to timeline, and single-click loading from Bin / music gen / isolate vocals.
**Created**: 2026-04-24
**Status**: Proposal
**Version**: 1.0.0

---

## Overview

Scenecraft has accumulated several inline preview surfaces — the music gen panel ships per-track ▶ buttons, the isolate vocals panel has its own `PoolAudioPlayButton`, the Bin shows hover-previews in the program preview panel, and `local.finalize-range.md` proposes a video preview surface for finalized ranges. None of these support scrubbing, in/out markers, or subclip extraction. Each plugin that wants "listen to this before committing to a timeline drop" has been reinventing the wheel.

This design introduces a **source monitor panel**: a general-purpose preview surface that sits alongside the program monitor (the existing timeline preview). Any plugin can push any `pool_segment` into it; the panel decides video vs waveform rendering from the declared media kind. It supports independent transport, in/out markers, and drag-to-timeline as either an audio clip or a kf+tr pair depending on source kind.

This is the NLE "source vs program" pattern (Premiere, Avid, Final Cut) — the program monitor shows the active edit, the source monitor shows source material you're evaluating.

---

## Problem Statement

- **Duplicated inline previews.** Each plugin (music gen, isolate vocals, foley, future) writes its own inline player. They drift in UX, controls, and affordances.
- **No scrub, no I/O markers, no subclip.** Inline ▶ buttons play linearly end-to-end. Users can't mark a specific range of a 4-minute music gen track to drop onto the timeline.
- **Finalize-range needs a preview surface.** `local.finalize-range.md` explicitly specifies a `source-monitor` panel for previewing rendered range MP4s but leaves implementation open.
- **No shared contract.** Plugins can't register "preview this entity" actions in a standard way, so right-click menus and click-handlers are bespoke per plugin.

Without this panel: finalize-range stays blocked on a missing dependency, inline previews keep proliferating, and subclipping from source material requires manual math on timestamps.

---

## Solution

A dockable `source-monitor` panel registered in the existing `PanelRegistry`. Lives in the **preview panel group** by default (sibling tab to the program monitor), auto-activates when a source is loaded, can be split for Premiere-style side-by-side dual-monitor layout.

Driven by a React context `useSourceMonitor()` with a discriminated-union source shape:

```ts
type SourceMonitorSource = {
  kind: 'video' | 'audio'
  path: string            // project-relative (e.g. "pool/segments/<uuid>.mp3")
  label: string           // display label (e.g. "Merged Motifs · v1")
  poolSegmentId?: string  // optional — enables "Reveal properties"
  metadata?: Record<string, unknown>  // caller-specific escape hatch
}
```

Any plugin (and any panel/menu) can call `setSource(source)` to load media. Plugins that want auto-wired right-click "Preview in source monitor" menu entries declare it in `plugin.yaml` via a `contributes.sourceMonitorProvider` contribution point; plugins that don't declare still work via imperative `setSource`.

The panel supports an independent playhead, transport controls (play/pause, scrub bar, timecode), in/out markers for subclip extraction, and drag-to-timeline. Drag semantics differ by source kind:

- **Video** → creates a new `keyframe + transition` pair at the drop position, with transition reconciliation against existing tr's (scenecraft's video model is kf+tr, not clip-based).
- **Audio** → creates an `audio_clips` row with `source_offset` + length derived from the I/O markers (standard clip model).

When no source is loaded, the panel shows a "Select a media item to preview" empty state. If the underlying file disappears (pool GC, delete, project switch), the panel shows a "source unavailable" state — never silently auto-closes. A Premiere-style recent-sources dropdown keeps the last N sources accessible within the session (not persisted across reloads).

**Rejected alternatives:**
- *Keep inline previews only.* Fails the subclip/scrub use case; doesn't unify UX.
- *Always in a dedicated top-strip slot.* Wastes screen space when no source is loaded; loses the tabbed-dock flexibility the rest of scenecraft uses.
- *Minimal `{ path, label }` contract with extension sniffing.* Unreliable (webm can be audio or video); callers already know the kind, so making them declare is cheaper than panel-side sniffing and prevents silent failures.
- *Persist source state across reloads.* Source monitor is ephemeral-by-nature; persistence complicates the "source unavailable after pool GC" case. Additive later if demanded.

---

## Implementation

### Panel registration

`EditorPanelLayout.tsx` `PanelRegistry`:

```ts
'source-monitor': { component: SourceMonitorPanelComponent, title: 'Source Monitor' }
```

Default layout: add as a **tab in the preview panel group** (sibling to the program monitor tab). When `setSource()` is called, the panel auto-brings-itself-to-front within its group (via `panelLayoutRef.current.activateTab('source-monitor')`).

### Context provider

`src/components/editor/SourceMonitorContext.tsx`:

```ts
type SourceMonitorContextValue = {
  source: SourceMonitorSource | null
  recentSources: SourceMonitorSource[]  // session-scoped stack
  setSource: (s: SourceMonitorSource | null) => void
  clearSource: () => void

  // Transport
  playing: boolean
  currentTime: number
  duration: number
  play: () => void
  pause: () => void
  seek: (seconds: number) => void

  // In/out markers
  inPoint: number | null
  outPoint: number | null
  markIn: () => void   // sets to currentTime
  markOut: () => void  // sets to currentTime
  clearMarks: () => void
}

export const useSourceMonitor = () => useContext(SourceMonitorContext)
```

Provider wraps the editor tree at the same level as `PreviewProvider`/`EditorStateProvider` in `EditorPanelLayout.tsx`.

### Panel rendering

```
┌─ Source Monitor ────────────────────── [Merged Motifs · v1] [Recent ▾] ─┐
│                                                                          │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                                                                 │   │
│   │     <video>  |  <WaveformView>  |  "Select a media item..."     │   │
│   │                                                                 │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│   ├──┼─[I]────────●────────────[O]──┤            0:47 / 2:48            │
│                                                                          │
│   ▶ ⏸   [mark in] [mark out] [clear]   🔊 ───●───    [Reveal props]    │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Media area**: conditional on `source.kind`:
  - `video` → `<video src={fileUrl}>` with `onTimeUpdate`/`onLoadedMetadata` feeding the context.
  - `audio` → an `<audio>` element for playback + a waveform view (reuse the `AudioWaveform` component / `peaks` endpoint the timeline already uses) with a moving cursor.
  - `null` → empty state.
  - Missing file → "source unavailable" state (detected via load error).
- **Scrub bar**: shows current position + in/out markers (`[I]` and `[O]` notches). Click-drag to scrub, click markers to jump.
- **Transport**: play/pause, mark in, mark out, clear marks. Volume slider for audio. v1 stays at 1x playback speed (no JKL / variable speed).
- **Header**: label + recent-sources dropdown. "Reveal properties" action (right-aligned) opens / focuses the Properties panel with the `poolSegmentId` loaded.
- **Timecode**: `M:SS / M:SS` format in the transport bar.

### Source URL resolution

The source monitor derives the file URL the same way other panels do:

```ts
const src = `${API_URL}/api/projects/${encodeURIComponent(projectName)}/files/${path
  .split('/').map(encodeURIComponent).join('/')}`
```

`path` is expected to include the `pool/` prefix (e.g. `pool/segments/<uuid>.mp3`) — matches the existing convention used by isolate_vocals, Bin imports, and (post-2026-04-24 fix) music gen.

### Plugin contribution point

`plugin.yaml`:

```yaml
contributes:
  sourceMonitorProvider:
    # Entity kinds this plugin provides for single-click/right-click preview.
    entityTypes: [pool_segment]
    # Optional — custom action label shown in menus. Defaults to "Preview in source monitor".
    label: "Preview generated track"
```

The core app reads declared providers at plugin activation and wires:
- Right-click menu item on matching entities → calls `setSource` with the entity resolved to a `SourceMonitorSource`.
- Click handler on standard list rows (when the plugin uses the standard row component).

Plugins that don't declare the contribution point can still call `useSourceMonitor().setSource(...)` imperatively from their own UI. Progressive enhancement: simple callers work out of the box, richer integration is opt-in.

### Drag-to-timeline

The panel exposes a drag handle (drag-grip icon) on the media area and on the header. `onDragStart` emits the appropriate payload based on `source.kind` + current in/out markers:

- **Audio** source →
  ```
  dataTransfer.setData('application/x-scenecraft-pool-path', source.path)
  dataTransfer.setData('application/x-scenecraft-in-out',
    JSON.stringify({ inSeconds: inPoint, outSeconds: outPoint }))
  ```
  `AudioLane`'s existing `onDropPoolAudio` handler extends to read the optional in/out and create an `audio_clips` row with `source_offset = inPoint` and length = `outPoint - inPoint`.

- **Video** source →
  ```
  dataTransfer.setData('application/x-scenecraft-video-subclip',
    JSON.stringify({ path, inSeconds, outSeconds, label }))
  ```
  Timeline / keyframe surface receives the drop, creates `keyframe` + `transition` rows at the drop position, and runs existing transition reconciliation (overlapping tr's nudged / trimmed).

When in/out aren't set, drag uses the full source range.

### Integration touchpoints

| Plugin / panel | v1 behavior |
|---|---|
| **Music gen panel** | Keep inline ▶ for quick-listen. Single-click on a track row also calls `setSource` to load into source monitor. |
| **Bin panel** | Hover-preview in program-preview panel stays. Single-click on a pool item calls `setSource`. |
| **Isolate vocals panel** | Keep the inline `PoolAudioPlayButton` (mirrors music gen). Single-click row also calls `setSource`. Inline ▶ for quick-listen; source monitor for scrub / I/O / detail. |
| **Timeline clip (video)** | Right-click → "Open source in source monitor" loads the original pre-trimmed media. |
| **Finalizations panel** (future, via `local.finalize-range.md`) | Row click loads `rendered_preview_path` as a video source. |

### No new REST endpoints

The panel consumes existing `/api/projects/:name/files/:path` for media streaming and the existing `/api/projects/:name/pool/:seg_id/peaks` endpoint for waveforms. No backend changes required beyond the file-serve endpoint already in place.

---

## Benefits

- **Unified preview UX.** One surface, one set of affordances, one implementation. Inline players can still exist for quick-listen but all scrub/subclip work flows through the source monitor.
- **Unblocks subclipping.** I/O markers + kind-aware drag payloads mean users can extract a specific range of a long music gen track or a finalized video without eyeballing timestamps.
- **Unblocks finalize-range.** The source monitor panel is a listed dependency of that design; this implementation satisfies it.
- **Plugin-friendly.** Open `setSource` contract + optional contribution point for declarative right-click wiring. Any future plugin that generates media gets preview for free.
- **Familiar.** NLE-standard pattern — Premiere users recognize it instantly.
- **No backend cost.** Reuses existing file-serve and peaks endpoints.

---

## Trade-offs

- **Video subclip is not a first-class entity.** Scenecraft's video model is kf+tr, not clip-based. Dragging a video subclip from the source monitor invokes reconciliation logic that may surprise users coming from clip-based NLEs (partial overlap warnings, etc.). Mitigation: clear preview modal when reconciliation is destructive, document the model in the panel's tooltip.
- **Plugin contribution point adds schema surface.** Another field on `plugin.yaml`. Mitigation: fully optional (imperative fallback). Adding it is cheap; dropping it later is cheap.
- **No persistence across reloads.** Users who reload mid-scrub lose their in/out markers and recent-sources stack. Mitigation: explicit v1 decision — shipping empty-on-reload is simpler and avoids "source unavailable after pool GC" on startup. Additive if requested.
- **Auto-activate on load can steal focus.** If the user is looking at the program monitor, `setSource` swaps the tab. Mitigation: only auto-activate on user-initiated `setSource` calls (click handlers), never on programmatic updates from WS events.
- **"Reveal properties" re-couples the source monitor to the Properties panel.** If the Properties panel isn't docked, the action needs a "where does it open" story. Mitigation: follow the pattern other panels use (activate if hidden, focus if visible); defer to existing workspace-view logic.

---

## Dependencies

- **Panel infrastructure** — `PanelRegistry`, `PanelLayout`, `buildPanelRegistry()` merger in `EditorPanelLayout.tsx`. ✅ already in place.
- **Plugin host** — `PluginHost.register_declared` + contribution point wiring for the optional `sourceMonitorProvider`. ✅ scaffold exists (generate_music, isolate_vocals use declared contributions).
- **Pool file serve** — `GET /api/projects/:name/files/:path` for media streaming. ✅ already in place; relies on the convention that `pool_segments.pool_path` starts with `pool/`.
- **Waveform peaks endpoint** — `GET /api/projects/:name/pool/:seg_id/peaks` for audio waveform rendering. ✅ already used by the timeline's `AudioWaveform` component.
- **No new backend work.** No schema changes, no REST, no WS.

---

## Testing Strategy

### Unit (frontend)

- `SourceMonitorContext` — setSource / clearSource / transport state machines / mark in-out invariants (inPoint <= outPoint, clamped to [0, duration]).
- `SourceMonitorPanel` render — empty state, audio rendering path, video rendering path, missing-file state.
- `buildDragPayload(source, inOut)` — correct `application/x-scenecraft-*` MIME + shape for each (kind, inOut) combo.
- Recent-sources stack — LIFO, de-dup on same path, max size.

### Integration (frontend)

- Music gen panel click → source loads → waveform renders with playhead cursor.
- Bin panel click on video pool item → video loads, transport controls respond.
- Mark in + mark out + drag to AudioLane → new `audio_clips` row has correct `source_offset` + duration.
- Mark in + mark out + drag to video timeline → new kf+tr pair at drop position with correct trim.
- Source file deleted between load and play → "source unavailable" state renders.
- Plugin activation with `contributes.sourceMonitorProvider` → standard right-click menu item appears on declared entity types.

### E2E

- Round-trip: generate music → single-click track → mark in/out → drag to timeline → hear clip play in correct range.

### No backend tests

No backend work.

---

## Migration Path

No existing code to migrate. Inline players stay during the rollout:

1. **M-N.1** — Build `SourceMonitorContext` + panel + registration in `PanelRegistry`. Ship with default layout including the new tab. Support audio + video kinds, transport, in/out markers, subclip drag.
2. **M-N.2** — Music gen panel: wire single-click row to `setSource`. Keep inline ▶. No behavior change unless user clicks row.
3. **M-N.3** — Bin panel: wire single-click on pool item to `setSource`. Hover preview unchanged.
4. **M-N.4** — Isolate vocals: replace inline `PoolAudioPlayButton` with single-click → `setSource`. Inline button removed.
5. **M-N.5** — Timeline clip: right-click "Open source in source monitor" for video clips.
6. **M-N.6** — `plugin.yaml` `contributes.sourceMonitorProvider` wiring (optional — imperative fallback works without).
7. **Future** — Finalizations panel (`local.finalize-range.md`) row click → `setSource` with video kind, label = `range_label v{version}`.

Each step is independently shippable and reversible.

---

## Key Design Decisions

### Scope

| Decision | Choice | Rationale |
|---|---|---|
| MVP scope | Broad from day 1 — accept any `pool_segment` | Covers music gen + Bin + stems via the data model; finalize-range (video) layers on top. Simpler contract, fewer rewrites than "one caller first." |
| Media kinds supported | Video + audio (with waveform viz) | Matches the set of pool_segment kinds that can be previewed. |
| Cover art display | No | Kept chrome lean; deferrable if requested. |
| Milestone placement | Own milestone (not folded into finalize-range) | Multiple features depend on this; shipping standalone unblocks them independently. |

### Interaction model

| Decision | Choice | Rationale |
|---|---|---|
| Playhead | Independent of program monitor | NLE standard. A/B "sync to program" toggle rejected for v1 (YAGNI). |
| Transport | Own strip inside the panel (not shared with program monitor) | Keeps the two surfaces cleanly separated. |
| Hot-swap the program monitor? | No — side-by-side tabs in the preview panel group | Standard NLE pattern; both surfaces stay visible when split. |
| Playback speed | 1x only for v1 | JKL / variable speed deferred. |
| In/out markers | Yes | Required for subclip extraction. |
| Subclip drag → timeline | Yes, kind-aware | Video creates kf+tr with reconciliation; audio creates `audio_clips`. |
| Recent sources | Premiere-style session-scoped stack | Flip back to a previous source without re-navigation. |
| Missing file behavior | "Source unavailable" state, no auto-close | Matches NLE offline-media pattern. |
| Persist source across reloads | No (always empty on reload) | Source monitor is ephemeral; avoids "unavailable after GC" on startup. |

### Visual design

| Decision | Choice | Rationale |
|---|---|---|
| Default layout slot | Tab in preview panel group (sibling to program monitor) | Auto-activates on load; users can split the group for side-by-side. |
| Empty state | Message ("Select a media item to preview") | Prefer affordance over hiding the tab. |
| Label display | Yes, in the panel header | Identifies which source is loaded. |
| Timecode | Yes (current / duration, M:SS format) | Standard transport affordance. |
| Metadata pane | No inline pane — "Reveal properties" action opens Properties panel | Reuses existing properties infra; keeps chrome lean. |
| Waveform for audio | Yes, with moving playhead cursor | Essential for scrubbing audio. |

### API

| Decision | Choice | Rationale |
|---|---|---|
| Hook shape | `useSourceMonitor()` → `{ source, setSource, clearSource, play, pause, seek, markIn, markOut, clearMarks }` | Covers all v1 operations; clean surface. |
| `setSource` payload | Discriminated union `{ kind: 'video'\|'audio', path, label, poolSegmentId?, metadata? }` | Caller knows the kind; explicit avoids unreliable extension sniffing. `poolSegmentId?` enables "Reveal properties"; `metadata?` is escape hatch. |
| Plugin integration | Both paths — declarative contribution point with imperative fallback | Progressive enhancement. Plugins that declare `contributes.sourceMonitorProvider` get auto-wired menus; plugins that don't can still `setSource` directly. |
| Caller authorization | Open contract (any plugin can push a source) | Keeps the surface flexible; no curation overhead. |

### Relationship to existing inline previews

| Plugin / panel | v1 decision | Why |
|---|---|---|
| Music gen panel | **Both** — inline ▶ stays; single-click row also loads into source monitor | Inline = quick-listen; source monitor = scrub / in-out / detail. |
| Bin panel | **Both** — hover preview stays; single-click loads into source monitor | Hover = ambient awareness; click = evaluation. |
| Isolate vocals panel | **Both** — inline ▶ stays; single-click row also loads into source monitor (harmonized with music gen on 2026-04-25) | Quick-listen via inline ▶, detail/scrub via source monitor. Mirrors music gen for consistency. |
| Timeline clip (video) | Right-click → "Open source in source monitor" | Surfaces the pre-trimmed media without leaving the timeline. |

### Urgency

| Decision | Choice | Rationale |
|---|---|---|
| Priority | Not blocking — backlog | Finalize-range isn't in flight; music gen inline ▶ works; isolate vocals has a working button. Slot when priorities allow. |

---

## Future Considerations

- **Persistence.** If users ask, add source + in/out + recent stack to workspace-view payload.
- **JKL / variable playback.** Defer to a later milestone when it becomes a pain point.
- **Volume automation preview.** Audio clips with a `volume_curve` could render the curve overlay during preview so users can evaluate automation before committing a clip.
- **Multi-source compare mode.** A/B preview toggle — load two sources, flip between them with a key. Useful for comparing music gen candidates or finalization versions.
- **Loop markers.** Let users loop a marked in/out range — useful when evaluating a specific passage repeatedly.
- **Zoom on waveform.** For long audio sources, pan + zoom the waveform to inspect sub-second detail.
- **Subclip metadata stamping.** When subclip drag creates a new `audio_clips` / kf+tr, stamp `source_variant_kind` on the created entity so the timeline's color map (music = purple, etc.) carries through.
- **Keyboard shortcuts.** J/K/L scrub, I/O mark, spacebar play/pause — Premiere conventions. Deferrable to post-v1.

---

**Status**: Proposal
**Recommendation**: Open a milestone for this design when backlog permits. Good candidate tasks: (1) `SourceMonitorContext` + panel shell, (2) music gen integration, (3) Bin integration, (4) isolate vocals migration, (5) video subclip drag + timeline receive, (6) plugin contribution point wiring. Ships in ~1 week of engineering.
**Related Documents**:
- `agent/clarifications/clarification-13-source-monitor-panel.md` — source clarification with 30 answered questions.
- `agent/design/local.finalize-range.md` — finalize-range depends on this panel for its "Preview" row action.
- `agent/design/local.interactive-preview-handles.md` — related preview-surface work.
