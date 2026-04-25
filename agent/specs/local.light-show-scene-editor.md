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
- Ten REST endpoints under `/api/projects/:name/plugins/light_show/` (scenes, placements, live, primitives — GET/PUT/POST variants)
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

- **R1.** `light_show__scenes` table MUST exist after schema migration with columns: `id TEXT PRIMARY KEY`, `label TEXT NOT NULL`, `type TEXT NOT NULL`, `params_json TEXT NOT NULL`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`.
- **R2.** `light_show__scene_placements` table MUST exist with columns: `id TEXT PRIMARY KEY`, `scene_id TEXT NOT NULL REFERENCES light_show__scenes(id)`, `start_time REAL NOT NULL`, `end_time REAL NOT NULL`, `display_order INTEGER NOT NULL DEFAULT 0`, `fade_in_sec REAL NOT NULL DEFAULT 0`, `fade_out_sec REAL NOT NULL DEFAULT 0`, `created_at`, `updated_at`. An index on `(start_time, end_time)` MUST exist.
- **R3.** `light_show__live_override` table MUST exist with columns: `id TEXT PRIMARY KEY CHECK (id = 'current')`, `scene_id TEXT REFERENCES light_show__scenes(id)`, `inline_type TEXT`, `inline_params_json TEXT`, `label TEXT NOT NULL`, `fade_in_sec REAL NOT NULL DEFAULT 0`, `fade_out_sec REAL NOT NULL DEFAULT 0`, `activated_at TEXT NOT NULL`, `deactivation_started_at TEXT`. A CHECK constraint MUST enforce exactly one of (`scene_id` set) OR (`inline_type` AND `inline_params_json` both set).

### `scenes` MCP tool

- **R4.** `scenes.list_primitives` MUST return the parsed contents of `primitives_catalog.yaml` (YAML → JSON via `yaml.safe_load`) wrapped as `{primitives: [...]}` over the wire. The structural content of the response MUST be byte-for-byte equivalent to the parsed YAML — no field reordering, omission, or transformation.
- **R5.** `scenes.list` MUST return all scenes as `{scenes: [{id, label, type, params, created_at, updated_at}]}` with `params` deserialized from `params_json`.
- **R6.** `scenes.set` MUST accept `{scenes: [...]}` and upsert by `id` with partial-state semantics: for existing ids, omitted fields preserve current values; for new ids, a new row is inserted with the provided fields, using primitive catalog defaults for any unspecified `params`.
- **R7.** `scenes.set` MUST reject entries missing `id`, returning `{error: "upsert_light_show_scenes: each scene must have an id"}`.
- **R8.** `scenes.set` MUST reject entries with unknown `type` values (not present in the catalog), returning `{error: "unknown primitive type: <type>"}`.
- **R9.** `scenes.remove` MUST accept `{ids: [...]}` and reject deletion of any scene currently referenced by one or more placements, returning `{error: "scene(s) still referenced", blocked: [{scene_id, placement_ids}, ...]}` and performing NO deletions when any are blocked (atomic all-or-nothing).
- **R10.** `scenes.remove` MUST reject deletion of a scene currently held by the live override, returning `{error: "scene held by live override; deactivate first", blocked_by_live: scene_id}` and performing NO deletions when blocked.
- **R11.** `scenes` MUST reject unknown actions with `{error: "unknown action <action>; expected one of list/list_primitives/set/remove"}`.

### `scene_timeline` MCP tool

- **R12.** `scene_timeline.list` MUST return all placements as `{placements: [{id, scene_id, start_time, end_time, display_order, fade_in_sec, fade_out_sec, created_at, updated_at}]}` ordered by `start_time` ascending.
- **R13.** `scene_timeline.set` MUST accept `{placements: [...]}` and bulk upsert. Entries without `id` MUST be inserted with an auto-generated UUID (backend-assigned). Entries with an existing `id` MUST merge the provided fields.
- **R14.** `scene_timeline.set` MUST reject entries where `end_time <= start_time`, returning `{error: "placement end_time must be greater than start_time"}` and performing NO writes when any entry is invalid (atomic all-or-nothing).
- **R15.** `scene_timeline.set` MUST reject entries with `scene_id` not present in `light_show__scenes`, returning `{error: "unknown scene_id: <id>"}` and performing NO writes (atomic).
- **R16.** `scene_timeline.remove` MUST accept `{ids: [...]}`, delete matching placements, and silently ignore missing ids. Returns the remaining placements.
- **R17.** `scene_timeline` MUST reject unknown actions with `{error: "unknown action <action>; expected one of list/set/remove"}`.

### `scene_live` MCP tool

- **R18.** `scene_live.activate` MUST accept EITHER `scene_id: string` (library scene reference) OR `scene: {type, params}` (inline), never both; rejecting calls that specify both with `{error: "provide scene_id OR scene, not both"}`.
- **R19.** `scene_live.activate` with `scene_id` MUST reject if the scene_id does not exist, with `{error: "unknown scene_id: <id>"}`.
- **R20.** `scene_live.activate` with inline `scene` MUST reject if `scene.type` is not in the primitive catalog, with `{error: "unknown primitive type: <type>"}`.
- **R21.** `scene_live.activate` MUST replace any existing live override silently (no error when one is already active). The previous override row is overwritten.
- **R22.** `scene_live.activate` MUST accept optional `fade_in_sec` (default 0), `label` (default: scene's label or `"directive"` for inline), and `save_as: string` (inline only — when present, also inserts the inline scene into `light_show__scenes` with id = `save_as`).
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

- **R30.** All MCP tool behaviors (R4-R27) MUST be independently reachable via REST endpoints at `/api/projects/:name/plugins/light_show/{scenes|placements|live|primitives}`. See Interfaces section for exact paths and methods.

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

- **R39.** When `liveOverride` is set, the evaluator MUST resolve the scene (from `scene_id` lookup or inline fields), compute `sceneTime = (wallClock_ms - activated_at_ms) / 1000`, call the corresponding `PRIMITIVE_REGISTRY[type](sceneTime, states, params, context)`, apply fade envelopes, and return `{activeLayer: 'live', label}`.
- **R40.** When no live override is set but one or more placements have `start_time <= playheadTime <= end_time`, the evaluator MUST pick the one with the highest `display_order` (ties broken by `created_at` ascending), compute `sceneTime = playheadTime - start_time`, apply the primitive, apply placement fade envelopes, and return `{activeLayer: 'timeline', label}`.
- **R41.** When neither live override nor placement is active, the evaluator MUST delegate to `fallbackScene.apply(playheadTime, states, context)` if provided, returning `{activeLayer: 'fallback', label}`, else return `{activeLayer: 'none'}`.
- **R42.** Fade envelopes MUST multiply the final `state.intensity` only. `state.color`, `state.pan`, and `state.tilt` MUST pass through without modification by the fade.
- **R43.** Placement fade-in envelope: for `sceneTime` in `[0, fade_in_sec)`, intensity is multiplied by `sceneTime / fade_in_sec`. At `sceneTime >= fade_in_sec`, multiplier is 1.
- **R44.** Placement fade-out envelope: let `timeToEnd = end_time - playheadTime`. For `timeToEnd` in `[0, fade_out_sec)`, intensity is multiplied by `timeToEnd / fade_out_sec`. At `timeToEnd >= fade_out_sec`, multiplier is 1.
- **R45.** When both fade-in and fade-out windows overlap (placement shorter than `fade_in_sec + fade_out_sec`), the multipliers compose (multiply). Minimum intensity multiplier is 0.
- **R46.** Live override fade-in envelope uses wall clock: for `(wallClock - activated_at)` in `[0, fade_in_sec)`, intensity multiplied by `(wallClock - activated_at) / fade_in_sec`.
- **R47.** Live override fade-out: when `deactivation_started_at` is set, for `(wallClock - deactivation_started_at)` in `[0, fade_out_sec)`, intensity multiplied by `1 - (wallClock - deactivation_started_at) / fade_out_sec`. When `>= fade_out_sec`, the evaluator MUST physically delete the override row (via REST POST `/live/deactivate?commit=true` or directly via the DB helper) and return as if no override was present.
- **R48.** Placement lookup MUST be deterministic given the same `playheadTime` and placement set: repeated evaluator calls at the same `playheadTime` return the same result.

### Frontend panel integration

- **R49.** `LightShow3DPanel` MUST fetch scenes, placements, and live override on mount; poll every `POLL_INTERVAL_MS` (2000ms); AND subscribe to `light_show__changed` events filtering on `kind: 'scenes' | 'placements' | 'live'` for instant refresh.
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

| Method | Path | Request body | Response body |
|---|---|---|---|
| GET | `/api/projects/:name/plugins/light_show/primitives` | — | `{primitives: [...]}` (parsed YAML catalog, returned as JSON body) |
| GET | `/api/projects/:name/plugins/light_show/scenes` | — | `{scenes: [...]}` |
| PUT | `/api/projects/:name/plugins/light_show/scenes` | `{scenes: [...]}` | `{scenes: [...]}` |
| POST | `/api/projects/:name/plugins/light_show/scenes/remove` | `{ids: [...]}` | `{scenes: [...]}` or `{error, blocked?}` |
| GET | `/api/projects/:name/plugins/light_show/placements` | — | `{placements: [...]}` |
| PUT | `/api/projects/:name/plugins/light_show/placements` | `{placements: [...]}` | `{placements: [...]}` or `{error}` |
| POST | `/api/projects/:name/plugins/light_show/placements/remove` | `{ids: [...]}` | `{placements: [...]}` |
| GET | `/api/projects/:name/plugins/light_show/live` | — | `{active: bool, ...}` |
| POST | `/api/projects/:name/plugins/light_show/live/activate` | `{scene_id?, scene?, fade_in_sec?, label?, save_as?}` | `{active: true, ...}` or `{error}` |
| POST | `/api/projects/:name/plugins/light_show/live/deactivate` | `{fade_out_sec?}` | `{active: false}` |

### MCP tool input schemas (plugin.yaml)

```yaml
- id: scenes
  description: |
    Scene library CRUD + primitive catalog discovery. Actions:
      - "list": return the current scene library.
      - "list_primitives": return the primitive catalog (JSON-schema per primitive).
      - "set": bulk partial upsert by id.
      - "remove": delete scenes by id (rejects if referenced by placements or live override).
  handler: "backend:tools_scenes"
  input_schema:
    type: object
    required: [action]
    properties:
      action: { type: string, enum: [list, list_primitives, set, remove] }
      scenes:
        type: array
        items:
          type: object
          required: [id]
          properties:
            id:     { type: string }
            label:  { type: string }
            type:   { type: string }
            params: { type: object }
      ids:
        type: array
        items: { type: string }

