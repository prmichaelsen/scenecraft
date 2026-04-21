# Render Workspace

**Concept**: DaVinci Resolve–style Deliver workspace — a dedicated three-panel layout (Render Settings · Preview+Timeline · Render Queue) where users set per-submission in/out ranges, queue multiple renders, and manage them (edit, rerun, duplicate, delete) while keeping the timeline freely editable during background renders
**Created**: 2026-04-21
**Status**: Proposal

---

## Overview

Scenecraft currently has no first-class render surface. Rendering is implicit in the composition and there is no way to queue multiple renders with different in/out ranges, re-render a prior job, or manage a render history.

This design adds a **Render Workspace** — a top-level workspace view (switchable from the editor, *not* a separate route) that mirrors Resolve's Deliver page:
- Left: **Render Settings** (format, codec, resolution, fps, output dir, range source, preset — "Add to Queue" button)
- Center: **Preview + Timeline** (with new `renderIn`/`renderOut` handles on the ruler)
- Right: **Render Queue** (unified queue + jobs history, Resolve-style, with per-row actions for rerun/edit/duplicate/delete/reveal)

Each queued job captures a VCS commit of the project state at "Add to Queue" time so background renders are isolated from live editing, concurrent renders are each bit-reproducible, and rerun is deterministic.

---

## Problem Statement

Users cannot:
- Render a specific time range (`[in, out]`) of the project
- Queue multiple renders with different in/out ranges from a single UI
- Keep editing while a render is in progress without corrupting the in-flight output
- Re-render a prior delivery with the same parameters
- See a persistent history of past renders with their parameters and output paths

Without this, Scenecraft can produce a composition but cannot be used as a delivery tool. Every render requires a separate CLI invocation and manual bookkeeping, and there's no way to preserve renders against subsequent edits.

---

## Solution

### Layout

```
Render Workspace (top-level workspace view in EditorPanelLayout)
┌─────────────────────┬──────────────────────────────┬────────────────────────┐
│ RenderSettingsPanel │ Preview + Timeline           │ RenderQueuePanel       │
│                     │  (ruler + I/O handles)       │                        │
│  Preset ▼           │                              │  [Start Render]        │
│  Filename           │  ┌──── render region ────┐   │  ▓▓▓▓▓░░░░  42%        │
│  Output dir         │  │                        │   │                        │
│  Format / codec     │  └────────────────────────┘   │  ┌─ job rows ──────┐   │
│  Resolution / fps   │                              │  │ clip-a (1080p)  │   │
│  Audio codec        │                              │  │ 02:30 → 04:15   │   │
│  Range:             │                              │  │ ▓▓▓▓▓░░░ 60%    │   │
│   • Timeline        │                              │  │ [⋯]              │   │
│   • In/Out          │                              │  └─────────────────┘   │
│   • Selected clips  │                              │  …                     │
│                     │                              │                        │
│  [+ Add to Queue]   │                              │                        │
└─────────────────────┴──────────────────────────────┴────────────────────────┘
```

### Snapshot model — VCS commit at submit

On "Add to Queue":
1. Backend calls `commit_working_copy()` (M6 VCS) → gets `snapshot_commit_sha` (content-addressed; reuses existing SHA if state unchanged).
2. Insert `render_jobs` row with `{snapshot_commit_sha, in, out, settings_json, status: queued, …}`.

When a worker picks up a queued job:
1. `copy_snapshot_to(temp_dir)` extracts the pinned commit's db to a temp directory.
2. Render runs against the temp db, isolated from live edits.
3. Output written to `renders/{job_id}.{ext}` (UUID-named, matching the media pattern for pool segments and candidates).
4. Temp dir discarded. Job row updated with `status: completed`, `output_path`, `completed_at`.

**Benefits**:
- User can keep editing immediately after clicking "Add to Queue"
- Multiple queued jobs from the same state **dedup to one on-disk DB**
- **Rerun** is bit-identical (same commit + same settings → same output)
- No coupling to M6's branch/merge machinery — just the commit-engine primitives (`commit_working_copy`, `copy_snapshot_to`)

