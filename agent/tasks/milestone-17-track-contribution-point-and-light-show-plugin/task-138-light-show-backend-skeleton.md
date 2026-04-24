# Task 138: Light Show Plugin — Backend Skeleton

**Milestone**: [M17 - Track Contribution Point and Light Show Plugin](../../milestones/milestone-17-track-contribution-point-and-light-show-plugin.md)
**Design Reference**: [local.track-contribution-point-and-light-show-plugin.md § Part 4](../../design/local.track-contribution-point-and-light-show-plugin.md)
**Estimated Time**: 10 hours
**Dependencies**: task-135 (register_migration), task-136 (tracks schema)
**Status**: Not Started

---

## Objective

Build the `light_show` plugin's Python backend: plugin directory, manifest, all `light_show__*` tables via `register_migration`, bundled GDTF seed profiles, seed scene primitives, default demo rig layout, REST endpoints, and MCP tool surface.

---

## Context

The `light_show` plugin is soup-to-nuts — frontend + Python backend — and dogfoods both new contribution points (`registerTrackType` and `register_migration`). The backend owns nine tables (sidecars under the `<plugin_id>__<table>` naming convention) and exposes REST + MCP for CRUD.

Scenes, fixtures, and the demo rig are seeded via versioned migrations so a fresh project gets a working starting point.

---

## Steps

### 1. Create plugin directory

```
scenecraft-engine/src/scenecraft/plugins/light_show/
├── __init__.py              # activate() entrypoint
├── plugin.yaml              # manifest, MCP tool declarations
├── migrations/
│   ├── __init__.py
│   ├── m001_create_tables.py
│   ├── m002_seed_profiles.py
│   ├── m003_seed_scenes.py
│   └── m004_seed_demo_rig.py
├── profiles/                # bundled GDTF files
│   ├── generic_rgb_par.gdtf
│   ├── generic_rgbw_par.gdtf
│   ├── generic_moving_head_16ch.gdtf
│   ├── generic_strobe.gdtf
│   ├── generic_laser.gdtf
│   ├── generic_fog.gdtf
│   └── generic_wash_7ch.gdtf
├── rest.py
├── tools.py
├── gdtf.py                  # GDTF parser
├── scene_defs.py            # seed scene definitions (GrandMA3-referenced)
└── tests/
    ├── __init__.py
    ├── test_migrations.py
    ├── test_rest.py
    └── test_tools.py
```

### 2. `plugin.yaml` manifest

```yaml
id: light_show
version: 1.0.0
description: DMX-simulated light show authoring plugin
mcp_tools:
  - id: set_rig_layout
    description: Set or upsert fixture positions, rotations, and addresses
    input_schema: ...
  - id: remove_fixtures
    ...
  # full set from the design
```

### 3. `__init__.py` activate

```python
def activate(plugin_api, context):
    import sys
    from .migrations import ALL_MIGRATIONS
    from . import rest, tools

    # Register migrations
    for mig in ALL_MIGRATIONS:
        plugin_api.register_migration(
            plugin_id='light_show',
            version=mig.version,
            up=mig.up,
            down=mig.down,
            context=context,
        )

    # Register REST endpoints
    plugin_api.register_rest_endpoint(
        r'^/api/projects/[^/]+/plugins/light_show/fixtures(?:/.*)?$',
        rest.handle_fixtures, context=context,
    )
    plugin_api.register_rest_endpoint(
        r'^/api/projects/[^/]+/plugins/light_show/scenes(?:/.*)?$',
        rest.handle_scenes, context=context,
    )
    # ... tracks, cues, transitions, candidates, rig_layout

    # Register from plugin.yaml (MCP tools, declared operations)
    PluginHost.register_declared(sys.modules[__name__], context)
```

### 4. Migration 001: create tables

`m001_create_tables.py`:

```python
UP = """
CREATE TABLE light_show__fixture_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  manufacturer TEXT,
  gdtf_blob BLOB,                          -- raw .gdtf zip bytes
  channel_map_json TEXT,                   -- parsed cache: channel → attribute mapping
  default_role TEXT,                       -- 'moving_head' | 'par' | ...
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE light_show__universes (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  label TEXT
);

CREATE TABLE light_show__fixtures (
  id TEXT PRIMARY KEY,
  profile_id TEXT REFERENCES light_show__fixture_profiles(id),
  universe_id TEXT REFERENCES light_show__universes(id),
  address INTEGER NOT NULL,
  role TEXT NOT NULL,                      -- denormalized from profile for fast role queries
  position_x REAL DEFAULT 0, position_y REAL DEFAULT 0, position_z REAL DEFAULT 0,
  rotation_x REAL DEFAULT 0, rotation_y REAL DEFAULT 0, rotation_z REAL DEFAULT 0,
  label TEXT
);
CREATE INDEX idx_fixtures_role ON light_show__fixtures(role);

CREATE TABLE light_show__scenes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  derived_from TEXT REFERENCES light_show__scenes(id),
  parameters_schema TEXT NOT NULL,         -- JSON
  animation TEXT NOT NULL,                 -- JSON
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE light_show__tracks (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  merge_mode TEXT DEFAULT 'top_wins',
  universe_id TEXT REFERENCES light_show__universes(id)
);

CREATE TABLE light_show__cues (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES light_show__tracks(track_id) ON DELETE CASCADE,
  time REAL NOT NULL
);
CREATE INDEX idx_cues_track_time ON light_show__cues(track_id, time);

CREATE TABLE light_show__transitions (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES light_show__tracks(track_id) ON DELETE CASCADE,
  start_cue_id TEXT REFERENCES light_show__cues(id),
  end_cue_id TEXT REFERENCES light_show__cues(id),
  scene_id TEXT NOT NULL REFERENCES light_show__scenes(id),
  trim_in REAL DEFAULT 0,
  trim_out REAL,
  time_remap_curve TEXT                    -- JSON
);

CREATE TABLE light_show__transition_parameters (
  transition_id TEXT NOT NULL REFERENCES light_show__transitions(id) ON DELETE CASCADE,
  param_name TEXT NOT NULL,
  static_value TEXT,                       -- JSON, nullable
  curve TEXT,                              -- JSON, nullable (xor with static_value)
  PRIMARY KEY (transition_id, param_name)
);

CREATE TABLE light_show__transition_overlays (
  id TEXT PRIMARY KEY,
  transition_id TEXT NOT NULL REFERENCES light_show__transitions(id) ON DELETE CASCADE,
  overlay_type TEXT NOT NULL,              -- 'hue_shift' | 'intensity_multiplier' | ...
  params TEXT NOT NULL                     -- JSON, overlay-specific params
);

CREATE TABLE light_show__transition_candidates (
  id TEXT PRIMARY KEY,
  transition_id TEXT NOT NULL REFERENCES light_show__transitions(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES light_show__scenes(id),
  params_snapshot TEXT,                    -- JSON
  is_selected INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
"""

DOWN = """
DROP TABLE IF EXISTS light_show__transition_candidates;
DROP TABLE IF EXISTS light_show__transition_overlays;
DROP TABLE IF EXISTS light_show__transition_parameters;
DROP TABLE IF EXISTS light_show__transitions;
DROP TABLE IF EXISTS light_show__cues;
DROP TABLE IF EXISTS light_show__tracks;
DROP TABLE IF EXISTS light_show__scenes;
DROP TABLE IF EXISTS light_show__fixtures;
DROP TABLE IF EXISTS light_show__universes;
DROP TABLE IF EXISTS light_show__fixture_profiles;
"""
```

### 5. Migration 002: seed fixture profiles (Python callable)

`m002_seed_profiles.py`:

```python
def up(cursor):
    import pathlib, uuid
    profiles_dir = pathlib.Path(__file__).parent.parent / 'profiles'
    for gdtf_path in profiles_dir.glob('*.gdtf'):
        blob = gdtf_path.read_bytes()
        parsed = parse_gdtf(blob)   # extract name, manufacturer, channel map, default role
        cursor.execute(
            "INSERT INTO light_show__fixture_profiles (id, name, manufacturer, gdtf_blob, channel_map_json, default_role) VALUES (?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), parsed.name, parsed.manufacturer, blob, json.dumps(parsed.channels), parsed.role),
        )

def down(cursor):
    cursor.execute("DELETE FROM light_show__fixture_profiles")
```

### 6. Migration 003: seed scene primitives

`m003_seed_scenes.py`:

Seed ~10-15 GrandMA3-referenced primitives. Each has a `parameters_schema` (JSON) and `animation` (JSON). Examples:

