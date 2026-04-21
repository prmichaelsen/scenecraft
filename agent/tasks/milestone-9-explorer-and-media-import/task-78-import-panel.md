# Task 78: Import Panel (Roots + Icons + Link Media Menu)

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 8 hours
**Dependencies**: Task 74 (upload pipeline), Task 75 (watchdog), Task 76 (panel registration), Task 79 (FS browser modal — can stub until it lands)
**Status**: Not Started

---

## Objective

Build the Import panel body: flat list of top-level roots (one per watched folder + a synthetic `"Uploads"` root), lucide media-kind icons per row, a "Link Media" header button opening Add File(s) / Add Folder to Watch, and per-row context menu actions.

---

## Context

The Import panel surfaces user-registered media sources. Each watched folder is its own top-level root. Single-file uploads land under a synthetic `"Uploads"` root grouped by the upload filename.

---

## Steps

1. **Data fetching**:
   - `GET /api/projects/:name/watched-folders` — list of watched roots (from Task 75).
   - `GET /api/projects/:name/pool/segments?source_kind=upload` — list of uploaded pool items (new endpoint if missing; returns `pool_segments` joined with `source_locations WHERE source_kind='upload'`).

2. **Tree structure** — Import panel renders a forest:
   ```
   📁 /mnt/media/videos                    ← watched folder root (absolute path shown)
      ├─ 🎬 scene1.mp4
      └─ 🎵 song.mp3
   📁 Uploads                               ← synthetic root
      ├─ 🎬 myclip.mp4
      └─ 🖼️ reference.png
   ```
   - Watched folder roots render the absolute path on disk as their label (truncated with ellipsis + hover tooltip for long paths).
   - Within each watched root, subtree mirrors the server FS (lazy-load via `/api/browse`).
   - `"Uploads"` is synthetic — flat list, no subtree.

3. **Row icons** (lucide-react, 14px):
   - `Folder` / `FolderOpen` for dirs (collapsed/expanded).
   - `Film` for video, `Image` for image, `AudioWaveform` for audio.
   - `FileQuestion` for missing-source rows (post-Task 81).

4. **Header**: "Link Media" button + menu:
   - Button: `<Link2 size={12} />` + text `"Link Media"`, right-aligned in the panel header.
   - On click, menu opens with two items:
     - **Add file(s) to import** — triggers a hidden `<input type="file" multiple accept="video/*,image/*,audio/*">`; on change, POSTs each file to `/api/projects/:name/pool/upload`; WS `pool_updated` triggers a panel refresh.
     - **Add folder to watch** — opens the FS browser modal (Task 79); on confirm, POSTs to `/api/projects/:name/watched-folders`.
   - Outside-click / Escape dismiss.

5. **Per-row context menu** (reuse `RowContextMenu` from Task 77):
   - **On a watched folder**:
     - _Unwatch (keep pool rows)_ — DELETE `/api/projects/:name/watched-folders/:id?keep_pool_rows=true`.
     - _Unwatch and remove pool rows_ — DELETE with `?keep_pool_rows=false`.
     - No "Refresh" — watchdog keeps it live.
     - No "Reveal in system file manager" — server is remote.
   - **On an imported file** (file in a watched folder, or upload):
     - _Drag to timeline_ — mark the row as draggable; standard DnD payload `{poolSegmentId, mediaKind}`.
     - _Remove from pool_ — DELETE `/api/projects/:name/pool/:id` — hard-deletes pool copy, drops `pool_segments` + `source_locations` rows. **Source file on disk is NOT touched.** Confirm with a modal that spells this out.

6. **Empty state**: when no watched folders exist and no uploads, show a centered message: _"No media yet. Click Link Media above to import files or watch a folder."_

7. **WS event handling**:
   - `pool_updated` → re-fetch uploads list + invalidate any relevant watched-folder subtree.
   - `folder_renamed` → invalidate the parent dir; re-render with new names.
   - `folder_removed` → invalidate.

8. **Tests**:
   - Mocked fetch returns two watched folders + one upload → panel renders three roots.
   - Icons match mediaKind.
   - Click "Link Media > Add file(s)" opens file picker; uploading triggers POST; panel refreshes.
   - Click "Link Media > Add folder to watch" opens FS browser modal (or its stub).
   - Context menu on a watched-folder row shows Unwatch options.
   - Context menu on a file row shows Drag + Remove.
   - Remove-from-pool confirm modal mentions "source file is NOT touched".

---

## Verification

- [ ] Import panel lists watched folders + synthetic "Uploads" root.
- [ ] Media icons per row (`Film`/`Image`/`AudioWaveform`, `Folder`/`FolderOpen`).
- [ ] "Link Media" header button opens menu with file picker + folder-watch actions.
- [ ] Native `<input type=file accept="video/*,image/*,audio/*">` triggered on Add File(s).
- [ ] Add Folder to Watch opens the FS browser modal.
- [ ] Per-row context menus work; remove-from-pool confirm wording is correct.
- [ ] WS events refresh the panel.
- [ ] Tests pass.

---

**Next Task**: [Task 79: In-app FS browser modal](task-79-fs-browser-modal.md)
