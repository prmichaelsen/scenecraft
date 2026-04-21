# Task 69: Rip Slot Concept + Drop `selected_*/` Directories

**Milestone**: [M7 — Clip Trim and Snap](../../milestones/milestone-7-clip-trim-and-snap.md)
**Design Reference**: None (rationale in Key Design Decisions below)
**Estimated Time**: 16-24 hours
**Dependencies**: Task 44 (schema already mutated); blocks Tasks 45–51 (their path math must use the new model)
**Status**: Not Started

---

## Objective

Remove the abandoned "slot" concept from the entire codebase AND stop writing/reading `selected_keyframes/<id>.png` and `selected_transitions/<id>_slot_0.mp4` copies. Render and UI code must read selected media directly from candidate paths resolved through SQL (`keyframes.selected`, `transitions.selected`, `tr_candidates`).

---

## Context

Originally each transition could have multiple "slots" — intermediate keyframe candidates between from/to kfs — and selection was tracked as a JSON array keyed by slot index. That feature was abandoned; every active transition uses exactly one slot (slot 0) and nothing in the product exposes multi-slot UI anymore. Every `_slot_0` in the codebase is dead metadata that complicates every downstream consumer.

Separately, selected media was historically duplicated on disk (a copy of the chosen candidate into `selected_keyframes/<id>.png` and `selected_transitions/<id>_slot_0.mp4`) so render code could resolve a selection without joining SQL. Now that `keyframes.selected` (integer index into `candidates` JSON array) and `transitions.selected` uniquely identify the chosen candidate, the duplicated copies are dead weight — they bloat the project dir, drift from SQL truth, and force `_slot_0` naming on every produced artifact.

This task consolidates both cleanups because they touch the same handlers, path helpers, and render-pipeline code paths — splitting them would force re-touching the same functions twice.

---

## Scope Boundaries

**In scope**:
- Schema changes to `transitions`, `tr_candidates`
- Backend handler removal + rewrite
- Render pipeline switchover (read selected candidate from SQL, not from `selected_*/`)
- Frontend removal of slot concept
- Migration that flattens existing data and deletes orphaned dirs
- Patch to Task 44's `backfill_transition_trim` (since it currently reads `selected_transitions/<id>_slot_0.mp4`)

**Out of scope** (leave alone):
- `pool_segments.kind` values (`imported`, `generated`) — unrelated
- `audio_clips` / `tracks` — no slot concept there
- `opacity_keyframes` — unrelated
- Any `keyframe_candidates/candidates/section_<kf_id>/` layout — this stays; only `slot_keyframe_candidates/` goes

---

## Steps

### 1. Schema migration (`scenecraft-engine/src/scenecraft/db.py`)

Add idempotent migrations inside `_ensure_schema()`, immediately after the M7 trim columns:

1. **`transitions.selected` flattening**
   - Read every row; parse `selected` JSON
   - If `selected` is `[N]` (one-element array with int): rewrite as `N` (integer stored as TEXT for schema compat, or add a new `selected_index INTEGER` column and keep `selected` for back-compat until Task 69 lands).
   - If `selected` is `[null]` or `[]`: rewrite as `null`
   - If `selected` already scalar: skip
   - Pick one of:
     - **Option A (preferred)**: rewrite `selected` column semantics — still `TEXT`, but now holds scalar JSON (`0`, `null`, or JSON integer). `_row_to_transition` already flattens `[N]` → `N`; just ensure writes use scalar JSON. One migration pass rewrites all existing rows.
     - **Option B**: add `selected_index INTEGER` column, backfill from `selected`, keep `selected` for rollback. More disruptive downstream.
   - Recommend **Option A**.

2. **`transitions.slots`**
   - SQLite ≥ 3.35 supports `ALTER TABLE transitions DROP COLUMN slots`. Verify project requires 3.35+ (check `pyproject.toml` / `sqlite3.sqlite_version`).
   - If supported: drop the column.
   - If not: leave column in place, mark deprecated in schema comment, stop reading/writing it.

3. **`tr_candidates.slot`**
   - If SQLite ≥ 3.35: `ALTER TABLE tr_candidates DROP COLUMN slot`.
   - Rebuild index: `DROP INDEX IF EXISTS idx_tr_candidates_order; CREATE INDEX idx_tr_candidates_order ON tr_candidates(transition_id, added_at);`

4. **Undo triggers**: the dynamic `PRAGMA table_info` enumeration already handles column drops — no manual trigger updates needed.

5. **Tests** (`scenecraft-engine/tests/test_migrations.py`): add `TestSlotRipout` class
   - Fresh DB has no `slots` / `tr_candidates.slot` columns (or both NULL if DROP COLUMN unsupported)
   - Existing DB with `selected='[2]'` gets rewritten to `selected='2'`
   - `selected='[null]'` → `null`
   - Idempotency: re-run migration is no-op

