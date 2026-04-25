# Spec: Light Show Scene Editor

> **🤖 Agent Directive**: This is an implementation-ready specification. The Tests section is the executable contract — implementations translate each `#### Test:` into a test function in the target framework (pytest for backend, vitest for frontend). Every assertion is observable and language-agnostic.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-24
**Last Updated**: 2026-04-24
**Status**: Ready for Implementation

---

## Purpose

Specify the exact observable behavior of the `light_show` scene editor MVP — a three-tier data model (scenes, placements, live override), a primitive catalog (`rotating_head` + `static_color`), a layered precedence evaluator, and three action-dispatched MCP tools (`scenes`, `scene_timeline`, `scene_live`). The system lets chat pre-program scenes, composite them onto the main scenecraft timeline, and trigger them live as cues or manual directives.

---

## Source

`--from-design agent/design/local.light-show-scene-editor.md`
Underlying decisions: [clarification-14-light-show-scene-editor-mvp.md](../clarifications/clarification-14-light-show-scene-editor-mvp.md)

---

## Scope

### In Scope

- Three new SQLite tables in per-project `project.db`: `light_show__scenes`, `light_show__scene_placements`, `light_show__live_override`
- Nine DB helper functions re-exported from `plugin_api.py`
- One shared catalog file: `scenecraft-engine/src/scenecraft/plugins/light_show/primitives_catalog.yaml` (YAML; static config that ships with the plugin)
- Conventional REST resource endpoints under `/api/projects/:name/plugins/light_show/`: `/scenes` and `/placements` collections (GET list / POST create / GET-PATCH-DELETE per id), `/live` singleton (GET/PUT/DELETE), `/primitives` (GET catalog)
- Three new MCP tools declared in `plugin.yaml`: `scenes`, `scene_timeline`, `scene_live` — each action-dispatched
- Two primitive apply functions in frontend `primitives.ts`: `applyRotatingHead`, `applyStaticColor`
- Layered scene evaluator in frontend `scene-evaluator.ts` with live > placement > fallback precedence
- Integration into `LightShow3DPanel.tsx`: fetch / poll / WS subscription for the three new entities; diagnostic bar shows active layer label
- WS broadcast expansion: `light_show__changed` event's `kind` field gains `"scenes" | "placements" | "live"` values

### Out of Scope

- Compositions / sequences (multi-primitive bundles)
- Modulation matrix / effect curves on params (`{source, mapper}`)
- Crossfade between placements (standard fades only)
- Multi-layer merge modes (HTP, additive, multiply, min) beyond the single-winner `display_order` rule
- Waveform `shape` param on `rotating_head` (pure sine at MVP)
- Additional primitives beyond `rotating_head` + `static_color`
- Scene library export / import
- Global / cross-project scene library
- Real DMX output bridge
- Priority stack for live overrides

---

## Requirements

### Schema

