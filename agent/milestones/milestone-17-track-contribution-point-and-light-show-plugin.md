# Milestone 17: Track Contribution Point and Light Show Plugin

**Goal**: Ship a first-class track-type contribution point (frontend + Python), migrate core `tracks` to a unified schema with per-type sidecars, add a `register_migration` plugin primitive, and deliver the `light_show` plugin — soup-to-nuts — as the third track type that dogfoods all of the above.
**Duration**: 4-6 weeks
**Dependencies**: M6 (git version control infrastructure — the migration script reuses patterns)
**Status**: Not Started

---

## Overview

Three intertwined pieces ship together because the plugin is the proof of the contribution points; splitting would leave orphaned infra.

1. **Track contribution point** — `registerTrackType` on `PluginHost` (frontend + backend). Video and audio become built-in registrations.
2. **Migration contribution point** — `register_migration` on the Python plugin host; `up`/`down` versioned migrations; SQL or Python.
3. **Light show plugin** — new `light_show` plugin (frontend + Python backend): tables, GDTF-backed fixtures, GrandMA3-referenced parameterized scenes, `kf`/`tr` timeline authoring, 3D preview panel (three.js/r3f), and an LLM-first MCP tool surface.

The design, rationale, and every decision backing this milestone live in:
- [Design: local.track-contribution-point-and-light-show-plugin.md](../design/local.track-contribution-point-and-light-show-plugin.md)
- [Clarification-12: Q&A record](../clarifications/clarification-12-track-contribution-point-and-light-show-plugin.md)

---

## Deliverables

### 1. Plugin system primitives
- `register_migration` method on `scenecraft-engine/src/scenecraft/plugin_host.py`
- `schema_migrations` meta table in core `db.py`
- `add_track(type, ...)` allowlisted helper in `plugin_api.py` for plugins registering track types

### 2. Unified tracks schema
- Core `tracks` table: common fields only (`id, project_id, type, name, display_order, muted, solo, hidden, ...`)
- `tracks_video` sidecar: `blend_mode, base_opacity, z_order, chroma_key_*`
- `tracks_audio` sidecar: `volume_curve`
- One-shot migration script: preserves existing project DB (rows, FKs to child tables), drops `audio_tracks`, transactional

### 3. TrackType contribution point (frontend)
- `TrackTypeContribution` interface with full slot set (Renderer, Inspector, HeaderActions, onAdd, sortHint, defaultHeight, icon)
- `PluginHost.registerTrackType`, `getTrackType`, `listTrackTypes` methods
- Video and audio extracted into built-in registrations (`VideoTrackType`, `AudioTrackType`)
- `Timeline.tsx` render loop refactored to dispatch via the registry
- Behavioral parity with pre-refactor rendering

### 4. Light show plugin — backend
- `scenecraft-engine/src/scenecraft/plugins/light_show/` directory
- `plugin.yaml` manifest (MCP tool declarations)
- Migration sequence seeding tables + ~10 generic GDTF files + ~10-15 generic scene primitives + default demo rig layout
- REST endpoints for fixtures, scenes, tracks, cues, transitions, candidates
- MCP tool implementations
- `register_migration` declarations for all `light_show__*` tables
- `registerTrackType` registration from Python side (for track-type validation and REST routing)

### 5. Light show plugin — frontend
- `scenecraft/src/plugins/light_show/` directory
- Scene evaluator (TS DSL interpreter): reads `animation` JSON, applies parameter bindings, output overlays, role-based fixture resolution
- `UniverseContext` (React Context + `useSyncExternalStore`, matching `JobStateContext` pattern)
- `LightShow3DPanel` (three.js + r3f, additive-cone beams, playhead-driven)
- `SceneListPanel` (hover-triggered preview override)
- `LightShowTrackType` registration
- MCP tool surface wired for chat

### 6. Testing
- Migration contribution: `up` / `down` reversibility tests
- Schema migration script: roundtrip test against a seeded project DB
- Scene evaluator: per-primitive output correctness at known parameter values
- TrackType registry: register/deregister/dispose behavior
- End-to-end MCP flow (create rig → scene → track → cue → transition → scrub → verify 3D preview)

---

