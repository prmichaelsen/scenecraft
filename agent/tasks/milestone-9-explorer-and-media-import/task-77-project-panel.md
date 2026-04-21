# Task 77: Project Panel (Tree View + Custom Contextmenu)

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 8 hours
**Dependencies**: Task 73 (`/api/browse` endpoint), Task 76 (panel registration)
**Status**: Not Started

---

## Objective

Build the Project panel body — a collapsible tree view of the server-side project directory, with a custom right-click menu (replacing the browser native) and row actions for copy path, rename, preview, and remove-from-project.

---

## Context

The Project panel shows the real on-disk contents of the project directory, rooted at `project_dir`. It always-hides the noise set (`project.db-wal`, `project.db-shm`, `.DS_Store`, `Thumbs.db`, `transaction_snapshots/`) with no user toggle. Backup/checkpoint state is surfaced via a future Branch Explorer panel, not here.

---

## Steps

1. **Backend endpoints needed** (confirm exist, add if missing):
   - `GET /api/projects/:name/tree?path=<relative>` — returns `{path, entries: [...]}` for a path within the project. Similar shape to `/api/browse` but relative paths rather than absolute. Implicit-allow (always permitted for the project's owner).
   - `PATCH /api/projects/:name/path` body `{old: "...", new: "..."}` — rename.
   - `DELETE /api/projects/:name/path` body `{path: "...", pool_segment_id?: "..."}` — hard-delete the on-disk file and (if `pool_segment_id` matches) drop the pool row + source_locations rows. Source files outside the project dir NOT affected.

2. **Tree component** — `scenecraft/src/components/editor/explorer/FSTree.tsx` (new, shared with Task 79):
   - Props: `{ rootPath: string, fetchChildren: (path: string) => Promise<Entry[]>, renderRow?, onRowActivate?, onRowContextMenu? }`.
   - Lazy-loads children when a folder is expanded; caches per path.
   - Listens for `folder_import` / `folder_removed` / `folder_renamed` WS events and invalidates the relevant path.
   - Keyboard navigation: arrow keys up/down/left/right.
   - Visual: fixed-row, hover highlight, folder chevrons.

3. **Project panel** — `scenecraft/src/components/editor/ProjectPanel.tsx`:
   - Mounts `FSTree` with `rootPath = ""` (project-relative) and `fetchChildren` → `GET /api/projects/<name>/tree?path=<rel>`.
   - Passes `onRowContextMenu` to render the custom menu.
   - Passes `onRowActivate` (double-click) → opens in Preview panel (for now; Source Monitor integration is deferred).

4. **Always-hidden filter** — before rendering, filter entries whose name is in `{"project.db-wal", "project.db-shm", ".DS_Store", "Thumbs.db"}` or whose name equals `"transaction_snapshots"` and `kind === "dir"`.

5. **Custom contextmenu** — `scenecraft/src/components/editor/explorer/RowContextMenu.tsx`:
   - Parent uses `onContextMenu` with `preventDefault()` to suppress the browser menu.
   - Shows a floating panel at the cursor position with items:
     - **Copy absolute path** — server returns absolute path via `/api/projects/:name/resolve?path=<rel>` (new mini endpoint) or the tree payload includes `absPath`. Writes to clipboard via `navigator.clipboard.writeText`.
     - **Copy relative path** — writes the project-relative path.
     - **Open in Preview** (files only) — fires the preview-panel event.
     - **Rename** — inline rename UI on the row (prompt for new name, PATCH).
     - **Remove from project** — confirm modal ("Hard-deletes this file from the project. The original source file is NOT touched. Continue?"), then DELETE.
   - Close on outside click, Escape key, action click.
   - Reuse the menu primitive from `PanelGroup.tsx:230-269` if feasible — same popover style, different contents.

6. **Row icons** — match by `entry.mediaKind` (from `/api/browse`-style response) or `entry.kind` for dirs:
   - `Folder` / `FolderOpen` for dirs.
   - `Film` for video, `Image` for image, `AudioWaveform` for audio.
   - Generic `File` for other (rarely rendered since most non-media is hidden or non-interactive).

7. **State invalidation**:
   - On rename success: re-fetch the parent directory.
   - On remove success: re-fetch the parent directory; also dispatch a pool-update event if a `pool_segment_id` was involved.
   - On WS events: selectively invalidate.

8. **Tests**:
   - Component test: render tree with a mocked fetch; expand folder; verify children render.
   - Context menu opens with `contextmenu` event; `preventDefault` called; items render.
   - Copy path writes to `navigator.clipboard` (mock).
   - Rename flow: prompt → PATCH → tree refreshes.
   - Delete flow: confirm → DELETE → tree refreshes.
   - Always-hidden filter: noise entries never appear in rendered DOM.

---

## Verification

- [ ] Project panel shows real project-dir contents via `/api/projects/:name/tree`.
- [ ] Always-hidden set filtered (noise files absent).
- [ ] `transaction_snapshots/` never shown.
- [ ] Custom contextmenu appears on right-click with all 5 action items.
- [ ] Each action works: copy abs path, copy rel path, open preview, rename, remove.
- [ ] Rename + remove invalidate the tree state so UI reflects disk state.
- [ ] WS events trigger targeted refreshes.
- [ ] Tests pass.

---

**Next Task**: [Task 78: Import panel](task-78-import-panel.md)
