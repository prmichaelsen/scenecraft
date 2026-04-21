# Explorer Panel and Media Import

**Concept**: A two-panel Explorer column (Project + Import) that surfaces the server-side project filesystem and watched media sources, backed by ACL-gated filesystem browsing, content-hashed dedup, and a live watchdog ingest pipeline.
**Created**: 2026-04-21
**Status**: Design Specification

---

## Overview

Scenecraft today has a Bin panel for pool media and a watched-folders API, but no way for users to browse the on-disk project state or explicitly register new media roots. This design introduces an **Explorer** — a left-column composition of two panel groups, `project-group` (on-disk project tree) and `import-group` (watched folders + uploaded files) — alongside the schema, ingest, and ACL work needed to back it.

The server-browser relationship in scenecraft is **remote**: the backend runs on one machine (filesystem, SQLite, pool), while the browser runs on another (user's laptop). This shapes every part of the design — file pickers that run locally (upload path) vs. an in-app filesystem browser that browses the server (watch path), no OS-level "reveal" affordances, and ACL rules that govern server paths only.

---

## Problem Statement

- **No way to see the project dir**. Everything the product persists lives on the server's filesystem (`project.db`, `pool/`, `keyframe_candidates/`, `selected_transitions/`, etc.), but the user has no UI to inspect or reveal it. Debugging drift between DB state and on-disk state requires shell access.
- **Watched-folders are invisible**. The backend supports watched folders and auto-import, but there is no panel showing the list, their contents, or their status.
- **No explicit "import this folder" flow**. Users can upload files one-by-one, but can't register an existing server directory as a rolling media source and have its contents auto-flow into the pool.
- **Pool has no content-hash identity**. `pool_segments` tracks a first-seen path only. The same bytes imported from two places create two rows; renames on disk look like delete+create to the watcher; there is no integrity check.
- **No permission surface**. Any user connecting to the server could potentially browse any server path. We need a default-deny ACL before shipping a filesystem browser.
- **Consequences**: users can't reason about what the product has ingested, what's new vs. stale, where media came from, or trust that the pool won't balloon with duplicates.

---

## Solution

A left-column **Explorer** with two independent panel groups (not a single panel with a split), layered on top of three new backend capabilities:

1. **Explorer frontend**: `project` and `import` panels registered in `PanelRegistry`; default layout places them as stacked `GroupNode`s in a vertical `SplitNode` on the left of the root horizontal split; collapsed by default. Each group has its own tab bar and can be collapsed independently. The Import panel adds a "Link Media" header action that opens either a native file picker (for uploads) or the in-app filesystem browser modal (for folder-watch).
2. **Server-side filesystem services**: a new `/api/browse` endpoint (ACL-gated), a `watchdog`-backed live watcher per registered folder, a file-type classifier (`mimetypes.guess_type` + ffprobe fallback), and a streaming SHA-256 hasher.
3. **Pool schema refinement**: `pool_segments` gains `source_hash` (indexed) and `source_size`; `original_filepath` is replaced by a new `source_locations` many-to-one table recording every place a given content-hash has been seen (`source_kind` + `source_ref` + `watched_folder_id` + timestamps).
4. **ACL model**: a server-level `acl_rules` table with per-user path-prefix grants, default-deny, longest-match wins with deny > allow on ties, and admin bootstrap.

A **Focus Mode** (`Shift+F`) and a **Source Monitor** panel are related but deferred — Focus Mode ships alongside this feature, Source Monitor is recorded as future work.

### Alternatives rejected

- **Single Explorer panel with an inner vertical split** — inconsistent with how the project already defines "panel groups" (a `GroupNode` _is_ a panel in this codebase). Two peer `GroupNode`s match the existing architecture and give per-half collapse/drag/detach for free.
- **Mounting the user's local filesystem via a browser API** (File System Access API) — doesn't give the server a resolvable path, so the server can't watch it. Usable for per-file upload only; we already have that via `<input type=file>`.
- **Allow-list roots instead of ACL** — simpler, but forecloses multi-user scenarios and doesn't distinguish between "readable" and "revealable" paths. ACL covers both v1 single-user and future multi-user at the same code surface.
- **Polling the filesystem instead of watchdog** — wasteful on large trees; poor latency. watchdog's per-OS native hooks are the right primitive. Fall back to polling only for network mounts.
- **Skip content hashing, dedup by path** — loses rename detection and cross-folder dedup; lets the pool accumulate duplicates. Hashing is cheap relative to upload.

---

## Implementation

### Panel structure

**Registry** (frontend, `src/components/editor/EditorPanelLayout.tsx`):

```ts
const panels: PanelRegistry = {
  // ...existing panels
  project: { component: ProjectPanelComponent, title: 'Project', icon: Folder },
  import:  { component: ImportPanelComponent,  title: 'Import',  icon: Link2 },
}
```

**Default layout** — add an Explorer column to the root split:

```
root: horizontal split (ratio ~0.18)
├─ explorer-column: vertical split (ratio 0.5, both groups collapsed by default)
│   ├─ project-group  (tabs: ['project'],  activeTab: 'project',  collapsed: true)
│   └─ import-group   (tabs: ['import'],   activeTab: 'import',   collapsed: true)
└─ (existing root children — preview-group, timeline-group, properties-group, etc.)
```

Expanded column width target: ~275 px.

**Focus Mode**:
- Add `primary?: boolean` to `GroupNode` (`src/components/panel-layout/types.ts`).
- Default layout marks `preview-group` and `timeline-group` as `primary: true`.
- `Shift+F` global handler: if not in Focus Mode, snapshot the layout into an in-memory `focusSnapshot`, then set `collapsed: true` on every non-primary group. On next press, restore from snapshot.
- `focusSnapshot` is ephemeral (NOT persisted in workspace view).
- `primary` IS persisted in workspace view.
- UI for toggling `primary`: the existing **ellipsis (⋮) menu** on each panel-group header (`PanelGroup.tsx:230-269`) gains a new item — **"Mark as Primary"** / **"Unmark as Primary"** depending on the current state. Placed below the existing "Add Panel" section and above "Close Group", separated by a divider. Checkmark or filled-vs-outline state indicator optional.

### Project view (top panel)

Renders the real on-disk contents of the project directory (`project_dir` from the router context), using a tree component with collapsible folders (VSCode-style). Fetches children via `GET /api/projects/:name/tree?path=<relative>`.

**Always-hidden filters** (no user toggle — these never appear in the Project view):
- `project.db-wal`, `project.db-shm` — SQLite sidecars; noise
- `.DS_Store`, `Thumbs.db` — OS cruft
- `transaction_snapshots/` — checkpoint/backup dir; surfaced instead via the future **Branch Explorer** panel (see Future Considerations), not the Project view

Filters NOT applied (none of these exist in a scenecraft project dir): `.git/`, `.scenecraft_work/`, `__pycache__/`, `node_modules/`.

There is **no "Show backups" / "Show hidden" toggle** in the Project view. Users who want to inspect checkpoint state use the Branch Explorer surface (dedicated panel, deferred).

**Row actions** (right-click opens a custom in-app menu; browser's native context menu is replaced via `contextmenu` event + `preventDefault()`):
- Copy absolute path
- Copy relative path
- Open in Preview panel (media files → double-click default)
- Rename (calls `PATCH /api/projects/:name/path`)
- Remove from project (hard-delete the pool copy on the server; **source file is NOT touched**). If the file is a pool-linked entry, this drops the corresponding `pool_segments` row AND unlinks its `source_locations` rows, but the bytes in the original source location (watched folder, or the user's local machine for uploaded files) are left intact. Not sent to the bin.

**Removed from original proposal** (due to remote-browser): "Reveal in system file manager" — server-side reveal is unreachable from the user's machine.

**Double-click** on a media file: opens it in the deferred **Source Monitor** panel (Future Considerations).

### Import view (bottom panel)

Flat tree with top-level roots — one per watched folder, plus one synthetic `"Uploads"` root for files imported via the native picker. Within each root, the tree mirrors the source structure (folders collapsible, files as leaves).

**Icons** (lucide-react, 14px):
- `Film` for video
- `Image` for image
- `AudioWaveform` for audio
- `Folder` / `FolderOpen` for directories
- `FileQuestion` for missing-source entries

No per-file status badges — the panel shows what's there; reconciliation is internal.

**Header action**: "Link Media" button (Link2 icon + text) opens a small menu:
- **Add file(s) to import** → native `<input type=file multiple accept="video/*,image/*,audio/*">` picker. Accepts **video, image, AND audio** files — the upload pipeline treats all three uniformly; server classifies each upload by `media_kind` and writes into a flat `pool/<uuid>.<ext>`. A new `source_locations` row records `source_kind='upload'` + `source_ref=<user-side filename string>` per file.
- **Add folder to watch** → opens the in-app filesystem browser modal (see _Filesystem browser modal_ below). User picks a server path; server registers it as a watched root.

**Row context menus**:
- On a watched folder: _Unwatch (keep pool rows)_, _Unwatch and remove pool rows_.
- On an imported file: _Drag to timeline_, _Remove from pool_ — hard-deletes the pool copy on the server and drops the `pool_segments` row + `source_locations` rows; **the original source file on disk (watched folder) or in the user's browser-local filesystem (upload) is untouched**. The same file can be re-ingested later from that source.
- No "Refresh" action — watched folders are always-live (see _Watched folders_ below).
- No "Reveal in file manager" — server-side.

### Source monitor (deferred)

A second tab on the same `GroupNode` as the Preview panel, named **Source Monitor** (Premiere convention). Double-click on a media item → activate Source Monitor tab, load the clip. Scrubber with in/out handles, `I`/`O` to set marks at the current frame. Two actions: _Insert at playhead_ (creates a transition or audio-clip on the selected track with `trim_in = markIn`, `trim_out = markOut`, `source_video_duration` probed on insert) and _Drag to timeline_ (standard DnD payload `{poolSegmentId, markIn, markOut}`).

**Scope**: NOT shipped in this milestone. Captured in Future Considerations.

### Server-side filesystem services

**`GET /api/browse?path=<abs>`**: returns children of a server directory after an ACL check against the requesting user. Response shape:
```json
{
  "path": "/mnt/media",
  "entries": [
    {"name": "clips", "kind": "dir"},
    {"name": "song.mp3", "kind": "file", "size": 4823041, "mtime": "...", "mediaKind": "audio"}
  ]
}
```
`mediaKind` is derived via the media classifier (see _File-type detection_).

**`POST /api/reveal` — NOT IMPLEMENTED.** Removed from scope; remote-browser makes it meaningless.

**Watched folders** — already scaffolded; this milestone upgrades the ingest path:
- Use Python `watchdog` for cross-platform FS events (inotify / FSEvents / ReadDirectoryChangesW).
- One `Observer` per watched root.
- Debounce file-write events by 2s after last modification before ingesting (handles mid-write).
- On rename within a watched root: watchdog emits a move event → update `source_locations.source_ref` for the existing pool row (keyed by hash), do not create a duplicate.
- On network mounts (SMB/NFS), inotify is unreliable. Detect via `os.statvfs` filesystem type at registration; fall back to 5-second polling for those mounts.
- Push `folder_import` / `folder_removed` / `folder_renamed` events to the frontend over the existing WebSocket channel when the watcher fires.

**File-type detection**:
- First pass: `mimetypes.guess_type(path)` (stdlib).
- If MIME is `video/*`, `image/*`, or `audio/*`: accept.
- If MIME is `application/octet-stream` or unknown AND extension is not in a known non-media blacklist (`.txt`, `.pdf`, `.zip`, `.md`, `.py`, etc.): fall back to `ffprobe -show_streams`.
- If ffprobe finds a video or audio stream: accept as corresponding kind.
- Otherwise: skip (non-media ignore rule).
- Cap ffprobe fallback to N/second on initial scans of large trees.

### Hashing and dedup

**Schema additions to `pool_segments`**:
```sql
ALTER TABLE pool_segments ADD COLUMN source_hash TEXT;
ALTER TABLE pool_segments ADD COLUMN source_size INTEGER;
ALTER TABLE pool_segments ADD COLUMN media_kind TEXT;     -- 'video' | 'image' | 'audio'
CREATE INDEX idx_pool_segments_source_hash ON pool_segments(source_hash);
CREATE INDEX idx_pool_segments_media_kind ON pool_segments(media_kind);
```

`media_kind` is populated on ingest by the file-type classifier (`mimetypes.guess_type` + ffprobe fallback); required on all new rows. The Import panel groups/filters by `media_kind` for icon selection and, optionally, per-kind filter chips.

**On-disk layout — flat pool**:

```
pool/
└─ <uuid>.<ext>        every imported/generated media file, regardless of kind
```

Ingest writes every file as `pool/<uuid>.<ext>`. Categorization is **SQL-only**, via `pool_segments.media_kind`. No per-kind subdirectories — the filesystem is just bytes-by-id; queries, filters, and grouping happen in the DB.

`pool_segments.pool_path` stores `<uuid>.<ext>` (relative to `pool/`).

Pre-existing `pool/segments/` and `pool/keyframes/` subdirs (legacy convention from the earlier codebase) are left in place for any code that still references them, but the new ingest path no longer writes there. Old subdirs can be collapsed in a follow-up cleanup once no code reads from them.

**New table `source_locations`** (replaces the single `original_filepath` column, which is migrated and then dropped or left NULL):
```sql
CREATE TABLE source_locations (
  id TEXT PRIMARY KEY,
  pool_segment_id TEXT NOT NULL REFERENCES pool_segments(id),
  source_kind TEXT NOT NULL,         -- 'upload' | 'server_path'
  source_ref TEXT NOT NULL,          -- user-side string for uploads; absolute server path for watched
  watched_folder_id TEXT,            -- nullable; FK to watched-folders row when source_kind='server_path'
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL         -- updated on re-sight by watcher
);
CREATE INDEX idx_source_locations_pool ON source_locations(pool_segment_id);
```

**Hashing strategy — sync, streaming** (Option A-streaming from the clarification):
- **Upload path**: during HTTP upload, read each incoming chunk once; feed it into both `hashlib.sha256()` and the disk-write buffer in parallel. By the time the last byte lands on disk, the hash is complete. Zero wall-clock overhead beyond the upload itself. Hash is typed ~40× faster than typical 100 Mbps upload on SSD.
- **Watched-folder path**: file is already on local disk; read it in chunks and hash. Sub-second for any normal size; runs synchronously during ingest.
- **Initial watched-folder scan**: loop runs in a background task (not blocking any HTTP request), but each file inside the loop still uses the same streaming hash function. Report per-file progress via WS.

**Dedup policy**:
1. Compute `source_hash` of the incoming file.
2. `SELECT id FROM pool_segments WHERE source_hash = ?`.
3. If hit: do NOT copy the file; do NOT create a new `pool_segments` row. Instead: insert a `source_locations` row linking the existing pool row to the new source path (if one doesn't already exist for this `source_ref`). Update `last_seen_at`.
4. If miss: write the file to `pool/segments/<uuid>.ext`, insert a `pool_segments` row, insert a `source_locations` row.

**Rename detection** (watchdog move event in a watched folder):
- If the new path already has a `source_locations` row for that pool_segment_id: update the `source_ref`.
- Else: insert a new `source_locations` row. Update `last_seen_at`.
- Never create a new `pool_segments` row on rename.

**Integrity check (future)**: the hash column makes it possible to re-probe pool files on demand and detect silent corruption or manual overwrite. Not implemented in MVP but unlocked.

### Missing-source recovery (was Item 5)

When a watched file disappears (watchdog delete event) and it's the only `source_locations` row for that pool_segment_id:
- Mark the pool row as `missing=true` (add column) — do NOT soft-delete yet.
- UI renders missing entries with the `FileQuestion` icon.
- Right-click offers **Relocate...** → opens the in-app filesystem browser modal. User picks a path; server verifies the hash matches; on match, inserts a new `source_locations` row and clears `missing`.
- If the user ignores it indefinitely, the bin-on-schedule sweep can soft-delete after a grace period (out of scope for MVP).

### In-app filesystem browser modal (server-side)

A modal version of the Import panel's tree, used exclusively for picking a server directory:
- Root(s) computed from the user's ACL: `SELECT path_prefix FROM acl_rules WHERE user_id = ? AND effect = 'allow'` — the top-level set of navigable starting points.
- Only one allowed root → modal opens at that root, expanded.
- Multiple roots → modal shows each as a top-level collapsed entry.
- Lists children via `GET /api/browse?path=<abs>` (ACL-enforced).
- The same tree component that renders the Import panel; single code path.

### ACL model

**Schema**:
```sql
CREATE TABLE acl_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  path_prefix TEXT NOT NULL,         -- absolute, normalized, trailing /
  effect TEXT NOT NULL,              -- 'allow' | 'deny'
  recursive INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL           -- user_id of admin who granted
);
CREATE INDEX idx_acl_rules_user ON acl_rules(user_id);
```

**Evaluation**:
1. Normalize the requested path (resolve symlinks, strip trailing `/`, re-add consistent trailing `/` for matching).
2. Select all rules for `user_id` whose `path_prefix` is a prefix of the requested path.
3. Filter to `recursive=1` rules OR `recursive=0` rules whose `path_prefix == requested_path`.
4. Sort by `length(path_prefix) DESC` (longest match wins).
5. On ties: `deny` beats `allow`.
6. Default (no match): **deny**.

**Implicit rule**: every user has an implicit `allow` on the on-disk directory of every project they own. No ACL row needed; enforced in the browse handler before the explicit-rule query.

**Bootstrap**: first user to connect to the server becomes admin and gets seeded with `allow / (root)`, recursive. Alternative: explicit CLI `scenecraft acl grant <user> /`. Auto-seed is simpler for MVP.

**Administration**:
- CLI: `scenecraft acl grant <user> <path>`, `scenecraft acl revoke <user> <path>`, `scenecraft acl list`.
- In-app admin settings page: deferred.
- Non-admin access-request workflow: deferred.

**Enforcement points** (every one of these calls checks ACL before acting):
- `GET /api/browse`
- `POST /api/projects/:name/watched-folders` (add folder)
- Any future endpoint that takes a server path as input

Existing watched folders grandfather in — no retroactive ACL check at startup. If an admin revokes a user's access, the user's existing watches continue to import until the admin also unwatches them explicitly.

---

## Benefits

- **Transparency**: users can see what the product has ingested, where it came from, and what's new.
- **Integrity**: hash-based identity eliminates silent duplicates and catches renames.
- **Permission-safe by default**: no filesystem surface is exposed without an explicit ACL grant.
- **Always-fresh ingest**: watchdog events mean the pool reflects disk state without manual refresh.
- **Minimal frontend coupling**: the Explorer is just two new panels in the existing panel library; no layout-library changes beyond the optional `primary?` flag.
- **Remote-ready**: the design correctly separates user-local (native picker, user-side paths) from server-side (browse, watch, reveal-drop, ACL), matching scenecraft's actual deployment model.

---

## Trade-offs

- **`watchdog` dependency**: adds a Python package; worth it for the cross-platform native-FS-event primitive.
- **Hash-everything cost**: every file ingested burns CPU on SHA-256. Mitigated by streaming during upload (hash is free) and background-thread scans for large initial folder ingests.
- **ACL complexity upfront**: a default-deny ACL before any file browsing makes single-user dev onboarding slightly more work (the first user bootstraps admin). Acceptable for the safety floor it provides.
- **Custom context menu**: replacing the browser's native right-click costs users some built-in commands (Inspect, Copy Link), but this is standard for desktop-class web apps (Figma, Linear, VSCode-for-Web).
- **`source_locations` schema split**: more joins when displaying a pool item. Indexed appropriately, still O(1) per fetch.
- **Remote-browser constraint**: can't offer OS-level reveal. Users pay a small UX cost (no "show in Finder") in exchange for a correct remote-capable design.
- **Initial-scan latency**: a newly-watched folder with thousands of files takes time to classify + hash. Mitigation: background task with progress events.

---

## Dependencies

- `watchdog` (Python package, cross-platform FS events).
- `mimetypes` (stdlib).
- `ffprobe` (already a project dependency; used for file-type fallback + duration probing).
- Existing WS channel for `folder_import` events.
- Existing panel library (`src/components/panel-layout/*`).
- Existing `lucide-react` icon set (`Film`, `Image`, `AudioWaveform`, `Folder`, `FolderOpen`, `FileQuestion`, `Link2`).

---

## Testing Strategy

**Backend**:
- `tests/test_acl.py`: rule evaluation correctness (longest match, deny on tie, recursive vs non-recursive, implicit-project-allow, default-deny).
- `tests/test_browse.py`: `/api/browse` respects ACL; returns correct entries; rejects denied paths with 403.
- `tests/test_watcher.py`: watchdog fires on create/modify/rename/delete; rename maps to `source_locations` update; 2s debounce holds; network-mount fallback polling works.
- `tests/test_ingest.py`: upload path uses streaming hash; watched-folder path uses file-scan hash; dedup across two import sources converges to one `pool_segments` row + two `source_locations` rows; MIME fallback accepts extensionless media; non-media ignored.
- `tests/test_migrations.py`: adds `source_hash` / `source_size`; creates `source_locations`; backfills existing `pool_segments.original_filepath` rows into `source_locations` with `source_kind` inferred from path shape.

**Frontend**:
- Integration: Explorer column appears, both groups collapsed by default; expanding each renders its tree.
- E2E upload: drag a file into "Link Media → Add file(s)"; pool row appears, icon matches media kind, tree shows the file under `"Uploads"` root.
- E2E folder-watch: pick a server dir via the in-app browser; server returns its tree; pool populates; dropping a new file into that dir (server-side) triggers a WS event and the tree updates without a manual refresh.
- Focus Mode: pressing `Shift+F` collapses all non-`primary` groups; pressing again restores.
- Custom context menu: right-click on a tree row opens the custom menu; `preventDefault` is called.
- Remote-browser boundary: attempting a "Reveal in OS" action surfaces nowhere in the UI (negative test).

**Security**:
- ACL bypass attempts: unauthenticated request → 401; authenticated but outside ACL → 403; path with `..` traversal → 403; symlink pointing outside allowed root → 403 after resolve.

---

## Migration Path

Greenfield — no backfill required. Existing `pool_segments` rows (if any are in use) can be cleared/ignored at migration time; production data for this feature has not yet accumulated.

1. **Schema**: add `source_hash`, `source_size`, `media_kind` columns; create `source_locations` and `acl_rules` tables; drop `pool_segments.original_filepath` outright (no data worth preserving). Ensure `pool/` exists on project startup; no per-kind subdirs.
2. **ACL bootstrap**: on first server start with a non-empty user base, if `acl_rules` is empty, seed the first authenticated user as admin with `allow / (root)` recursive. Log the seed event.
3. **Watcher**: register observers for every pre-existing watched folder on server start. Any rows the pre-migration watcher produced are discarded along with the old columns — greenfield.
4. **Frontend default layout**: ship the new default layout with the Explorer column collapsed. Existing users keep their saved layouts; a small migration in the workspace-view loader inserts the Explorer column on the left if their saved layout doesn't have it. `primary: true` is applied to `preview-group` and `timeline-group` automatically if absent.
5. **Rollback**: remove the new panel registrations and default-layout migration; drop `acl_rules` and `source_locations`; `source_hash` / `source_size` / `media_kind` are harmless if left nullable.

---

## Key Design Decisions

### Panel architecture

| Decision | Choice | Rationale |
|---|---|---|
| Single panel with inner split vs. two panel groups | **Two peer `GroupNode`s** in a vertical `SplitNode` | Matches the project's existing "panel group" concept; per-group collapse/drag/detach for free; no layout-library schema changes. User correction: "it's two separate panels". |
| Sidebar concept | **No hard-coded sidebar** | "'sidebars' don't technically exist in this project, everything is a panel group." Explorer lives as peer columns under the root split. |
| Default-collapsed | **Yes** | Minimal default clutter; user opts in to the Explorer surface. |
| Expanded width | **~275 px** | User preference over right-sidebar parity. |
| Focus Mode hotkey | **`Shift+F`** | DaVinci Resolve convention, familiar to video editors; short and chord-free vs. IntelliJ's `Cmd+Shift+F12`. |
| Primary flag location | `primary?: boolean` on `GroupNode` | Smallest schema addition; reuses existing collapse infra for the focus-mode behavior. |
| Primary toggle UI | **Ellipsis (⋮) menu** on the panel-group header | Not right-click. The ellipsis menu already exists on every group (Add Panel, Close Group) — adding "Mark as Primary" / "Unmark as Primary" keeps all group-level controls in one discoverable surface. |

### Project view

| Decision | Choice | Rationale |
|---|---|---|
| View model | **Real on-disk mirror** | Matches VSCode explorer familiarity; no drift between dir state and UI. |
| Default hidden filters | `project.db-wal/shm`, `.DS_Store`, `Thumbs.db`, `transaction_snapshots/` — **always hidden, no toggle** | After verifying what a project dir actually contains, most originally-proposed filters match nothing. `transaction_snapshots/` is checkpoint state — surfaced via the future Branch Explorer panel (separate tab), not the Project view. |
| Context menu | **Custom in-app menu replacing browser native** | Web pages can't extend the browser's context menu; all desktop-class web apps (Figma/Linear/VSCode-for-Web) replace it. |
| "Reveal in system file manager" | **Dropped** | Server-side reveal is unreachable from a remote browser. |

### Import view and ingest

| Decision | Choice | Rationale |
|---|---|---|
| Tree shape | **Flat roots** (one per watched folder + `"Uploads"`) | Matches how watched folders are conceptually independent. |
| Media-kind icons | `Film` / `Image` / `AudioWaveform` / `Folder` / `FolderOpen` / `FileQuestion` (lucide) | User pref for waveform over music-note; shared visual metaphor with existing audio track UI. |
| Status badges | **None** | UI shows state, not lifecycle. |
| Header button | "Link Media" | User-chosen phrasing; encompasses both upload and watch paths. |
| Refresh action | **None — always live via watchdog** | "should always be fresh". |
| File-type detection | `mimetypes.guess_type` + ffprobe fallback | Broad acceptance without libmagic dep; fallback catches edge-case files without extensions. |
| Import semantics | **Copy into pool** (not symlink) | Pool must be self-contained; symlinks break if the source moves. |
| Dedup | **By content hash** (SHA-256) | Catches cross-folder duplicates, upload-then-watch duplicates, and renames (when combined with `source_locations`). |
| Hash timing | **Sync, streaming during upload**; sync file-scan for watched-folder path; initial scan runs in a background thread | Hash is ~40× faster than upload; streaming means zero wall-clock overhead on uploads. |
| Pool removal semantics | **Hard-delete pool copy; leave source intact** | Source files (watched-folder contents, user-local uploads) are owned by the user, not by scenecraft. Removing a pool entry drops the DB rows and the on-disk `pool/segments/*` copy only. A subsequent re-ingest (same source, same hash) recreates the pool row cleanly. No bin state for pool items — hard delete is the contract. |
| Upload media types | **Video, image, AND audio** | Native file picker uses `accept="video/*,image/*,audio/*"`. Same upload endpoint + ingest pipeline for all three; classifier assigns `media_kind` on the fly. Single `pool_segments` table, `media_kind` column for queries. |
| On-disk pool layout | **Flat `pool/<uuid>.<ext>`** — categorization via SQL only | One source of truth. Avoids dir-vs-column desync (no risk of a row's `media_kind` disagreeing with which subdir it lives in). Filesystem is just content-addressable storage; every query goes through SQL. Legacy `pool/segments/` and `pool/keyframes/` left in place for any still-reading code, collapsed in a follow-up. |
| Migration strategy | **Greenfield — no backfill** | No accumulated production data to preserve. Old `pool_segments.original_filepath` column is dropped outright; new columns added fresh. Simpler, no heuristic `source_kind` inference, no ffprobe sweep at startup. |

### Architecture

| Decision | Choice | Rationale |
|---|---|---|
| Server-browser topology | **Treated as remote throughout** | User correction: "the web browser is remote". Shapes every reveal/picker/path decision. |
| OS reveal | **Dropped** | Would run on the server. |
| File picker vs. in-app browser | **Native picker for file upload; in-app browser for folder watch** | File upload only needs bytes (native works fine); folder watch needs server-side path (native folder picker doesn't expose one). |
| `source_locations` schema | Replaces single `original_filepath` | Supports multi-source dedup (same bytes seen from multiple folders), rename detection, and upload-vs-server-path distinction. |
| Persisted focus-mode snapshot | **No, ephemeral** | Snapshot is UI state that shouldn't survive restart; `primary` flag is what's persisted. |

### ACL

| Decision | Choice | Rationale |
|---|---|---|
| Scope | **Server-level** (one ACL table) | Roots being browsed are machine-wide, not per-project. |
| Granularity | **Per-user path-prefix grants**, no roles for MVP | Simplest model that handles multi-user; roles layer on top later. |
| Default policy | **Deny all** | Safety floor; users need explicit grants to browse outside their projects. |
| Project-dir implicit allow | **Yes** | Each user can always browse the projects they own without needing a rule. |
| Evaluation order | **Longest-prefix match; deny beats allow on tie** | Standard ACL precedence; lets narrow deny rules carve out exceptions. |
| Bootstrap | **First user auto-admin** with `allow /` | Simplest for single-user dev; CLI can add more admins later. |
| Admin UI | **CLI only for MVP** | In-app settings page is a whole other surface; defer. |

---

## Future Considerations

- **Source Monitor panel** (Premiere-style) — second tab on `preview-group`; double-click a media row → opens clip, scrubber, `I`/`O` marks, Insert at Playhead / Drag to timeline. Deferred to its own milestone; it's a separate UI surface with its own scope (media playback, in/out handles, track-insert semantics).
- **Branch Explorer panel** — dedicated tab (separate from Project view) for browsing checkpoint/snapshot state in `transaction_snapshots/` and the VCS layer. Lets users view snapshot history, diff revisions, and restore checkpoints without cluttering the on-disk Project view with backup noise. Ties into M6 (Git-Style Version Control). Out of scope for this milestone.
- **In-app ACL admin UI**: replace CLI grants with a settings page once we have multiple users regularly.
- **Access-request workflow**: non-admin asks admin for a path; notification + one-click approve.
- **Role-based ACL**: `admin` / `editor` / `viewer` roles on top of the existing rules.
- **Integrity sweep**: periodic background job that re-hashes pool files and flags drift from `source_hash`.
- **Network-mount polling frequency tuning**: currently hard-coded to 5s; may need per-mount config.
- **Local-daemon client**: if we ever ship a desktop companion that exposes a local FS browser to the server, we can re-introduce OS reveal and true local-folder watching.
- **Watched-folder "soft delete on missing file with grace period"**: auto-bin pool entries whose only source has been absent for N days.
- **Drag-from-Explorer-to-timeline**: currently routed through the Bin/Source Monitor paths; direct Explorer-to-timeline is a follow-up polish.

---

**Status**: Design Specification
**Recommendation**: Proceed to milestone + task breakdown via `@acp.plan`. Implementation cleanly divides into (a) schema + ACL foundation, (b) server-side browse/watch services, (c) frontend Explorer panels, (d) Focus Mode integration.
**Related Documents**:
- [Clarification 5: Explorer Panel and Media Import](../clarifications/clarification-5-explorer-panel-and-media-import.md)
- [local.custom-panel-layout.md](local.custom-panel-layout.md) — panel library this builds on
- [local.candidate-pool-migration.md](local.candidate-pool-migration.md) — earlier pool work
