# Task 106: Schema Migration — `derived_from` + `variant_kind` on pool_segments

**Milestone**: [M13 - Audio Sync Tab](../../milestones/milestone-13-audio-sync.md)
**Design Reference**: [local.audio-sync.md](../../design/local.audio-sync.md)
**Estimated Time**: 2 hours
**Dependencies**: None (net-new columns on an existing table)
**Status**: Not Started

---

## Objective

Add the two nullable columns that turn `pool_segments` into a parent-linked graph for candidate variants. Update existing helpers to read/write the new columns and surface them on the `candidateDetails[]` API response.

Implements in `scenecraft-engine/src/scenecraft/db.py` and `api_server.py`.

---

## Steps

### 1. Schema — idempotent migration

In `_ensure_schema` (or the equivalent migration block), add:

```python
cols = {row[1] for row in conn.execute("PRAGMA table_info(pool_segments)").fetchall()}
if "derived_from" not in cols:
    conn.execute("ALTER TABLE pool_segments ADD COLUMN derived_from TEXT REFERENCES pool_segments(id)")
if "variant_kind" not in cols:
    conn.execute("ALTER TABLE pool_segments ADD COLUMN variant_kind TEXT")
conn.execute(
    "CREATE INDEX IF NOT EXISTS idx_pool_segments_derived_from "
    "ON pool_segments(derived_from) WHERE derived_from IS NOT NULL"
)
```

Existing rows get `NULL` for both. No backfill.

### 2. Helper updates

Update `_row_to_pool_segment` (or equivalent) to include:

```python
seg["derivedFrom"] = row["derived_from"]
seg["variantKind"] = row["variant_kind"]
```

Update `insert_pool_segment` (or wherever new pool_segments are written) to accept optional `derived_from` and `variant_kind` parameters.

### 3. API response

In `api_server.py`, wherever `candidateDetails[]` is assembled (currently for `GET /api/projects/:name/transitions`), include the two new fields from the pool_segment rows. No response-shape surprise — just carry them through.

### 4. VCS compatibility

- Audit `DIFFABLE_TABLES` and row-level diff helpers to confirm the new columns are picked up automatically (they should, since the diff machinery walks `PRAGMA table_info`).
- If the diff engine hard-codes column lists anywhere, add the two new columns.

### 5. Tests

New file or additions to existing `test_candidate_pool.py`:

- Fresh DB: migration creates columns + index
- Existing DB (simulate by creating without the columns): migration block adds them idempotently; running twice is a no-op
- Insert a pool_segment with `derived_from` + `variant_kind='lipsync'`; read back; values round-trip
- FK enforcement: inserting a pool_segment with a non-existent `derived_from` raises (or is caught at the helper boundary — depends on SQLite PRAGMA foreign_keys setting used in the project; match existing behavior)
- `candidateDetails[]` response includes `derivedFrom` and `variantKind` for both NULL and non-NULL cases

---

## Verification

- [ ] Migration runs on a fresh DB and creates both columns + index
- [ ] Migration runs on an existing DB without the columns and is idempotent
- [ ] `insert_pool_segment` accepts `derived_from` and `variant_kind`
- [ ] `_row_to_pool_segment` returns `derivedFrom` and `variantKind`
- [ ] `GET /transitions/:tr_id` response carries the two fields on every `candidateDetails[]` entry
- [ ] All existing pool-segment tests still pass
- [ ] New test covers round-trip of the new columns
