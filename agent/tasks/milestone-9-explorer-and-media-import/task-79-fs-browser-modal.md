# Task 79: In-App Filesystem Browser Modal (ACL-Gated)

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 5 hours
**Dependencies**: Task 73 (`/api/browse`), Task 76 (panel registration), Task 77 (FSTree component)
**Status**: Not Started

---

## Objective

Build a modal filesystem-browser that shows the **server's** filesystem (not the user's local machine), ACL-gated. Used by "Add folder to watch" in the Import panel and by the Relocate flow (Task 81). Reuses the `FSTree` component from Task 77.

---

## Steps

1. **Fetch allowed roots** — new endpoint `GET /api/acl/my-roots`:
   - Returns the set of `path_prefix` values the authenticated user has `allow` rules for, plus the paths of all projects the user owns (implicit-allow).
   - Response: `{"roots": ["/", "/mnt/media/", "/home/user/Movies/"]}` (example).

2. **Modal component** — `scenecraft/src/components/editor/explorer/FSBrowserModal.tsx` (new):
   - Props:
     ```ts
     {
       open: boolean
       title?: string                    // e.g. "Add folder to watch" or "Relocate source"
       mode: 'directory' | 'file'        // what can be selected
       onCancel: () => void
       onConfirm: (selectedPath: string) => void
     }
     ```
   - On open, fetch allowed roots.
   - If one root → render it expanded; no top-level grouping UI.
   - If multiple roots → render each as a collapsed top-level entry, user clicks to expand.
   - Body uses `FSTree` with `fetchChildren = (path) => GET /api/browse?path=<abs>`.
   - Selection state: single-select path (absolute).
   - Footer: Cancel + `mode === 'directory' ? 'Watch this folder' : 'Select'`.
   - In `directory` mode, the Confirm button is enabled only when a directory row is selected.

3. **Dismiss behavior**:
   - Escape key → cancel.
   - Backdrop click → cancel.
   - Confirm → `onConfirm(selectedPath)`; modal closes.

4. **Modal container** — use whatever modal primitive the project uses (check `src/components/` for existing `Dialog` / `Modal` components). If none exists, use a fixed-position overlay + centered card.

5. **Hidden files**: leave the `?show_hidden=` toggle in `/api/browse` opt-in; the modal defaults to `show_hidden=0`.

6. **Error states**:
   - 403 on expand → render that row as "Access denied" (inert, italic).
   - 404 → "Path not found — may have been moved".

7. **Tests**:
   - Modal renders with mocked `/api/acl/my-roots` returning two roots.
   - Expand a root → fetches children, renders them.
   - Click a directory → selection highlights → Confirm fires `onConfirm(path)`.
   - Click a file in directory mode → Confirm stays disabled.
   - Escape / backdrop → fires `onCancel`.

---

## Verification

- [ ] `/api/acl/my-roots` endpoint returns the union of allow-prefixes and implicit project dirs.
- [ ] Modal opens, shows allowed roots, expands via `/api/browse`.
- [ ] Selection + Confirm returns the absolute path.
- [ ] Mode gating works (directory-only vs file selection).
- [ ] Dismiss via Escape / backdrop / Cancel.
- [ ] Access-denied and not-found errors rendered gracefully.
- [ ] Tests pass.

---

**Next Task**: [Task 80: Focus Mode](task-80-focus-mode.md)
