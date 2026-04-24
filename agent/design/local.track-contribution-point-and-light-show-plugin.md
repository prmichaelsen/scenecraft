# Track Contribution Point and Light Show Plugin

**Concept**: A first-class track-type contribution point (frontend + Python plugin system), sidecar-schema migration of core `tracks`, and the `light_show` plugin that dogfoods both — with a 3D preview panel simulating DMX universes, scene primitives parameterized in the GrandMA3 tradition, and GDTF-backed fixture profiles.
**Created**: 2026-04-24
**Status**: Design Specification

---

## Overview

Scenecraft today hardcodes two track hierarchies: `tracks` (video) and `audio_tracks` (audio). The Timeline dispatches per type via `if`/`else` blocks. `agent/design/local.contribution-points.md` listed `trackTypes` as a planned contribution point but it was never built.

This design delivers three intertwined pieces:

1. **Track contribution point** — `registerTrackType` on both frontend (TS) and backend (Python) plugin hosts. Video and audio become built-in registrations; new track types (lighting, MIDI, subtitles, etc.) plug in through the same seam.
2. **Migration contribution point** — `registerMigration` on the Python plugin host, with versioned `up`/`down` migrations (SQL or Python). General-purpose shared infra; `generate_music` and `isolate_vocals` can adopt later.
3. **Light show plugin** — soup-to-nuts plugin (frontend + Python backend + tables + evaluator + 3D preview panel) that uses both new contribution points, proving the API by building a real third track type.

The `light_show` plugin simulates DMX universes. Real hardware output (OLA, Art-Net, sACN) is out of scope — the data model is DMX-shaped, the output is a 3D visual render.

See [clarification-12](../clarifications/clarification-12-track-contribution-point-and-light-show-plugin.md) for the full Q&A record behind these decisions.

---

## Problem Statement

- **Tracks are hardcoded.** Adding a new track type today requires editing `Timeline.tsx`, `scenecraft-client.ts`, and `db.py`. Third-party plugins cannot contribute track types at all. This blocks any feature that would naturally present as a timeline track (lighting, MIDI, subtitles, chat-overlay tracks, etc.).
- **Plugins cannot ship schema.** Plugins that want to persist state have no versioned migration surface. `generate_music` and `isolate_vocals` scaffold their tables directly in core `db.py`, which is a known compromise noted in `plugin_api.py`.
- **No lighting support.** Scenecraft has no concept of fixtures, scenes, cues, or lighting state. Shows with a lighting dimension can't be authored end-to-end.
- **Core schema has legacy quirks.** `tracks` and `audio_tracks` exist as parallel tables. Adding a third track type without unification would permanently cement the quirk.

Consequences of not solving this: Timeline.tsx accretes per-type branches forever; plugins can't contribute persistent state cleanly; scenecraft ships nothing for lighting; the tracks/audio_tracks split becomes architectural debt.

---

## Solution

### Part 1: Track contribution point

**Frontend** (`PluginHost.registerTrackType` in `src/lib/plugin-host.ts`):

```ts
interface TrackTypeContribution {
  id: string                         // e.g. 'video', 'audio', 'light_show'
  label: string                      // "Video", "Audio", "Light Show"
  icon?: ReactNode
  Renderer: React.FC<TrackRendererProps>
  Inspector?: React.FC<TrackInspectorProps>
  HeaderActions?: React.FC<TrackHeaderProps>
  onAdd?: (projectName: string) => Promise<Track>
  sortHint?: number                  // default ordering relative to other types
  defaultHeight?: number             // pixel row height
}
```

Video and audio become built-in registrations at editor bootstrap. Timeline.tsx replaces its `if`/`else` dispatch with a single `sortedTracks.map(t => registry.get(t.type).Renderer({track: t, ...}))`.

