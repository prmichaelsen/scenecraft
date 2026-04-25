# Task 153: REST Endpoints (Conventional REST)

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — R30, REST table under Interfaces, R29 (WS broadcasts)
**Design Reference**: [`local.light-show-scene-editor.md`](../../design/local.light-show-scene-editor.md) — Part 5
**Estimated Time**: 1 hour
**Dependencies**: task-151 (DB helpers), task-152 (catalog YAML)
**Status**: Not Started

---

## Objective

Implement conventional REST endpoints (resource-based paths, standard HTTP verbs, query-param filtering on lists) for scenes / placements / live override / primitives. NOT collapsed action endpoints. Wire WS broadcasts on each mutation with the new `kind` values.

---

## Steps

### 1. Add handlers to `scenecraft-engine/src/scenecraft/plugins/light_show/routes.py`

Per the spec REST table:

**Catalog (read-only)**:
- `GET /primitives` → `{primitives: [...]}` (parsed YAML catalog)

**Scenes**:
- `GET /scenes` → query params `type, label_query, ids[], limit, offset, order_by, order` → `{scenes, total, has_more}` (sparse params)
- `POST /scenes` → body `{label, type, params?}` (no id) → `201 {scene}`
- `GET /scenes/:id` → `{scene}` or `404`
- `PATCH /scenes/:id` → body `{label?, type?, params?}` (RFC 7396 merge-patch) → `{scene}` or `400` for null on top-level
- `DELETE /scenes/:id` → `{scene}` (deleted) or `409 {error, blocked?, blocked_by_live?}`

**Placements**:
- `GET /placements` → query params `scene_id, time_start, time_end, ids[], limit, offset, order_by, order` → `{placements, total, has_more}`
- `POST /placements` → `{placement}`
- `GET /placements/:id` → `{placement}` or `404`
- `PATCH /placements/:id` → `{placement}` or `400`
- `DELETE /placements/:id` → `{placement}` (deleted) or `404`

**Live override (singleton)**:
- `GET /live` → `{active: false}` or `{active: true, ...}`
- `PUT /live` → body `{scene_id? | scene?, fade_in_sec?, label?, save_as?}` → `{active: true, scene_id, ...}` (response includes `scene_id` — for `save_as`, the new uuid)
- `DELETE /live` → optional query `?fade_out_sec=N` → `{active: false}`

### 2. Query param parsing

- Repeated key syntax for arrays: `?ids=a&ids=b` (NOT comma-separated)
- `time_start` + `time_end` both required if either is present (overlap filter on `[time_start, time_end]`)
- `limit` clamped to per-resource max (500 for scenes per R5, 1000 for placements per R12)
- `order_by` and `order` validated against per-resource enums; invalid → 400

### 3. WS broadcasts

After each successful mutation (create / update / delete), call `plugin_api.broadcast_event(PLUGIN_ID, "changed", project_name=name, payload={"kind": "<scenes|placements|live>"})`. Existing `_broadcast_changed` helper in `routes.py` extends to the new kinds.

### 4. Register endpoints in `register(plugin_api, context)`

Use `plugin_api.register_rest_endpoint(pattern, handler, method, context=context)` — the existing pattern. Append after the screens endpoints.

### 5. Error envelope

4xx errors: `{error: "<message>"}` JSON body. 409 specifically for blocked DELETE on `/scenes/:id`. 400 for validation errors. 404 for missing resource. Backend handlers raise structured exceptions; route layer maps to status codes.

---

## Verification

- [ ] `GET /scenes?limit=10` returns `{scenes: [...up to 10], total, has_more}`
- [ ] `GET /scenes?label_query=slow` filters case-insensitively (ASCII per R5 limitation note)
- [ ] `POST /scenes` body `{label, type}` (no id, no params) creates a scene with empty `params: {}` and a fresh uuid
- [ ] `PATCH /scenes/:id` with `{params: {role: null}}` removes role from stored params
- [ ] `PATCH /scenes/:id` with `{label: null}` returns 400
- [ ] `DELETE /scenes/:id` for a scene held by the live override returns 409 with `blocked_by_live` field
- [ ] `DELETE /scenes/:id` for a scene with placements returns 409 with `blocked: [{scene_id, placement_ids}]`
- [ ] `GET /placements?time_start=5&time_end=15` returns only placements that overlap that window
- [ ] `PUT /live` with `{scene_id: <uuid>}` activates by reference; subsequent `GET /live` shows `active: true`
- [ ] `PUT /live` with `{scene: {type, params}, save_as: "Label"}` creates a new scene with that label, returns its uuid in `scene_id`
- [ ] `DELETE /live` with `?fade_out_sec=2` sets `deactivation_started_at`; `GET /live` still returns `active: true` until evaluator deletes the row (frontend concern in task-161)
- [ ] Each mutation emits a `light_show__changed` WS event with the correct `kind` (`scenes` / `placements` / `live`)

---

## Notes

- These endpoints are the EXTERNAL HTTP surface (browsers, external clients). MCP tools (tasks 154-156) call `plugin_api` / DB helpers directly — they don't go through REST. So bulk dispatch happens at the MCP layer in atomic transactions; REST stays per-resource and clean.
- Path prefix: `/api/projects/:name/plugins/light_show`.
