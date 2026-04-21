# Task 81: Missing-Source Recovery (Detection + Relocate)

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 4 hours
**Dependencies**: Task 74 (upload pipeline), Task 75 (watchdog delete event), Task 79 (FS browser modal)
**Status**: Not Started

---

## Objective

Detect when a watched-folder source disappears (watchdog delete event), mark the corresponding `pool_segments` row as missing, render it with the `FileQuestion` icon in the Import panel, and offer a **Relocate...** action that opens the FS browser modal to pick a new path (with hash re-verification).

---

## Context

Sources can vanish: a user deletes a watched file, renames the enclosing folder, or unmounts a drive. The pool copy still exists (scenecraft owns it), but the source path in `source_locations` is now stale. This task handles the UX for that case.

---

## Steps

1. **Schema addition** — `pool_segments.missing INTEGER NOT NULL DEFAULT 0` (added here if not done in Task 75). Follow the idempotent `ALTER TABLE` pattern.

2. **Watchdog delete handler update** (Task 75 may already do this; if not, add):
   - On `on_deleted`, look up `source_locations WHERE source_ref = <path>`.
   - If found:
     - Delete the `source_locations` row.
     - If no other locations remain for that `pool_segment_id`: set `pool_segments.missing = 1`.
     - Broadcast WS `pool_missing` event with the pool id.

3. **Import panel rendering** (extends Task 78):
   - For rows where `pool_segments.missing = 1`, render with the `FileQuestion` icon and a subtle color treatment (e.g. red-tinted text).
   - Add tooltip: "Source file not found. Click to relocate."

4. **Row action "Relocate..."** — adds a new context-menu item for missing rows:
   - Opens the FS browser modal (Task 79) in `file` mode.
   - On confirm with a selected path, POST `/api/projects/:name/pool/:id/relocate` body `{new_path: "..."}`.

5. **Backend endpoint** `POST /api/projects/:name/pool/:id/relocate`:
   - ACL-check the new path.
   - Compute SHA-256 of the new file via `hashing.hash_file`.
   - Compare to `pool_segments.source_hash`:
     - **Match**: insert new `source_locations` row with `source_kind='server_path'`, `source_ref=<new_path>`; set `pool_segments.missing = 0`; return 200.
     - **Mismatch**: return 409 with a message ("Selected file's contents do not match the original. Pick a different file.").
   - No new pool copy — we trust the existing `pool/<uuid>.<ext>`.

6. **Watchdog auto-recover** (bonus, nice-to-have): if a file shows up in any watched folder with a hash matching a `missing=1` row, auto-add a `source_locations` entry and clear `missing`. Task 75's debounced ingest path already hashes every new file; add the "check if this hash is a missing-source candidate" step when `find_pool_by_hash` hits an existing row.

7. **Tests**:
   - Simulate a watched file being deleted → pool row `missing=1`, WS `pool_missing` fires.
   - Relocate endpoint with matching hash → 200, `missing=0`, new source_location present.
   - Relocate endpoint with mismatched hash → 409, `missing` stays 1.
   - Auto-recover (bonus): drop the identical file in another watched folder → `missing` clears automatically.
   - UI: row with `missing=1` renders `FileQuestion` + tooltip; Relocate menu item present; clicking opens FS browser modal.

---

## Verification

- [ ] `pool_segments.missing` column present.
- [ ] Watchdog delete → `missing=1` when no other source_locations remain.
- [ ] UI renders missing rows with `FileQuestion` + tooltip + Relocate action.
- [ ] `/api/projects/:name/pool/:id/relocate` ACL-checks, hash-verifies, updates on match.
- [ ] Mismatch → 409 with clear error message.
- [ ] Auto-recover on re-sighted hash works (if implemented).
- [ ] Tests pass.

---

**Next Task**: (End of M9) — Review M9 success criteria; run milestone completion sweep.