- **R1.** `light_show__scenes` table MUST exist after schema migration with columns: `id TEXT PRIMARY KEY` (server-generated UUID; chat cannot supply on create), `label TEXT NOT NULL` (human-readable, free-form, no uniqueness constraint), `type TEXT NOT NULL`, `params_json TEXT NOT NULL`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`.
- **R2.** `light_show__scene_placements` table MUST exist with columns: `id TEXT PRIMARY KEY`, `scene_id TEXT NOT NULL REFERENCES light_show__scenes(id)`, `start_time REAL NOT NULL`, `end_time REAL NOT NULL`, `display_order INTEGER NOT NULL DEFAULT 0`, `fade_in_sec REAL NOT NULL DEFAULT 0`, `fade_out_sec REAL NOT NULL DEFAULT 0`, `created_at`, `updated_at`. An index on `(start_time, end_time)` MUST exist.
- **R3.** `light_show__live_override` table MUST exist with columns: `id TEXT PRIMARY KEY CHECK (id = 'current')`, `scene_id TEXT REFERENCES light_show__scenes(id)`, `inline_type TEXT`, `inline_params_json TEXT`, `label TEXT NOT NULL`, `fade_in_sec REAL NOT NULL DEFAULT 0`, `fade_out_sec REAL NOT NULL DEFAULT 0`, `activated_at TEXT NOT NULL`, `deactivation_started_at TEXT`. A CHECK constraint MUST enforce exactly one of (`scene_id` set) OR (`inline_type` AND `inline_params_json` both set).

### `scenes` MCP tool

- **R4.** `scenes.list_primitives` MUST return the parsed contents of `primitives_catalog.yaml` (YAML → JSON via `yaml.safe_load`) wrapped as `{primitives: [...]}` over the wire. The structural content of the response MUST be byte-for-byte equivalent to the parsed YAML — no field reordering, omission, or transformation.
- **R5.** `scenes.list` MUST return scenes as `{scenes: [...], total: number, has_more: boolean}` where `scenes[]` rows have shape `{id, label, type, params, created_at, updated_at}`. The `params` field MUST be the **sparse stored value** (only keys explicitly overridden by the user) — NOT merged with catalog defaults. Catalog defaults are resolved at evaluator time, not at list time, so list → set round-trips do not promote defaults to explicit overrides. It MUST accept optional args:
  - `filter.ids: [string]` — exact id lookup; missing ids are silently absent from results
  - `filter.type: string` — exact primitive type match (e.g. `"rotating_head"`)
  - `filter.label_query: string` — case-insensitive substring on label (`LOWER(label) LIKE '%' || LOWER(query) || '%'` semantics)
  - `limit: number` — default 50, maximum 500 (values > 500 clamped to 500)
  - `offset: number` — default 0
  - `order_by: string` — one of `"created_at" | "updated_at" | "label"`; default `"updated_at"`
  - `order: string` — one of `"asc" | "desc"`; default `"desc"`
  Filter conditions combine with AND. `total` is the count after filtering, before pagination. `has_more` is `offset + scenes.length < total`.
- **R6.** `scenes.set` MUST accept `{scenes: [...]}` and dispatch by id-presence:
  - **No `id` on entry** → CREATE with a server-generated UUID. `label` and `type` MUST be present (these columns are NOT NULL); otherwise reject with `{error: "label and type required to create scene"}`. `params` is optional (defaults to `{}` — sparse empty).
  - **`id` present on entry** → UPDATE existing row, partial-merge per RFC 7396 JSON Merge Patch:
    - **Top-level fields** (`label`, `type`):
      - omitted → preserve existing value
      - `<value>` → set to value
      - `null` → reject with `{error: "cannot null required column: <field>"}`
    - **`params` object** (per-key partial update):
      - omitted → preserve all stored params as-is
      - `null` → reject with `{error: "params object cannot be null; use {} to preserve or {key: null} to delete a key"}`
      - `{key: <value>}` → set that key in stored params
      - `{key: null}` → DELETE that key from stored params (revert to whatever the catalog default supplies at evaluator time)
      - `{key: undefined}` (key absent from object) → preserve existing value for that key
  - **Storage is sparse.** params_json contains ONLY explicitly-set keys; catalog defaults are merged at evaluator time, not at insert/update. New scene with `params: {period_sec: 6}` stores exactly `{"period_sec": 6}` — no other keys.
  - Returns `{scenes: [...]}` containing **only the upserted rows** (each with the server-assigned `id` for fresh creates, sparse params), NOT the full library. Order matches the input array — caller can correlate auto-uuids by position.
- **R7.** `scenes.set` MUST reject UPDATE entries (those with `id` present) where the id does not exist in `light_show__scenes`, returning `{error: "unknown scene id: <id>"}` and performing NO writes (atomic all-or-nothing across the batch).
- **R8.** `scenes.set` MUST reject entries with unknown `type` values (not present in the catalog), returning `{error: "unknown primitive type: <type>"}` (applies on both create and update paths).
- **R9.** `scenes.remove` MUST accept `{ids: [...]}` and reject deletion of any scene currently referenced by one or more placements, returning `{error: "scene(s) still referenced", blocked: [{scene_id, placement_ids}, ...]}` and performing NO deletions when any are blocked (atomic all-or-nothing). On success returns `{scenes: [...]}` containing only the **deleted** rows (pre-deletion state); silently skips missing ids without error.
- **R10.** `scenes.remove` MUST reject deletion of a scene currently held by the live override, returning `{error: "scene held by live override; deactivate first", blocked_by_live: scene_id}` and performing NO deletions when blocked.
- **R11.** `scenes` MUST reject unknown actions with `{error: "unknown action <action>; expected one of list/list_primitives/set/remove"}`.

### `scene_timeline` MCP tool

- **R12.** `scene_timeline.list` MUST return placements as `{placements: [...], total: number, has_more: boolean}` where rows have shape `{id, scene_id, start_time, end_time, display_order, fade_in_sec, fade_out_sec, created_at, updated_at}`. It MUST accept optional args:
  - `filter.ids: [string]` — exact id lookup
  - `filter.scene_id: string` — placements of a specific scene
  - `filter.time_range: {start: number, end: number}` — placements that **overlap** the window (i.e., `placement.start_time <= range.end AND placement.end_time >= range.start`)
  - `limit: number` — default 100, maximum 1000
  - `offset: number` — default 0
  - `order_by: string` — one of `"start_time" | "created_at"`; default `"start_time"`
  - `order: string` — one of `"asc" | "desc"`; default `"asc"` (chronological)
  Filter conditions combine with AND. `total` and `has_more` follow same semantics as R5.
- **R13.** `scene_timeline.set` MUST accept `{placements: [...]}` and bulk upsert. Entries without `id` MUST be inserted with an auto-generated UUID (backend-assigned). Entries with an existing `id` MUST merge the provided fields. Returns `{placements: [...]}` containing **only the upserted rows** (post-merge state), NOT all placements. Order matches the input array; auto-generated ids appear on the corresponding output entries.
- **R14.** `scene_timeline.set` MUST reject entries where `end_time <= start_time`, returning `{error: "placement end_time must be greater than start_time"}` and performing NO writes when any entry is invalid (atomic all-or-nothing).
- **R15.** `scene_timeline.set` MUST reject entries with `scene_id` not present in `light_show__scenes`, returning `{error: "unknown scene_id: <id>"}` and performing NO writes (atomic).
- **R16.** `scene_timeline.remove` MUST accept `{ids: [...]}`, delete matching placements, and silently ignore missing ids. Returns `{placements: [...]}` containing only the **deleted** rows (with their pre-deletion state) — NOT the full remaining list.
- **R17.** `scene_timeline` MUST reject unknown actions with `{error: "unknown action <action>; expected one of list/set/remove"}`.

### `scene_live` MCP tool

- **R18.** `scene_live.activate` MUST accept EITHER `scene_id: string` (library scene reference) OR `scene: {type, params}` (inline), never both; rejecting calls that specify both with `{error: "provide scene_id OR scene, not both"}`.
- **R19.** `scene_live.activate` with `scene_id` MUST reject if the scene_id does not exist, with `{error: "unknown scene_id: <id>"}`.
- **R20.** `scene_live.activate` with inline `scene` MUST reject if `scene.type` is not in the primitive catalog, with `{error: "unknown primitive type: <type>"}`.
- **R21.** `scene_live.activate` MUST replace any existing live override silently (no error when one is already active). The previous override row is overwritten.
- **R22.** `scene_live.activate` MUST accept optional `fade_in_sec` (default 0), `label` (default: scene's label or `"directive"` for inline), and `save_as: string` (inline only — when present, persists the inline scene into `light_show__scenes` with `label = save_as` and a server-generated UUID `id`; the override then references the new scene by `scene_id`). The `activate` response MUST include the resulting `scene_id` (uuid) in the override status — chat needs this for any subsequent `scenes.set`/`remove`/`scene_timeline.set` referencing the saved scene.
- **R23.** `scene_live.activate` with `save_as` but no inline `scene` (i.e., `scene_id` + `save_as`) MUST reject with `{error: "save_as requires inline scene"}`.
- **R24.** `scene_live.deactivate` MUST accept optional `fade_out_sec` (default 0). Sets `deactivation_started_at = now` and updates `fade_out_sec` on the override row. The row is physically deleted by the evaluator when fade-out completes.
- **R25.** `scene_live.deactivate` when no override is active MUST be a no-op (returns `{active: false}`).
- **R26.** `scene_live.status` MUST return `{active: bool, scene_id?, label?, activated_at?, fade_in_sec?, fade_out_sec?, deactivation_started_at?}`. When `active: false`, only the `active` field is present.
- **R27.** `scene_live` MUST reject unknown actions with `{error: "unknown action <action>; expected one of activate/deactivate/status"}`.

### Persistence

- **R28.** All three new tables' rows MUST persist across engine restart. Specifically, after a backend restart, the active `light_show__live_override` row (if present) MUST be readable and the scene MUST render on next frame.

### WS broadcasts

- **R29.** On any mutation to `light_show__scenes`, `light_show__scene_placements`, or `light_show__live_override`, the backend MUST broadcast an event with type `light_show__changed` and payload `{kind: "scenes" | "placements" | "live"}` respectively, via `plugin_api.broadcast_event`.

### REST endpoints

- **R30.** REST endpoints MUST follow conventional REST design (resource-based paths, standard HTTP verbs, query-param filtering on list endpoints) — NOT collapsed action endpoints. The MCP tools (action-dispatched) call plugin_api / DB helpers directly, not REST; REST is the external HTTP surface for browsers / external clients. See Interfaces section for the resource map.

### Frontend primitive catalog

- **R31.** The frontend `PRIMITIVE_REGISTRY` MUST contain an entry for each primitive in `primitives_catalog.yaml`. Frontend build-time or runtime validation that catalog keys match registry keys MUST be present (e.g., assert in module top-level).

### `applyRotatingHead`

- **R32.** At `sceneTime = 0`, `applyRotatingHead` with defaults MUST set `state.pan = 0`, `state.tilt = tilt_center_rad`, `state.intensity = 1`, `state.color = [1, 1, 1]` for every fixture matching `role`.
- **R33.** At `sceneTime = period_sec / 4`, `state.pan` MUST equal `pan_amplitude_rad` (sin(π/2) = 1 × amplitude).
- **R34.** At `sceneTime = period_sec / 2`, `state.pan` MUST equal `0` (sin(π) = 0).
- **R35.** At `sceneTime = 3 * period_sec / 4`, `state.pan` MUST equal `-pan_amplitude_rad` (sin(3π/2) = -1 × amplitude).
- **R36.** Fixtures whose `role` does not match the primitive's `role` param MUST be untouched (state passed through unchanged).
- **R37.** When `role` param is undefined, ALL fixtures MUST have their intensity and color set; pan/tilt writes MUST still occur but are harmless on par fixtures (no rotation channels in the DMX patch).

### `applyStaticColor`

- **R38.** `applyStaticColor` MUST set `state.intensity` and `state.color` for every fixture matching `role` (or all fixtures if `role` undefined) at every `sceneTime`. It MUST NOT modify `state.pan` or `state.tilt`.

### Layered evaluator (`evaluateLayeredScene`)

- **R39.** When `liveOverride` is set, the evaluator MUST resolve the scene (from `scene_id` lookup or inline fields), merge the sparse stored params with the primitive's catalog defaults (stored values win per-key), compute `sceneTime = (wallClock_ms - activated_at_ms) / 1000`, call the corresponding `PRIMITIVE_REGISTRY[type](sceneTime, states, mergedParams, context)`, apply fade envelopes, and return `{activeLayer: 'live', label}`.
- **R40.** When no live override is set but one or more placements have `start_time <= playheadTime <= end_time`, the evaluator MUST pick the one with the highest `display_order` (ties broken by `created_at` ascending), merge the scene's sparse stored params with the primitive's catalog defaults (stored wins per-key), compute `sceneTime = playheadTime - start_time`, apply the primitive with the merged params, apply placement fade envelopes, and return `{activeLayer: 'timeline', label}`.
- **R40a.** Param merge resolution rule: for each key declared in the primitive's `params_schema`, if the key is present in stored params (including being explicitly set to a non-null value), use the stored value; otherwise use the catalog `default`. If a key has no catalog default and is absent from stored params, the value passed to `apply()` is `undefined` (which the primitive interprets per its own contract — e.g., `role: undefined` → all fixtures per Q 4.1).
- **R41.** When neither live override nor placement is active, the evaluator MUST delegate to `fallbackScene.apply(playheadTime, states, context)` if provided, returning `{activeLayer: 'fallback', label}`, else return `{activeLayer: 'none'}`. **Transitional**: at MVP, `fallbackScene` is the current dropdown-picked scene in `LightShow3DPanel` (`rainbow_chase`, `beat_strobe`, etc.) — preserves existing scene-experimentation affordance until the future scene editor panel lands. Long-term direction (deferred): drop the dropdown, make fallback blackout (intensity 0), and move all scene previewing into a dedicated Scene Editor Panel that runs its own state buffer / playhead independently of the show.
- **R42.** Fade envelopes MUST multiply the final `state.intensity` only. `state.color`, `state.pan`, and `state.tilt` MUST pass through without modification by the fade.
- **R43.** Placement fade-in envelope: for `sceneTime` in `[0, fade_in_sec)`, intensity is multiplied by `sceneTime / fade_in_sec`. At `sceneTime >= fade_in_sec`, multiplier is 1.
- **R44.** Placement fade-out envelope: let `timeToEnd = end_time - playheadTime`. For `timeToEnd` in `[0, fade_out_sec)`, intensity is multiplied by `timeToEnd / fade_out_sec`. At `timeToEnd >= fade_out_sec`, multiplier is 1.
- **R45.** When both fade-in and fade-out windows overlap (placement shorter than `fade_in_sec + fade_out_sec`), the multipliers compose (multiply). Minimum intensity multiplier is 0.
- **R46.** Live override fade-in envelope uses wall clock: for `(wallClock - activated_at)` in `[0, fade_in_sec)`, intensity multiplied by `(wallClock - activated_at) / fade_in_sec`.
- **R47.** Live override fade-out: when `deactivation_started_at` is set, for `(wallClock - deactivation_started_at)` in `[0, fade_out_sec)`, intensity multiplied by `1 - (wallClock - deactivation_started_at) / fade_out_sec`. When `>= fade_out_sec`, the evaluator MUST physically delete the override row (via REST POST `/live/deactivate?commit=true` or directly via the DB helper) and return as if no override was present.
- **R48.** Placement lookup MUST be deterministic given the same `playheadTime` and placement set: repeated evaluator calls at the same `playheadTime` return the same result.

### Frontend panel integration

- **R49.** `LightShow3DPanel` MUST fetch scenes, placements, and live override on mount and refresh on the following triggers (no periodic polling):
  - **WS event**: subscribe to `light_show__changed` filtering on `kind: 'scenes' | 'placements' | 'live'`; refetch the corresponding entity on each event.
  - **WS reconnect**: when `useScenecraftSocket().connected` transitions from `false` to `true`, refetch all three entities (catches mutations broadcast during the disconnect window when the WS subscription was inactive).
  - **Project switch**: re-fetch on `projectName` change.
  Periodic polling is explicitly NOT in the design — the WS event + reconnect-refetch combo covers the same correctness guarantees at far lower steady-state cost.
- **R50.** The diagnostic bar MUST display an active-layer label: `"LIVE: <scene label>"` when a live override is driving output, `"TIMELINE: <scene label>"` when a placement is driving output, `"FALLBACK: <scene label>"` when neither is active and the dropdown scene runs.

---

## Interfaces / Data Shapes

### `primitives_catalog.yaml`

```yaml
primitives:
  - id: rotating_head
    label: Rotating Head
    description: |
      Sinusoidal pan/tilt sweep with hold color + intensity.
      Period controls cycle length; amplitude controls arc width.
    params_schema:
      type: object
      properties:
        role:
          type: string
          default: moving_head
          description: Fixture role filter; undefined = all fixtures
        period_sec:        { type: number, minimum: 0.1, default: 4.0 }
        pan_amplitude_rad: { type: number, minimum: 0,   default: 0.7853981633974483 }
        tilt_center_rad:   { type: number, default: -0.3 }
        tilt_amplitude_rad: { type: number, minimum: 0,  default: 0.2 }
        tilt_period_sec:   { type: number, minimum: 0.1, default: 4.0 }
        intensity:         { type: number, minimum: 0, maximum: 1, default: 1.0 }
        color:
          type: array
          minItems: 3
          maxItems: 3
          items: { type: number, minimum: 0, maximum: 1 }
          default: [1, 1, 1]

  - id: static_color
    label: Static Color
    description: |
      Hold a color + intensity. No animation; use for static
      backdrops or baseline fills.
    params_schema:
      type: object
      properties:
        role:
          type: string
          description: Fixture role filter; undefined = all fixtures
        intensity: { type: number, minimum: 0, maximum: 1, default: 1.0 }
        color:
          type: array
          minItems: 3
          maxItems: 3
          items: { type: number, minimum: 0, maximum: 1 }
          default: [1, 1, 1]