## Success Criteria

- [ ] `register_migration` implemented and tested (up/down roundtrip works)
- [ ] Core `tracks` schema migrated to unified + sidecars; existing project DB survives migration with all tracks/clips/keyframes intact
- [ ] Video and audio tracks render identically pre/post refactor (visual regression passes)
- [ ] Timeline.tsx no longer contains per-type `if`/`else` dispatch; all tracks render via the registry
- [ ] `light_show` plugin activates, runs migrations, seeds data, registers MCP tools
- [ ] User can author a complete light show via chat alone: set rig layout, create scene, add track, add cues + transition, set parameter binding, scrub playhead, see 3D preview update
- [ ] Scene hover-preview works on the Scene List panel
- [ ] Transition candidates support: add, select, generate (LLM), hotswap
- [ ] No YAML in runtime code beyond existing carve-outs (plugin.yaml, index, progress)
- [ ] No Zustand/other state libs added (follow Context + useSyncExternalStore pattern)
- [ ] `three`, `@react-three/fiber`, `@react-three/drei` added to frontend package.json

---

## Key Files to Create

```
scenecraft/
├── src/
│   ├── lib/
│   │   └── plugin-host.ts                              # add registerTrackType
│   ├── components/editor/
│   │   ├── tracks/
│   │   │   ├── VideoTrackType.ts                       # built-in registration
│   │   │   └── AudioTrackType.ts                       # built-in registration
│   │   └── Timeline.tsx                                # refactor render loop
│   ├── contexts/
│   │   └── UniverseContext.tsx                         # new
│   └── plugins/
│       └── light_show/
│           ├── index.ts                                # activate, register track type, panels, MCP tools
│           ├── LightShow3DPanel.tsx
│           ├── SceneListPanel.tsx
│           ├── LightShowTrackType.ts
│           ├── LightShowInspector.tsx
│           ├── evaluator.ts                            # scene DSL interpreter
│           ├── role-resolver.ts
│           └── overlay.ts

scenecraft-engine/
├── src/scenecraft/
│   ├── plugin_host.py                                  # add register_migration, schema_migrations init
│   ├── plugin_api.py                                   # re-export, add_track helper
│   ├── db.py                                           # new tracks + sidecars; drop audio_tracks
│   ├── migrations/
│   │   └── core_tracks_unify.py                        # one-shot migration script
│   └── plugins/light_show/
│       ├── __init__.py
│       ├── plugin.yaml
│       ├── migrations/
│       │   ├── 001_create_tables.sql
│       │   ├── 002_seed_profiles.py
│       │   ├── 003_seed_scenes.py
│       │   └── 004_seed_demo_rig.py
│       ├── profiles/                                   # bundled GDTFs (generic par, moving head, etc.)
│       ├── rest.py
│       ├── tools.py
│       └── tests/
```

---

## Tasks

1. [Task 135: Migration contribution point](../tasks/milestone-17-track-contribution-point-and-light-show-plugin/task-135-migration-contribution-point.md) — Implement `register_migration` on Python `PluginHost`, `schema_migrations` meta table, up/down orchestration at activate
2. [Task 136: Core tracks schema unification + migration](../tasks/milestone-17-track-contribution-point-and-light-show-plugin/task-136-tracks-schema-unification.md) — New `tracks` + sidecar tables; one-shot migration of existing project DB
3. [Task 137: TrackType contribution point (frontend)](../tasks/milestone-17-track-contribution-point-and-light-show-plugin/task-137-tracktype-contribution-point.md) — `registerTrackType`, extract video/audio built-ins, refactor `Timeline.tsx` dispatch
4. [Task 138: Light show plugin backend skeleton](../tasks/milestone-17-track-contribution-point-and-light-show-plugin/task-138-light-show-backend-skeleton.md) — Plugin directory, tables, seed migrations (GDTFs, scenes, demo rig), REST endpoints, MCP tools
5. [Task 139: Scene evaluator (TS)](../tasks/milestone-17-track-contribution-point-and-light-show-plugin/task-139-scene-evaluator.md) — DSL interpreter: role resolution, parameter bindings, time remap, overlays, merge math
6. [Task 140: 3D preview panel + UniverseContext](../tasks/milestone-17-track-contribution-point-and-light-show-plugin/task-140-3d-preview-panel.md) — r3f scene, additive cones, playhead-driven render, UniverseContext store
7. [Task 141: Scene List panel, candidates, E2E polish](../tasks/milestone-17-track-contribution-point-and-light-show-plugin/task-141-scene-list-candidates-polish.md) — Scene List panel with hover-preview, transition candidate tools, end-to-end MCP flow verification