### Job lifecycle

```
    ┌──────────┐   start   ┌──────────┐   ok   ┌────────────┐
 →  │ queued   │ ────────→ │ running  │ ─────→ │ completed  │
    └──────────┘           └──────────┘        └────────────┘
         │                      │ fail
         │ cancel               ▼
         ▼                 ┌──────────┐
    ┌──────────┐           │ failed   │
    │ canceled │           └──────────┘
    └──────────┘
```

States: `queued` · `running` · `completed` · `failed` · `canceled`
- **Start Render** button moves the top `queued` job → `running`.
- Only one `running` job at a time (sequential processing, matches Resolve and simplifies resource management; parallel can come later).
- Completed and failed jobs persist in the list until explicitly cleared.

### Row actions (⋯ menu per row)

| Action | Behavior |
|---|---|
| Rename | Edit the job's display name in place |
| Edit | Load settings + in/out back into `RenderSettingsPanel` + timeline; "Update" saves in place, "Add to Queue" clones |
| Rerun | Clone row with same `snapshot_commit_sha` + settings, status=`queued`, new output UUID |
| Duplicate | Clone row with same settings, **fresh snapshot from current state**, user adjusts in/out before next submit |
| Reveal in Project panel | `activatePanel('project')` + `projectPanel.revealPath('renders/{id}.{ext}')` — expands `renders/`, scrolls, highlights the row |
| Download | `GET /api/projects/:name/render-jobs/:id/output` with `Content-Disposition: attachment; filename="{sanitized_name}.{ext}"` |
| Open in tab | Same endpoint without `attachment` disposition → browser plays MP4 inline |
| Copy remote path | Writes server path (e.g. `renders/{id}.mp4`) to clipboard for SSH/scp workflows |
| Delete | Remove row (does NOT delete the output file on disk; GC pass later frees orphaned commits + files) |
| Retry (failed only) | Same as Rerun but on a failed row |

Double-click row = Edit.

Because scenecraft is deployed remotely (backend on server, webapp in browser), there is no OS-level file reveal. All file-facing UX is either in-app (Project panel from M9) or browser-native (HTTP download / in-browser playback / clipboard).

---

## Implementation

### Backend — schema

New table in `project.db`:

```sql
CREATE TABLE IF NOT EXISTS render_jobs (
    id              TEXT PRIMARY KEY,              -- uuid
    name            TEXT NOT NULL,                 -- display name (editable)
    snapshot_commit_sha TEXT NOT NULL,             -- points to VCS commit
    in_seconds      REAL NOT NULL,                 -- render range start
    out_seconds     REAL NOT NULL,                 -- render range end (> in)
    settings_json   TEXT NOT NULL,                 -- { format, codec, width, height, fps, audio_codec, preset_id? }
    status          TEXT NOT NULL DEFAULT 'queued',-- queued|running|completed|failed|canceled
    queue_position  INTEGER NOT NULL,              -- ordering in queue (lower = earlier)
    output_path     TEXT,                          -- relative to project: renders/{id}.{ext}
    progress        REAL DEFAULT 0.0,              -- 0.0 - 1.0 while running
    error_message   TEXT,
    submitted_at    TEXT NOT NULL,
    started_at      TEXT,
    completed_at    TEXT
);

CREATE INDEX idx_render_jobs_status_position ON render_jobs(status, queue_position);
```

Optional, deferred to a follow-up:

```sql
CREATE TABLE IF NOT EXISTS render_presets (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    settings_json   TEXT NOT NULL,
    is_builtin      INTEGER NOT NULL DEFAULT 0
);
```

### Backend — API