**Backend** (`scenecraft-engine/src/scenecraft/plugin_host.py`):
- No `registerTrackType` equivalent is needed. The backend only needs to know the `type` discriminant on the `tracks` table and route type-specific CRUD to the right plugin's REST endpoints.
- Core `tracks` common-field CRUD stays in core SQL.
- Plugins own REST endpoints for their sidecar tables and use the allowlisted `add_track(type, ...)` helper in `plugin_api.py` for the core-row INSERT side. FKs from sidecar to core `tracks.id` glue the two together.

### Part 2: Core schema migration

Unified base table + per-type sidecars (the sidecar pattern enforced by plugin_api R9a — plugins cannot touch core schema, so they must own their own tables):

```sql
-- Core (common fields only)
CREATE TABLE tracks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,               -- 'video', 'audio', 'light_show'
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  muted INTEGER DEFAULT 0,
  solo INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

-- Video sidecar
CREATE TABLE tracks_video (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  blend_mode TEXT DEFAULT 'normal',
  base_opacity REAL DEFAULT 1.0,
  z_order INTEGER NOT NULL,         -- video compositing depth, kept semantically distinct from display_order
  chroma_key_color TEXT,
  chroma_key_threshold REAL
  -- ...other video-specific fields
);

-- Audio sidecar
CREATE TABLE tracks_audio (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  volume_curve TEXT                 -- JSON
);

-- Plugin sidecars follow <plugin_id>__<table> naming, e.g.:
CREATE TABLE light_show__tracks (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  merge_mode TEXT DEFAULT 'top_wins',
  universe_id TEXT REFERENCES light_show__universes(id)
);
```

One-shot migration script reads old `tracks` (video) + `audio_tracks` rows, inserts into the new shape, rewires child-table FKs (`opacity_keyframes.track_id`, `audio_clips.track_id`, etc. — most already reference `tracks.id` correctly), and drops the old `audio_tracks` table inside a single transaction.

### Part 3: Migration contribution point

```python
# plugin_api.register_migration
registerMigration({
    "version": 1,                          # monotonic per plugin
    "up":   "CREATE TABLE light_show__fixtures (...);",  # or list[str], or Callable(cursor)
    "down": "DROP TABLE light_show__fixtures;",          # required — no one-way trips
})
```

- Tracked in `schema_migrations` meta table keyed `(plugin_id, version, applied_at)`
- Runs at plugin activate: applies pending `up` migrations in ascending version order if installed plugin version is newer; applies pending `down` migrations in descending version order if installed plugin version is older
- `up` and `down` accept SQL string, list of SQL strings, or Python callable receiving a cursor
- Idempotent: re-running same version is a no-op

Enables plugin version upgrade AND downgrade via the same mechanism. General-purpose — `generate_music` / `isolate_vocals` can adopt later and move their tables out of core `db.py`.

### Part 4: Light show plugin

