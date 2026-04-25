# Light Show Scene Editor

**Concept**: Pre-programmed scene authoring for the `light_show` plugin — a three-tier data model (scenes / placements / live override) plus an extensible primitive catalog, layered precedence evaluator, and three action-dispatched MCP tools. Goal is compositing animated light scenes onto the main timeline and triggering them live via chat.
**Created**: 2026-04-24
**Status**: Design Specification

---

## Overview

The `light_show` plugin today ships rig fixtures (`light_show__fixtures`), screens (`light_show__screens`), per-fixture channel overrides (`light_show__overrides`), and a 3D preview with hardcoded scenes (`rainbow_chase`, `panSweep`, audio-reactive beat_* scenes). What's missing — and what this design addresses — is a way for chat to **author scenes, place them on the timeline, and trigger them live**, so that pre-programmed animations like a rotating moving-head sweep can be composited onto the main scenecraft playhead.

This design delivers three intertwined pieces:

1. **Three-tier data model** — reusable scene library, time-bound placements on the main timeline, and a single-slot live override for chat-triggered cues / directives.
2. **Primitive catalog** — parameterized animation shapes (code) keyed by `type`. MVP ships `rotating_head` and `static_color`; the catalog is extensible and self-describing via `scenes.list_primitives`.
3. **MCP tool suite** — three action-dispatched tools (`scenes`, `scene_timeline`, `scene_live`) that let chat author, schedule, and trigger scenes live.

Together, this gives scenecraft a functioning light-show authoring layer driven entirely from chat, with a deterministic playhead-to-fixture evaluation path that's easy to reason about and extend.

See [clarification-14](../clarifications/clarification-14-light-show-scene-editor-mvp.md) for the decision record.

---

## Problem Statement

- **No way to author scenes from chat.** The MVP rig editor (`light_show.set_rig_layout`, etc.) lets chat position fixtures, but there is no tool surface for "create a scene named X that does Y" or "play scene X from t=5 to t=10". Scenes are hardcoded TS functions the user picks from a dropdown.
- **No way to composite scenes onto the timeline.** Even if scenes existed as data, there's no binding between scenes and the main scenecraft playhead. A pre-programmed animation cannot advance as the timeline plays.
- **No live-trigger / cue surface.** Operating a show interactively ("flash red now", "switch to rotating head until I say otherwise") requires a runtime override that overrides the scheduled timeline until explicitly cleared. Today's `set_fixture_state` overrides are per-channel per-fixture, not whole-scene.
- **No primitive catalog.** Adding a new animation shape today requires editing the frontend scenes.ts. There's no way for chat to discover "what scene types are available and what params do they take?" — so all authoring would be guesswork.

Consequences of not solving this:
- The light_show plugin stays demo-quality — fixtures + 3D preview with canned scenes, no real authoring workflow.
- "Test a rotating head animation" (the immediate goal) requires writing a new TS scene, recompiling, picking from dropdown — not the chat-driven workflow scenecraft targets.
- The broader M17 "track contribution point + full scene DSL" plan has no intermediate deliverable to validate the data model and tool surface before committing to the full DSL implementation.

---

## Solution

### Part 1: Three-tier data model

**Scene library** (`light_show__scenes`): reusable primitive instances.

