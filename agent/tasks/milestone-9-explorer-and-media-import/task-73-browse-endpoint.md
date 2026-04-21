# Task 73: /api/browse Endpoint (ACL-Gated Server FS Listing)

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 5 hours
**Dependencies**: Task 71 (ACL system), Task 72 (classifier)
**Status**: Not Started

---

## Objective

Build the single HTTP endpoint the frontend uses to browse server-side filesystem: `GET /api/browse?path=<abs>`. Checks ACL on the requested path, returns a directory listing with media-kind annotations.

---

## Context

The in-app filesystem browser modal and the Project panel (when it peeks outside the project dir for a Relocate flow) are both backed by this one endpoint. Same shape, ACL-consistent, no other path-listing surfaces.

---

## Steps

1. **Register route** in `scenecraft-engine/src/scenecraft/api_server.py`:
   ```
   GET /api/browse?path=<abs>
   ```
   Auth required (reuse existing JWT/SSH pubkey auth).

2. **Handler** (`_handle_browse`):
   - Parse `path` query parameter; reject if missing or empty with 400.
   - Normalize path via `acl.normalize_path`.
   - Call `acl.check_access(user_id, normalized)`; on False, return 403.
   - Reject if path isn't a directory (404 or 400 — prefer 400 for user-provided paths that exist but aren't dirs).
   - Enumerate children via `pathlib.Path.iterdir()`.
   - For each child:
     - `name`: child's filename.
     - `kind`: `'dir'` if `is_dir()`, else `'file'`.
     - `size`: for files, the byte size.
     - `mtime`: ISO 8601 modified time.
     - For files, call `media.classify_media(child)` → `mediaKind`.
   - Sort: dirs first alphabetically, then files alphabetically.
   - Return:
     ```json
     {
       "path": "/mnt/media",
       "entries": [
         {"name": "clips", "kind": "dir"},
         {"name": "song.mp3", "kind": "file", "size": 4823041, "mtime": "2026-04-20T...", "mediaKind": "audio"}
       ]
     }
     ```

3. **Filter hidden files**:
   - By default, skip entries whose name starts with `.` (dotfiles) unless the caller passes `?show_hidden=1`.
   - Skip the "always-hidden" set regardless (see design doc): `project.db-wal`, `project.db-shm`, `.DS_Store`, `Thumbs.db`, and `transaction_snapshots/` when inside a project dir.

4. **Rate classification**:
   - Classify media kind only for small files OR only for files matching media MIME via extension first (fast path). Avoid `ffprobe` fallback in `/api/browse` — a 1000-file dir should list fast. Use `mimetypes.guess_type` only; leave ffprobe for ingest time.

5. **Error handling**:
   - `PermissionError` reading a directory → 403 with message.
   - `FileNotFoundError` → 404.
   - Path traversal attempts (`..` in the query) → rejected by `normalize_path` → 403.

6. **Tests** (`scenecraft-engine/tests/test_browse.py`):
   - Authenticated user with allow rule on `/tmp/fixture/` → 200 with sorted entries.
   - Same user requests `/tmp/other/` → 403.
   - Unauthenticated → 401.
   - Path with `..` that escapes ACL → 403 after resolve.
   - Symlink pointing outside allowed root → 403.
   - Non-directory path → 400.
   - Hidden files filtered by default; `?show_hidden=1` includes them.
   - `mediaKind` populated for media files via extension; unknowns have `null`.

---

## Verification

- [ ] Route registered and responds to authenticated GETs.
- [ ] ACL check runs before any filesystem enumeration.
- [ ] Response shape matches design (`{path, entries: [...]}`).
- [ ] Dirs sorted before files; both alphabetical.
- [ ] Hidden files filtered by default.
- [ ] `mediaKind` set via fast extension match only (no ffprobe in this endpoint).
- [ ] All tests pass including traversal + symlink-escape cases.

---

**Next Task**: [Task 74: Upload pipeline](task-74-upload-pipeline.md)