### 2. Update Task 44 backfill (`scenecraft-engine/src/scenecraft/db.py`)

`backfill_transition_trim()` currently reads `project_dir / "selected_transitions" / f"{tr_id}_slot_0.mp4"`. Rewrite to resolve the selected candidate through `tr_candidates`:

```python
row = conn.execute(
    "SELECT pool_segment_id FROM tr_candidates WHERE transition_id = ? ORDER BY added_at LIMIT 1 OFFSET ?",
    (tr_id, selected_idx),
).fetchone()
if row:
    seg = conn.execute("SELECT pool_path FROM pool_segments WHERE id = ?", (row["pool_segment_id"],)).fetchone()
    video_path = project_dir / seg["pool_path"]
```

(Exact lookup depends on `pool_segments` schema — verify in `db.py` and `_handle_generate_transition_candidates` in api_server.py.)

Update `tests/test_migrations.py::TestBackfill` fixtures to create a `pool_segments` row + `tr_candidates` row instead of placing a file at the legacy path.

### 3. Backend endpoint + handler removal (`scenecraft-engine/src/scenecraft/api_server.py`)

1. **Delete endpoint routes**:
   - `POST /api/projects/:name/select-slot-keyframes` (line ~1600)
   - `POST /api/projects/:name/generate-slot-keyframe-candidates` (line ~2000)

2. **Delete handler functions**:
   - `_handle_select_slot_keyframes`
   - `_handle_generate_slot_keyframe_candidates`

3. **Rewrite handlers that iterate over slots**:
   - `_handle_get_transition_details` — drop `slot_candidates`, `slot_candidate_details`, `slotKeyframeCandidates`, `selectedSlotKeyframes`, `slotActions` from the response payload. Return the single selected candidate inline.
   - `_handle_generate_transition_action` — replace per-slot action array with a single `action` string.
   - `_handle_select_transitions` — accept `{transition_id, selected: int | null}`, not a slot-indexed array.
   - `_handle_generate_transition_candidates` — drop `slot_index` parameter; always generate into the transition's single candidate pool.

4. **Drop `tr["slots"]` / `tr["slot_actions"]` reads/writes** everywhere (grep for `slots`, `slot_actions`, `slot_index`, `_slot_`). Use a targeted grep pass after the handler edits to catch stragglers.

5. **Update `_row_to_transition` (`db.py`)**: drop `slots` key from the returned dict; ensure `selected` is already flattened (existing code at line 555 flattens `[N]` → `N`).

### 4. Render pipeline — stop reading from `selected_*/`

1. **Locate every read of `selected_keyframes/` and `selected_transitions/`** in `scenecraft-engine/src/scenecraft/`:
   ```
   grep -rn "selected_keyframes\|selected_transitions" scenecraft-engine/src/scenecraft
   ```
2. **Replace with SQL-resolved candidate paths**:
   - Keyframe resolution: `selected_idx = kf["selected"]`; `candidate_path = project_dir / kf["candidates"][selected_idx]`
   - Transition resolution: query `tr_candidates` joined with `pool_segments` for the selected index; use `pool_segments.pool_path`
3. **Add a helper in `db.py`** to centralize this:
   ```python
   def get_selected_keyframe_path(project_dir: Path, kf: dict) -> Path | None: ...
   def get_selected_transition_path(project_dir: Path, tr: dict) -> Path | None: ...
   ```
   Then rewrite callsites to use the helpers (render code, `backfill_transition_trim`, any preview-serving endpoint).

4. **Stop writing to `selected_*/`**: trace every `shutil.copy2(...selected_keyframes/...)` and `shutil.copy2(...selected_transitions/...)` call. Delete those copy operations; the SQL selection is the source of truth.

5. **Split-keyframe flow** (api_server.py:3831): currently `sel_video = project_dir / "selected_transitions" / f"{tr_id}_slot_0.mp4"`. Rewrite to use the new helper; drop the `_slot_split` background task that rewrites slot-based selections.

### 5. Filesystem GC on project open

Add a one-time sweep when a project opens (detect via a `meta` key `slot_gc_done = 1`):

1. If `selected_keyframes/` exists: log count of files, delete the directory.
2. If `selected_transitions/` exists: log count, delete.
3. If `slot_keyframe_candidates/` exists: log count, delete.
4. If `selected_slot_keyframes/` exists: log count, delete.
5. Set `meta.slot_gc_done = 1`.

Gate with env var `SCENECRAFT_SLOT_GC=0` to opt-out (for users who want to inspect the old dirs first).

