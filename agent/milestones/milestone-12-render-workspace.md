# Milestone 12: Render Workspace

**Goal**: Ship a DaVinci Resolve–style Render Workspace — top-level workspace view with Render Settings (left) · Preview+Timeline (center) · Render Queue (right), per-job in/out ranges, VCS-snapshot isolation for background rendering, and full row actions (edit, rerun, duplicate, delete, reveal)
**Duration**: 3 weeks
**Dependencies**: M6 Tasks 36, 37 (✅ commit engine + branch refs); M2 Task 3 (✅ EditorPanelLayout); **M9 Explorer & Media Import** (assumed complete — specifically Task 76 panel registration, Task 77 Project panel tree view); existing JobStateContext WS protocol
**Status**: Not Started

---

## Overview

Scenecraft has no first-class render surface today. This milestone adds a workspace view modeled on DaVinci Resolve's Deliver page, where users queue multiple renders with different in/out ranges, re-run or edit prior jobs, and continue editing the project while renders run in the background.

Each queued job pins a VCS commit of the project state at submit time. The render worker extracts that commit into a temp db via `copy_snapshot_to`, so concurrent queued jobs are each reproducible and the live `project.db` is never touched during a render. Content-addressed commits mean N queued jobs from the same state share one on-disk db file.

Phases:
- **P1** — Backend: schema, API, worker + snapshot isolation + WS progress
- **P2** — Frontend scaffolding: timeline in/out handles, RenderSettingsPanel, RenderQueuePanel
- **P3** — Workspace view integration: switcher in `EditorPanelLayout`, "Render" layout
- **P4** — Row actions + polish: edit-to-load, rerun, duplicate, reveal, rename

---

## Deliverables

1. **Backend schema** — `render_jobs` table with `{id, name, snapshot_commit_sha, in_seconds, out_seconds, settings_json, status, queue_position, output_path, progress, error_message, submitted_at, started_at, completed_at}` plus `(status, queue_position)` index
2. **Backend API** — `/api/projects/:name/render-jobs` CRUD + `/rerun` + `/duplicate` + `/cancel` + `/reorder` + `/start` + `/clear-rendered` + `/clear-all`
3. **Backend worker** — polls top queued job, calls `copy_snapshot_to(temp_dir, sha)`, invokes existing render module, streams WS `job_progress` events, writes output to `renders/`, cleans up temp dir
4. **Timeline in/out handles** — draggable handles on the ruler + `I`/`O` keyboard shortcuts + shaded range region; `renderIn`/`renderOut` draft state in `RenderWorkspaceContext` (not persisted)
5. **RenderSettingsPanel** — preset ▼ + filename + output dir + format/codec/resolution/fps/audio + range picker (Timeline / In-Out / Selected) + "Add to Queue" button; bound to draft settings
6. **RenderQueuePanel** — per-row status badge + progress bar + in/out display + format/res display + ⋯ menu + overall progress bar + Start Render button + drag-to-reorder
7. **Render workspace view** — registered in `EditorPanelLayout` with its own `defaultLayout` tree; workspace switcher pill toggles between "Editor" and "Render" views, with per-view autosave
8. **Row actions** — Rename · Edit (load back into settings panel + timeline) · Rerun (same commit) · Duplicate (fresh commit) · Delete · Reveal in Project panel (M9) · Download · Open in tab · Copy remote path · Retry (failed only); double-click row = Edit. Extends M9's Project panel with a `revealPath(path)` imperative API
9. **(Optional / stretch)** Render presets — `render_presets` table + preset picker UI; builtin bundles for YouTube 1080p, ProRes 422, Social 9:16

---

## Success Criteria

- [ ] User can set `renderIn`/`renderOut` on the timeline via ruler handles or `I`/`O` keys while in Render workspace
- [ ] "Add to Queue" creates a `render_jobs` row with the current range + settings and pins a `snapshot_commit_sha`
- [ ] Two "Add to Queue" clicks with no edits between them produce two rows sharing the same `snapshot_commit_sha` (verified content-addressed dedup)
- [ ] Queue panel shows rows with status, per-row progress bar, in/out, and format/resolution
- [ ] Overall progress bar at the top of the queue reflects aggregate progress across the running batch
- [ ] "Start Render" begins processing the top `queued` row → `running`
- [ ] Worker renders against a temp db (`copy_snapshot_to`); live `project.db` edits during a render do not affect the output
- [ ] Rerun of a completed job produces a byte-identical output (same commit + same settings)
- [ ] Duplicate of a completed job uses a *fresh* commit from current live state, not the original snapshot
- [ ] Edit on a queued job loads its settings into `RenderSettingsPanel` and sets `renderIn`/`renderOut` on the timeline; "Update" saves in place
- [ ] Cancel on a queued job transitions to `canceled`; cancel on a running job stops the worker and cleans up partial output
- [ ] Reveal in Project panel activates the Project panel and highlights the render output row under `renders/`
- [ ] Download serves the render output with an HTTP `Content-Disposition: attachment; filename="{sanitized_name}.{ext}"` header
- [ ] Open in tab streams the render inline (browser `<video>` playback)
- [ ] Copy remote path writes the server path (e.g. `renders/{id}.mp4`) to the clipboard
- [ ] Completed and failed jobs persist in the queue list until cleared via `/clear-rendered` or `/clear-all`
- [ ] Workspace switcher toggles between "Editor" and "Render" views, each restoring its own autosaved layout
- [ ] No regressions in existing editor workspace (dockview path still works)