```

The catalog is **static config that ships with the plugin code** — same shape on every install of the same plugin version. Backend reads it via `yaml.safe_load` (the engine already vends `ruamel.yaml` for `plugin.yaml` parsing — same dependency); frontend reads it at build time (Vite's `?raw` import + `js-yaml`) or at runtime via the REST `/primitives` endpoint, which returns the parsed YAML as JSON.

### REST endpoints

Conventional REST. Path prefix below shortened to `/api/projects/:name/plugins/light_show` for readability. List endpoints accept query params for filter/pagination. PATCH bodies follow RFC 7396 JSON Merge Patch (e.g. `{"params": {"role": null}}` deletes the `role` key).

#### Catalog (read-only)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/primitives` | — | `{primitives: [...]}` (parsed YAML catalog as JSON) |

#### Scenes

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/scenes` | query: `?type=&label_query=&ids=a&ids=b&limit=50&offset=0&order_by=updated_at&order=desc` | `{scenes: [...], total, has_more}` (sparse params) |
| POST | `/scenes` | `{label, type, params?}` (no id; server assigns UUID) | `201 {scene: {id, label, type, params, ...}}` |
| GET | `/scenes/:id` | — | `{scene: {...}}` or `404` |
| PATCH | `/scenes/:id` | `{label?, type?, params?}` (merge-patch; null deletes per-key inside params) | `{scene: {...}}` |
| DELETE | `/scenes/:id` | — | `{scene: {...}}` (deleted row, sparse) or `409 {error, blocked?, blocked_by_live?}` |

#### Placements

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/placements` | query: `?scene_id=&time_start=&time_end=&ids=a&ids=b&limit=100&offset=0&order_by=start_time&order=asc` | `{placements: [...], total, has_more}` |
| POST | `/placements` | `{scene_id, start_time, end_time, display_order?, fade_in_sec?, fade_out_sec?}` | `201 {placement: {id, ...}}` |
| GET | `/placements/:id` | — | `{placement: {...}}` or `404` |
| PATCH | `/placements/:id` | `{scene_id?, start_time?, end_time?, display_order?, fade_in_sec?, fade_out_sec?}` | `{placement: {...}}` |
| DELETE | `/placements/:id` | — | `{placement: {...}}` (deleted row) or `404` |

#### Live override (singleton resource)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/live` | — | `{active: false}` or `{active: true, scene_id, label, activated_at, fade_in_sec, fade_out_sec, deactivation_started_at}` |
| PUT | `/live` | `{scene_id?, scene?, fade_in_sec?, label?, save_as?}` (replaces if active) | `{active: true, scene_id, ...}` (for `save_as`, `scene_id` is the new uuid) |
| DELETE | `/live` | optional query: `?fade_out_sec=N` | `{active: false}` |

**Notes:**
- Bulk operations are NOT a REST concern. The MCP tools call plugin_api / DB helpers directly for bulk dispatch (atomic transaction). External REST clients that want bulk semantics issue parallel single-resource calls (`Promise.all` on the frontend).
- 4xx error responses include `{error: "<message>"}` JSON body. `409 Conflict` is used when DELETE is blocked by references (placements / live override).
- Query params for list filtering are flat (no `filter[type]` bracket nesting); array fields use repeated keys (`?ids=a&ids=b`).
- Time-range filter on placements uses `time_start` and `time_end` query params (both required if used; selects placements that overlap `[time_start, time_end]`).

### MCP tool input schemas (plugin.yaml)

```yaml
- id: scenes
  description: |
    Scene library CRUD + primitive catalog discovery + filtered/paginated list. Actions:
      - "list": return scenes (filtered + paginated). Defaults: 50 most recently updated.
      - "list_primitives": return the primitive catalog (JSON-schema per primitive).
      - "set": bulk partial upsert by id; returns only upserted rows.
      - "remove": delete scenes by id (rejects if referenced by placements or live override); returns only deleted rows.
  handler: "backend:tools_scenes"
  input_schema:
    type: object
    required: [action]
    properties:
      action: { type: string, enum: [list, list_primitives, set, remove] }
      # set — id presence dispatches: missing → CREATE (server assigns uuid),
      # present → UPDATE (id must reference existing scene). Create requires
      # `label` and `type`. Update accepts merge-patch on params (null deletes).
      scenes:
        type: array
        items:
          type: object
          properties:
            id:     { type: string, description: "Omit to create with server-assigned UUID; present to update by id" }
            label:  { type: string }
            type:   { type: string }
            params: { type: object, description: "Merge-patch: {key: null} deletes the key from sparse storage" }
      # remove
      ids:
        type: array
        items: { type: string }
      # list — pagination + filter
      filter:
        type: object
        properties:
          ids:         { type: array, items: { type: string } }
          type:        { type: string, description: "Exact primitive type match" }
          label_query: { type: string, description: "Case-insensitive substring on label" }
      limit:    { type: integer, minimum: 1, maximum: 500, default: 50 }
      offset:   { type: integer, minimum: 0, default: 0 }
      order_by: { type: string, enum: [created_at, updated_at, label], default: updated_at }
      order:    { type: string, enum: [asc, desc], default: desc }

- id: scene_timeline
  description: |
    Timeline placement CRUD with filter/pagination. Actions:
      - "list": return placements (filtered + paginated). Defaults: 100 placements, chronological.
      - "set": bulk partial upsert (missing id → new UUID); returns only upserted rows.
      - "remove": delete by ids; returns only deleted rows.
  handler: "backend:tools_scene_timeline"
  input_schema:
    type: object
    required: [action]
    properties:
      action: { type: string, enum: [list, set, remove] }
      # set
      placements:
        type: array
        items:
          type: object
          required: [scene_id, start_time, end_time]
          properties:
            id:            { type: string }
            scene_id:      { type: string }
            start_time:    { type: number }
            end_time:      { type: number }
            display_order: { type: integer }
            fade_in_sec:   { type: number, minimum: 0 }
            fade_out_sec:  { type: number, minimum: 0 }
      # remove
      ids:
        type: array
        items: { type: string }
      # list — pagination + filter
      filter:
        type: object
        properties:
          ids:      { type: array, items: { type: string } }
          scene_id: { type: string, description: "Placements of a specific scene" }
          time_range:
            type: object
            required: [start, end]
            description: "Placements that overlap the [start, end] window (seconds)"
            properties:
              start: { type: number }
              end:   { type: number }
      limit:    { type: integer, minimum: 1, maximum: 1000, default: 100 }
      offset:   { type: integer, minimum: 0, default: 0 }
      order_by: { type: string, enum: [start_time, created_at], default: start_time }
      order:    { type: string, enum: [asc, desc], default: asc }

- id: scene_live
  description: |
    Single-slot live override (cues + manual directives). Actions:
      - "activate": fire a cue (scene_id) or manual directive (inline scene).
      - "deactivate": fade out current override and release.
      - "status": inspect current override state.
  handler: "backend:tools_scene_live"
  destructive: true  # activate can replace an active cue; deactivate drops state
  input_schema:
    type: object
    required: [action]
    properties:
      action: { type: string, enum: [activate, deactivate, status] }
      scene_id: { type: string, description: "Library scene id (exclusive with `scene`)" }
      scene:
        type: object
        description: "Inline scene (exclusive with `scene_id`)"
        required: [type, params]
        properties:
          type:   { type: string }
          params: { type: object }
      label:        { type: string }
      save_as:      { type: string, description: "Inline only — also persist to library with this id" }
      fade_in_sec:  { type: number, minimum: 0 }
      fade_out_sec: { type: number, minimum: 0 }
```

