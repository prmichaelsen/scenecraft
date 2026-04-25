# Task 151: Schema + DB Helpers + plugin_api Re-Exports

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — R1, R2, R3, R28, R30
**Design Reference**: [`local.light-show-scene-editor.md`](../../design/local.light-show-scene-editor.md) — Part 1: Three-tier data model
**Estimated Time**: 1 hour
**Dependencies**: existing light_show plugin schema (fixtures/overrides/screens) for pattern
**Status**: Not Started

---

## Objective

Add the three new tables (`light_show__scenes`, `light_show__scene_placements`, `light_show__live_override`) to `_ensure_schema` in `db.py`, implement the 9 DB helpers (sparse params, partial-upsert with null-delete merge-patch, atomic batch rejection, FK + CHECK constraints), and re-export from `plugin_api.py`.

---

## Steps

### 1. `_ensure_schema` additions in `scenecraft-engine/src/scenecraft/db.py`

Place after the existing `light_show__screens` block. Schema per R1-R3:
- `light_show__scenes (id PK uuid, label NOT NULL, type NOT NULL, params_json NOT NULL [sparse], created_at, updated_at)`
- `light_show__scene_placements (id PK uuid, scene_id FK→scenes, start_time, end_time, display_order DEFAULT 0, fade_in_sec DEFAULT 0, fade_out_sec DEFAULT 0, created_at, updated_at)` + index on `(start_time, end_time)`
- `light_show__live_override (id TEXT PK CHECK = 'current', scene_id FK nullable, inline_type nullable, inline_params_json nullable, label NOT NULL, fade_in_sec, fade_out_sec, activated_at, deactivation_started_at nullable)` + CHECK enforcing `(scene_id NOT NULL XOR inline_*)`

### 2. DB helpers (in `db.py`)

- `list_light_show_scenes(project_dir, *, ids=None, type_filter=None, label_query=None, limit=50, offset=0, order_by='updated_at', order='desc')` → `(rows, total, has_more)` with sparse `params` deserialized from JSON
- `upsert_light_show_scenes(project_dir, scenes)` — id-presence dispatch (missing id → INSERT new uuid; present id → UPDATE merge-patch on params with null-delete); rejects null on top-level fields and on the params object; rejects unknown type; atomic transaction
- `remove_light_show_scenes(project_dir, ids)` — atomic; raises with structured info if any id is referenced by placements or held by live_override (caller surfaces as `{error, blocked, blocked_by_live?}`)
- `list_light_show_placements(project_dir, *, ids=None, scene_id=None, time_start=None, time_end=None, limit=100, offset=0, order_by='start_time', order='asc')` → `(rows, total, has_more)`
- `upsert_light_show_placements(project_dir, placements)` — id-presence dispatch; rejects `end_time <= start_time`; rejects unknown scene_id; atomic
- `remove_light_show_placements(project_dir, ids)` — silently skips missing; returns deleted rows only
- `get_light_show_live_override(project_dir)` → row or None
- `activate_light_show_live_override(project_dir, payload)` — replaces existing silently; rejects when both `scene_id` AND inline fields are present, neither, unknown scene_id, unknown primitive type; for `save_as` with inline scene, persists a new scene row first, then references it
- `deactivate_light_show_live_override(project_dir, fade_out_sec=0)` — sets `deactivation_started_at = now`, updates `fade_out_sec`; physical deletion happens later (frontend evaluator triggers when fade completes — see task-161)

### 3. UUID generation

Use `uuid.uuid4().hex` (32-char no-dash) consistently across all three tables for server-assigned ids.

### 4. plugin_api.py re-exports

Add the 9 new helpers to the import block + `__all__` list in `scenecraft-engine/src/scenecraft/plugin_api.py`.

---

## Verification

- [ ] Fresh project DB on first open creates all three tables + the placements `(start_time, end_time)` index
- [ ] CHECK constraint on `light_show__live_override.id = 'current'` rejects any other id
- [ ] CHECK constraint on inline-vs-scene_id mutual exclusion rejects rows where neither or both are set
- [ ] `upsert_light_show_scenes` with `{params: {role: null}}` removes the `role` key from `params_json`
- [ ] `upsert_light_show_scenes` with `params: null` is rejected with the spec'd error message
- [ ] `upsert_light_show_scenes` with `label: null` is rejected (NOT NULL column)
- [ ] `remove_light_show_scenes` blocked by placements returns the `blocked` array structure per R9
- [ ] `remove_light_show_scenes` blocked by live override returns `blocked_by_live` per R10
- [ ] `upsert_light_show_placements` with `end_time < start_time` rejects atomically (no rows mutated)
- [ ] `upsert_light_show_placements` with unknown `scene_id` rejects atomically
- [ ] All 9 helpers importable from `scenecraft.plugin_api`
- [ ] `list_*` returns `(rows, total, has_more)` shape with sparse params on scenes

---

## Notes

- Tables go in **per-project `project.db`** (matches existing fixtures/overrides/screens convention).
- Sparse params = no merge with catalog defaults at insert/update; only explicit overrides stored. Catalog merge happens at evaluator time (task-161).
- `params_json` is `'{}'` for scenes created with no explicit param overrides.