```sql
CREATE TABLE light_show__scenes (
  id             TEXT PRIMARY KEY,            -- server-generated UUID (chat cannot supply on create)
  label          TEXT NOT NULL,               -- human-readable, free-form, no uniqueness constraint
  type           TEXT NOT NULL,               -- keys primitive catalog (e.g. "rotating_head")
  params_json    TEXT NOT NULL,               -- sparse JSON: ONLY explicit param overrides (catalog defaults merged at evaluator time)
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

A scene is pure data: `{type, params}`. Animation flexibility equals what its primitive supports.

**Param storage is sparse with null-delete semantics (RFC 7396 JSON Merge Patch):**

- `params_json` stores ONLY keys explicitly set by the user. Catalog defaults are NOT written into the row at insert time — they're merged at evaluator time.
- Updates via `scenes.set` follow merge-patch:
  - `params: {key: value}` → set that key
  - `params: {key: null}` → DELETE that key from stored params (revert to whatever the catalog default supplies at evaluator time)
  - `params: {key: undefined}` (key absent) → preserve existing value
  - `params: {}` → preserve all params as-is
  - `params: null` → rejected (use `{}` to preserve or `{key: null}` to delete)
- Top-level fields (`label`, `type`) are NOT NULL columns; null on those is rejected.

**Why sparse storage**: `list` → modify → `set` round-trips don't accidentally promote defaults to explicit overrides. Future catalog default updates flow forward to existing scenes that didn't explicitly override the changed key. The evaluator merges sparse stored params with catalog defaults transiently — the merge is never written back.

**`scenes.list` returns sparse params** — the `params` field on each row contains only the user's overrides. Chat can fetch the catalog separately via `scenes.list_primitives` and merge client-side if it needs to display the resolved values. This keeps the merge logic in one place (the evaluator) and prevents accidental write-amplification through fetch-modify-write loops.

**Timeline placements** (`light_show__scene_placements`): time-bound activations on the main scenecraft timeline.

```sql
CREATE TABLE light_show__scene_placements (
  id              TEXT PRIMARY KEY,           -- auto-UUID (backend-generated)
  scene_id        TEXT NOT NULL REFERENCES light_show__scenes(id),
  start_time      REAL NOT NULL,              -- seconds on main timeline
  end_time        REAL NOT NULL,              -- seconds; end > start enforced
  display_order   INTEGER NOT NULL DEFAULT 0, -- overlap winner: highest wins per fixture
  fade_in_sec     REAL NOT NULL DEFAULT 0,
  fade_out_sec    REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_light_show_scene_placements_time
  ON light_show__scene_placements(start_time, end_time);
```

Placements are the "pre-programmed" layer: "play scene labeled 'Slow Rotating Head' (id `<uuid>`) from 5 to 15 seconds with a 1s fade in and 2s fade out". They reference library scenes by id; inline placements are not supported (two calls: `scenes.set` to create then `scene_timeline.set` to place).

**Live override** (`light_show__live_override`): single-slot state for chat-triggered cues and manual directives.

```sql
CREATE TABLE light_show__live_override (
  id                       TEXT PRIMARY KEY CHECK (id = 'current'),  -- exactly one row
  scene_id                 TEXT REFERENCES light_show__scenes(id),   -- NULL if inline
  inline_type              TEXT,                                      -- NULL if scene_id set
  inline_params_json       TEXT,                                      -- NULL if scene_id set
  label                    TEXT NOT NULL,
  fade_in_sec              REAL NOT NULL DEFAULT 0,
  fade_out_sec             REAL NOT NULL DEFAULT 0,
  activated_at             TEXT NOT NULL,
  deactivation_started_at  TEXT,                                      -- set when deactivate() called; row removed after fade-out completes
  CHECK (
    (scene_id IS NOT NULL AND inline_type IS NULL AND inline_params_json IS NULL)
    OR
    (scene_id IS NULL AND inline_type IS NOT NULL AND inline_params_json IS NOT NULL)
  )
);
```

Persists across engine restart (matches "DMX persists to backend" project memory). When present, overrides the timeline entirely until explicitly deactivated.

### Part 2: Primitive catalog

Primitives are TS functions keyed by `type`. The **shared source of truth** is `scenecraft-engine/src/scenecraft/plugins/light_show/primitives_catalog.yaml` — read by the backend for `scenes.list_primitives` MCP responses and read at frontend build time (or runtime via REST `/primitives`) as the schema reference. YAML is preferred per project convention for static config / catalogs that ship with code. Ships with two primitives:

**`rotating_head`** — pan/tilt sinusoidal sweep with hold color + intensity.

| Param | Type | Default | Description |
|---|---|---|---|
| `role` | string | `"moving_head"` | Fixture role filter; undefined = all fixtures |
| `period_sec` | number | `4.0` | Seconds per full pan cycle |
| `pan_amplitude_rad` | number | `π/4` (≈0.785) | ±radians from center |
| `tilt_center_rad` | number | `-0.3` | Base tilt angle; negative = downward at stage |
| `tilt_amplitude_rad` | number | `0.2` | ±radians tilt oscillation |
| `tilt_period_sec` | number | `4.0` | Tilt cycle; different from `period_sec` gives figure-8 patterns |
| `intensity` | number | `1.0` | 0..1 |
| `color` | [number, number, number] | `[1, 1, 1]` | RGB 0..1 |

**`static_color`** — hold a color + intensity.

| Param | Type | Default | Description |
|---|---|---|---|
| `role` | string | undefined (all fixtures) | |
| `intensity` | number | `1.0` | |
| `color` | [number, number, number] | `[1, 1, 1]` | RGB 0..1 |

Each primitive's `apply()` function receives `(sceneTime, states, params, context)` and mutates `states` in place. `context` carries playhead, beats, and live master-bus energy (`masterLevel`, `masterLowLevel`) — primitives can read these directly for audio reactivity without any matrix infrastructure.

### Part 3: Layered precedence evaluator

Per frame, the scene runner resolves which scene (if any) drives fixture output, in this order:

1. **Live override wins** — if `light_show__live_override` has a row, its scene is applied. `sceneTime = now - activated_at`. Fade-in uses wall clock; fade-out begins when `deactivation_started_at` is set and runs `fade_out_sec`, after which the row is deleted.
2. **Timeline placement wins** — if any placement has `start_time <= playhead <= end_time`, the one with highest `display_order` (ties broken by `created_at`) is applied. `sceneTime = playhead - start_time` (deterministic — scrubbing shows the primitive at its exact scene-local time). Fade-in/out envelopes are a deterministic function of `sceneTime` vs. `(fade_in_sec, end_time - fade_out_sec)`.
3. **Fallback** — existing behavior: dropdown-picked scene (`rainbow_chase`, `beat_strobe`, etc.) runs as before. The master-bus audio-reactive path is preserved.

Fade envelopes multiply the **final intensity** only (per Q 3.1) — color, pan, and tilt pass through at scene-computed values.

### Part 4: Three action-dispatched MCP tools

**`scenes`** — library CRUD + catalog discovery + filtered/paginated list.

| Action | Args | Behavior |
|---|---|---|
| `list` | `filter?: {ids?, type?, label_query?}, limit? (default 50, max 500), offset?, order_by? (default "updated_at"), order? (default "desc")` | Returns `{scenes, total, has_more}` after filtering and paginating. Substring matching (`label_query`) is `LOWER(label) LIKE '%q%'` at MVP — forward-compatible upgrade path to FTS5 trigram in a later phase. |
| `list_primitives` | — | Returns parsed `primitives_catalog.yaml`: `{primitives: [{id, label, description, params_schema}]}`. |
| `set` | `scenes: [{id, label?, type?, params?}, ...]` | Bulk partial upsert by id. Unknown ids create new scenes. Omitted fields preserve existing values. **Returns only the upserted rows**, not the full library. |
| `remove` | `ids: [...]` | Delete by id. **Rejects** if any target has placements or is held by the live override; returns list of blocking references. **Returns only deleted rows on success** (pre-deletion state); missing ids silently skipped. |

**`scene_timeline`** — placements CRUD with filter/pagination.

| Action | Args | Behavior |
|---|---|---|
| `list` | `filter?: {ids?, scene_id?, time_range?: {start, end}}, limit? (default 100, max 1000), offset?, order_by? (default "start_time"), order? (default "asc")` | Returns `{placements, total, has_more}`. `time_range` filter returns placements whose `[start_time, end_time]` overlaps the window. |
| `set` | `placements: [{id?, scene_id, start_time, end_time, display_order?, fade_in_sec?, fade_out_sec?}, ...]` | Bulk partial upsert. Missing `id` → insert (auto-UUID). Existing `id` → merge fields. **Returns only upserted rows** (auto-generated ids included). |
| `remove` | `ids: [...]` | Delete by id. **Returns only deleted rows** (pre-deletion state); missing ids silently skipped. |

**`scene_live`** — single-slot live override.

| Action | Args | Behavior |
|---|---|---|
| `activate` | `scene_id: string` OR `scene: {type, params}` + `save_as?: string` + `fade_in_sec?: number` + `label?: string` | Activates a live override. If called while one is already active, replaces silently. Inline scene is ephemeral by default — pass `save_as: "label"` to also persist it to the library. |
| `deactivate` | `fade_out_sec?: number` | Begins fade-out; row is removed after fade completes. `fade_out_sec=0` is an instant cut. |
| `status` | — | Returns `{active: bool, scene_id?, label?, activated_at?, fade_in_sec?, fade_out_sec?, deactivation_started_at?}` for UI display. |

### Part 5: REST endpoints + WS broadcasts

Conventional REST (resource-based paths, standard HTTP verbs, query-param filters on list endpoints). Existing fixtures/overrides/screens endpoints predate this convention and stay in their current shape; new resources follow REST proper. The MCP tools call plugin_api / DB helpers directly (not REST), so the REST surface is for browser / external HTTP clients only.

```
# Catalog (read-only)
GET    /api/projects/:name/plugins/light_show/primitives          # parsed YAML catalog as JSON

# Scenes (collection + item)
GET    /api/projects/:name/plugins/light_show/scenes              # ?type=&label_query=&ids=&limit=&offset=&order_by=&order=
POST   /api/projects/:name/plugins/light_show/scenes              # body: {label, type, params?} (no id; server assigns UUID)
GET    /api/projects/:name/plugins/light_show/scenes/:id          # one by id
PATCH  /api/projects/:name/plugins/light_show/scenes/:id          # RFC 7396 merge-patch on params (null deletes per-key)
DELETE /api/projects/:name/plugins/light_show/scenes/:id          # 409 if blocked by placements / live override

# Placements (collection + item)
GET    /api/projects/:name/plugins/light_show/placements          # ?scene_id=&time_start=&time_end=&ids=&limit=&offset=&...
POST   /api/projects/:name/plugins/light_show/placements          # body: {scene_id, start_time, end_time, ...}; server assigns UUID
GET    /api/projects/:name/plugins/light_show/placements/:id
PATCH  /api/projects/:name/plugins/light_show/placements/:id
DELETE /api/projects/:name/plugins/light_show/placements/:id

# Live override (singleton resource)
GET    /api/projects/:name/plugins/light_show/live                # current state ({active: bool, ...})
PUT    /api/projects/:name/plugins/light_show/live                # activate (replaces if active); body has scene_id | scene + save_as
DELETE /api/projects/:name/plugins/light_show/live                # deactivate; ?fade_out_sec=N optional
```

Bulk operations are not a REST concern — the MCP tools handle bulk via direct DB-helper calls in a single transaction. External clients that want bulk semantics issue parallel single-resource calls.

WS broadcasts expand the existing `light_show__changed` event's `kind` field:

- Before: `"fixtures" | "overrides" | "screens"`
- After: `"fixtures" | "overrides" | "screens" | "scenes" | "placements" | "live"`

Frontend keeps one subscription and filters on `kind`.

---

## Implementation

### File layout

**Backend** (`scenecraft-engine/`):

- `src/scenecraft/db.py`
  - New tables: `light_show__scenes`, `light_show__scene_placements`, `light_show__live_override` in `_ensure_schema`
  - New helpers: `list/upsert/remove_light_show_scenes`, `list/upsert/remove_light_show_placements`, `get/activate/deactivate_light_show_live_override`
- `src/scenecraft/plugin_api.py`
  - Re-export the 9 new helpers + update `__all__`
- `src/scenecraft/plugins/light_show/primitives_catalog.yaml` **(new)**
  - Shared catalog: primitive id, label, description, param JSON-schema
- `src/scenecraft/plugins/light_show/routes.py`
  - Add REST handlers for `/scenes`, `/placements`, `/live`, `/primitives`
- `src/scenecraft/plugins/light_show/__init__.py`
  - Add `tools_scenes`, `tools_scene_timeline`, `tools_scene_live` dispatchers
  - Each dispatches on `args["action"]` to sub-handlers
- `src/scenecraft/plugins/light_show/plugin.yaml`
  - Declare 3 new tools with action enums + input schemas

**Frontend** (`scenecraft/`):

- `src/plugins/light_show/light-show-client.ts`
  - Types: `SceneRow`, `SceneUpsert`, `PlacementRow`, `PlacementUpsert`, `LiveOverrideRow`, `PrimitiveCatalogEntry`
  - Fetchers: `fetchScenes/upsertScenes/removeScenes`, `fetchPlacements/upsertPlacements/removePlacements`, `fetchLiveOverride/activateLive/deactivateLive`, `fetchPrimitivesCatalog`
- `src/plugins/light_show/primitives.ts` **(new)**
  - `applyRotatingHead(sceneTime, states, params, context)`
  - `applyStaticColor(sceneTime, states, params, context)`
  - `PRIMITIVE_REGISTRY: Record<string, PrimitiveApplyFn>`
- `src/plugins/light_show/scene-evaluator.ts` **(new)**
  - `evaluateLayeredScene(playheadTime, wallClock, scenes, placements, liveOverride, states, context)`
  - Precedence resolution, scene-local time computation, fade envelope application
- `src/plugins/light_show/LightShow3DPanel.tsx`
  - Fetch scenes / placements / live on mount; poll + WS subscription
  - Replace `SceneRunner` body with `evaluateLayeredScene` call
  - Diagnostic bar shows active layer: `LIVE: rh_slow`, `TIMELINE: rh_slow`, or `FALLBACK: rainbow_chase`

### Primitive implementation sketch

```ts
export function applyRotatingHead(
  t: number,
  states: FixtureState[],
  params: RotatingHeadParams,
  _ctx: SceneContext,
): void {
  const roleFilter = params.role // undefined = all fixtures
  const panPhase = (t / params.period_sec) * 2 * Math.PI
  const tiltPhase = (t / params.tilt_period_sec) * 2 * Math.PI
  for (const s of states) {
    if (roleFilter !== undefined && s.role !== roleFilter) continue
    s.intensity = params.intensity
    s.color = [...params.color]
    s.pan = Math.sin(panPhase) * params.pan_amplitude_rad
    s.tilt = params.tilt_center_rad + Math.sin(tiltPhase) * params.tilt_amplitude_rad
  }
}
```

### Evaluator sketch

```ts
export function evaluateLayeredScene(args: {
  playheadTime: number
  wallClock: number
  placements: PlacementRow[]
  scenesById: Map<string, SceneRow>
  liveOverride: LiveOverrideRow | null
  fallbackScene: SceneDef | null
  states: FixtureState[]
  context: SceneContext
}): { activeLayer: 'live' | 'timeline' | 'fallback' | 'none'; label?: string } {
  // 1. Live override
  if (args.liveOverride) {
    const sceneTime = (args.wallClock - parseISO(args.liveOverride.activated_at)) / 1000
    const scene = resolveLiveOverrideScene(args.liveOverride, args.scenesById)
    const apply = PRIMITIVE_REGISTRY[scene.type]
    apply(sceneTime, args.states, scene.params, args.context)
    applyFadeEnvelope(args.states, sceneTime, args.liveOverride)
    return { activeLayer: 'live', label: args.liveOverride.label }
  }
  // 2. Timeline placement
  const active = args.placements
    .filter(p => p.start_time <= args.playheadTime && args.playheadTime <= p.end_time)
    .sort((a, b) => b.display_order - a.display_order || a.created_at.localeCompare(b.created_at))
  if (active.length > 0) {
    const p = active[0]
    const scene = args.scenesById.get(p.scene_id)
    if (scene) {
      const sceneTime = args.playheadTime - p.start_time
      const apply = PRIMITIVE_REGISTRY[scene.type]
      apply(sceneTime, args.states, JSON.parse(scene.params_json), args.context)
      applyPlacementFadeEnvelope(args.states, sceneTime, p)
      return { activeLayer: 'timeline', label: scene.label }
    }
  }
  // 3. Fallback
  if (args.fallbackScene) {
    args.fallbackScene.apply(args.playheadTime, args.states, args.context)
    return { activeLayer: 'fallback', label: args.fallbackScene.label }
  }
  return { activeLayer: 'none' }
}
```

---

## Benefits

- **Chat-first authoring works end-to-end.** `scenes.set` → `scene_timeline.set` → play timeline → rotating head animates in the 3D preview. No code changes, no redeploy.
- **Precedence is trivially debuggable.** Three layers, deterministic pick, mode label in the diag bar. You can always tell which layer is driving output.
- **Extensible without DSL debt.** Adding a new primitive = one entry in `primitives_catalog.yaml` + one TS function in `primitives.ts`. No parser, no grammar.
- **Pre-programmed + live-triggered unified.** Same scene library serves both timeline placements and live cues. Chat can build up a cue sheet (library scenes) and fire them live or pre-schedule them — same authoring, same mental model.
- **Audio reactivity still works.** `context.masterLevel` / `masterLowLevel` reach primitives as before. A rotating-head primitive can read low-band energy to modulate its speed without any matrix infrastructure.
- **Dogfoods the M17 plan.** This is a concrete deliverable on the M17 roadmap. Validates the data model before the full scene DSL / track contribution point work lands.

---

## Trade-offs

- **No multi-layer composition at MVP.** Overlapping placements resolve by highest `display_order` (single winner per fixture). True layering / HTP / additive mixing is deferred until a real need emerges. Mitigation: phase 2 multi-layer model is a clean addition when compositions become worth it.
- **No crossfade at MVP.** Back-to-back placements see a fade-down-then-fade-up with a dark moment. Overlapping placements have one winner (no blend). Three phase-2 paths documented (multi-layer, fade-overlap exception, explicit crossfade field). Mitigation: fade-in/out alone handles most aesthetic intent.
- **Primitive catalog is hand-coded, not DSL-driven.** Every new animation shape needs TS code. Mitigation: catalog entries are small (~30 LOC), and the "effect curves on params" phase-2 layer (modulation matrix, Item 7 of clarification-14) composes existing primitives instead of requiring new ones.
- **Live override is single-slot.** No priority stack. Activating while active replaces. Mitigation: matches user-confirmed mental model ("cues / scenes would need to be switched off explicitly") and keeps state trivial to reason about. Stack is straightforward to add later if a real need appears.
- **Scenes must be deleted after placements.** `scenes.remove` rejects when references exist. Slight ceremony but prevents accidental data loss. Mitigation: chat can do `scene_timeline.remove` first when this matters; dual-call is explicit about intent.
- **Playhead clock vs. wall clock split.** Placements use playhead-derived scene time (deterministic on scrub); live overrides use wall clock. Two mental models. Mitigation: documented clearly; evaluator handles the split internally.

---

## Dependencies

- **Existing frontend infra**: `LightShow3DPanel`, `SceneRunner`, `MasterBusSampler`, `Screen`, `subscribePluginEvent`, `audio-mixer-ref`.
- **Existing backend infra**: `plugin_api` (for `broadcast_event`, `register_rest_endpoint`), `PluginHost.register_declared` for MCP tool wiring.
- **Existing DB conventions**: per-project SQLite at `~/.scenecraft/projects/<name>/project.db`, `_ensure_schema` in `db.py`.
- **Scenecraft main timeline**: `useCurrentTime` + `usePlaybackState` contexts for playhead source.
- **No new npm deps.** Uses existing `three`, `@react-three/fiber`, JSON types.
- **No new Python deps.** Uses stdlib `json`, `uuid`, `datetime`.

---

## Testing Strategy

**Backend unit** (pytest):
- CRUD roundtrip for each table (list/insert/update/delete)
- Partial upsert semantics on `scenes.set` / `scene_timeline.set`
- Reference blocking: `scenes.remove` rejects when placements or live override reference the scene
- Live override CHECK constraint: exactly one of `scene_id` or `inline_*` set
- `list_primitives` returns catalog file verbatim

**Backend integration** (pytest):
- Three MCP tools dispatch correctly via action discriminator
- Invalid action returns error envelope
- WS broadcast fires on each mutation with correct `kind`

**Frontend unit** (vitest — install if not present per project memory):
- `applyRotatingHead` produces expected pan/tilt/intensity at known `sceneTime` values
- `applyStaticColor` respects role filter
- `evaluateLayeredScene` picks correct layer in each precedence case
- Fade envelope math at boundaries (`sceneTime=0`, `sceneTime=fade_in_sec`, etc.)

**Frontend E2E / manual**:
- Create rotating_head scene via `scenes.set`
- Place it 5-15s with `scene_timeline.set`
- Press play; verify rotating-head animation appears 5-15s, vanishes outside
- `scene_live.activate` mid-play; verify override takes over, placement stops rendering, diag bar shows "LIVE"
- `scene_live.deactivate`; verify fade-out (if fade_out_sec > 0) and timeline resumes
- Scrub mid-placement; verify deterministic scene-local time (no reset)

---

## Migration Path

This is additive — no existing behavior changes, no existing data to migrate.

1. **Phase 1 — Schema**: Add three tables to `_ensure_schema` in `db.py`. New projects pick them up automatically; existing projects get them on next DB open.
2. **Phase 2 — Backend helpers + REST + MCP tools**: Land all three tools behind their respective action dispatchers. Tools are inert if no scenes exist (which is the default state).
3. **Phase 3 — Frontend evaluator**: Wire `scene-evaluator.ts` into `SceneRunner`. While scenes/placements tables are empty and no live override is set, the existing dropdown-picked scene continues to run as today. Landing order-independent.
4. **Phase 4 — Manual test**: rotating-head animation authoring flow (create scene, place on timeline, play, scrub, live-trigger, deactivate).
5. **Phase 5 — Documentation / task-create**: Break into tasks per the DAG.

---

## Key Design Decisions

Sourced from [clarification-14](../clarifications/clarification-14-light-show-scene-editor-mvp.md).

### Live override behavior

| Decision | Choice | Rationale |
|---|---|---|
| Playhead while override active | Keeps advancing | Timeline is the clock; override just suppresses output. Preserves sync with audio and video preview. |
| Inline scene persistence | Ephemeral by default; opt-in `save_as` | Manual directives are exploratory; auto-persisting pollutes library. |
| Activate while active | Replaces silently | Matches "cue overrides whatever's playing"; avoids deactivate ceremony. |
| Persistence across engine restart | Preserved | Matches "DMX persists to backend" memory; restart shouldn't drop mid-show cue. |

### Placement semantics

| Decision | Choice | Rationale |
|---|---|---|
| Scene-local time | Deterministic from playhead | Scrubbing shows exact animation state; pure function of local clock. |
| Overlap resolution | Highest `display_order` wins per fixture | Simple; multi-layer composition deferred to phase 2. |
| Placement inline scene | Not supported | Placements are long-lived; inline belongs to ephemeral live overrides. |
| Delete scene with placements | Reject | Prevents accidental data loss; explicit two-step cleanup. |
| Delete scene held by live override | Reject | Mirrors placement rule; consistent safety. |

### Fade behavior

| Decision | Choice | Rationale |
|---|---|---|
| What channels fade | Intensity only | Pan/tilt have no natural zero state; color-from-black is rarely desired. |
| Live overrides have fades | Yes, optional `fade_in_sec` on activate / `fade_out_sec` on deactivate | Covers snap-on strobe and slow ambient fade-out. |
| Fade-out timing relative to `end_time` | Fade ends at `end_time` | Placement strictly bounded by `[start_time, end_time]`. |
| Crossfade | Deferred | Three phase-2 paths: multi-layer, fade-overlap exception, explicit crossfade field. |

### Role resolution

| Decision | Choice | Rationale |
|---|---|---|
| `role` param undefined | Applies to all fixtures | Simpler model; primitives silently ignore irrelevant channels. |

### Primitive defaults

| Decision | Choice | Rationale |
|---|---|---|
| `rotating_head` waveform | Pure sine | Simplest; `shape` param (triangle/saw/pulse) deferred. |
| Default `period_sec` | 4.0 | Slow, readable sweep. |
| Default `pan_amplitude_rad` | π/4 (~45°) | Wide enough to read, narrow enough to stay on-stage. |
| Default `tilt_center_rad` | -0.3 | Slight downward — aims at stage floor. |
| `static_color` role default | undefined (all fixtures) | Most common use case is stage-wide wash. |

### Catalog discovery, storage, tool surface

| Decision | Choice | Rationale |
|---|---|---|
| `list_primitives` return shape | Full JSON-schema per primitive | Chat introspects params without guessing; self-service LLM reference. |
| WS broadcast granularity | Expand existing `kind` field | Matches existing pattern; single subscription on frontend. |
| ID format | Auto-UUID for both scenes AND placements (server-assigned) | Supersedes clarification-14 Q 6.3. `label` carries the human name; `id` is a stable machine reference. Lets users freely rename scenes without breaking placement / live-override references. Removes redundancy between "id" and "label" fields. |
| `clear` action | Dropped | No real user story for "delete every scene simultaneously". |
| Partial upsert on `set` | Yes (RFC 7396 merge-patch) | Matches `screens` / `fixtures` pattern; null = delete on params keys. |
| Bulk `set` | Yes (arrays) | Consistent with existing tools. |
| `list` filter + pagination | Yes | Scene bank can grow large; default 50 sorted by `updated_at desc`. |
| `set` / `remove` return shape | Only affected rows | Avoid pulling full table back; matches large-bank scale. |
| Param storage shape | Sparse (only explicit overrides) | Round-trip safe; catalog default updates flow forward; merge happens at evaluator time only. |
| `null` semantics on `params` keys | Delete the key | Standard JSON Merge Patch; only realistic delete case is e.g. removing role filter to revert to "applies to all fixtures". |
| `params` returned on list | Sparse (not merged) | Prevents fetch-modify-write from promoting defaults to explicit overrides. |

---

## Future Considerations

Deferred per clarification-14:

- **Compositions / sequences** — pre-composed multi-primitive or multi-curve bundles with top-level pass-through params. Two likely implementations: bundle-of-placements (instantiated at offset time) OR new primitive type that sequences other primitives.
- **Effect curves on params (modulation matrix)** — params become `{static: 0.8}` OR `{source: "masterLow", mapper: {...}}`. Generic evaluator resolves at `t`. DaVinci-style chained node graphs as the UI layer on the same data model.
- **Crossfade** — multi-layer track model (most likely path), fade-overlap exception, or explicit `crossfade_sec` field.
- **Merge modes on overlapping placements** — HTP, additive, multiply, min.
- **Waveform `shape` param** on `rotating_head` (triangle / sawtooth / pulse).
- **More primitives** — `strobe`, `chase`, `fade`, `breathe`, `circle`, `figure_eight`, etc.
- **Search upgrade path** — `label_query` semantics start as `LOWER(label) LIKE '%q%'` (sufficient up to a few thousand scenes). Forward-compatible to:
  - **Phase 2: FTS5 with trigram tokenizer** — virtual table on `(id, label, type)`, BM25 ranking, sync triggers. ~1 day of work; same `label_query` API. Vanilla SQLite 3.34+; no new dependencies.
  - **Phase 3: typo-tolerant** — `spellfix1` extension or post-fetch `rapidfuzz`. Practical only if typos become common.
  - **Phase 4: semantic / embedding search** — `sqlite-vec` / `sqlite-vss` if labels become free-text. Big lift; only worth it if scene labels evolve toward descriptive prose.
  None of these change the `scenes.list` MCP tool surface — only the storage backend behind `label_query` changes.
- **Per-project vs. global scene library** — MVP is per-project; global/shared library deferred.
- **Scene library export / import** — relevant when MVR adoption lands (from broader M17 design).
- **Priority stack for live overrides** — multi-cue layering with stack-based precedence.
- **Real DMX output bridge** — the broader M17 goal; this scene editor is a consumer of that evaluator when it ports to Python.

---

**Status**: Design Specification
**Recommendation**: Proceed to `@acp.spec` to produce the implementation-ready contract with test coverage, then `@acp.task-create` to break into tasks against the DAG.
**Related Documents**:
- [clarification-14-light-show-scene-editor-mvp.md](../clarifications/clarification-14-light-show-scene-editor-mvp.md) — decision record
- [local.track-contribution-point-and-light-show-plugin.md](./local.track-contribution-point-and-light-show-plugin.md) — broader M17 design
- [milestone-17-track-contribution-point-and-light-show-plugin.md](../milestones/milestone-17-track-contribution-point-and-light-show-plugin.md) — M17 milestone plan
