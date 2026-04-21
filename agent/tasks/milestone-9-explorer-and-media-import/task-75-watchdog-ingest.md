# Task 75: Watchdog Ingest (Live Watcher + Rename Detection)

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 8 hours
**Dependencies**: Task 71 (ACL), Task 72 (classifier + hasher), Task 74 (upload pipeline shares dedup path)
**Status**: Not Started

---

## Objective

Replace polling-based watched-folder ingest with a `watchdog`-backed live observer per root. 2s debounce for file-writes, rename detection via move events, network-mount polling fallback, WS broadcasts on change.

---

## Context

Today's watched-folders API registers paths and ingests on demand/poll. This task makes it live: a Python `watchdog` Observer per registered root fires events in near-real-time, which route through the dedup-aware ingest path (Task 74 shares the helper).

Key behaviors from the design:
- **Debounce**: wait 2s after the last modification event before ingesting (file may still be being written).
- **Rename**: watchdog distinguishes rename from delete+create; update `source_locations.source_ref` on the existing pool row rather than creating a new row.
- **Network mounts**: inotify/FSEvents don't fire on SMB/NFS. Detect via `statvfs` at registration; fall back to polling every 5s.
- **ACL**: `add-watched-folder` checks ACL on the target path.

---

## Steps

1. **Add `watchdog` to `pyproject.toml`** (scenecraft-engine): `watchdog>=4.0`.

2. **Watched-folders schema** — ensure there's a server-level table tracking registered folders:
   ```sql
   CREATE TABLE IF NOT EXISTS watched_folders (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     project_name TEXT NOT NULL,
     path TEXT NOT NULL,
     uses_polling INTEGER NOT NULL DEFAULT 0,
     registered_at TEXT NOT NULL
   );
   ```
   Reuse existing if present; otherwise add.

3. **Core watcher module** in `scenecraft-engine/src/scenecraft/watch.py` (new):
   ```python
   from watchdog.observers import Observer
   from watchdog.observers.polling import PollingObserver
   from watchdog.events import FileSystemEventHandler
   import threading, time

   class MediaIngestHandler(FileSystemEventHandler):
       def __init__(self, project_dir, watched_folder_id, debounce_s=2.0):
           self.project_dir = project_dir
           self.watched_folder_id = watched_folder_id
           self.debounce_s = debounce_s
           self._pending: dict[str, threading.Timer] = {}

       def on_created(self, event):  ...
       def on_modified(self, event): ...
       def on_moved(self, event):    ...  # rename
       def on_deleted(self, event):  ...

       def _debounced_ingest(self, path):
           timer = self._pending.pop(path, None)
           if timer: timer.cancel()
           t = threading.Timer(self.debounce_s, self._ingest_now, args=(path,))
           self._pending[path] = t
           t.start()

       def _ingest_now(self, path):
           # Classify, hash, dedup, insert source_location
           # Shared helper with upload pipeline (extract from Task 74)
           ...
   ```

4. **Observer pool** — manager class `WatchManager`:
   - `register(project_dir, path, user_id)`:
     - Check ACL.
     - Detect filesystem type via `os.statvfs`. If `cifs`/`nfs`/`fuse.*`, use `PollingObserver` instead of `Observer`. Set `uses_polling=1`.
     - Insert row into `watched_folders`.
     - Create an Observer, attach a `MediaIngestHandler`, start it, keep reference.
     - Trigger initial scan (runs in a background thread; iterates existing files, debounce-ingests each).
   - `unregister(folder_id)`:
     - Stop the Observer.
     - Remove the `watched_folders` row.
     - Optionally (param): remove pool rows referenced only from this folder. Default: keep.
   - `restart_all()`: called on server start; re-spawns observers for every row in `watched_folders`.

5. **Extract shared ingest helper** from Task 74 into `scenecraft-engine/src/scenecraft/ingest.py`:
   ```python
   def ingest_file(project_dir, abs_path, source_kind, source_ref, watched_folder_id=None):
       """Classify, hash, dedup, insert pool_segments + source_locations as needed.
          Returns {pool_segment_id, deduped, media_kind}."""
       ...
   ```
   Task 74's upload handler calls this after writing to the pool dir (with `source_kind='upload'`); Task 75 watchdog calls this with `source_kind='server_path'` pointed at the file on disk in the watched folder.

6. **Rename handling** in `on_moved`:
   - Look up `source_locations WHERE source_ref = <old_path>`.
   - If found: `UPDATE source_locations SET source_ref = <new_path>, last_seen_at = NOW()`.
   - Do NOT call `ingest_file`.
   - Broadcast `folder_renamed` WS event.

7. **Delete handling** in `on_deleted`:
   - Look up `source_locations WHERE source_ref = <path>`.
   - If this is the ONLY location for its `pool_segment_id`: mark pool row `missing=true` (add `missing INTEGER NOT NULL DEFAULT 0` to pool_segments — minor schema addition that belongs here OR in Task 81; place in Task 81 if prefer).
   - Broadcast `folder_removed` WS event.

8. **Endpoints** in `api_server.py`:
   - `POST /api/projects/:name/watched-folders` body `{path: "..."}` → `WatchManager.register`.
   - `DELETE /api/projects/:name/watched-folders/:id` → `WatchManager.unregister`.
   - `GET /api/projects/:name/watched-folders` → list rows.

9. **WS events**: `pool_updated`, `folder_renamed`, `folder_removed` — same channel as existing events.

10. **Server-start hook**: call `WatchManager.restart_all()` in `api_server.py` startup.

11. **Tests** (`scenecraft-engine/tests/test_watcher.py`):
    - `tmpdir`-backed fixture + real watchdog Observer.
    - Create a new media file in a registered folder → WS event fires within debounce + epsilon.
    - Rename a file → `source_locations.source_ref` updates; no new pool row.
    - Delete a file → `source_locations` row removed / pool row marked missing (depending on where `missing` flag lands).
    - Network-mount detection: mock `statvfs` to return `'nfs'` → `PollingObserver` selected.
    - ACL rejection on register → 403; no watcher created; no DB row.

---

## Verification

- [ ] `watchdog` dep added.
- [ ] `WatchManager` registers/unregisters observers; handles FS-type polling fallback.
- [ ] `MediaIngestHandler` debounces writes 2s before ingest.
- [ ] Rename event updates `source_locations.source_ref`, never creates a duplicate pool row.
- [ ] Delete event removes the source location; pool row status handled.
- [ ] Initial scan on register runs in background thread.
- [ ] WS events fire on all transitions.
- [ ] Endpoints exist and are ACL-gated.
- [ ] Server-start hook re-spawns observers for all registered folders.
- [ ] All tests pass.

---

**Next Task**: [Task 76: Panel registration + default layout](task-76-panel-registration-and-layout.md)