### TypeScript types

```ts
export type SceneRow = {
  id: string
  label: string
  type: string
  params: Record<string, unknown>  // deserialized params_json
  created_at: string
  updated_at: string
}

export type PlacementRow = {
  id: string
  scene_id: string
  start_time: number
  end_time: number
  display_order: number
  fade_in_sec: number
  fade_out_sec: number
  created_at: string
  updated_at: string
}

export type LiveOverrideRow =
  | { active: false }
  | {
      active: true
      scene_id?: string                  // when referring to library scene
      inline_type?: string               // when inline
      inline_params?: Record<string, unknown>  // when inline
      label: string
      fade_in_sec: number
      fade_out_sec: number
      activated_at: string
      deactivation_started_at: string | null
    }

export type PrimitiveApplyFn = (
  sceneTime: number,
  states: FixtureState[],
  params: Record<string, unknown>,
  context: SceneContext,
) => void

export type EvaluatorResult = {
  activeLayer: 'live' | 'timeline' | 'fallback' | 'none'
  label?: string
}
```

---

## Behavior

### Scene authoring flow (chat-driven)

1. Chat invokes `scenes.list_primitives` → receives catalog
2. Chat invokes `scenes.set({scenes: [{label: "Slow Rotating Head", type: "rotating_head", params: {period_sec: 6, pan_amplitude_rad: 0.5}}]})` → server assigns uuid; response includes `{id: "<RH_UUID>", label, type, params: {period_sec: 6, pan_amplitude_rad: 0.5}}` (sparse). Chat captures `RH_UUID`.
3. Chat invokes `scene_timeline.set({placements: [{scene_id: "<RH_UUID>", start_time: 5, end_time: 15, fade_in_sec: 1, fade_out_sec: 2}]})` → placement inserted with auto-UUID
4. User presses play on main timeline → playhead advances 0 → 15 → 20s
5. During 0 → 5s: fallback scene runs (dropdown-selected scene or existing default)
6. At t=5s: placement becomes active; evaluator merges sparse params with rotating_head catalog defaults; primitive renders with `sceneTime=0`, fade-in begins
7. At t=6s: fade-in complete, rotating_head at full intensity; pan/tilt animate per `sceneTime = playheadTime - 5`
8. At t=13s: fade-out begins (`fade_out_sec=2`, `timeToEnd=2`)
9. At t=15s: placement ends, intensity back to 0 → fallback resumes

### Live override flow (chat-triggered cue)

1. User scrubs to t=8s, hits play; placement `rh_slow` is rendering (activeLayer = timeline)
2. Chat invokes `scene_live.activate({scene_id: "rh_slow", fade_in_sec: 0.5})` → override row inserted; diag bar flips to `LIVE: Slow Rotating Head`; placement stops rendering
3. Timeline playhead continues advancing (9s, 10s, 11s...) — placement logic runs but output is suppressed by live layer
4. User sees override scene play; `sceneTime = wallClock - activated_at`
5. Chat invokes `scene_live.deactivate({fade_out_sec: 1})` → `deactivation_started_at = now`; fade-out begins
6. After 1s, evaluator removes the override row; placement at current playhead resumes (if any is active) or fallback takes over

### Manual directive flow (inline scene)