```
GET    /api/projects/:name/render-jobs                 → [job]
POST   /api/projects/:name/render-jobs                 → create (body: {name, in, out, settings}) — snapshot happens server-side
PATCH  /api/projects/:name/render-jobs/:id             → update (name/settings/in/out; only if status == queued)
DELETE /api/projects/:name/render-jobs/:id             → delete row
POST   /api/projects/:name/render-jobs/:id/rerun       → clone row (same commit) → status=queued
POST   /api/projects/:name/render-jobs/:id/duplicate   → clone row (fresh commit) → status=queued
POST   /api/projects/:name/render-jobs/:id/cancel      → canceled (if queued or running)
POST   /api/projects/:name/render-jobs/reorder         → body: {ids[]} → rewrite queue_position
POST   /api/projects/:name/render-jobs/start           → kick worker (sets top queued → running)
POST   /api/projects/:name/render-jobs/clear-rendered  → delete completed + failed rows
POST   /api/projects/:name/render-jobs/clear-all       → delete all except running
GET    /api/projects/:name/render-jobs/:id/output      → streams the MP4 (range-request aware)
                                                          ?attachment=1 sets Content-Disposition for download
                                                          otherwise served inline for <video> tag playback
```

### Backend — worker

Reuses the existing `job_*` WS event protocol from `JobStateContext`:

```
job_started   { job_id, kind: "render", entity_key: render_job_id }
job_progress  { job_id, progress, stage: "video"|"audio"|"mux" }
job_completed { job_id, output_path }
job_failed    { job_id, error }
```

Worker loop (async):
1. Poll for top `queued` job (order by `queue_position ASC`).
2. `copy_snapshot_to(temp_dir, job.snapshot_commit_sha)`.
3. Emit `job_started`.
4. Invoke existing composition renderer (from the active render module) with temp db + in/out + settings.
5. Stream `job_progress` every ~500 ms.
6. On success: write output to `renders/`, update row, emit `job_completed`.
7. On failure: update row with error_message, emit `job_failed`.
8. Clean up temp dir.
9. Advance to next queued job.

### Frontend — state + data flow

- `RenderWorkspaceContext` — owns `renderIn`/`renderOut` (timeline range), selected preset, currently-edited job (for Edit mode).
- `renderJobs` list fetched on mount; updates applied optimistically on mutations; reconciled via WS `job_*` events + periodic refetch.
- `RenderSettingsPanel` is a form bound to a draft job; "Add to Queue" POSTs `/render-jobs` with current settings + current `{renderIn, renderOut}`.
- `RenderQueuePanel` renders the list with status, progress, and row actions. Clicking Edit populates the settings panel + sets `renderIn`/`renderOut` from the job.

### Frontend — timeline in/out handles

New UI on `Timeline.tsx` ruler:
- Two draggable handles (▶ at in, ◀ at out) with shaded region between.
- Keyboard: `I` sets in at playhead; `O` sets out at playhead; `Shift+I`/`Shift+O` clears.
- State lives in `RenderWorkspaceContext` (not DB) — this is a draft; the DB row only captures the value at submit time.
- Visible only in the Render Workspace view; hidden in the default editor workspace.

### Frontend — workspace view switcher

`EditorPanelLayout` currently has one hardcoded default layout. We add:
- A **workspace-view registry** keyed by id (`editor` | `render` | future user-named views)
- A workspace switcher pill/dropdown in the top bar (or footer) — "Editor" / "Render"
- Each registry entry has a `defaultLayout` tree and a list of valid panel ids
- Switching view saves the current layout under `_autosave_{view_id}` and restores the new view's autosave (or default)

This is the minimal port of the dockview `WorkspaceMenu` concept. Full user-named workspace CRUD is still M2 task-8 / follow-up work.

---

## Benefits

- **Per-job in/out ranges** — queue N deliveries of different segments without manual bookkeeping
- **Non-blocking** — user keeps editing while renders run in the background (no live-db contention)
- **Deterministic rerun** — VCS snapshot means same commit + same settings = bit-identical output
- **Cheap storage** — content-addressed commits dedup identical state across jobs
- **Familiar mental model** — mirrors DaVinci Resolve's Deliver page conventions
- **Leverages existing infra** — reuses VCS commit engine (M6) and JobStateContext WS protocol