**Plugin identifier**: `light_show` — transport-agnostic name (the data model is DMX-shaped, but the plugin doesn't commit to DMX as the wire protocol; Art-Net / sACN / KiNET fit the same universe model).

**Table set** (all `<plugin_id>__<table>` prefixed):

| Table | Purpose |
|---|---|
| `light_show__fixture_profiles` | GDTF-backed fixture type library. Stores raw `.gdtf` blob + parsed cache columns (channel map, attribute list, role). |
| `light_show__fixtures` | Rigged fixtures. `id, profile_id, universe, address, role, position_x/y/z, rotation_x/y/z, label`. |
| `light_show__universes` | Universe definitions. `id, number, label`. |
| `light_show__scenes` | Parameterized animation primitives. `id, label, description, derived_from (self-FK), parameters_schema (JSON), animation (JSON), created_at, updated_at`. |
| `light_show__tracks` | Sidecar to core `tracks`. `merge_mode` (enum), `universe_id`. |
| `light_show__cues` | Timeline anchors (scenecraft-native keyframes, NOT live-show cues). `id, track_id, time`. |
| `light_show__transitions` | Scene placements between cues. `id, track_id, start_cue_id, end_cue_id, scene_id, trim_in, trim_out, time_remap_curve` (JSON). |
| `light_show__transition_parameters` | Per-tr scene parameter bindings. `(transition_id, param_name, static_value_json \| curve_id)`. |
| `light_show__transition_overlays` | Per-tr post-process overlays. `(transition_id, overlay_type, params_json)`. |
| `light_show__transition_candidates` | Candidate pool per transition (hotswap between scene picks). Mirrors `tr_candidates`. |

**Scene model**: parameterized primitives, role-based addressing.

- Scenes declare a `parameters_schema` (list of named inputs with type/default/constraints).
- Scenes reference fixtures by `@role.<role>` or via a `fixture_group` parameter defaulting to a role.
- Resolution happens at playback against the user's rig: `@role.moving_head` expands to the list of fixtures with that role.
- User scenes can pin specific fixture IDs as an escape hatch.

**Scene animation evaluation pipeline** (per tr, per frame):

1. Evaluate tr's scene parameter bindings → concrete param values at time t (static or curve-interpolated)
2. Run scene evaluator: `scene(params, scene_time = time_remap(t))` → raw channel output
3. Apply tr's output overlays (`hue_shift`, `intensity_multiplier`, etc.) → final channel output

**Combination math** (multiple tracks → one universe):
- Per-track `merge_mode` column: `top_wins` (default), `additive`, `max` (HTP), `latest` (LTP), `multiply`, `min`
- Mirrors video's `blend_mode` concept — per-track compositing algebra

**Seed data via v1 migration**:
- ~10-15 generic scene primitives (blackout, full_on, color_wash, strobe, chase, comet, rainbow_sweep, breathing, pan_sweep, tilt_sweep, circle, search_stab) — all parameterized, role-based
- ~6-10 stripped GDTF files (generic RGB par, RGBW par, generic moving head 16ch, generic strobe, laser, fog, wash 7ch) — no 3D models, ~5-30 KB each
- A default demo rig layout (4 movers upstage, 8 wash pars linear front, 2 strobes downstage) so users start with a non-empty stage

### Part 5: 3D Preview Panel

- **Stack**: three.js + `@react-three/fiber` + `@react-three/drei` (added to `package.json`)
- **Rendering**: additive cone meshes per fixture (soft-edge translucent shader) for MVP. Upgrade to ray-marched volumetric beams is a later polish task.
- **Data source**: frontend TS evaluator reads scenes + rig from SQL via REST, evaluates universes per frame at the current playhead time. No backend involvement during playback. Future Python port of the same evaluator enables real DMX output.
- **Playhead binding**: shares scenecraft's main timeline. Scrubbing drives lighting.
- **Panel modes**: playback-driven by default. Hovering a row in the companion Scene List panel swaps the preview to loop that scene with default params. Leaving reverts. Implemented via a `universe_store.override` field.

### Part 6: MCP tool surface

All tools auto-prefixed by the plugin host as `light_show.<verb>`:

- **Rig**: `set_rig_layout` (bulk upsert), `remove_fixtures`, `list_fixtures`, `get_fixture`, `import_gdtf`
- **Scenes**: `list_scenes`, `get_scene`, `clone_scene`, `delete_scene`, `create_scene`, `render_scene_preview`
- **Timeline**: `add_track`, `remove_track`, `add_cue`, `remove_cue`, `add_transition`, `remove_transition`, `set_parameter_binding`, `add_overlay`, `remove_overlay`, `add_transition_candidate`, `select_transition_candidate`, `generate_transition_candidates`
- **Reads**: `get_current_universe_state`, `get_fixture_state`

`set_rig_layout` accepts partial fixture lists with upsert-by-id semantics. LLMs populate spatial coordinates from natural-language descriptions ("4 movers upstage truss at 4m height"); no drag-and-drop UI.

---

## Implementation

### File layout

**Frontend** (`scenecraft/`):
- `src/lib/plugin-host.ts` — add `registerTrackType` and `TrackTypeContribution` type
- `src/components/editor/Timeline.tsx` — refactor render loop to dispatch via registry
- `src/components/editor/tracks/VideoTrackType.ts` — extract into built-in registration
- `src/components/editor/tracks/AudioTrackType.ts` — extract into built-in registration
- `src/plugins/light_show/` — new plugin
  - `index.ts` — plugin entrypoint; `registerTrackType`, `registerPanel` (3D preview + Scene List), MCP tool registration
  - `LightShow3DPanel.tsx` — r3f scene
  - `SceneListPanel.tsx` — hoverable scene list
  - `evaluator.ts` — scene DSL interpreter
  - `universe-store.ts` — Zustand-alternative following `JobStateContext` pattern (Context + `useSyncExternalStore`, matches project convention — no Zustand, see `project_no_zustand`-style memory)
- `src/contexts/UniverseContext.tsx` — the universe state context, shape mirrors `JobStateContext`

**Backend** (`scenecraft-engine/`):
- `src/scenecraft/plugin_host.py` — add `register_migration` method and `schema_migrations` meta-table management
- `src/scenecraft/plugin_api.py` — re-export `register_migration`; add `add_track(type, ...)` allowlisted helper
- `src/scenecraft/db.py` — **remove** old `tracks` / `audio_tracks` schemas, add new unified `tracks` + `tracks_video` + `tracks_audio` sidecars, add migration script for existing project DBs
- `src/scenecraft/plugins/light_show/` — new plugin
  - `__init__.py` — `activate(plugin_api, context)`; registers migrations, REST endpoints, MCP tools
  - `plugin.yaml` — plugin manifest (MCP tools declared here per scenecraft convention)
  - `migrations/` — versioned migration files (SQL + Python)
    - `001_create_tables.sql`
    - `002_seed_profiles.py` — parses bundled GDTFs
    - `003_seed_scenes.py` — seeds default scene primitives
    - `004_seed_demo_rig.py` — seeds default rig layout
  - `profiles/` — bundled stripped GDTF files (generic par, moving head, etc.)
  - `rest.py` — REST handlers for fixtures/scenes/tracks/cues/transitions
  - `tools.py` — MCP tool implementations

### Track contribution point interface (TS)

```ts
// src/lib/plugin-host.ts
export interface TrackRendererProps {
  track: Track
  pxPerSec: number
  scrollLeft: number
  viewportWidth: number
  currentTime: number
  // ... standard timeline row props
}

export interface TrackInspectorProps {
  track: Track
}

export interface TrackTypeContribution {
  id: string
  label: string
  icon?: ReactNode
  Renderer: React.FC<TrackRendererProps>
  Inspector?: React.FC<TrackInspectorProps>
  HeaderActions?: React.FC<{ track: Track }>
  onAdd?: (projectName: string) => Promise<Track>
  sortHint?: number
  defaultHeight?: number
}

// PluginHost additions:
registerTrackType(contribution: TrackTypeContribution, context?: PluginContext): Disposable
getTrackType(id: string): TrackTypeContribution | null
listTrackTypes(): TrackTypeContribution[]
```

### Migration contribution point (Python)

```python
# plugin_api.py additions
def register_migration(
    *,
    version: int,
    up: str | list[str] | Callable[[sqlite3.Cursor], None],
    down: str | list[str] | Callable[[sqlite3.Cursor], None],
    context: PluginContext | None = None,
) -> Disposable:
    ...

# plugin_host.py: at activate, run pending migrations
# schema_migrations table:
#   plugin_id TEXT, version INTEGER, applied_at TEXT, PRIMARY KEY (plugin_id, version)
```

### Scene animation JSON (example)

```json
{
  "target": "@param.fixtures",
  "channels": {
    "intensity": {
      "curve_type": "pulse_wave",
      "rate": "@param.speed",
      "width": 0.2,
      "phase_offset_per_fixture": 0.1
    },
    "hue": { "value": "@param.hue" }
  }
}
```

Exact DSL grammar is follow-up work; scope for M17 is the evaluator supporting the ~10-15 seeded scene primitives and the extension vocabulary documented per primitive.

---

## Benefits

- **Extensibility unlocked.** Any plugin can contribute a track type. Future MIDI, subtitle, DMX-output, audio-description-v2, or shotlist tracks follow the same pattern.
- **API validation by three real consumers.** Video, audio, and light_show all implement `TrackTypeContribution`. The interface isn't designed in a vacuum or around one example.
- **Sidecar pattern enforced architecturally.** R9a (no raw DB access from plugins) already forces the sidecar model — we're documenting and building around the enforcement, not inventing a new constraint.
- **Schema cleaned up.** The `tracks`/`audio_tracks` quirk is resolved into a consistent base+sidecar shape.
- **Lighting is a real scenecraft capability.** Users can author rigs, scenes, cues, and shows from chat alone. 3D preview gives feedback. GDTF adoption puts scenecraft on the interoperability map.
- **Migration contribution point is reusable infra.** generate_music and isolate_vocals can adopt it; removes the "scaffolding in core db.py" compromise noted in plugin_api.py.
- **Scene authoring is LLM-native.** Bulk MCP tools with partial-state upsert semantics make natural-language rig/scene authoring the primary interface. No drag-and-drop UI needed at MVP.

---

## Trade-offs

- **M17 scope is large.** Three intertwined pieces (contribution point, migration system, full plugin). Bigger than a typical milestone. Mitigation: the plugin is the dogfood; the contribution points are necessary for it. Splitting would leave orphaned infra.
- **Timeline refactor risk.** Replacing `Timeline.tsx`'s hardcoded render dispatch touches the most-edited file in the frontend. Mitigation: video and audio registrations become the first two registrations; behavior parity is the acceptance bar; visual regression testing.
- **Scene DSL is novel.** No open standard exists. We mirror GrandMA3 but invent the concrete serialization. Mitigation: keep the DSL minimal at M17 (~10-15 primitives), document each primitive's grammar, treat the full DSL grammar as follow-up work.
- **One-shot migration script is destructive.** If it fails partway, the one existing project DB could corrupt. Mitigation: single transaction, backup before apply, well-tested (unit + integration against a seeded project DB).
- **Frontend-TS-only evaluator means no Python parity at M17.** Future real-DMX-output bridge requires a Python port. Mitigation: documented as post-M17; the evaluator's API surface is small enough to port mechanically.
- **GDTF parsing is new work.** Adds a dependency on an XML-parsing path. Mitigation: stripped profiles (no 3D models) keep parsing surface minimal; seed GDTFs ship tested.

---

## Dependencies

- **Frontend**: `three`, `@react-three/fiber`, `@react-three/drei` — new npm deps
- **Backend**: XML parsing (stdlib `xml.etree` or `lxml` — TBD during implementation)
- **Open standards**:
  - [GDTF (DIN SPEC 15800:2022)](https://www.gdtf.eu/) — fixture profile format
  - [MVR (DIN SPEC 15801:2023)](https://gdtf-share.com/help/en/help/mvr/index.html) — rig interchange format (post-M17)
- **Reference console (for scene DSL semantics)**: GrandMA3
- **Existing plugin system**: `scenecraft-engine/src/scenecraft/plugin_host.py` + `plugin_api.py` (core-invariant R9a)
- **Related design**: [local.contribution-points.md](./local.contribution-points.md)

---

## Testing Strategy

- **Unit**:
  - `TrackType` registry: register/deregister, duplicate-id rejection, dispose behavior
  - Migration contribution: `up`/`down` reversibility (apply `up`, apply `down`, assert schema identical to pre-apply)
  - Scene evaluator: each seeded primitive outputs correct channel values at known parameter values and times
  - Role resolution: `@role.moving_head` expands correctly against varied rigs
  - Combination math: each `merge_mode` computes expected blended channel values
- **Integration**:
  - Schema migration script: seed an old-style project DB, run migration, assert all tracks/clips/keyframes still addressable; rollback test via the down migrations
  - End-to-end MCP flow: `set_rig_layout` → `create_scene` → `add_track` → `add_cue` → `add_transition` → `set_parameter_binding` → scrub playhead → verify 3D preview reflects state
  - Plugin activation lifecycle: activate `light_show`, register migrations run, tables appear, deactivate disposes REST routes and MCP tools
- **Visual/manual**:
  - 3D preview panel visual regression against recorded golden frames
  - Scene hover-preview interaction on the Scene List panel
- **Performance**:
  - Evaluator budget: <5ms per frame for 50-fixture rig at 60fps
  - 3D render budget: <10ms per frame for the additive-cone MVP

No frontend test framework is currently installed (see project memory). Install `vitest` as part of this milestone if evaluator / store unit tests are part of the scope. Backend tests follow the existing pytest structure under `plugins/light_show/tests/`.

---

## Migration Path

1. **Phase 1 — Plugin system primitives**
   - Add `register_migration` to Python `plugin_host.py` + `plugin_api.py`
   - Create `schema_migrations` meta table in core `db.py`
   - Add `add_track(type, ...)` allowlisted helper to `plugin_api.py`

2. **Phase 2 — Core schema migration**
   - Write one-shot migration script: unified `tracks` table + `tracks_video` / `tracks_audio` sidecars + child-table FK rewiring
   - Drop `audio_tracks`
   - Update `db.py` `_ensure_schema` to target the new shape; migration script runs before schema check on existing DBs

3. **Phase 3 — TrackType contribution (frontend)**
   - Add `TrackTypeContribution` + `registerTrackType` to `PluginHost`
   - Extract `VideoTrackType` / `AudioTrackType` into built-in registrations
   - Refactor `Timeline.tsx` render loop to dispatch via the registry
   - Behavioral parity is the acceptance bar

4. **Phase 4 — Light show plugin skeleton**
   - Create plugin directory (frontend + backend)
   - Implement `registerMigration` calls for all `light_show__*` tables
   - Bundle stripped GDTF seed files + seed migrations (scenes, demo rig)
   - Register REST endpoints for CRUD, MCP tools, and the `LightShowTrackType`

5. **Phase 5 — Evaluator + 3D preview**
   - Implement scene evaluator (TS): interprets `animation` JSON, applies parameter bindings, overlays, role resolution
   - Implement `UniverseContext` (Context + useSyncExternalStore pattern)
   - Implement `LightShow3DPanel` with additive-cone beams, fixture geometry, per-channel-driven transforms
   - Implement `SceneListPanel` with hover-preview behavior

6. **Phase 6 — Polish + integration**
   - Candidate pool tools
   - Verify end-to-end MCP authoring flow
   - Visual regression against a recorded golden scene

---

## Key Design Decisions

### Track contribution point

| Decision | Choice | Rationale |
|---|---|---|
| Refactor scope | Video + audio become built-in track type registrations | API validated by three real consumers (video, audio, light_show) rather than one plugin + two exceptions |
| `TrackType` interface | Full slot set (id, label, icon, Renderer, Inspector, HeaderActions, onAdd, sortHint, defaultHeight) | Matches observed needs across video, audio, and light_show; extensions are opt-in via `?` |
| Backend dispatch | No core-side dispatcher. Common-field CRUD in core SQL; type-specific CRUD via plugin REST endpoints | R9a forbids raw DB access for plugins; plugins can't modify core schema. Dispatcher would be ceremony without capability. |

### Core schema

| Decision | Choice | Rationale |
|---|---|---|
| Migration shape | Full unification: core `tracks` + per-type sidecars; `audio_tracks` dropped | No feature-flag drift; cleaner long-term schema; greenfield enough to pay the migration cost now |
| Migration execution | One-shot script | One existing project DB must be preserved |
| `z_order` | Kept on `tracks_video` sidecar, semantically distinct from `display_order` | They're currently always in sync but represent different concepts (UI row order vs. video compositing depth) |

### Plugin naming

| Decision | Choice | Rationale |
|---|---|---|
| Plugin identifier | `light_show` | Transport-agnostic; data model is DMX-shaped internally but Art-Net / sACN / KiNET all fit without renaming |

### Light show data model

| Decision | Choice | Rationale |
|---|---|---|
| Track content | Full `kf`/`tr` pattern mirroring video tracks | Scenecraft-native abstraction; reuses validated concepts (candidates, transitions, time-remap) |
| Scene parameterization | Scenes declare parameter schemas; trs bind each param to static value or animated curve | Single `comet_burst` scene reused many times with different hue/speed curves; mirrors audio macro pattern |
| Parameter binding vs overlay | Two separate pipeline stages | Scene parameters feed IN to scene eval; overlays transform scene output. Distinct semantics — a strobe scene with no hue param still needs hue-shift overlay |
| `trim_in`/`trim_out` | Reuse project convention from audio clips / video trs | Consistency |
| Fixture addressing | Role-based (`@role.moving_head`) with escape hatch to specific IDs | Default scenes work on any user's rig; power users can pin |
| Clone semantics | `derived_from` FK (self-ref) on scenes | Matches existing `duplicateKeyframe` pattern; preserves lineage |
| Scene storage | SQL rows with JSON `animation` column | Animation tree is evaluated, never queried; JSON is right shape. Parameter schema is more structured and also lives as JSON per entity. |
| Transition candidates | Yes — candidate pool per transition | Matches existing `tr_candidates` pattern; enables hotswap between scene picks |

### Combination math

| Decision | Choice | Rationale |
|---|---|---|
| Default merge mode | Top-wins (highest `display_order` per-channel) | Matches video compositing intuition; simplest to implement |
| Per-track override | `merge_mode` enum column on `light_show__tracks` | Mirrors video's `blend_mode`; enables power-user patterns (global dim via `multiply`, strobe overlay via `max`) |

### Migration contribution point

| Decision | Choice | Rationale |
|---|---|---|
| Existence | New addition — does not exist today | Confirmed by grep against plugin_host.py, plugin_api.py, plugins/ |
| Shape | `{version, up, down}` — both required | Enables plugin version downgrade; no one-way trips |
| Content types | SQL string, list of SQL strings, or Python callable | Declarative dominant case (CREATE/ALTER/INSERT seed); Python for data reshaping |
| Tracking | `schema_migrations` meta table keyed `(plugin_id, version)` | Idempotent; plugin-scoped; standard pattern |

### 3D preview

| Decision | Choice | Rationale |
|---|---|---|
| 3D stack | three.js + `@react-three/fiber` + `@react-three/drei` | Industry standard for React + 3D in 2026; lighter bundle than Babylon; ASLS Studio validates stack for DMX visualization |
| Volumetric beams | Additive cone meshes for MVP; ray-marched shader is polish follow-up | Credible in dark scenes at ~1 day effort |
| Data source | Frontend TS evaluator | Matches "Frontend WebAudio is audio source of truth" pattern; no per-frame backend round-trip; offline-capable |
| Playhead binding | Unified with scenecraft main playhead | Lighting is content authored against audio/video, not a separate runtime |
| Preview panel mode | Hover-triggered override on Scene List panel | No toggle UI; natural authoring gesture |
| Fixture placement | Bulk `set_rig_layout` MCP tool + seeded default demo rig | LLM populates coords from natural-language; no drag-and-drop UI needed |

### MCP tool surface

| Decision | Choice | Rationale |
|---|---|---|
| Namespacing | Tools auto-prefixed to `light_show.<verb>` by plugin host | Internal names stay clean; no collision with core or other plugins |
| Rig tools | Single `set_rig_layout` with partial-state upsert; no specialized spatial helpers | LLM handles spatial math natively; helpers are sprawl |
| Other groups | Discrete verbs per entity (scenes, timeline, reads) | Different entities, different arg shapes, not composable; too-generic tools increase LLM footgun risk |

### Industry standards adopted

| Decision | Choice | Rationale |
|---|---|---|
| Fixture profile format | GDTF (DIN SPEC 15800:2022) | Open standard, industry-wide (GrandMA3, Vectorworks, WYSIWYG, Capture, BlenderDMX); free GDTFs available |
| Rig layout interchange | MVR (DIN SPEC 15801:2023), deferred to post-M17 | Natural extension once GDTF is in place |
| Scene DSL reference | GrandMA3 phaser/effect model | No open standard exists; GrandMA3 is the most widely-used console with a thoughtful parameterized effect model aligning with GDTF attribute taxonomy |

### Scope boundaries (out of scope for M17)

| Out of scope | Reason |
|---|---|
| Real DMX output protocols (OLA / Art-Net / sACN) | Sim-only at M17; output layer is a separate concern |
| Offline render integration | Post-M17 milestone |
| MVR import | Post-M17 milestone; natural follow-up |
| Ray-marched volumetric beams | Polish pass after MVP |
| 3D drag-and-drop UI | `set_rig_layout` via chat is sufficient |
| Full scene editor UI | Tools-first; visual editor post-M17 |
| Live-performance mode | Authoring-only scope at M17 |
| Python-side scene evaluator | Frontend-TS only at M17 |
| Global scene library | Per-project defaults are enough at MVP |

---

## Future Considerations

- **Post-M17 milestone: real DMX output bridge.** Port the TS evaluator to Python; add a WS-to-OLA bridge / Art-Net emitter / sACN emitter. Scenecraft becomes a real lighting-show creation tool, not just a simulator.
- **Post-M17 milestone: MVR import.** Natural extension once GDTF parsing is in place. Enables importing full rig layouts from Capture / GrandMA3 / Vectorworks.
- **Post-M17 milestone: ray-marched volumetric beams.** Polish pass. ~3-5 days of shader work for a major visual upgrade.
- **Post-M17 milestone: scene editor UI.** Visual DSL editor for authoring scene animations without chat. Timeline-within-a-timeline.
- **Post-M17 milestone: live-performance mode.** Re-introduce `light_show__cue_lists` with the live-show meaning; add a "Go" transport; enable scenecraft as a hybrid authoring + performance tool.
- **Migration adoption for other plugins.** Once `register_migration` is proven by `light_show`, migrate `generate_music` and `isolate_vocals` off the "tables in core `db.py`" scaffolding.
- **Scene DSL grammar documentation.** The concrete DSL deserves its own design doc once the M17 evaluator covers the seeded ~10-15 primitives. Grammar spec, primitive catalog, curve expression language.
- **GDTF marketplace integration.** gdtf-share.com has thousands of real-world fixtures; a browse/install UX would unlock real rigs.
- **Fixture role ontology.** The M17 `role` column is a small enum. A richer tagging system (multiple tags, user-defined roles) gives scenes more addressing power.

---

**Status**: Design Specification
**Recommendation**: Proceed to milestone creation (M17). Split into the phased tasks listed in "Migration Path." Phases 1-3 can proceed in parallel once the schema migration is reviewed.
**Related Documents**:
- [clarification-12-track-contribution-point-and-light-show-plugin.md](../clarifications/clarification-12-track-contribution-point-and-light-show-plugin.md)
- [local.contribution-points.md](./local.contribution-points.md)
