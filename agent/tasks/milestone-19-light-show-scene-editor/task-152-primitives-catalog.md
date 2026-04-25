# Task 152: Primitives Catalog YAML

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — R4, R31; `primitives_catalog.yaml` definition under Interfaces
**Design Reference**: [`local.light-show-scene-editor.md`](../../design/local.light-show-scene-editor.md) — Part 2: Primitive catalog
**Estimated Time**: 0.5 hour
**Dependencies**: none
**Status**: Not Started

---

## Objective

Create the shared YAML catalog that backend and frontend both consume. This is the single source of truth for primitive metadata (id, label, description, JSON-schema for params with defaults).

---

## Steps

### 1. Create file

Path: `scenecraft-engine/src/scenecraft/plugins/light_show/primitives_catalog.yaml`

Two entries: `rotating_head` + `static_color`. Use the YAML form from the spec's Interfaces section verbatim — defaults locked in clarification-14 Q 5.1 / 5.2:

`rotating_head` defaults:
- `role: "moving_head"`, `period_sec: 4.0`, `pan_amplitude_rad: 0.7853981633974483` (π/4), `tilt_center_rad: -0.3`, `tilt_amplitude_rad: 0.2`, `tilt_period_sec: 4.0`, `intensity: 1.0`, `color: [1, 1, 1]`

`static_color` defaults:
- `role`: undefined (means "all fixtures"), `intensity: 1.0`, `color: [1, 1, 1]`

### 2. Backend smoke

Confirm `yaml.safe_load(open(catalog_path))` round-trips to a dict with `primitives: [...]` and the two expected entries.

### 3. Doc the load points (will be wired in tasks 153/160)

- Backend: `routes.py` and `tools_scenes` handler load the catalog once at module init; cache in module global.
- Frontend: import via Vite (`?raw` + `js-yaml`) OR fetch via REST `/primitives` at boot; document which approach in task-160.

---

## Verification

- [ ] File exists at the declared path with valid YAML
- [ ] `yaml.safe_load` produces a dict with key `primitives` whose value is a list of 2 entries
- [ ] Each entry has required fields: `id`, `label`, `description`, `params_schema`
- [ ] `rotating_head.params_schema.properties.period_sec.default == 4.0`
- [ ] `static_color.params_schema.properties.color.default == [1, 1, 1]`
- [ ] No structural drift between this file and the canonical YAML in the spec's Interfaces section

---

## Notes

- The catalog stays YAML (not JSON, not hardcoded TS/Python) per memory: "DB for data records; YAML preferred for static config / catalogs / manifests that ship with code".
- Future primitives (strobe, chase, fade, breathe, …) are added here as the catalog grows. Currency rule: a primitive id present here MUST have a matching `apply()` function in `primitives.ts` (task-160 enforces with module-init assertion per R31).