1. User says in chat: "give me a red static color"
2. Chat invokes `scene_live.activate({scene: {type: "static_color", params: {color: [1, 0, 0]}}, label: "Red Wash"})` — no `save_as` passed; scene is ephemeral
3. Override row created with `scene_id=NULL, inline_type="static_color", inline_params_json='{"color":[1,0,0]}'`. Response: `{active: true, scene_id: null, label: "Red Wash", ...}` (no scene_id because it's inline).
4. User likes it; says "save this as 'Emergency Red'"
5. Chat re-fires `scene_live.activate({scene: {type: "static_color", params: {color: [1, 0, 0]}}, save_as: "Emergency Red"})` — `save_as` is the **label**; backend creates a new library scene with `label = "Emergency Red"` and a fresh uuid; the override now references that uuid. Response: `{active: true, scene_id: "<EMERGENCY_RED_UUID>", label: "Emergency Red", ...}`.
6. On subsequent chat session, user says "fire emergency red" → chat calls `scenes.list({filter: {label_query: "emergency red"}})` to find the uuid, then `scene_live.activate({scene_id: "<EMERGENCY_RED_UUID>"})`.

### Scrub behavior

Scrubbing the main timeline mid-placement: evaluator computes `sceneTime = playheadTime - start_time` on every frame, calls the primitive with that value. Since primitives are pure functions of `sceneTime`, scrubbing shows the animation at its exact local time. No resets.

Scrubbing into a placement's fade-in window: intensity multiplier is `sceneTime / fade_in_sec` at that playhead position — partial brightness. Same for scrub into fade-out window.

### Reference cleanup (delete-safely)

Chat wants to delete a scene that has placements:
1. `scenes.remove({ids: ["rh_slow"]})` → returns `{error: "scene(s) still referenced", blocked: [{scene_id: "rh_slow", placement_ids: ["<uuid>"]}]}`
2. Chat gets the placement ids, runs `scene_timeline.remove({ids: ["<uuid>"]})` → placement removed
3. Chat retries `scenes.remove({ids: ["rh_slow"]})` → scene removed

Same pattern for a scene held by the live override: `scene_live.deactivate` first.

---

## Acceptance Criteria

- [ ] All three new DB tables exist after schema migration on both new and existing project DBs (verified via sqlite schema query)
- [ ] All nine DB helper functions are importable from `scenecraft.plugin_api`
- [ ] `primitives_catalog.yaml` exists at the declared path with the two primitives and their full parameter schemas
- [ ] `scenes.list_primitives` returns the catalog file contents verbatim
- [ ] `scenes.set` partial upsert preserves omitted fields on existing rows
- [ ] `scenes.remove` atomically rejects when any target has placements or is held by the live override
- [ ] `scene_timeline.set` generates auto-UUIDs for new placements and merges fields for existing
- [ ] `scene_timeline.set` atomically rejects invalid entries (end <= start, unknown scene_id)
- [ ] `scene_live.activate` supports both scene_id and inline modes and rejects both-at-once
- [ ] `scene_live.activate` silently replaces the existing override when one is active
- [ ] `scene_live.activate` with `save_as` persists the inline scene to the library
- [ ] `scene_live.deactivate` sets `deactivation_started_at` and the evaluator handles row deletion after fade completes
- [ ] WS `light_show__changed` events fire with correct `kind` value for every mutation
- [ ] Live override row persists across backend restart
- [ ] Frontend `PRIMITIVE_REGISTRY` passes a startup assertion that keys match catalog ids
- [ ] Layered evaluator applies live > timeline > fallback precedence correctly
- [ ] Fade envelopes multiply intensity only; color/pan/tilt pass through
- [ ] `LightShow3DPanel` diagnostic bar shows the active-layer label
- [ ] Rotating-head animation visually renders during its placement window on the main timeline, scrubs deterministically, and is overridden by a live activate mid-playback

---

## Tests

**Test fixture convention**: where tests below refer to a scene id like `"rh_slow"`, that string is shorthand for the uuid created via `scenes.set` (or seeded via direct DB insert in test setup). Production code paths cannot supply chat-chosen ids on scene CREATE per R6 — the server assigns the UUID and returns it. Tests that exercise the create path explicitly use `Given: scene created with no id; received uuid as SCENE_RH_SLOW` style, then reference `SCENE_RH_SLOW` thereafter.

### Base Cases

The core behavior contract: happy path, common bad paths, primary positive and negative assertions.

#### Test: schema-migration-creates-tables (covers R1, R2, R3)

**Given**: A fresh project directory with no project.db yet.

**When**: The scenecraft engine opens the project (triggering `_ensure_schema`).

**Then** (assertions):
- **scenes-table-exists**: `SELECT name FROM sqlite_master WHERE type='table' AND name='light_show__scenes'` returns one row.
- **placements-table-exists**: same query for `light_show__scene_placements` returns one row.
- **live-override-table-exists**: same query for `light_show__live_override` returns one row.
- **placements-time-index-exists**: `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='light_show__scene_placements' AND sql LIKE '%start_time%end_time%'` returns one row.
- **live-check-constraint-present**: attempting to insert a row with `scene_id=NULL, inline_type=NULL, inline_params_json=NULL` raises an IntegrityError.
- **live-check-constraint-both-disallowed**: attempting to insert a row with BOTH `scene_id` set AND `inline_type` set raises IntegrityError.

#### Test: scenes-list-primitives-returns-catalog-verbatim (covers R4)

**Given**: The `primitives_catalog.yaml` file exists with the two MVP primitives.

**When**: Chat calls `tools_scenes({action: "list_primitives"}, ctx)`.

**Then** (assertions):
- **returns-primitives-wrapper**: response has `primitives` key, value is a list.
- **includes-rotating-head**: one primitive has `id == "rotating_head"` with all default values specified in the spec.
- **includes-static-color**: one primitive has `id == "static_color"`.
- **schema-shape-matches-file**: parsing the YAML file independently and comparing the resulting object structure to the response body (both as Python dicts / JS objects) yields equality — no fields added, removed, or reordered.

#### Test: scenes-set-creates-new-with-server-uuid (covers R5, R6)

**Given**: Empty `light_show__scenes` table.

**When**: Chat calls `tools_scenes({action: "set", scenes: [{label: "Slow Rotating Head", type: "rotating_head", params: {period_sec: 6}}]}, ctx)` (no `id`).

**Then** (assertions):
- **set-returns-upserted-only**: response is `{scenes: [...]}` with exactly one entry (NOT the full library).
- **id-is-server-uuid**: returned scene has an `id` field matching a UUIDv4 pattern; chat did not supply this id.
- **set-response-not-full-list**: response does NOT include unrelated rows (verified by also having an unrelated scene in DB before the call and confirming it does not appear in the response).
- **row-persisted**: a subsequent `list` call returns the new scene with the server-assigned uuid.
- **label-persisted**: returned scene has `label: "Slow Rotating Head"`.
- **params-stored-sparse**: returned `params` is exactly `{period_sec: 6}` — only the explicitly-set key. Other rotating_head defaults (`pan_amplitude_rad`, `tilt_center_rad`, etc.) MUST NOT be present in the response or in `params_json`.
- **created-at-set**: `created_at` field is a valid ISO8601 timestamp within last 5 seconds.
- **ws-broadcast-scenes**: a `light_show__changed` event with `kind: "scenes"` was broadcast.

#### Test: scenes-set-rejects-create-without-label-or-type (covers R6)

**Given**: Empty scenes table.

**When**: Chat calls `tools_scenes({action: "set", scenes: [{type: "rotating_head"}]}, ctx)` (no id, no label).

**Then** (assertions):
- **error-returned**: response has `error` matching `/label and type required/i`.
- **no-rows-inserted**: scenes table row count is 0.

#### Test: scenes-set-rejects-update-with-unknown-id (covers R7)

**Given**: Scenes table contains a scene with id `"existing_uuid"` only.

**When**: Chat calls `tools_scenes({action: "set", scenes: [{id: "ghost_uuid", params: {period_sec: 5}}]}, ctx)`.

**Then** (assertions):
- **error-returned**: response has `error` matching `/unknown scene id/i`.
- **no-mutation**: `existing_uuid` is unchanged.

#### Test: scenes-set-partial-update-preserves-omitted (covers R6)

**Given**: A scene exists with `id="rh_slow", label="Slow", params={period_sec: 6, pan_amplitude_rad: 0.5}`.

**When**: Chat calls `tools_scenes({action: "set", scenes: [{id: "rh_slow", params: {period_sec: 8}}]}, ctx)`.

**Then** (assertions):
- **period-updated**: returned `params.period_sec == 8`.
- **amplitude-preserved**: returned `params.pan_amplitude_rad == 0.5`.
- **label-preserved**: returned `label == "Slow"`.
- **updated-at-advances**: `updated_at` timestamp is newer than prior value.
- **no-new-row-inserted**: count of scenes is still 1.

#### Test: scenes-set-null-deletes-param-key (covers R6)

**Given**: Scene `"rh_slow"` exists with `params_json = '{"period_sec": 6, "role": "moving_head"}'`.

**When**: Chat calls `tools_scenes({action: "set", scenes: [{id: "rh_slow", params: {role: null}}]}, ctx)`.

**Then** (assertions):
- **role-key-removed**: stored `params_json` no longer contains a `role` key.
- **period-preserved**: stored `params_json.period_sec == 6` (untouched).
- **response-shows-sparse**: response `scenes[0].params` is exactly `{period_sec: 6}` — no `role`, no other defaults.

#### Test: scenes-set-rejects-null-on-top-level (covers R6)

**Given**: Scene `"rh_slow"` exists.

**When**: Chat calls `tools_scenes({action: "set", scenes: [{id: "rh_slow", label: null}]}, ctx)`.

**Then** (assertions):
- **error-returned**: response has `error` matching `/cannot null required column: label/i`.
- **no-mutation**: stored row's `label` is unchanged.

#### Test: scenes-set-rejects-null-params-object (covers R6)

**Given**: Any state.

**When**: Chat calls `tools_scenes({action: "set", scenes: [{id: "rh_slow", params: null}]}, ctx)`.

**Then** (assertions):
- **error-returned**: response has `error` matching `/params object cannot be null/i`.
- **no-mutation**: existing row (if any) is untouched.

#### Test: scenes-roundtrip-list-set-preserves-sparse (covers R5, R6)

**Given**: Scene `"rh_slow"` was created with `params: {period_sec: 6}` (sparse — only one key).

**When**:
- Chat calls `tools_scenes({action: "list", filter: {ids: ["rh_slow"]}}, ctx)` → receives the scene.
- Chat passes the received scene back via `tools_scenes({action: "set", scenes: [<received>]}, ctx)` unchanged.

**Then** (assertions):
- **stored-params-still-sparse**: stored `params_json` after the round-trip is still exactly `{"period_sec": 6}` — no defaults promoted to explicit storage.
- **future-default-changes-flow-through**: if catalog default for `tilt_center_rad` were updated post-roundtrip, the evaluator would pick up the new default for this scene (verified by reading sparse params and observing `tilt_center_rad` is NOT in `params_json`).

#### Test: scenes-set-rejects-unknown-type (covers R8)

**Given**: Empty scenes table.

**When**: Chat calls `tools_scenes({action: "set", scenes: [{id: "x", label: "X", type: "nonexistent", params: {}}]}, ctx)`.

**Then** (assertions):
- **error-returned**: response has `error` matching `/unknown primitive type/i`.
- **no-rows-inserted**: scenes table row count is 0.

#### Test: scenes-remove-happy-path (covers R9)

**Given**: A scene `"rh_slow"` exists; no placements reference it; no live override holds it.

**When**: Chat calls `tools_scenes({action: "remove", ids: ["rh_slow"]}, ctx)`.

**Then** (assertions):
- **row-deleted**: subsequent `list` returns no scene with id `"rh_slow"`.
- **ws-broadcast-scenes**: a `light_show__changed` event with `kind: "scenes"` was broadcast.

#### Test: scenes-remove-rejects-when-placements-reference (covers R9)

**Given**: Scene `"rh_slow"` exists; one placement `"p1"` references it.

**When**: Chat calls `tools_scenes({action: "remove", ids: ["rh_slow"]}, ctx)`.

**Then** (assertions):
- **error-returned**: response has `error` mentioning "still referenced".
- **blocked-list-includes-placement**: `blocked` field contains an entry with `scene_id: "rh_slow"` and `placement_ids: ["p1"]`.
- **scene-still-exists**: `list` call still includes `"rh_slow"`.
- **no-ws-broadcast**: no `light_show__changed` event fired.

#### Test: scenes-remove-rejects-when-live-override-holds (covers R10)

**Given**: Scene `"rh_slow"` exists; live override references it; no placements reference it.

**When**: Chat calls `tools_scenes({action: "remove", ids: ["rh_slow"]}, ctx)`.

**Then** (assertions):
- **error-returned**: response has `error` matching `/held by live override/i`.
- **blocked-by-live-field**: response has `blocked_by_live: "rh_slow"`.
- **scene-still-exists**: `list` call still includes `"rh_slow"`.

#### Test: scenes-list-default-pagination (covers R5)

**Given**: 75 scenes exist; the most recently `updated_at` are `s_75`, `s_74`, ... `s_1` in descending update order.

**When**: Chat calls `tools_scenes({action: "list"}, ctx)` with no other args.

**Then** (assertions):
- **default-limit-50**: `scenes.length == 50`.
- **total-is-75**: `total == 75`.
- **has-more-true**: `has_more == true`.
- **default-order-updated-desc**: first element is `s_75`, last element is `s_26`.

#### Test: scenes-list-pagination-second-page (covers R5)

**Given**: Same 75-scene fixture as above.

**When**: Chat calls `tools_scenes({action: "list", offset: 50, limit: 50}, ctx)`.

**Then** (assertions):
- **page-2-length**: `scenes.length == 25` (75 − 50).
- **total-still-75**: `total == 75`.
- **has-more-false**: `has_more == false`.
- **page-2-first-is-s25**: first element id is `s_25`.

#### Test: scenes-list-filter-by-type (covers R5)

**Given**: 10 scenes, 4 of `type: "rotating_head"`, 6 of `type: "static_color"`.

**When**: Chat calls `tools_scenes({action: "list", filter: {type: "rotating_head"}}, ctx)`.

**Then** (assertions):
- **only-matching-type**: every returned scene has `type == "rotating_head"`.
- **count-matches**: `scenes.length == 4`, `total == 4`, `has_more == false`.

#### Test: scenes-list-filter-by-label-query-substring-case-insensitive (covers R5)

**Given**: Scenes with labels `"Slow Rotating Head"`, `"Fast rotating Head"`, `"Static Red"`.

**When**: Chat calls `tools_scenes({action: "list", filter: {label_query: "ROTATING"}}, ctx)`.

**Then** (assertions):
- **case-insensitive-match**: both rotating-head scenes are returned (case insensitive).
- **non-matching-excluded**: the static_red scene is NOT in the response.
- **total-2**: `total == 2`.

#### Test: scenes-list-filter-by-ids (covers R5)

**Given**: Scenes `"a"`, `"b"`, `"c"` exist; `"x"` does NOT exist.

**When**: Chat calls `tools_scenes({action: "list", filter: {ids: ["a", "x", "c"]}}, ctx)`.

**Then** (assertions):
- **returns-existing-only**: `scenes.length == 2`, ids are `"a"` and `"c"` (in `updated_at desc` order or as DB returns).
- **missing-silently-skipped**: no error, no entry for `"x"`.

#### Test: scenes-list-order-by-label-asc (covers R5)

**Given**: Scenes with labels `"Apple"`, `"banana"`, `"Cherry"`.

**When**: Chat calls `tools_scenes({action: "list", order_by: "label", order: "asc"}, ctx)`.

**Then** (assertions):
- **alphabetical**: response order is `"Apple"`, `"banana"`, `"Cherry"` (case-insensitive collation OR documented case-sensitive — assertion matches whichever the implementation chose, but is deterministic across runs).

#### Test: scenes-list-limit-clamped-to-max (covers R5)

**Given**: 600 scenes exist.

**When**: Chat calls `tools_scenes({action: "list", limit: 9999}, ctx)`.

**Then** (assertions):
- **limit-clamped-to-500**: `scenes.length == 500` (max).
- **total-is-600**: `total == 600`.
- **has-more-true**: `has_more == true`.

#### Test: scene-timeline-set-inserts-with-auto-uuid (covers R12, R13)

**Given**: Scene `"rh_slow"` exists; placements table empty.

**When**: Chat calls `tools_scene_timeline({action: "set", placements: [{scene_id: "rh_slow", start_time: 5, end_time: 10}]}, ctx)`.

**Then** (assertions):
- **one-placement-inserted**: `list` returns one placement.
- **auto-id-assigned**: placement `id` is a non-empty string matching a UUID pattern.
- **start-end-persisted**: `start_time == 5`, `end_time == 10`.
- **defaults-applied**: `display_order == 0`, `fade_in_sec == 0`, `fade_out_sec == 0`.
- **ws-broadcast-placements**: `light_show__changed` event with `kind: "placements"` fired.

#### Test: scene-timeline-set-rejects-end-before-start (covers R14)

**Given**: Scene `"rh_slow"` exists.

**When**: Chat calls `tools_scene_timeline({action: "set", placements: [{scene_id: "rh_slow", start_time: 10, end_time: 5}]}, ctx)`.

**Then** (assertions):
- **error-returned**: response has `error` matching `/end_time must be greater than start_time/i`.
- **no-rows-inserted**: placements table empty.

#### Test: scene-timeline-set-rejects-unknown-scene-id (covers R15)

**Given**: No scenes; empty placements table.

**When**: Chat calls `tools_scene_timeline({action: "set", placements: [{scene_id: "nonexistent", start_time: 5, end_time: 10}]}, ctx)`.

**Then** (assertions):
- **error-returned**: response has `error` matching `/unknown scene_id/i`.
- **no-rows-inserted**: placements table empty.

#### Test: scene-timeline-list-default-chronological (covers R12)

**Given**: 5 placements at `start_time` 0, 5, 10, 15, 20.

**When**: Chat calls `tools_scene_timeline({action: "list"}, ctx)`.

**Then** (assertions):
- **chronological-ascending**: response `placements` are ordered by `start_time` ascending (0, 5, 10, 15, 20).
- **total-is-5**: `total == 5`, `has_more == false`.

#### Test: scene-timeline-list-filter-time-range (covers R12)

**Given**: Placements:
- A: `[0, 5]`
- B: `[5, 10]` (boundary touch — overlaps `[7, 12]` window)
- C: `[8, 12]` (overlaps)
- D: `[15, 20]` (no overlap)

**When**: Chat calls `tools_scene_timeline({action: "list", filter: {time_range: {start: 7, end: 12}}}, ctx)`.

**Then** (assertions):
- **overlapping-included**: B and C are in the response.
- **non-overlapping-excluded**: D is NOT in the response.
- **boundary-touch-included**: B is included even though only `start_time=5` to `end_time=10` and the query starts at 7 (overlap is 7-10, non-empty).

#### Test: scene-timeline-list-filter-by-scene-id (covers R12)

**Given**: 6 placements: 4 reference scene `"rh_slow"`, 2 reference `"static_blue"`.

**When**: Chat calls `tools_scene_timeline({action: "list", filter: {scene_id: "rh_slow"}}, ctx)`.

**Then** (assertions):
- **only-rh-slow**: every returned placement has `scene_id == "rh_slow"`.
- **count**: `scenes.length == 4`, `total == 4`.

#### Test: scene-timeline-set-returns-upserted-only (covers R13)

**Given**: 5 placements exist; chat upserts 1 new placement.

**When**: Chat calls `tools_scene_timeline({action: "set", placements: [{scene_id: "rh_slow", start_time: 30, end_time: 40}]}, ctx)`.

**Then** (assertions):
- **set-returns-only-new**: response `placements.length == 1`.
- **set-response-not-full-list**: response does NOT include the 5 prior placements.
- **list-still-shows-all-6**: subsequent `list` returns 6 placements.

#### Test: scenes-remove-returns-deleted-rows (covers R9)

**Given**: Scenes `"a"`, `"b"`, `"c"` exist; none referenced.

**When**: Chat calls `tools_scenes({action: "remove", ids: ["a", "x", "c"]}, ctx)` (`"x"` does not exist).

**Then** (assertions):
- **returns-only-deleted**: response `scenes` has exactly 2 entries — the deleted `"a"` and `"c"` (with their pre-deletion data).
- **missing-id-silently-skipped**: no error for `"x"`.
- **scene-b-remains**: subsequent `list` shows `"b"` still present.

#### Test: scene-timeline-remove-returns-deleted-rows (covers R16)

**Given**: 3 placements exist with ids `p1`, `p2`, `p3`.

**When**: Chat calls `tools_scene_timeline({action: "remove", ids: ["p1", "p3", "ghost"]}, ctx)` (`"ghost"` does not exist).

**Then** (assertions):
- **returns-only-deleted**: response `placements` has exactly 2 entries — `p1` and `p3` with their pre-deletion data (start_time, end_time, etc.).
- **p2-remains**: `list` shows only `p2`.
- **no-error**: no error for missing `"ghost"`.

#### Test: scene-live-activate-by-scene-id (covers R18, R19, R21, R26)

**Given**: Scene `"rh_slow"` exists; no live override active.

**When**: Chat calls `tools_scene_live({action: "activate", scene_id: "rh_slow", fade_in_sec: 0.5}, ctx)`.

**Then** (assertions):
- **override-row-exists**: subsequent `status` returns `active: true`.
- **scene-id-persisted**: `status` response has `scene_id: "rh_slow"`.
- **label-default-to-scene-label**: `status.label` equals the scene's label.
- **activated-at-set**: `activated_at` is a valid ISO8601 timestamp.
- **fade-in-sec-persisted**: `fade_in_sec == 0.5`.
- **ws-broadcast-live**: `light_show__changed` event with `kind: "live"` fired.

#### Test: scene-live-activate-with-inline-scene (covers R18, R20, R22)

**Given**: No live override.

**When**: Chat calls `tools_scene_live({action: "activate", scene: {type: "static_color", params: {color: [1, 0, 0]}}, label: "Red Wash"}, ctx)`.

**Then** (assertions):
- **override-row-uses-inline**: subsequent `status` returns `active: true` with no `scene_id`.
- **label-applied**: `status.label == "Red Wash"`.
- **no-library-entry**: `scenes.list` does not include a scene for this inline.

#### Test: scene-live-activate-rejects-both-forms (covers R18)

**Given**: Scene `"rh_slow"` exists.

**When**: Chat calls `tools_scene_live({action: "activate", scene_id: "rh_slow", scene: {type: "static_color", params: {}}}, ctx)`.

**Then** (assertions):
- **error-returned**: response matches `/provide scene_id OR scene, not both/i`.
- **no-override-created**: `status` returns `active: false`.

#### Test: scene-live-activate-save-as-persists (covers R22)

**Given**: No library entry for id `"emergency_red"`; no override active.

**When**: Chat calls `tools_scene_live({action: "activate", scene: {type: "static_color", params: {color: [1, 0, 0]}}, save_as: "emergency_red"}, ctx)`.

**Then** (assertions):
- **library-entry-created**: `scenes.list` includes a scene with `id: "emergency_red"`.
- **override-references-library**: `status` has `scene_id: "emergency_red"` (not inline).
- **scene-params-match-inline**: the library entry's params include `color: [1, 0, 0]`.

#### Test: scene-live-activate-replaces-existing (covers R21)

**Given**: Live override currently active for scene `"rh_slow"`.

**When**: Chat calls `tools_scene_live({action: "activate", scene_id: "other_scene", label: "Other"}, ctx)`.

**Then** (assertions):
- **no-error**: response has no `error` key.
- **override-is-other**: `status.scene_id == "other_scene"`.
- **override-label-is-other**: `status.label == "Other"`.
- **activated-at-updated**: `activated_at` is newer than the original activation.

#### Test: scene-live-deactivate-no-op-when-inactive (covers R25)

**Given**: No live override active.

**When**: Chat calls `tools_scene_live({action: "deactivate"}, ctx)`.

**Then** (assertions):
- **no-error**: response has no `error` key.
- **returns-inactive**: `status` returns `active: false`.

#### Test: apply-rotating-head-at-zero (covers R32)

**Given**: A fixture list with one `moving_head` fixture (state zero-initialized); primitive params at defaults.

**When**: `applyRotatingHead(0, states, defaultParams, emptyContext)` is called.

**Then** (assertions):
- **pan-zero**: `states[0].pan == 0`.
- **tilt-at-center**: `states[0].tilt == -0.3` (tilt_center_rad default).
- **intensity-full**: `states[0].intensity == 1`.
- **color-white**: `states[0].color == [1, 1, 1]`.

#### Test: apply-rotating-head-quarter-period (covers R33)

**Given**: Same fixture list; `sceneTime == period_sec / 4 == 1.0`.

**When**: `applyRotatingHead(1.0, states, defaultParams, emptyContext)` is called.

**Then** (assertions):
- **pan-at-amplitude**: `states[0].pan` equals `pan_amplitude_rad` (within floating-point epsilon 1e-9).

#### Test: apply-rotating-head-respects-role-filter (covers R36)

**Given**: Fixture list with one `moving_head` and one `par`; params `{role: "moving_head"}`.

**When**: `applyRotatingHead(0, states, {...defaults, role: "moving_head"}, emptyContext)` is called.

**Then** (assertions):
- **mover-updated**: moving_head fixture's state reflects the primitive's writes.
- **par-untouched**: par fixture's state is byte-for-byte unchanged from its pre-call value.

#### Test: evaluator-merges-sparse-params-with-catalog-defaults (covers R39, R40, R40a)

**Given**:
- Scene `"rh_partial"` with sparse stored `params_json = '{"period_sec": 6}'` (only one key).
- Catalog defaults for `rotating_head` include `pan_amplitude_rad: 0.785, tilt_center_rad: -0.3, role: "moving_head", intensity: 1, color: [1,1,1], tilt_amplitude_rad: 0.2, tilt_period_sec: 4`.
- One placement `[0, 10]` references this scene.
- Evaluator runs at `playheadTime = 0`.

**When**: Evaluator resolves params and calls `applyRotatingHead`.

**Then** (assertions):
- **period-from-stored**: the `params` arg to `applyRotatingHead` has `period_sec == 6` (stored override).
- **other-keys-from-catalog**: `pan_amplitude_rad ≈ 0.785`, `tilt_center_rad == -0.3`, `intensity == 1`, `color == [1, 1, 1]`, `role == "moving_head"`.
- **stored-not-mutated**: after the evaluator call, `params_json` for the scene is still exactly `{"period_sec": 6}` (the merge happens transiently, never written back).

#### Test: evaluator-uses-undefined-when-no-default-and-not-stored (covers R40a)

**Given**:
- A primitive whose `params_schema` declares `role` with NO default value (i.e. `role` is "optional, no fallback").
- Scene with sparse params that omits `role`.

**When**: Evaluator resolves params for this scene.

**Then** (assertions):
- **role-is-undefined**: `params.role === undefined` (or equivalent absence) in the args passed to `apply()`.
- **primitive-handles-undefined**: per Q 4.1, primitive applies to all fixtures (specifically tested in `apply-rotating-head-respects-role-filter` for the rotating_head case).

#### Test: evaluator-live-wins (covers R39)

**Given**:
- `liveOverride` exists, references scene `"rh_slow"` which is a `static_color` with `color: [0, 0, 1]`.
- One placement exists at `[5, 10]` referencing a scene with `color: [1, 0, 0]`.
- `playheadTime = 7` (inside placement window).
- `wallClock` makes `sceneTime = 2`.

**When**: `evaluateLayeredScene(...)` is called.

**Then** (assertions):
- **active-layer-live**: return value has `activeLayer: "live"`.
- **state-color-blue**: states reflect blue color (from live scene), not red.

#### Test: evaluator-timeline-wins-when-no-live (covers R40)

**Given**: No live override; one placement `[5, 10]` with scene that sets `color: [1, 0, 0]`; `playheadTime = 7`.

**When**: `evaluateLayeredScene(...)` is called.

**Then** (assertions):
- **active-layer-timeline**: return value has `activeLayer: "timeline"`.
- **state-color-red**: states reflect red color.
- **scene-time-is-2**: if the primitive samples `sceneTime` (verified via spy), it saw `sceneTime == 2`.

#### Test: evaluator-fallback-when-neither (covers R41)

**Given**: No live override; no placements active at `playheadTime = 1`; `fallbackScene` is `rainbow_chase`.

**When**: `evaluateLayeredScene(...)` is called.

**Then** (assertions):
- **active-layer-fallback**: `activeLayer: "fallback"`.
- **fallback-scene-apply-called**: `fallbackScene.apply` was invoked once.

#### Test: fade-envelope-only-intensity (covers R42)

**Given**: A fixture state after primitive writes: `{intensity: 0.8, color: [0, 1, 0], pan: 0.3, tilt: -0.2}`. Fade multiplier is 0.5.

**When**: The evaluator applies the fade envelope.

**Then** (assertions):
- **intensity-halved**: `state.intensity == 0.4`.
- **color-unchanged**: `state.color` still equals `[0, 1, 0]`.
- **pan-unchanged**: `state.pan == 0.3`.
- **tilt-unchanged**: `state.tilt == -0.2`.

#### Test: live-override-persists-across-restart (covers R28)

**Given**: Live override row inserted; scenecraft engine shut down and restarted against the same project DB.

**When**: The evaluator runs its first frame after restart.

**Then** (assertions):
- **row-readable**: `scene_live.status` returns `active: true` with the same `scene_id`, `label`, `activated_at`.
- **evaluator-picks-live**: `evaluateLayeredScene` returns `activeLayer: "live"`.

### Edge Cases

Boundaries, concurrency, idempotency, ordering, resource exhaustion. Every edge the agent or user can reasonably think of that is NOT in Non-Goals goes here.

#### Test: scenes-remove-multiple-atomic-when-one-blocked (covers R9)

**Given**: Scenes `"a"`, `"b"`, `"c"` exist; `"b"` has a placement; `"a"` and `"c"` have none.

**When**: Chat calls `tools_scenes({action: "remove", ids: ["a", "b", "c"]}, ctx)`.

**Then** (assertions):
- **error-returned**: response has `error` and `blocked` fields.
- **blocked-list-has-b**: `blocked` contains an entry for scene_id `"b"`.
- **no-partial-deletion**: scenes `"a"`, `"b"`, `"c"` ALL still exist in the library (atomic all-or-nothing).

#### Test: scene-timeline-overlap-highest-display-order-wins (covers R40)

**Given**:
- Placements A `[5, 15]` with scene-color red, `display_order=0`
- Placements B `[10, 20]` with scene-color blue, `display_order=1`
- `playheadTime = 12` (both active)

**When**: `evaluateLayeredScene(...)` runs.

**Then** (assertions):
- **blue-wins**: states reflect blue (higher `display_order`).
- **red-suppressed**: no red in output.

#### Test: scene-timeline-overlap-tie-broken-by-created-at (covers R40)

**Given**:
- Placements A and B, both `display_order=0`, both covering `playheadTime`.
- A `created_at` is strictly earlier than B's.

**When**: Evaluator runs.

**Then** (assertions):
- **earlier-wins**: A's scene output is what renders.

#### Test: fade-in-at-boundary-zero (covers R43)

**Given**: Placement with `fade_in_sec = 2`; `sceneTime = 0`.

**When**: Fade envelope is applied to an intensity-1 state.

**Then** (assertions):
- **intensity-zero-at-start**: `state.intensity == 0` after envelope.

#### Test: fade-in-midway (covers R43)

**Given**: Placement with `fade_in_sec = 2`; `sceneTime = 1`.

**When**: Fade envelope is applied to intensity-1 state.

**Then** (assertions):
- **intensity-half**: `state.intensity == 0.5`.

#### Test: fade-in-after-window (covers R43)

**Given**: Placement with `fade_in_sec = 2`; `sceneTime = 3` (past window).

**When**: Fade envelope is applied to intensity-1 state.

**Then** (assertions):
- **intensity-full**: `state.intensity == 1`.

#### Test: fade-out-at-end (covers R44)

**Given**: Placement `start_time=0, end_time=10, fade_out_sec=2`; `playheadTime = 10`.

**When**: Fade envelope is applied.

**Then** (assertions):
- **intensity-zero-at-end**: `state.intensity == 0`.

#### Test: fade-in-and-out-overlap-short-placement (covers R45)

**Given**: Placement `start_time=0, end_time=2, fade_in_sec=1, fade_out_sec=1`; primitive writes intensity=1; `sceneTime = 1`.

**When**: Fade envelopes are composed.

**Then** (assertions):
- **fade-in-multiplier**: fade-in gives 1.0 (sceneTime == fade_in_sec).
- **fade-out-multiplier**: fade-out gives 1.0 (timeToEnd == fade_out_sec, which is the peak).
- **composed-intensity**: `state.intensity == 1 * 1 * 1 == 1`.

#### Test: fade-in-and-out-overlap-midpoint (covers R45)

**Given**: Placement `start_time=0, end_time=1, fade_in_sec=1, fade_out_sec=1`; `sceneTime = 0.5`, `timeToEnd = 0.5`; primitive writes intensity=1.

**When**: Fade envelopes are composed.

**Then** (assertions):
- **fade-in-at-half**: fade-in multiplier = 0.5.
- **fade-out-at-half**: fade-out multiplier = 0.5.
- **composed-intensity-quarter**: `state.intensity == 1 * 0.5 * 0.5 == 0.25`.

#### Test: live-override-fade-out-completes-and-row-deleted (covers R47)

**Given**: Live override active for scene_id `"rh_slow"`; `fade_out_sec=1`. Deactivate was called `1.5s` ago (beyond fade window).

**When**: Evaluator runs.

**Then** (assertions):
- **row-physically-deleted**: `scene_live.status` returns `active: false`.
- **active-layer-not-live**: evaluator returns `activeLayer: "timeline"` or `"fallback"`.

#### Test: live-override-fade-out-in-progress (covers R47)

**Given**: Live override active; `fade_out_sec=2`. Deactivate was called `1s` ago (halfway through fade).

**When**: Evaluator runs with primitive that writes intensity=1.

**Then** (assertions):
- **intensity-at-half**: `state.intensity == 0.5` after fade envelope.
- **active-layer-still-live**: `activeLayer: "live"` (row not yet deleted).
- **row-still-present**: `scene_live.status` still returns `active: true`.

#### Test: scrub-backward-into-fade-in-window (covers R43, R48)

**Given**: Placement `start_time=0, end_time=10, fade_in_sec=2`; primitive writes intensity=1.

**When**: Evaluator is called at `playheadTime=5`, then at `playheadTime=1`, then at `playheadTime=5` again.

**Then** (assertions):
- **first-call-full-intensity**: first call yields `intensity=1` (past fade-in window).
- **middle-call-half**: second call yields `intensity=0.5`.
- **last-call-full-again**: third call yields `intensity=1` (deterministic).

#### Test: primitive-registry-catalog-mismatch-assertion (covers R31)

**Given**: `primitives_catalog.yaml` contains a primitive `"rotating_head"` but `PRIMITIVE_REGISTRY` in `primitives.ts` has no entry for it.

**When**: Frontend module imports / boots.

**Then** (assertions):
- **assertion-error-thrown**: an error is thrown (or an explicit console.error fires) with a message containing the missing primitive id.
- **no-silent-gap**: the missing-registry case does NOT silently pass (no-op evaluator calls for the missing primitive).

#### Test: empty-placements-empty-live-renders-fallback (covers R41)

**Given**: Empty scenes, empty placements, no live override. Fallback scene is `all_white`.

**When**: Evaluator runs at `playheadTime = 5`.

**Then** (assertions):
- **active-layer-fallback**: `activeLayer: "fallback"`.
- **all-fixtures-white**: every fixture state has `intensity=1, color=[1,1,1]`.

#### Test: negative-no-mutation-of-unselected-scene-roles (covers R36, R37)

**Given**: Fixture list with one `moving_head` and one `par`; scene is `rotating_head` with `role: "moving_head"`; par fixture state pre-call is `{intensity: 0.2, color: [0.5, 0.5, 0.5], pan: 0, tilt: 0}`.

**When**: Primitive applies.

**Then** (assertions):
- **par-intensity-unchanged**: par's `intensity` is still `0.2`.
- **par-color-unchanged**: par's `color` is still `[0.5, 0.5, 0.5]`.

#### Test: negative-no-broadcast-on-rejected-set (covers R7, R14, R15)

**Given**: Any state; chat calls a `set` that is rejected (unknown scene id on update path, bad end_time, unknown scene_id reference, etc.).

**When**: The tool returns an error.

**Then** (assertions):
- **no-ws-event**: no `light_show__changed` event was broadcast during the call.

#### Test: negative-no-partial-placement-write-on-multi-invalid (covers R14)

**Given**: Chat calls `scene_timeline.set` with two placements: one valid, one with `end_time < start_time`.

**When**: Tool returns an error.

**Then** (assertions):
- **neither-inserted**: placements table row count is unchanged from before the call.

#### Test: negative-no-concurrency-primitives-default-single-threaded (covers implicit)

**Given**: The evaluator runs on the frontend r3f useFrame tick (single-threaded JavaScript event loop).

**When**: Two primitives are applied in the same frame.

**Then** (assertions):
- **serial-execution**: primitives execute sequentially (no Promise.all, no AudioWorklet mid-apply). This is an explicit negative assertion: no implementation SHOULD introduce concurrency in the per-frame apply path without updating this spec.

#### Test: unknown-action-returns-error-not-exception (covers R11, R17, R27)

**Given**: Any state.

**When**: Chat calls `tools_scenes({action: "bogus"}, ctx)` (or equivalent for the other two tools).

**Then** (assertions):
- **error-returned**: response has `error` key listing the valid actions for that tool.
- **no-exception-propagated**: no uncaught exception escapes the tool handler.

#### Test: panel-refetches-on-ws-reconnect (covers R49)

**Given**:
- `LightShow3DPanel` is mounted; initial fetch + WS subscription succeed.
- Test framework controls the WS connection state via the `useScenecraftSocket` mock.

**When**:
- Backend WS connection drops; `useScenecraftSocket().connected` flips from `true` to `false`.
- (Backend side, observable separately) Chat creates a new scene during the disconnect window. WS broadcast is emitted but the panel's subscription does not deliver it.
- WS reconnects; `useScenecraftSocket().connected` flips from `false` to `true`.

**Then** (assertions):
- **refetch-on-reconnect**: a fresh GET to `/scenes`, `/placements`, AND `/live` is observed within the next render cycle of the false→true transition.
- **state-includes-disconnect-mutations**: the panel's scene list now includes the scene created during the disconnect window.
- **no-periodic-poll**: across the test duration (e.g. 10s), no additional HTTP fetches are observed beyond mount-fetch, the reconnect-refetch, and any explicit WS-event-driven refetches. Specifically, no fetches at the historical 2000ms interval.

#### Test: ws-broadcast-kind-on-each-mutation (covers R29)

**Given**: A test WS listener subscribed to `light_show__changed`.

**When**:
- `scenes.set` is called (successful)
- `scene_timeline.set` is called (successful)
- `scene_live.activate` is called (successful)

**Then** (assertions):
- **scenes-event-kind-scenes**: first event has `payload.kind == "scenes"`.
- **placements-event-kind-placements**: second event has `payload.kind == "placements"`.
- **live-event-kind-live**: third event has `payload.kind == "live"`.

---

## Non-Goals

- **Compositions / sequences.** No multi-primitive bundles at MVP. Two placements of two scenes is the workaround.
- **Modulation matrix / effect curves on params.** All params are static scalars; live audio reactivity is handled by primitives reading `context.masterLevel` directly in code.
- **Crossfade between placements.** Fades are solo per-placement; overlaps resolve by `display_order`. Multi-layer or fade-overlap-exception is a phase-2 concern.
- **Merge modes beyond single-winner.** No HTP, additive, multiply, min on overlap.
- **Waveform `shape` param.** `rotating_head` uses pure sine; no triangle/sawtooth/pulse.
- **More primitives.** Only `rotating_head` and `static_color` at MVP.
- **Real DMX output protocols (OLA, Art-Net, sACN).** Sim-only in the 3D preview.
- **Priority stack for live overrides.** Single slot; activate replaces silently.
- **Scene Editor Panel (decoupled preview).** A future dedicated panel that previews a scene-in-authoring with its own state buffer and playhead, fully decoupled from the live show. Enables editing scenes mid-show without interrupting the show output. When this lands, the current dropdown fallback in `LightShow3DPanel` is removed and `fallbackScene` becomes blackout (R41 transitional → permanent: no fallback layer, just live > placement > blackout).
- **Global scene library / cross-project sharing.** Per-project only.
- **Fuzzy / FTS / semantic search on `label_query`.** MVP uses `LOWER(label) LIKE '%q%'` substring matching only. The forward-compatible upgrade path (FTS5 trigram → spellfix1 → embeddings) does not change the tool surface — only the storage backend behind `label_query` evolves.
- **Scene library export / import.**
- **Backend Python port of the evaluator.** TS frontend only.
- **Industry-standard format interop** (GDTF, MVR, external scene/show files). The MVP catalog ships only the two primitives needed for the rotating-head goal. Adopting industry standards happens at adjacent layers — see design's Future Considerations: GDTF → `light_show__fixture_profiles`; MVR → one-time `import_mvr` backend op; external scene formats → import adapters that translate to our primitives, with `dmx_playback` as the escape-hatch primitive for raw-bits "play this exact look" cases. None of these change the scene editor's data model or evaluator.

---

## Open Questions

None — all design decisions locked in clarification-14. Carry forward:

- If phase-2 multi-layer composition becomes the chosen crossfade path, the `light_show__scene_placements` schema may need a `layer_id` column. Left as a future migration concern.
- If MVR import lands (broader M17 roadmap), per-project scene library export shape will likely align with MVR scene/cue conventions.

---

## Related Artifacts

- **Design**: [agent/design/local.light-show-scene-editor.md](../design/local.light-show-scene-editor.md)
- **Clarification**: [agent/clarifications/clarification-14-light-show-scene-editor-mvp.md](../clarifications/clarification-14-light-show-scene-editor-mvp.md)
- **Broader M17 design**: [agent/design/local.track-contribution-point-and-light-show-plugin.md](../design/local.track-contribution-point-and-light-show-plugin.md)
- **M17 milestone**: [agent/milestones/milestone-17-track-contribution-point-and-light-show-plugin.md](../milestones/milestone-17-track-contribution-point-and-light-show-plugin.md)
- **Existing light_show code** (MVP basis):
  - `scenecraft-engine/src/scenecraft/plugins/light_show/{__init__.py,plugin.yaml,routes.py}`
  - `scenecraft-engine/src/scenecraft/db.py` (light_show__fixtures / __overrides / __screens schemas)
  - `scenecraft/src/plugins/light_show/{LightShow3DPanel.tsx,audio-scenes.ts,scenes.ts,scene-types.ts,light-show-client.ts,Screen.tsx}`
