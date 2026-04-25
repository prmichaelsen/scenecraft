# Task 158: Backend pytest Coverage

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — Tests section (~30 base + edge tests in scope for backend)
**Estimated Time**: 1 hour
**Dependencies**: tasks 151-157 (full backend stack must exist)
**Status**: Not Started

---

## Objective

Translate the spec's backend-relevant Given/When/Then tests into pytest. Cover schema migration, three MCP tool dispatchers, REST endpoints, persistence, WS broadcasts, and the catalog YAML round-trip.

---

## Steps

### 1. Test file layout

```
scenecraft-engine/src/scenecraft/plugins/light_show/tests/
├── test_scene_editor_schema.py
├── test_tools_scenes.py
├── test_tools_scene_timeline.py
├── test_tools_scene_live.py
└── test_scene_editor_rest.py
```

### 2. Translate spec tests to pytest

For each `#### Test:` in the spec's Base Cases + Edge Cases that has a backend assertion, write a pytest function. Test names mirror the spec's kebab-case names converted to snake_case:

- `test_scene_editor_schema.py`:
  - `schema-migration-creates-tables` (R1, R2, R3 + CHECK constraints)

- `test_tools_scenes.py`:
  - `scenes-list-primitives-returns-catalog-verbatim` (R4)
  - `scenes-set-creates-new-with-server-uuid` (R5, R6)
  - `scenes-set-rejects-create-without-label-or-type` (R6)
  - `scenes-set-rejects-update-with-unknown-id` (R7)
  - `scenes-set-partial-update-preserves-omitted` (R6)
  - `scenes-set-null-deletes-param-key` (R6)
  - `scenes-set-rejects-null-on-top-level` (R6)
  - `scenes-set-rejects-null-params-object` (R6)
  - `scenes-roundtrip-list-set-preserves-sparse` (R5, R6)
  - `scenes-set-rejects-unknown-type` (R8)
  - `scenes-remove-happy-path` (R9)
  - `scenes-remove-rejects-when-placements-reference` (R9)
  - `scenes-remove-rejects-when-live-override-holds` (R10)
  - `scenes-remove-multiple-atomic-when-one-blocked` (R9, edge)
  - `scenes-list-default-pagination` (R5)
  - `scenes-list-pagination-second-page` (R5)
  - `scenes-list-filter-by-type` (R5)
  - `scenes-list-filter-by-label-query-substring-case-insensitive` (R5)
  - `scenes-list-filter-by-ids` (R5)
  - `scenes-list-order-by-label-asc` (R5)
  - `scenes-list-limit-clamped-to-max` (R5)
  - `scenes-remove-returns-deleted-rows` (R9)

- `test_tools_scene_timeline.py`:
  - `scene-timeline-set-inserts-with-auto-uuid` (R12, R13)
  - `scene-timeline-set-rejects-end-before-start` (R14)
  - `scene-timeline-set-rejects-unknown-scene-id` (R15)
  - `scene-timeline-list-default-chronological` (R12)
  - `scene-timeline-list-filter-time-range` (R12)
  - `scene-timeline-list-filter-by-scene-id` (R12)
  - `scene-timeline-set-returns-upserted-only` (R13)
  - `scene-timeline-remove-returns-deleted-rows` (R16)
  - `negative-no-partial-placement-write-on-multi-invalid` (R14, edge)

- `test_tools_scene_live.py`:
  - `scene-live-activate-by-scene-id` (R18, R19, R21, R26)
  - `scene-live-activate-with-inline-scene` (R18, R20, R22)
  - `scene-live-activate-rejects-both-forms` (R18)
  - `scene-live-activate-save-as-persists` (R22)
  - `scene-live-activate-replaces-existing` (R21)
  - `scene-live-deactivate-no-op-when-inactive` (R25)
  - `live-override-persists-across-restart` (R28) — uses fixture that closes + reopens connection
  - activate with `save_as` + `scene_id` (no inline) → R23 rejection
  - `unknown-action-returns-error-not-exception` (covers all three tools)
  - `negative-no-broadcast-on-rejected-set` (R7, R14, R15) — verifies WS NOT emitted on rejected set
  - `ws-broadcast-kind-on-each-mutation` (R29) — verifies correct `kind` values

- `test_scene_editor_rest.py`:
  - REST happy-path coverage for each endpoint (smoke), including 404 / 409 / 400 envelope shapes

### 3. Fixtures

- `tmp_project_dir` — pytest fixture that creates a fresh project DB with `_ensure_schema` applied
- `seeded_scenes(tmp_project_dir, count=N, type="rotating_head")` — bulk-creates N scenes with predictable labels for filter/pagination tests
- `seeded_placements(tmp_project_dir, count=N, with_scene_ids=[...])` — bulk-creates placements
- WS broadcast capture: monkey-patch `plugin_api.broadcast_event` to a recording mock for assertion

### 4. Run

`./.venv/bin/python -m pytest src/scenecraft/plugins/light_show/tests/ -v --tb=short` — full suite green.

---

## Verification

- [ ] All listed pytest functions exist and pass
- [ ] No skipped tests in the suite
- [ ] Coverage gap check: every spec requirement R1-R29 has at least one test in this suite (frontend-only requirements R31-R50 are out of scope here, covered in task-162)
- [ ] `negative-no-broadcast-on-rejected-set` confirms zero WS events fired on rejected mutations
- [ ] `live-override-persists-across-restart` closes and reopens the SQLite connection between activate and status verification

---

## Notes

- This task is the backend-side proof of the spec contract. After this passes, the backend implementation can be considered complete pending frontend integration.
- Follow the existing test convention in `src/scenecraft/plugins/isolate_vocals/tests/` and `src/scenecraft/plugins/generate_music/tests/` for fixture style.