- `blackout`, `full_on`
- `color_wash(fixtures, color)`
- `strobe(fixtures, rate, intensity)`
- `chase(fixtures, rate, direction)`
- `comet(fixtures, speed, tail_length)`
- `rainbow_sweep(fixtures, rate, phase_offset_per_fixture)`
- `breathing(fixtures, rate, depth)`
- `pan_sweep(fixtures, rate, amplitude)` / `tilt_sweep(...)`
- `circle(fixtures, rate, radius)`
- `search_stab(fixtures, duration, intensity)`

Exact DSL serialization: concrete `animation` JSON per scene following the shape documented in task-139's evaluator. Keep to ~15 max.

### 7. Migration 004: seed demo rig

`m004_seed_demo_rig.py`:

- 1 universe (number=1, label="Main")
- 4 moving heads upstage truss at (-3, 4, 2), (-1, 4, 2), (1, 4, 2), (3, 4, 2)
- 8 RGB wash pars linear front at (-3.5, 0, -2) through (3.5, 0, -2), 1m spacing
- 2 strobes downstage at (-2, 0.5, -4), (2, 0.5, -4)
- 1 fog machine at (0, 0.2, -3)

Each fixture references a `light_show__fixture_profiles` row by name (resolved at migration time).

### 8. `gdtf.py` parser

Minimal XML extraction from `description.xml` inside the zip. Extract:
- Fixture name + manufacturer
- DMX mode (pick first mode by default)
- Channel list with attribute per channel (Pan, Tilt, Dimmer, ColorRGB_R/G/B, etc.)
- Suggested role based on attribute profile (has Pan+Tilt → moving_head; has ColorRGB + no Pan/Tilt → par; etc.)

Use stdlib `xml.etree.ElementTree` + `zipfile`. Skip 3D models (not needed).

### 9. `rest.py` endpoints

CRUD for fixtures, profiles, scenes, universes, tracks, cues, transitions, overlays, candidates. Each endpoint uses the allowlisted helpers (e.g., `add_track` for core row insertion, plus direct writes to `light_show__*` sidecar tables through a plugin-scoped cursor).

### 10. `tools.py` MCP tool handlers

One Python function per MCP tool declared in `plugin.yaml`. Each accepts the tool input, calls into the same helpers that `rest.py` uses. Shared business logic — don't duplicate.

### 11. Tests

- Migrations roundtrip: up/down both complete, schema reverts cleanly
- Fixture profile parsing: each bundled GDTF parses to expected name/channels/role
- Demo rig seed: correct count of fixtures with correct roles and positions
- REST: each endpoint's happy path
- MCP tools: each tool's happy path; error cases (missing fixture, invalid scene_id)

---

## Verification

- [ ] Plugin directory and manifest exist per layout
- [ ] All 4 migrations register and run in order at plugin activate
- [ ] All 10 `light_show__*` tables created
- [ ] 7 bundled GDTF files parse and seed into `light_show__fixture_profiles`
- [ ] ~15 seed scenes inserted into `light_show__scenes`
- [ ] Demo rig seeded with universes + fixtures
- [ ] REST endpoints respond for all declared routes
- [ ] MCP tools registered and callable
- [ ] Down migrations revert cleanly (roundtrip test passes)
- [ ] Unit tests pass

---

## Key Design Decisions

See [design doc § Part 4](../../design/local.track-contribution-point-and-light-show-plugin.md) for scene model rationale, role-based addressing, and the kf/tr pattern.

| Decision | Choice | Rationale |
|---|---|---|
| Plugin directory naming | `<plugin_id>__` prefix for tables | Established convention from `generate_music__*` |
| Seed content | GDTFs in `profiles/`, scenes in `scene_defs.py`, migrations in `migrations/` | Separation of data and code; migrations load from these |
| GDTF scope | Strip 3D models at M17; parse XML + channel map only | Minimal parser surface; full GDTF including 3D is post-M17 |
| REST route namespace | `/api/projects/:name/plugins/light_show/*` | Consistent with existing `isolate_vocals` endpoint pattern |

---

## Notes

- All bundled GDTFs are downloaded from [gdtf-share.com](https://gdtf-share.com/) or synthesized. License compliance: GDTF files are freely distributable per the GDTF Share terms.
- No YAML beyond plugin.yaml (per carve-out).
- `parse_gdtf` is a narrow helper — don't over-engineer. Post-M17 GDTF import UI reuses the same parser.

---

**Next Task**: [task-139-scene-evaluator.md](./task-139-scene-evaluator.md)
**Related Design Docs**: [local.track-contribution-point-and-light-show-plugin.md](../../design/local.track-contribution-point-and-light-show-plugin.md)