---

## Trade-offs

- **Cannot GC orphaned commits yet** — if user deletes a completed job, its commit remains on disk until a later GC pass. Disk-growth impact is bounded by content-addressing but non-zero. Mitigation: add a `render-gc` admin CLI in a follow-up.
- **Sequential rendering only** — one running job at a time simplifies the worker but constrains throughput. Mitigation: parallelism is a future enhancement; most single-user workloads don't need it.
- **Settings bound to single-workspace-view** — Edit loads a job into the left panel; if user switches away from Render Workspace mid-edit, state is lost. Mitigation: persist draft form state to sessionStorage; on return, restore.
- **`project.db` copy cost** — `copy_snapshot_to()` is a file copy; for very large projects, this takes seconds. Acceptable for single-render workflows; batch renders bear the cost per job. Mitigation: future optimization — skip copy if commit equals last-rendered commit.
- **Dockview coexists** — until full dockview removal, two panel systems live side-by-side. Render Workspace is pure `EditorPanelLayout`; default editor keeps working via dockview. Migration off dockview is deferred as its own milestone.

---

## Dependencies

- **M6 Task 36** (Content-addressed object store & commit engine) — ✅ completed, required for snapshot primitives (`commit_working_copy`, `copy_snapshot_to`)
- **M6 Task 37** (Branch refs & operations) — ✅ completed, used by `commit_working_copy` branch head advance
- **M9 Explorer & Media Import** — **assumed complete**. Specifically:
  - Task 76 (panel registration) — Project panel registered in `EditorPanelLayout`
  - Task 77 (Project panel) — tree view of server-side project dir; extended here with a `revealPath(path: string)` imperative API for the Render Queue's Reveal action
  - Renders under `renders/` show up automatically in the Project panel tree
- **JobStateContext** (shipped with M4 chat) — reused for WS progress plumbing
- **EditorPanelLayout** (M2 Task 3) — ✅ completed, host for the new workspace view
- **ffmpeg / existing render module** in scenecraft-engine — invoked by the new worker

**Remote deployment constraint**: backend runs on a remote machine, webapp is a browser client. No OS-level file reveal is possible. All file-facing UX is either in-app (Project panel) or browser-native (HTTP download / Copy path / `<video>` playback).

No external services or new libraries required.

---

## Testing Strategy

**Backend**:
- Unit: commit creation path dedups identical states (two submissions without edits → same SHA → single on-disk db file)
- Unit: `copy_snapshot_to` isolates render from live edits (modify live db during render → output reflects commit state)
- Integration: queue 3 jobs, call `/start`, verify all three render sequentially with correct in/out slices
- Integration: rerun a completed job → output matches original byte-for-byte
- Integration: edit live project + duplicate a prior job → duplicate uses *current* state (fresh commit)
- Integration: delete a running job → `canceled`, worker stops, partial output cleaned up

**Frontend**:
- Timeline `I`/`O` keys set `renderIn`/`renderOut` at playhead
- "Add to Queue" POSTs with current range and clears form (or stays — preference TBD)
- Queue row progress bar updates from WS `job_progress` events
- Edit flow loads a job's settings + in/out back into settings panel and timeline handles
- Workspace switcher saves+restores layout autosaves per view id
- Reveal output opens the correct file path (abstracted via existing file-action plumbing)

---

## Key Design Decisions

### Snapshot

| Decision | Choice | Rationale |
|---|---|---|
| When to snapshot | At "Add to Queue" (not at start-of-render) | Multiple jobs can queue simultaneously without racing; rerun is deterministic; live editing is decoupled |
| Snapshot backend | VCS commit engine (M6), not checkpoint | Content-addressed (dedup); `copy_snapshot_to` writes to arbitrary temp location; checkpoints can only restore to live db; M6 task-38 direction is toward commits |
| Snapshot lifecycle | Kept as long as any job references it; GC pass later | Simpler than ref-counting up-front; content-addressing means overhead is bounded |

