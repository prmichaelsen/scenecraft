# Task 143: Foley Schema + Migrations

**Milestone**: [M18](../../milestones/milestone-18-foley-generation-plugin.md)
**Design Reference**: [`local.foley-generation-plugin.md`](../../design/local.foley-generation-plugin.md) — "Schema"
**Clarification**: [`clarification-12-foley-generation-plugin.md`](../../clarifications/clarification-12-foley-generation-plugin.md) — Item 7
**Estimated Time**: 2 hours
**Dependencies**: M13 `pool_segments.variant_kind` + `derived_from` columns (already present); M16 `spend_ledger` (already present)
**Status**: Not Started

---

## Objective

Create two plugin-owned tables in `project.db` — `generate_foley__generations` + `generate_foley__tracks` — mirroring M16's `generate_music` schema shape exactly. Forward-looking multi-variant support via `variant_count` + the `__tracks` junction (MVP enforces `count == 1`).

---

## Context

Audit of existing generators (keyframe, transition, music, isolate, transcribe) established that **no generator uses a `batch_id` column** — grouping is always via natural keys. Music's `generate_music__generations` + `generate_music__tracks` is the closest match to foley semantics (net-new audio asset, drag-placed to pool, no candidate attachment). This task clones that shape with foley-specific columns.

---

## Steps

### 1. Migration file

Add a new migration in `scenecraft-engine/migrations/` (match existing naming convention, e.g. `NNNN_foley_generations.sql` where NNNN is the next sequential number):

```sql
-- generate_foley plugin schema

CREATE TABLE IF NOT EXISTS generate_foley__generations (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,

    -- mode + input
    mode TEXT NOT NULL CHECK (mode IN ('t2fx', 'v2fx')),
    prompt TEXT,
    duration_seconds REAL,
    source_candidate_id TEXT,
    source_in_seconds REAL,
    source_out_seconds REAL,

    -- model params
    model TEXT NOT NULL,
    negative_prompt TEXT,
    cfg_strength REAL,
    seed INTEGER,

    -- kickoff context (auto-stamped onto pool_segments)
    entity_type TEXT CHECK (entity_type IN ('transition') OR entity_type IS NULL),
    entity_id TEXT,

    -- forward-looking multi-variant
    variant_count INTEGER NOT NULL DEFAULT 1,

    -- execution
    status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
    error TEXT,

    started_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS generate_foley__tracks (
    generation_id TEXT NOT NULL REFERENCES generate_foley__generations(id),
    pool_segment_id TEXT NOT NULL REFERENCES pool_segments(id),
    variant_index INTEGER NOT NULL,
    replicate_prediction_id TEXT NOT NULL,
    duration_seconds REAL,
    spend_ledger_id TEXT,
    PRIMARY KEY (generation_id, pool_segment_id)
);

CREATE INDEX IF NOT EXISTS idx_foley_gen_status ON generate_foley__generations(status);
CREATE INDEX IF NOT EXISTS idx_foley_gen_entity ON generate_foley__generations(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_foley_tracks_pool ON generate_foley__tracks(pool_segment_id);
```

### 2. Schema notes

- `pool_segment_id` in `__tracks` has no ON DELETE clause — pool_segments are content-addressed and shouldn't be deleted while a generation references them. If needed later, add `ON DELETE RESTRICT` via a follow-up migration.
- `variant_count` is `INTEGER NOT NULL DEFAULT 1` — MVP always writes 1; future multi-variant writes N.
- `mode` is required; enforced by CHECK constraint.
- `entity_type` allows NULL for t2fx; CHECK constraint ensures only `'transition'` (or NULL) for now — future entity types add to the CHECK.
- Both tables prefix with `generate_foley__` (double underscore) matching M16's `generate_music__*` convention for plugin-owned sidecars.

### 3. Migration idempotency

All CREATEs use `IF NOT EXISTS`. Re-running on a project that already has these tables is a no-op. Verify by applying the migration twice in tests.

### 4. No changes to `pool_segments` or `spend_ledger`

Both are already at the shape this plugin needs (M13 + M16 landed). Existing columns consumed:
- `pool_segments.variant_kind` — write `'foley'`
- `pool_segments.context_entity_type`, `context_entity_id` — write from `generate_foley__generations.entity_*`
- `pool_segments.derived_from` — v2fx only, points to source tr_candidate's pool_segment
- `pool_segments.generation_params` (JSON) — `{provider, model, prompt, cfg_strength, seed, ...}`
- `pool_segments.created_by` — `'plugin:generate-foley'`
- `pool_segments.kind` — `'generated'`
- `spend_ledger` row written by `plugin_api.providers.replicate.run_prediction` with `source='generate_foley'`, `unit='prediction'`, `amount=1`

### 5. Tests

- Fresh project DB: migration applies cleanly, both tables exist with expected schema.
- Project DB with M13/M16 state: migration applies cleanly, no conflicts.
- Re-apply: second run is a no-op.
- CHECK constraint: inserting `mode='invalid'` fails; inserting `status='weird'` fails.
- FK constraint: `__tracks.generation_id` must reference an existing `__generations.id`; `pool_segment_id` must reference an existing pool row.

---

## Verification

- [ ] Migration file created and numbered sequentially
- [ ] Both tables created with correct schema
- [ ] All indexes created
- [ ] Idempotent re-application (no errors on second run)
- [ ] Applies on a fresh project AND on one with existing M13/M16 schema state
- [ ] CHECK constraints enforce `mode ∈ {t2fx, v2fx}` and `status ∈ {pending, running, completed, failed}`
- [ ] FK constraints reject orphan rows in `__tracks`
- [ ] No modifications to `pool_segments` or `spend_ledger` schemas

---

## Expected Output

```
scenecraft-engine/migrations/
└── NNNN_foley_generations.sql     (new)

scenecraft-engine/tests/migrations/
└── test_foley_schema.py           (new)
```

---

## Notes

- Follow existing migration numbering convention — check latest applied migration before picking NNNN.
- `spend_ledger_id` in `__tracks` is nullable because download-failed-after-prediction-charged writes the tracks row with a non-null `spend_ledger_id` but can leave the full lifecycle incomplete — tighten to NOT NULL only if we can guarantee it's always set before insert.

---

**Next Task**: [task-144](task-144-backend-plugin-module.md) — Backend plugin module
