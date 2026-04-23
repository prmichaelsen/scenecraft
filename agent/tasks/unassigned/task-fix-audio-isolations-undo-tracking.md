# Task: Fix `audio_isolations` + `isolation_stems` undo-tracking bug

**Milestone**: Unassigned (bug introduced in M11 task-100b; M11 is closed)
**Design Reference**: [Stem Splitter Plugin](../../design/local.stem-splitter-plugin.md) — Section "Generation writes bypass the undo log" surfaces this bug
**Estimated Time**: 1–2 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Remove `audio_isolations` and `isolation_stems` from the undo-tracked tables list and drop their undo triggers. Bring these tables in line with scenecraft's convention that generation-output tables (`pool_segments`, `tr_candidates`, `audio_candidates`, junction tables) do not participate in the undo log.

---

## Context

### The bug

M11 task-100b (`feat(db): add audio_isolations + isolation_stems schema + helpers`, commit `14700c6`) did two things that turned out to be wrong:

1. Added `"audio_isolations"` to `_undo_tracked_tables` in `db.py::_ensure_schema` — which means `_install_undo_triggers` installs insert/update/delete undo triggers on it.
2. Added explicit composite-PK undo triggers for `isolation_stems` (the junction's composite key couldn't use the shared id-keyed trigger pattern, so the task installed hand-written ones).

Both tables are **generation metadata**, not editorial state. Per the scenecraft convention:

- **`_undo_tracked_tables` holds editorial state only**: `keyframes`, `transitions`, `suppressions`, `effects`, `tracks`, `transition_effects`, `markers`, `audio_tracks`, `audio_clips`. Things the user deliberately placed, moved, or edited.
- **Tables NOT in `_undo_tracked_tables`**: `pool_segments`, `tr_candidates`, `audio_candidates`, `audio_clip_links`, `pool_segment_tags`, etc. — artifacts, references, or provenance data. Inserts into these don't fire any undo trigger.

By the convention, `audio_isolations` + `isolation_stems` belong in the second group — they record "a run happened, here are its stem pool_segment ids". They aren't user-placed edits, they're system-produced metadata.

### Current observable effect

Ctrl+Z on a completed `isolate_vocals` run today:

- Deletes the `audio_isolations` row (undone correctly by trigger)
- Deletes the `isolation_stems` junction rows (undone correctly by composite-PK trigger)
- Leaves the 2 stem WAV files on disk in `pool/segments/` (files aren't in undo scope)
- Leaves the 2 `pool_segments` rows in place (pool_segments isn't tracked)
- Result: **orphaned pool_segments rows + orphaned WAV files** with no audio_isolations linking them. The pool files are unreachable via the AudioIsolationsPanel and just take up disk.

### How this surfaced

During the design session for the future `stem_splitter` plugin, I initially proposed a `persistent_write` contextmanager to exempt stem_splitter's finalize writes from the undo log (so Ctrl+Z wouldn't orphan 11 stems + files). The user pointed out this framing was wrong — "conceptually there's nothing to undo. the generations are made, the files stay on disk, undo would simply orphan the disk content". That led to realizing the convention already handles this by **table choice**, not by bypass mechanism. Task-100b violated the convention; this task fixes it.

### What this task does NOT fix

- It does not migrate existing undo_log entries that reference the removed triggers. Those entries become no-ops (the referenced rows already moved through other paths) or hit missing-row conditions; the undo-execute layer tolerates that silently.
- It does not delete existing orphaned stem files that landed via the bug. That's a separate janitorial task if needed; scenecraft doesn't have a pool-GC pass yet.
- It does not change `isolate_vocals` plugin behavior. The plugin already calls `undo_begin` before its finalize writes; with the tracked-list change those writes simply won't enter the undo_log regardless of `undo_begin` having been called. (`undo_begin` still creates an empty undo_group, which is harmless but wasteful — a small cleanup opportunity listed in the verification.)

---

## Steps

### 1. Remove tables from `_undo_tracked_tables`

File: `src/scenecraft/db.py`

```python
# before
_undo_tracked_tables = ["keyframes", "transitions", "suppressions", "effects", "tracks",
                        "transition_effects", "markers", "audio_tracks", "audio_clips",
                        "audio_isolations"]

# after
_undo_tracked_tables = ["keyframes", "transitions", "suppressions", "effects", "tracks",
                        "transition_effects", "markers", "audio_tracks", "audio_clips"]
```

### 2. Drop the explicit `isolation_stems` composite-PK triggers

Same file, same `_ensure_schema`. The current block installs three triggers (`isolation_stems_insert_undo`, `isolation_stems_update_undo`, `isolation_stems_delete_undo`). Remove the entire block.

Keep the preceding `DROP TRIGGER IF EXISTS` statements for idempotency — the migration step below uses them to clean up existing project.dbs.

### 3. Add a migration step to drop stale triggers from existing project.dbs

In the migration section of `_ensure_schema` (near the other `ALTER TABLE` + `DROP TRIGGER` cleanup statements), unconditionally run:

```python
for t in ("audio_isolations", "isolation_stems"):
    for action in ("insert", "update", "delete"):
        conn.execute(f"DROP TRIGGER IF EXISTS {t}_{action}_undo")
```

This removes the triggers from any project.db that was bootstrapped under the buggy schema. Idempotent — no-op on a fresh DB.

### 4. Sanity-check `isolate_vocals` plugin behavior

File: `src/scenecraft/plugins/isolate_vocals/isolate_vocals.py`

The plugin currently calls `plugin_api.undo_begin(project_dir, f"Isolate vocals: ...")` before its finalize writes. After this task, that call still creates an empty undo_group (no inserts enter the log since the tables aren't tracked). **Leave the call for now** — it's harmless and removing it mixes unrelated concerns into this bug fix. If you want a cleanup pass, drop the `undo_begin` call in a separate commit and verify no undo-group side effects (e.g., clearing redo-log) were load-bearing for this plugin's UX.

### 5. Tests

Add to `tests/test_audio_isolations_schema.py`:

- **New test: `test_audio_isolations_insert_does_not_enter_undo_log`**
  - Fresh project.db
  - Call `add_audio_isolation(...)`; count `undo_log` entries — should be **0**
  - Call `add_isolation_stem(...)`; count `undo_log` entries — should still be **0**
  - `update_audio_isolation_status(...)` — **0**

- **Update existing undo-round-trip test** (currently expects rows to be reverted on undo). After the fix: an undo group that previously contained these rows no longer exists, so test-renames to something like `test_undo_skips_generation_metadata_tables` and asserts `undo_execute` on a session that ONLY inserted into these tables returns `None` (no undoable group) or reverts the most-recent actual editorial-state change.

- **Migration test: `test_migration_drops_stale_isolation_triggers`**
  - Construct a project.db with the old triggers installed (run the pre-fix schema SQL manually)
  - Run `_ensure_schema` on it
  - Assert all 6 triggers (`audio_isolations_{insert,update,delete}_undo`, `isolation_stems_{insert,update,delete}_undo`) are gone from `sqlite_master`

### 6. Stale undo_log entries

Optional hardening: if a project.db was created under the buggy schema and had runs undone, its `undo_log` may contain SQL_TEXT entries for rows that no longer exist. On `undo_execute`, these run against rows that are already gone (no-op) or against the `audio_isolations`/`isolation_stems` tables to insert rows that shouldn't come back.

For safety, add a one-shot cleanup in `_ensure_schema` that runs the first time the migration sees the old triggers missing:

```python
# Best-effort cleanup of stale undo_log entries referencing removed trigger tables.
# These would otherwise re-insert rows into audio_isolations/isolation_stems on undo.
conn.execute("DELETE FROM undo_log WHERE sql_text LIKE '%audio_isolations%' OR sql_text LIKE '%isolation_stems%'")
```

Document why, wrap in a try/except (undo_log might not exist yet on brand-new DBs), commit.

---

## Verification

- [ ] `_undo_tracked_tables` no longer contains `"audio_isolations"`
- [ ] `_ensure_schema` no longer installs the three `isolation_stems_*_undo` triggers
- [ ] Migration step drops all 6 stale triggers on existing project.dbs
- [ ] On a fresh project.db, inserting into `audio_isolations` produces no `undo_log` entry
- [ ] On a fresh project.db, inserting into `isolation_stems` produces no `undo_log` entry
- [ ] `update_audio_isolation_status` produces no `undo_log` entry
- [ ] New test `test_audio_isolations_insert_does_not_enter_undo_log` passes
- [ ] Migration test confirms triggers are dropped from legacy DBs
- [ ] Stale undo_log entries cleanup runs idempotently
- [ ] Existing M11 tests still pass (some may need renaming if they were asserting the previously-wrong undo behavior)
- [ ] `isolate_vocals` plugin tests still pass — plugin's `undo_begin` call is now a no-op but doesn't crash

---

## Key Design Decisions

### Convention alignment

| Decision | Choice | Rationale |
|---|---|---|
| Which tables participate in undo | Editorial-state only (the existing `_undo_tracked_tables` list) | Generation outputs are artifacts, not user actions; reverting them orphans disk content |
| Where generation-output tables live | NOT in `_undo_tracked_tables` | Scenecraft convention — matches `pool_segments`, `tr_candidates`, etc. |
| `isolate_vocals` plugin's `undo_begin` call | Leave in place for now | Removing it is separate scope; harmless with the trigger removal |
| Stale undo_log entries | One-shot cleanup in migration | Prevents re-inserting removed-schema rows on undo in legacy project.dbs |

---

## Related Artifacts

- **Origin**: M11 task-100b (`feat(db): add audio_isolations + isolation_stems schema + helpers`, commit `14700c6`)
- **Surfaced by**: `agent/design/local.stem-splitter-plugin.md` — the stem_splitter design originally proposed a `persistent_write` primitive to work around this; discussion with the user surfaced that the convention solves it via table choice.
- **Affects**: `isolate_vocals` plugin (behavior unchanged in practice, undo_log entries eliminated) and the future `stem_splitter` plugin (no longer needs a bypass primitive).