### 6. Frontend cleanup (`scenecraft` TS repo)

1. **`src/lib/scenecraft-client.ts`**:
   - Drop `VideoCandidate.slot` field (line 403).
   - Drop `slotIndex?: number` from `postGenerateTransitionCandidates` (line 724).
   - Drop `slotActions?: string[]` from `postUpdateTransitionAction` (line 699); replace with scalar `action: string`.
   - Drop slot key semantics from `postSelectTransitions` (line 888); accept `{transitionId, selectedIndex: number | null}`.

2. **`src/components/editor/TransitionPanel.tsx`** (line 1023): replace `selectionKey = \`${transition.id}_slot_0\`` with `selectionKey = transition.id`.

3. **`src/components/editor/BinPanel.tsx`** (lines 35, 474, 534): remove `_slot_0` hardcoded suffixes; rebuild URLs from `pool_segments.pool_path`.

4. **`src/components/editor/StatusBar.tsx`** (lines 22–26): drop `parsePreloadKey` regex handling for `slot_N`; simplify to `{transitionId, variantIndex}`.

5. **Search TS for any `slot`/`_slot_` reference** and remove:
   ```
   grep -rn "slot" src/ --include="*.ts" --include="*.tsx"
   ```

6. **Update `TransitionPanel` selection UI**: wherever the UI showed per-slot candidate pickers, collapse to a single candidate picker (if not already single-slot visually).

### 7. Types + validation

1. **TS types**: ensure `Transition.selected` is `number | null` (not `number[]`). Update `EditorData` and any zod schema.
2. **Python types**: ensure response payloads for transitions use scalar `selected`.
3. **Frontend adapter**: if any callsite was already treating the `[N]` array form, confirm it now reads the scalar.

### 8. Tests

1. `tests/test_migrations.py` — TestSlotRipout (see Step 1).
2. `tests/test_api.py` — verify deleted endpoints return 404; verify `get_transition_details` response no longer includes slot fields.
3. `tests/test_render.py` (if exists) or `tests/test_narrative.py` — render pipeline uses the new helper; add a unit test that a keyframe with `selected=1` resolves to `candidates[1]` rather than `selected_keyframes/<id>.png`.
4. Manual QA: open an existing project with legacy `selected_*/` dirs; verify GC fires, renders still work, transitions still preview correctly.

### 9. Documentation

1. Update any `agent/design/*.md` that references slots or selected-media paths.
2. Note in `agent/design/local.clip-trim-and-snap.md` that post-Task-69 the path for selected transition video is resolved via `tr_candidates`, not `selected_transitions/<id>_slot_0.mp4`.
3. Add a `CHANGELOG.md` entry summarizing the breaking schema/path changes.

---

## Verification

- [ ] No match for `_slot_\d+` in `scenecraft/` Python sources (except migration backfill logic)
- [ ] No match for `slots INTEGER`, `slot INTEGER` in any `CREATE TABLE` statement
- [ ] No match for `slotIndex|slotActions|slot_keyframe_candidates|selected_slot_keyframes|\.slot\b` in `src/` TS sources
- [ ] `selected_keyframes/` and `selected_transitions/` dirs are never written by any code path
- [ ] `GET /api/projects/:name/transitions/:id` response contains no `slot_candidates`, `slotKeyframeCandidates`, `slotActions`
- [ ] `POST /api/projects/:name/select-slot-keyframes` returns 404
- [ ] `POST /api/projects/:name/generate-slot-keyframe-candidates` returns 404
- [ ] `transitions.selected` in DB is scalar JSON (`0`, `1`, `null`), never `[N]`
- [ ] `backfill_transition_trim` reads candidate path through SQL, passes all existing tests in `test_migrations.py`
- [ ] Schema migration is idempotent (run twice is no-op)
- [ ] Opening an existing project with legacy `selected_*/` dirs: GC fires once, dirs are removed, `meta.slot_gc_done = 1`
- [ ] Render a project end-to-end (via existing `test_render.py` or manual): all media correctly resolved from candidate paths
- [ ] Preview panel displays selected keyframe and transition correctly
- [ ] Transition candidate generation + selection flow works end-to-end

---

## Expected Output

