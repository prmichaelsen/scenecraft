# Milestone 20: Source Monitor Panel

**Goal**: Ship a general-purpose source monitor panel — a Premiere-style preview surface that sits alongside the program monitor, plays any pool_segment (audio waveform or video), supports independent transport + in/out markers + subclip drag-to-timeline, and exposes both an imperative `setSource` hook and a declarative plugin contribution point. Unifies inline previews across music gen, Bin, isolate vocals, and timeline video clips. Also unblocks finalize-range (which depends on this surface for its rendered-preview viewer).
**Duration**: ~3 days (~17h)
**Dependencies**:
- M11 plugin scaffolding (PluginHost + plugin_api + panel registry — all done)
- M16 music generation plugin (provides one of the consumer panels — done)
- M17 light show / track contribution point (in progress; not blocking — source monitor's panel registration is independent of track-type contribution)
- Existing `selected_transitions` cache, `pool_segments`, and `transitions.selected` columns (all in place)
- Existing `/api/projects/:name/files/:path` and `/api/projects/:name/pool/:seg_id/peaks` endpoints (no backend work)

**Status**: Not Started

---

## Overview

Implements the spec at `agent/specs/local.source-monitor-panel.md` (53 numbered requirements, all 8 OQs resolved, ~30 language-agnostic tests). Panel registers as `source-monitor` in the existing `PanelRegistry` and lives as a tab in the preview panel group by default. Auto-activates when any caller invokes `setSource(...)`. Independent playhead, transport (play/pause/scrub/timecode in `M:SS.f` format matching `Timeline.tsx`'s `fmtTimestamp`), in/out markers, Premiere-style session-scoped recent-sources stack (cap 10).

Drag-to-timeline is kind-aware:
- **Audio** → emits `application/x-scenecraft-pool-path` + `application/x-scenecraft-in-out`; receiving lane creates an `audio_clips` row with `source_offset = inSeconds` and length = `outSeconds − inSeconds`.
- **Video** → emits `application/x-scenecraft-video-subclip`; the timeline drop handler runs **insert-and-consume** semantics matching the project's "consume on overlap" mental model — partial coverage at boundaries triggers `split-transition` (existing primitive at `api_server.py:6941`), full-coverage rows are soft-deleted, the new transition between boundary kfs carries the subclip at native 1.0 rate. Whole drop wraps in one `undo_begin` group.

Plugin integration is progressive enhancement: declare `contributes.sourceMonitorProvider` in `plugin.yaml` for auto-wired right-click menus, OR call `useSourceMonitor().setSource(...)` imperatively. The right-click wiring uses the existing `ContextMenuProvider` subscription pattern (not extending Timeline.tsx inline) so all callers — Bin, music gen, isolate vocals, plugin-contributed entities — share one path.

**Design references**:
- `agent/design/local.source-monitor-panel.md` — what/why, alternatives rejected, migration path
- `agent/specs/local.source-monitor-panel.md` — exact behavior contract, all R1-R53 + tests
- `agent/clarifications/clarification-13-source-monitor-panel.md` — 30 answered design questions (gitignored, local-only)
- `agent/design/local.finalize-range.md` — primary downstream consumer; will reuse this panel for its rendered-preview viewer

---

## Deliverables

### 1. Source monitor panel shell (task-163)
- `src/components/editor/SourceMonitorContext.tsx` — `useSourceMonitor()` hook with discriminated-union `SourceMonitorSource` type (audio requires `poolSegmentId`; video keeps it optional)
- `src/components/editor/SourceMonitorPanel.tsx` — render shell: media area (`<video>` or `<audio>` + waveform via existing peaks endpoint), transport (play/pause/scrub/`M:SS.f` timecode), in/out marker buttons, Reveal Properties action, recent-sources dropdown, missing-file "source unavailable" state
- `src/components/editor/EditorPanelLayout.tsx` updates — register `source-monitor` panel; add to default preview-panel-group; auto-activate tab on `setSource`
- `PanelLayoutHandle.revealPanel(panelId)` method — handles already-active / inactive-tab / removed cases (R51, R52)
- Focus-scoped `Space` keyboard shortcut for play/pause (R49)
- Runtime kind-validation guard in `setSource` — invalid kind logs warn + no-op (R50)
- Vitest tests for: load/empty/missing-file/transport/timecode/markers/recent-sources/Space-focused/Space-unfocused/revealPanel cases
- ~6h

### 2. Music gen panel: single-click row → setSource (task-164)
- Wire single-click on a `RunCard` track row to call `useSourceMonitor().setSource({ kind: 'audio', path: tr.pool_path, label: tr.song_title || 'song', poolSegmentId: tr.pool_segment_id })`
- Inline `▶` PoolAudioPlayButton on each row STAYS — `event.stopPropagation` so its click doesn't bubble up to the row's setSource handler
- Vitest tests for: row-click loads source; inline ▶ click does NOT load source
- ~1h

### 3. Bin panel: single-click pool item → setSource (task-165)
- Wire single-click on a Bin pool item to call `setSource` with `kind` matching the segment kind, `path = pool_path`, `label = label || basename(pool_path)`, `poolSegmentId = id`
- Existing hover-preview behavior in the program-preview panel is unchanged
- Distinguish click from drag-start via mouse-movement threshold (~5px) so dragging to the timeline still works
- Vitest tests for: click loads source; hover preview unchanged; drag still drops to timeline
- ~2h

### 4. Isolate vocals: single-click row + keep inline ▶ (task-166)
- Wire single-click on a stem row to call `setSource` with `kind: 'audio'`
- Existing inline `PoolAudioPlayButton` on each row STAYS (mirrors music gen — quick-listen + detail view coexist)
- `event.stopPropagation` on the inline button so click→play doesn't also trigger setSource
- Vitest tests for: row-click loads source; inline ▶ still works and doesn't load source
- ~1h

### 5. Timeline video clip right-click → "Open source in source monitor" (task-167)
- New `ContextMenuProvider` subscription registers an entry against `entityType: 'transition'` (R53)
- Resolution: read `transition.selected` (pool_segment_id, slot 0 if array) → look up `pool_segments` row → call `setSource({ kind: 'video', path: <pool_segment.pool_path>, label: <transition.label || pool_segment.label || basename(pool_path)>, poolSegmentId: <pool_segment.id>, metadata: { transitionId, trim_in, trim_out } })` (R46)
- Trim metadata is informational only — do NOT auto-apply trim_in/trim_out as in/out markers
- Menu item disabled when `transition.selected` is null/empty
- Vitest tests for: menu fires setSource with resolved path; disabled when no selected; trim metadata informational only
- ~3h

### 6. Plugin contribution point: `contributes.sourceMonitorProvider` (task-168)
- Extend `plugin.yaml` schema validator to accept the new contributes entry (R33)
- At plugin activation, the core app reads declared providers and wires standard right-click menu entries on matching entity kinds via the same ContextMenuProvider used in task-167 (R34)
- Plugins without the declaration still work via imperative `setSource` (R35) — the contribution point is purely additive
- Vitest tests for: plugin with declared provider gets auto-wired menu entry; plugin without declaration can still call setSource imperatively
- Documentation comment in `plugin-host.ts` showing the example manifest snippet
- ~4h

---

## Success Criteria

All 53 requirements R1–R53 in the spec must pass. Summary:

- [ ] `source-monitor` appears as a tab in the default preview panel group on a fresh project
- [ ] `setSource` from any caller auto-activates the tab; passing `null` does NOT activate
- [ ] Audio sources render as waveform (via peaks endpoint); video sources render as `<video>`
- [ ] Empty state, missing-file ("source unavailable"), and transport (play/pause/scrub/timecode in `M:SS.f`) all work
- [ ] In/out markers settable, with crossed-marker invariant; no-op when source null OR duration ≤ 0
- [ ] Audio drag with marks → `audio_clips` row with correct `source_offset` + length; without marks → full-range (existing behavior preserved)
- [ ] Video drag with marks → boundary kfs + transition between with `selected = source.poolSegmentId`, `trim_in/trim_out` matching markers; **insert-and-consume** runs (split on partial coverage, soft-delete on full)
- [ ] Recent sources stack: cap 10, dedup by path, session-scoped, empty after reload
- [ ] Music gen single-click loads source; inline ▶ still works independently
- [ ] Bin single-click loads source; hover-preview behavior unchanged
- [ ] Isolate vocals single-click loads source; inline ▶ still present
- [ ] Timeline video clip right-click resolves through `tr.selected → pool_segments`, NOT through `selected_transitions` cache
- [ ] Reveal Properties works in all three states (active / inactive / removed)
- [ ] `Space` toggles play/pause when source-monitor has focus; passes through to timeline otherwise
- [ ] Invalid `kind` runtime values → warn + no-op, no throw, no source mutation
- [ ] Plugin manifest with `contributes.sourceMonitorProvider` produces auto-wired right-click menu entry
- [ ] Plugin without manifest declaration can still call `setSource` imperatively
- [ ] No backend REST, WS, or schema changes were required
- [ ] Single undo group: video subclip drop reverts entirely with one Ctrl+Z

---

## Out of Scope

Per spec Non-Goals:

- Persistence across reloads (source state always empty on reload)
- Sync-to-program-monitor playhead toggle (independent playhead only in v1)
- Variable playback speed / JKL scrub (1x only)
- Cover art display for music gen tracks with `cover_url`
- Loop markers on the in/out range
- Multi-source compare mode (A/B)
- Zoom on the waveform
- `variant_kind` stamp on subclip-created entities (FK chain already propagates color)
- Keyboard shortcuts beyond `Space` (JKL, I, O, etc.) — Future
- Finalize-range integration (lands when finalize-range milestone is built)
- The paste-group skip-on-overlap → consume-on-overlap fix (separate bug — see `local.source-monitor-panel.md` Related Artifacts)

---

## Risks / Mitigations

| Risk | Mitigation |
|---|---|
| Insert-and-consume video drop deletes user data without a confirmation | Wrapped in single `undo_begin` group → one Ctrl+Z reverts. If consumed range contains "interesting" content (named labels, generated variants), surface a non-blocking toast summarizing the consume. |
| Auto-activate tab steals focus from program monitor mid-edit | Only auto-activate on user-initiated `setSource` (click handlers). NEVER auto-activate from WS events or background updates. |
| `revealPanel` re-add lands in an unexpected group, surprising the user | Prefer last-known group from workspace-view; fall back to the source-monitor's group as a sensible default. Layout auto-saves so the user can rearrange once and have it stick. |
| Plugin contribution point widens the manifest schema in a way that's hard to evolve | Optional fields only (`label?`); core app falls through to defaults if missing. Adding new fields later is additive. |
| `Space` shortcut collides with timeline's existing handler | Focus-scoped: only fires when source-monitor or one of its descendants is the active focus owner. Timeline-focused spacebar passes through unchanged. |

---

## Tasks

1. [task-163: Source monitor panel shell + context + revealPanel + Space + runtime guard](../tasks/milestone-20-source-monitor-panel/task-163-source-monitor-panel-shell.md) — 6h
2. [task-164: Music gen panel single-click → setSource](../tasks/milestone-20-source-monitor-panel/task-164-music-gen-single-click.md) — 1h
3. [task-165: Bin panel single-click → setSource](../tasks/milestone-20-source-monitor-panel/task-165-bin-single-click.md) — 2h
4. [task-166: Isolate vocals single-click → setSource](../tasks/milestone-20-source-monitor-panel/task-166-isolate-vocals-single-click.md) — 1h
5. [task-167: Timeline video clip right-click via ContextMenuProvider](../tasks/milestone-20-source-monitor-panel/task-167-timeline-video-clip-right-click.md) — 3h
6. [task-168: Plugin contributes.sourceMonitorProvider wiring](../tasks/milestone-20-source-monitor-panel/task-168-source-monitor-provider-contribution.md) — 4h

**Total**: ~17h. Tasks 164-168 are independent of each other; they can run as parallel worktrees stacked on task-163's branch.