**Estimated total**: ~52 hours across the 7 tasks.

---

## Dependencies

- **Frontend**: `three`, `@react-three/fiber`, `@react-three/drei` — new npm packages
- **Backend**: XML parsing for GDTF (stdlib `xml.etree` preferred)
- **External standards**:
  - [GDTF (DIN SPEC 15800:2022)](https://www.gdtf.eu/) — adopted for fixture profiles
  - GrandMA3 phaser/effect model — reference for scene DSL semantics
  - [MVR (DIN SPEC 15801:2023)](https://gdtf-share.com/help/en/help/mvr/index.html) — documented, import deferred to post-M17
- **Internal**: Python plugin host (`plugin_host.py`), frontend plugin host (`plugin-host.ts`), existing `JobStateContext` pattern

---

## Testing Requirements

- [ ] Unit: `register_migration` up/down roundtrip per migration
- [ ] Unit: scene evaluator output per seeded primitive at known param values
- [ ] Unit: role resolver against varied rigs
- [ ] Unit: merge math for each `merge_mode`
- [ ] Integration: schema migration script against a seeded project DB; FK preservation for all child tables
- [ ] Integration: plugin activate/deactivate lifecycle (migrations run, REST routes appear/disappear, MCP tools register/dispose)
- [ ] E2E: full MCP authoring flow (chat → rig → scene → track → cue → transition → parameter binding → playhead scrub → 3D preview)
- [ ] Visual regression: 3D preview panel golden frames
- [ ] Performance: evaluator <5ms/frame for 50-fixture rig at 60fps; 3D render <10ms/frame

Install `vitest` if evaluator / store unit tests are in scope (no frontend test framework today).

---

## Documentation Requirements

- [ ] Design doc (already shipped): `local.track-contribution-point-and-light-show-plugin.md`
- [ ] Clarification-12 (already shipped)
- [ ] Per-task docs (this milestone)
- [ ] Post-M17: scene DSL grammar doc (primitives catalog, curve expression language)

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Timeline.tsx refactor introduces regression in video/audio rendering | High | Medium | Behavioral parity is acceptance bar; visual regression tests against pre-refactor golden; ship video/audio registrations first and verify before extending to light_show |
| Schema migration corrupts existing project DB | High | Low | Single-transaction migration; backup before apply; unit + integration tests against seeded fixture DBs; dry-run flag on migration CLI |
| Scene DSL design drifts without clear vocabulary discipline | Medium | Medium | Seed ~10-15 primitives at M17 following GrandMA3 vocabulary; DSL grammar doc is a post-M17 deliverable; resist inventing new patterns beyond what's needed for the seeds |
| GDTF parser complexity underestimated | Medium | Medium | Ship stripped GDTFs (no 3D models) at M17; parser only extracts `description.xml` attribute list for the seed set; full GDTF import (including 3D models) is post-M17 polish |
| r3f + SSR / hydration edge cases | Low | Low | Panel is client-only (dockview panels already client-side); no SSR path |
| `register_migration` interacts poorly with existing scenecraft-engine startup | Medium | Medium | Design to run at plugin activate, not at engine boot; schema_migrations is per-plugin, idempotent; activate order deterministic |

---

**Next Milestone**: TBD (candidates: M18 for real DMX output bridge, M18 for MVR import, M18 for scene DSL grammar doc)
**Blockers**: None
**Notes**:
- M11 isolate_vocals and M16 generate_music can migrate to the new `register_migration` primitive as post-M17 cleanup (not required for M17 completion)
- The "kf/tr" pattern for light_show is scenecraft-native; industry "cue" concept (live-performance) is deliberately deferred
- Per-project scene libraries are the M17 model; global scene sharing is out of scope