**Files modified**:
- `scenecraft-engine/src/scenecraft/db.py` — migrations, helpers, `_row_to_transition`
- `scenecraft-engine/src/scenecraft/api_server.py` — handler deletions, handler rewrites, GC sweep
- `scenecraft-engine/src/scenecraft/render/narrative.py` — drop slot generation, use helpers
- `scenecraft-engine/src/scenecraft/render/*.py` — replace `selected_*/` reads
- `scenecraft-engine/tests/test_migrations.py` — `TestSlotRipout` + updated backfill fixtures
- `scenecraft-engine/tests/test_api.py` — 404 assertions for deleted endpoints
- `scenecraft/src/lib/scenecraft-client.ts` — type + signature cleanup
- `scenecraft/src/components/editor/TransitionPanel.tsx`
- `scenecraft/src/components/editor/BinPanel.tsx`
- `scenecraft/src/components/editor/StatusBar.tsx`
- `scenecraft/src/components/editor/EditorDataContext.tsx` (if type shape changes)
- `scenecraft/agent/design/local.clip-trim-and-snap.md`
- `scenecraft/CHANGELOG.md` (if present)
- `scenecraft-engine/CHANGELOG.md` (if present)

**Files NOT created** (cleanup only; no new files except possibly a helper module if `db.py` becomes too crowded).

---

## Key Design Decisions

### Why one task, not a milestone

| Decision | Choice | Rationale |
|---|---|---|
| Task granularity | Single task | User preference (2026-04-21): "I want one task for both of rip slot and drop selected" — both concerns touch the same handlers/helpers; splitting forces repeated rewrites of the same functions. Accept the larger commit for a cleaner refactor arc. |

### Why consolidate slot removal and selected-dir removal

| Decision | Choice | Rationale |
|---|---|---|
| Cleanup coupling | Combined in one task | Both concerns intersect at the same code paths: `_handle_select_transitions`, render resolution of selected media, file naming conventions (`_slot_0.mp4`), and Task 44's backfill. Combining saves one full rewrite pass of those paths. |

### Schema migration strategy

| Decision | Choice | Rationale |
|---|---|---|
| `selected` column | Flatten in place (Option A) | Avoids a new `selected_index` column that duplicates semantics. `_row_to_transition` already flattens `[N]` → `N` at read time — migration makes the on-disk form match. |
| Column drops | Use `ALTER TABLE DROP COLUMN` if SQLite ≥ 3.35 | Keeps schema clean. Fallback: leave columns with NULLs. |

### Selection-to-path resolution

| Decision | Choice | Rationale |
|---|---|---|
| Source of truth | `keyframes.selected` + `keyframes.candidates` for kfs; `transitions.selected` + `tr_candidates` + `pool_segments` for trs | SQL already holds the selection; `selected_*/` dirs were a pre-SQL workaround. Centralize resolution in `get_selected_*_path()` helpers. |
| Cutover safety | One-time GC on project open, gated by `meta.slot_gc_done` | Users can inspect legacy dirs before GC via `SCENECRAFT_SLOT_GC=0`. |

---

## Common Issues and Solutions

### Issue 1: SQLite version too old for `DROP COLUMN`
**Symptom**: `ALTER TABLE ... DROP COLUMN` raises `no such command`.
**Solution**: Check `sqlite3.sqlite_version`; if < 3.35, skip the drop and leave the column NULL. Add a schema-comment note; column is deprecated but harmless.

### Issue 2: Render code reads a keyframe where `selected IS NULL`
**Symptom**: `get_selected_keyframe_path` returns `None`; renderer falls back to... what?
**Solution**: That keyframe is "empty" (no selected candidate). Renderer must treat it as an empty keyframe — no image to resolve. Confirm with existing empty-kf handling (see M7 design doc).

### Issue 3: Legacy project with on-disk `_slot_0` paths referenced from some test fixture
**Symptom**: Test fails because it expected the file in `selected_transitions/`.
**Solution**: Update fixture to seed `tr_candidates` + `pool_segments` instead of dropping a file in the legacy path. This happens at least once in `test_migrations.py::TestBackfill`.

### Issue 4: Frontend still shows slot tab UI
**Symptom**: Transition panel shows multiple slot pickers even though selection is single.
**Solution**: Grep TransitionPanel for any `.map(slot => ...)` render. Collapse to a single candidate row.

---

## Notes

- **Breaking change**: this task changes on-wire shape of `GET /api/projects/:name/transitions/:id`. Bump backend minor version. Frontend must ship together (coordinated release).
- **Roll-forward only**: there is no clean rollback once `transitions.selected` is flattened and `selected_*/` dirs are deleted. Commit on a feature branch; verify render still works end-to-end before merging.
- **Keep `pool_segments` intact**: this task does NOT touch pool-level storage; only cleans up the layer above it.

---

**Next Task**: [Task 45: Backend trim support](task-45-backend-trim-support.md) (now unblocked to use the new selection-resolution helpers)
**Related Design Docs**: `agent/design/local.clip-trim-and-snap.md` (needs an update note after this task lands)
**Estimated Completion Date**: TBD