---

## Tasks

1. [Task 106: Backend `render_jobs` schema + migration](../tasks/milestone-12-render-workspace/task-106-backend-schema.md) — Table DDL, idempotent migration, ID generator, basic CRUD helpers in `db.py`
2. [Task 107: Backend render-job API endpoints](../tasks/milestone-12-render-workspace/task-107-backend-api.md) — All CRUD + reorder + rerun + duplicate + cancel + start + clear endpoints in `api_server.py`; snapshot captured via `commit_working_copy` on create
3. [Task 108: Backend render worker + snapshot isolation + WS events](../tasks/milestone-12-render-workspace/task-108-backend-worker.md) — Async worker loop, `copy_snapshot_to` to temp dir, integration with existing render module, `job_*` WS event emission, cleanup
4. [Task 109: Frontend timeline in/out handles](../tasks/milestone-12-render-workspace/task-109-frontend-timeline-handles.md) — Ruler handles, shaded range region, `I`/`O` keyboard shortcuts, `RenderWorkspaceContext` draft state
5. [Task 110: Frontend `RenderSettingsPanel`](../tasks/milestone-12-render-workspace/task-110-render-settings-panel.md) — Form components, preset/filename/output/format/codec/res/fps/audio/range fields, "Add to Queue" handler
6. [Task 111: Frontend `RenderQueuePanel`](../tasks/milestone-12-render-workspace/task-111-render-queue-panel.md) — List rendering, status badges, progress bars, overall progress, Start Render button, basic row layout
7. [Task 112: Render workspace view + switcher](../tasks/milestone-12-render-workspace/task-112-workspace-view-and-switcher.md) — Register "render" view in `EditorPanelLayout`, default layout tree, workspace switcher UI, per-view autosave keys
8. [Task 113: Row actions and edit/rerun/duplicate flows](../tasks/milestone-12-render-workspace/task-113-row-actions-and-flows.md) — ⋯ menu, Edit loads job back, Rerun, Duplicate, Rename, Reveal output, Delete, Retry; double-click = Edit; drag-to-reorder
9. [Task 114: (Stretch) Render presets](../tasks/milestone-12-render-workspace/task-114-render-presets.md) — `render_presets` table, preset picker in settings panel, builtin YouTube/ProRes/Social bundles

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| `copy_snapshot_to` too slow for large projects | Medium | Low | Measure first; if >2s, add skip-copy-if-commit-matches-last-render optimization |
| Orphaned commits accumulate on disk after job deletion | Medium | Medium | Ship GC later as `scenecraft admin render-gc`; content-addressing keeps bloat bounded in the interim |
| Workspace switcher conflicts with dockview's existing autosave | Low | Low | `EditorPanelLayout` autosave keys are already prefixed; scope new keys to `_autosave_{view_id}` |
| WS `job_*` events overlap with existing chat-generation jobs | Low | Low | `kind: "render"` discriminator on each event; `JobStateContext` already keys on `entity_key` |
| User edits during render cause output to reflect mid-edit state | High | Low | Snapshot isolation via `copy_snapshot_to`; render worker never touches live db. Covered by integration test |
| Render worker race on `/start` (two callers → two workers) | Medium | Low | Single-flight lock on the worker; second call returns current running job status |
| Cancel of running render leaves partial files in `renders/` | Low | Medium | Worker cleans up partial output in `finally` block; manual recovery via Reveal + delete if needed |
| Timeline in/out handles conflict with existing trim drag | Low | Low | Handles only visible in Render workspace view; trim handles live on clip edges, range handles live on ruler — separate hit zones |
| Dockview coexistence causes layout confusion | Low | Medium | Workspace switcher is clearly labeled "Editor" / "Render"; Render workspace is pure EditorPanelLayout |

---

**Next Milestone**: TBD (dockview removal candidate)
**Blockers**: None. All dependencies already shipped.
**Notes**:
- Design doc: [`agent/design/local.render-workspace.md`](../design/local.render-workspace.md)
- Reuses VCS commit engine from M6 (`scenecraft.vcs.objects.commit_working_copy`, `copy_snapshot_to`)
- Reuses WS `job_*` protocol from M4 chat jobs via `JobStateContext`
- Full user-named workspace CRUD (M2 Task 8) is a follow-up; this milestone ships only built-in "Editor" and "Render" views
- Sequential rendering only (one running job at a time); parallel workers are a future enhancement