- id: scene_timeline
  description: |
    Timeline placement CRUD. Actions:
      - "list": return all placements ordered by start_time.
      - "set": bulk partial upsert (missing id → new UUID).
      - "remove": delete by ids.
  handler: "backend:tools_scene_timeline"
  input_schema:
    type: object
    required: [action]
    properties:
      action: { type: string, enum: [list, set, remove] }
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
      ids:
        type: array
        items: { type: string }

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
2. Chat invokes `scenes.set({scenes: [{id: "rh_slow", label: "Slow Rotating Head", type: "rotating_head", params: {period_sec: 6, pan_amplitude_rad: 0.5}}]})` → scene persisted with merged defaults
3. Chat invokes `scene_timeline.set({placements: [{scene_id: "rh_slow", start_time: 5, end_time: 15, fade_in_sec: 1, fade_out_sec: 2}]})` → placement inserted with auto-UUID
4. User presses play on main timeline → playhead advances 0 → 15 → 20s
5. During 0 → 5s: fallback scene runs (dropdown-selected scene or existing default)
6. At t=5s: placement becomes active; rotating_head primitive renders with `sceneTime=0`, fade-in begins
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
2. Chat agent invokes `scene_live.activate({scene: {type: "static_color", params: {color: [1, 0, 0]}}, label: "Red Wash"})` — no `save_as` passed; scene is ephemeral
3. Override row created with `scene_id=NULL, inline_type="static_color", inline_params_json='{"color":[1,0,0]}'`
4. User likes it; says "save this as 'emergency red'"
5. Chat invokes `scenes.set({scenes: [{id: "emergency_red", label: "Emergency Red", type: "static_color", params: {color: [1, 0, 0]}}]})` → library entry created
6. On subsequent chat session, user says "fire emergency red" → `scene_live.activate({scene_id: "emergency_red"})`

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