### Layout

| Decision | Choice | Rationale |
|---|---|---|
| Layout host | `EditorPanelLayout` only, not dockview | New work goes on EditorPanelLayout; dockview removal is a separate milestone |
| Queue and Jobs split | Unified in one right panel | User requested; matches Resolve's single Render Queue panel |
| Settings panel | Left | Matches Resolve Deliver page conventions |
| Workspace view infra | Minimal switcher (built-in views only) for this milestone | Full user-named workspace CRUD is M2 task-8; not blocking |

### Queue semantics

| Decision | Choice | Rationale |
|---|---|---|
| Concurrency | One running job at a time | Simplifies worker; matches Resolve default; parallelism can be added later |
| Completed job visibility | Persist in the right-panel list | Enables rerun/edit/duplicate from history; user clears manually |
| Rerun semantics | Clone row, same commit, same settings, new output path | Deterministic reproduction |
| Duplicate semantics | Clone row, **fresh commit**, user adjusts in/out | "Render another chunk from current state" |

### Ins/outs

| Decision | Choice | Rationale |
|---|---|---|
| Timeline in/out UI | Handles on ruler + I/O keyboard shortcuts | Resolve convention; discoverable + fast |
| Storage | Per-job in the DB; frontend `{renderIn, renderOut}` is a draft only | Only committed values matter for reproducibility |
| Default range | "In/Out" if handles set, else "Timeline" (full duration) | Matches Resolve's Range picker behavior |

### Output paths

| Decision | Choice | Rationale |
|---|---|---|
| Output filename | `renders/{job_id}.{ext}` (UUID) | Matches media-file pattern (pool segments, candidates); each render is a distinct user artifact — rerun produces a new UUID |
| Dedup | At snapshot layer (content-addressed commits), not at output layer | User expectation: rerun creates a fresh deliverable file; same-state submits share one `.db` file but distinct output files |
| Reveal target | Project panel (M9) via `revealPath` | No OS file reveal on remote deployment; Project panel is the canonical in-app filesystem surface |

---

## Migration Path

No existing render state to migrate. This is a greenfield feature.

- `render_jobs` table created fresh on first server start after deploy (idempotent `CREATE TABLE IF NOT EXISTS`).
- No breaking API changes. New endpoints are additive.
- Existing dockview editor workspace is unaffected; users opt in by switching to the Render workspace view.
- `renders/` directory created under project root on first render.

---

## Future Considerations

- **Render GC admin CLI** — `scenecraft admin render-gc` removes orphaned commits and their object files
- **Parallel renders** — multiple workers for throughput on machines with spare CPU/GPU
- **Cloud rendering** — commit + settings is enough to hand off to a remote worker; only the commit SHA + settings need to travel
- **Render presets** — named bundles (YouTube 1080p, ProRes 422, Social 9:16) stored in `render_presets` table
- **Daily render limit / quota enforcement** — useful if rendering moves to paid GPU
- **Per-track render routing** — output only selected tracks (audio-only, specific track subset)
- **Render chains** — post-render hooks (upload to YouTube, copy to NAS, run ffprobe)
- **Full dockview removal** — port `WorkspaceMenu` + remaining dockview-only panels to `EditorPanelLayout`

---

**Status**: Proposal
**Recommendation**: Accept design, proceed with Milestone 12 (9 tasks, ~55 hours)
**Related Documents**:
- Milestone: [milestone-12-render-workspace.md](../milestones/milestone-12-render-workspace.md)
- VCS (snapshot primitives): M6 Tasks 36, 37
- Workspace views (predecessor work): M2 Task 8 (not_started)
- JobStateContext (reused WS plumbing): M4 Task 16