#### Test: scenes-set-creates-new (covers R5, R6)

**Given**: Empty `light_show__scenes` table.

**When**: Chat calls `tools_scenes({action: "set", scenes: [{id: "rh_slow", label: "Slow Rotating Head", type: "rotating_head", params: {period_sec: 6}}]}, ctx)`.

**Then** (assertions):
- **row-inserted**: subsequent `list` call returns one scene with `id: "rh_slow"`.
- **label-persisted**: returned scene has `label: "Slow Rotating Head"`.
- **params-merged-with-defaults**: returned `params` includes `period_sec: 6` AND all other rotating_head defaults (e.g., `pan_amplitude_rad: π/4`).
- **created-at-set**: `created_at` field is a valid ISO8601 timestamp within last 5 seconds.
- **ws-broadcast-scenes**: a `light_show__changed` event with `kind: "scenes"` was broadcast.

#### Test: scenes-set-partial-update-preserves-omitted (covers R6)

**Given**: A scene exists with `id="rh_slow", label="Slow", params={period_sec: 6, pan_amplitude_rad: 0.5}`.

**When**: Chat calls `tools_scenes({action: "set", scenes: [{id: "rh_slow", params: {period_sec: 8}}]}, ctx)`.

**Then** (assertions):
- **period-updated**: returned `params.period_sec == 8`.
- **amplitude-preserved**: returned `params.pan_amplitude_rad == 0.5`.
- **label-preserved**: returned `label == "Slow"`.
- **updated-at-advances**: `updated_at` timestamp is newer than prior value.
- **no-new-row-inserted**: count of scenes is still 1.

#### Test: scenes-set-rejects-missing-id (covers R7)

**Given**: Any state.

**When**: Chat calls `tools_scenes({action: "set", scenes: [{label: "No ID"}]}, ctx)`.

**Then** (assertions):
- **error-returned**: response has `error` key matching `/must have an id/i`.
- **no-rows-inserted**: scenes table row count is unchanged.
- **no-ws-broadcast**: no `light_show__changed` event fired.

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

**Given**: Any state; chat calls a `set` that is rejected (missing id, bad end_time, unknown scene_id).

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
- **Global scene library / cross-project sharing.** Per-project only.
- **Scene library export / import.**
- **Backend Python port of the evaluator.** TS frontend only.

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
