# Unified Candidate Pool Migration

**Concept**: Consolidate per-transition candidate directories (`transition_candidates/{tr_id}/slot_N/v*.mp4`) into the existing shared `pool/segments/` directory, with a junction table tracking tr → candidate associations. Decouple candidate storage from transition identity.  
**Created**: 2026-04-16  
**Status**: Design Specification  

---

## Overview

Today, generated transition videos live in a per-transition directory (`transition_candidates/{tr_id}/slot_N/v*.mp4`) and the `transitions.selected` column stores a 1-based rank that maps to a filename (`v{rank}.mp4`). Meanwhile, the project already has a standalone asset pool at `pool/keyframes/` and `pool/segments/` where users can import or stage raw media.

This design unifies these: all generated transition videos become ordinary pool entries, and a new junction table records which candidates belong to which transition. Splits, duplicates, and cross-transition candidate sharing become cheap DB operations rather than filesystem copies.

---

## Problem Statement

### Current issues

1. **Split duplicates files**: the M7 clip-trim split copies entire candidate directories from the original tr to each half. For a tr with 5 candidates at ~20MB each, that's 100MB duplicated per split.
2. **No candidate sharing**: if you like a generated clip, there's no way to use it on another tr without file copy + rank reassignment.
3. **Orphaned candidates**: when a tr is soft-deleted or hard-deleted, its candidate files become orphaned (or must be manually cleaned).
4. **Rank fragility**: `selected` is a 1-based integer. Deleting a candidate file (`v2.mp4`) makes `selected=2` point at something unexpected (or missing).
5. **Two separate asset systems**: `transition_candidates/` (owned by trs, generation output) vs `pool/segments/` (user-imported, unowned). User-imported videos must be explicitly `assign-pool-video` to a tr, which copies the file — same duplication issue.

### Design constraints

- Greenfield — no production data to preserve, no backwards compat required
- Must support the M7 clip-trim split cleanly (metadata-only split)
- Must preserve the "variant rank" UI abstraction (v1, v2, v3 in the candidates tab) so frontend changes are minimal
- Must not block on the git-version-control milestone (M6 assets are shared across branches; this migration should play nicely with that)

---

## Solution

### Storage model

All transition videos live in a flat pool: `pool/segments/`. **Every file is UUID-addressed.** Generated candidates use `cand_{uuid4}.mp4`; user-imported media uses `import_{uuid4}.{ext}`. Original filenames and user-facing labels are preserved in a `pool_segments` table — the filesystem does not carry naming meaning beyond the prefix.

```
project/
  pool/
    segments/
      cand_a3f8c2e9-0e10-4e1a-b2c3-001122334455.mp4    ← AI-generated
      cand_b7d1e4f3-9a88-4d12-8e40-998877665544.mp4    ← AI-generated
      import_c4a1f209-4d2e-48b1-8f93-aabbccddeeff.mov  ← user-imported (originally `drone_shot.mov`)
    keyframes/
      ...
```

### Schema

Two new tables: `pool_segments` (the authoritative record of every pool file) and `tr_candidates` (the junction mapping transitions to pool segments).

```sql
CREATE TABLE IF NOT EXISTS pool_segments (
    id TEXT PRIMARY KEY,                -- UUID (matches the filename stem's uuid portion)
    pool_path TEXT NOT NULL UNIQUE,     -- e.g., "pool/segments/cand_<uuid>.mp4" or "pool/segments/import_<uuid>.mov"
    kind TEXT NOT NULL,                 -- 'generated' | 'imported'
    created_by TEXT NOT NULL,           -- username of the user who generated or imported this file (immutable)
    original_filename TEXT,             -- user-provided name for imports (e.g., "drone_shot.mov"); null for generated
    original_filepath TEXT,             -- full source path on the importing user's machine at upload time (e.g., "/Volumes/RAID/footage/drone_shot.mov"); null for generated. Informational only — not used for reads.
    label TEXT,                         -- user-editable display name (defaults to original_filename for imports, empty for generated)
    generation_params TEXT,             -- JSON blob: full generation context for 'generated' rows; null for imports
    created_at TEXT NOT NULL,
    duration_seconds REAL,              -- cached ffprobe result
    width INTEGER,                      -- cached ffprobe result
    height INTEGER,                     -- cached ffprobe result
    byte_size INTEGER                   -- stat().st_size cache
);

CREATE INDEX IF NOT EXISTS idx_pool_segments_kind ON pool_segments(kind);
CREATE INDEX IF NOT EXISTS idx_pool_segments_created_by ON pool_segments(created_by);

CREATE TABLE IF NOT EXISTS pool_segment_tags (
    pool_segment_id TEXT NOT NULL REFERENCES pool_segments(id),
    tag TEXT NOT NULL,
    tagged_by TEXT NOT NULL,            -- username of the user who applied this tag
    tagged_at TEXT NOT NULL,
    PRIMARY KEY (pool_segment_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_pool_segment_tags_tag ON pool_segment_tags(tag);
CREATE INDEX IF NOT EXISTS idx_pool_segment_tags_segment ON pool_segment_tags(pool_segment_id);

CREATE TABLE IF NOT EXISTS tr_candidates (
    transition_id TEXT NOT NULL REFERENCES transitions(id),
    slot INTEGER NOT NULL DEFAULT 0,
    pool_segment_id TEXT NOT NULL REFERENCES pool_segments(id),
    added_at TEXT NOT NULL,             -- drives display order (ORDER BY added_at ASC); no stored rank column
    source TEXT NOT NULL,               -- 'generated' | 'imported' | 'split-inherit' | 'cross-tr-copy'
    PRIMARY KEY (transition_id, slot, pool_segment_id)
);

CREATE INDEX IF NOT EXISTS idx_tr_candidates_tr ON tr_candidates(transition_id);
CREATE INDEX IF NOT EXISTS idx_tr_candidates_segment ON tr_candidates(pool_segment_id);
CREATE INDEX IF NOT EXISTS idx_tr_candidates_order ON tr_candidates(transition_id, slot, added_at);
```

**Normalized tags** (not JSON array): feature-film projects can have 10,000+ segments. JSON array queries aren't index-friendly in SQLite — they require full-table scans plus `json_each` unpacking. A normalized `pool_segment_tags` table gives indexed lookups (`WHERE tag = 'keeper'`), merge-friendly semantics (adding/removing a tag is a row-level op, no string collision), and per-tag attribution for free (`tagged_by`, `tagged_at`).

**Rank is derived, not stored.** The UI's `v1`, `v2`, `v3` display comes from ordering `tr_candidates` rows by `added_at ASC` within `(transition_id, slot)`. Display rank is purely a rendered label.

**`transitions.selected` changes from rank (INTEGER) to pool_segment_id (TEXT).** Since rank is derived from `added_at` and can shift when rows are added (especially across branch merges), storing a rank as the selection would silently remap what's selected when new candidates appear. Storing the `pool_segment_id` directly is semantically stable — "the user picked this specific file" — and survives merges cleanly.

**Lookup path**: `transitions.selected` → `pool_segments.id` → `pool_segments.pool_path` → serve file.

**Migration of `transitions.selected`**: schema change from `INTEGER` to `TEXT`. No data to migrate (greenfield). The column's null/empty semantics for "no selection" carry over unchanged.

**Why derive rank (not store it)**: when two branches generate candidates in parallel and both want `rank=3`, a stored rank column would conflict at merge time. With derived rank, both candidates simply append to the ordering based on their timestamps — purely additive, no conflict. Generation order is preserved naturally.

**Generation params capture**: every `generated` pool segment stores a JSON `generation_params` blob recording everything needed to reproduce or iterate on that generation:

```json
{
  "provider": "google-veo",
  "model": "veo-3",
  "prompt": "cinematic pan over sunset mountains",
  "negative_prompt": "",
  "seed": 42,
  "ingredients": {
    "from_keyframe_image": "pool/keyframes/kf_abc.png",
    "to_keyframe_image": "pool/keyframes/kf_def.png",
    "motion_prompt": "slow camera drift",
    "section_description": "establishing shot",
    "refinement_prompt": ""
  },
  "params": {
    "duration_target": 5.0,
    "fps": 24,
    "resolution": [1920, 1080]
  }
}
```

Schema is provider-specific — Veo, Kling, Wan2.1 each write their own shape. Frontend feature "Regenerate with same settings" / "Use as base for new generation" reads this blob and POSTs it back as the generation request body.

**Why on `pool_segments`, not `tr_candidates`**: generation params describe how the file was made — an intrinsic property of the pool segment. If the same segment gets attached to multiple trs via cross-tr sharing or split-inherit, all attachments see the same generation history. Imports leave `generation_params = null`.

**Why two tables, not one**: pool files can exist without being associated with any transition (e.g., a user imports an asset for later use, or a generated candidate gets detached from its original tr). The `pool_segments` table is the canonical record of every file in the pool, independent of any transition. `tr_candidates` is strictly the association layer.

**Frontend change**: the candidates panel still displays `v1, v2, v3` (derived from the sorted junction rows at render time). Clicking "Select v2" sends `pool_segment_id` (read from the rendered row) instead of an integer rank. The rank label is presentation-only.

### Selected transition video

`selected_transitions/{tr_id}_slot_N.mp4` continues to exist as a convenience cache — it's a copy of the currently-selected candidate, used by the render path. On variant switch, refresh the cache from the pool.

Alternative considered: drop the cache, read directly from pool. Works but changes many file paths in render/narrative code. Keeping the cache is a minimal-change migration.

### Operations

**Generate candidates** (existing `_handle_generate_transition_candidates`):
- Write video files directly to `pool/segments/cand_{uuid4}.mp4`
- Insert a `pool_segments` row with `kind='generated'`, `id = uuid`, `created_by = <authenticated user>`, full `generation_params` JSON (provider, model, prompt, negative_prompt, seed, ingredients, params), and ffprobe metadata
- Insert a `tr_candidates` row with `source='generated'`, `added_at = now()`; no stored rank
- Response format unchanged (frontend sees the same candidate URLs; derives v1/v2/v3 by `added_at` sort)

**Import a user file** (existing upload / file-browser paste flow):
- Generate a new UUID
- Preserve the original filename + extension AND the full original source path for metadata
- Write the file to `pool/segments/import_{uuid}.{ext}`
- Insert a `pool_segments` row with `kind='imported'`, `created_by = <authenticated user>`, `original_filename=<basename>`, `original_filepath=<full source path>`, `label=<basename>` (editable later), `generation_params=null`, and ffprobe metadata
- Do NOT insert a `tr_candidates` row yet — imports start unattached; the user attaches them to a tr via a separate action

**Assign pool segment to transition** (existing `assign-pool-video`):
- No file copy. Insert a `tr_candidates` row with the target `transition_id`, `pool_segment_id` pointing at the existing row, `added_at = now()`, and `source='imported'`

**Select variant** (existing `_handle_select_transitions`):
- Request body provides `pool_segment_id` (not a rank integer)
- Write `transitions.selected = pool_segment_id`
- Resolve `pool_segment_id` → `pool_path` via `pool_segments` join
- Copy pool file to `selected_transitions/{tr_id}_slot_N.mp4` (keep the cache hot)
- Use cached `duration_seconds` from `pool_segments` for `source_video_duration`, clamp trim

**Regenerate with same settings** (new affordance):
- Given a pool_segment_id, load `pool_segments.generation_params`
- POST to `generate-transition-candidates` with the same params as the request body (user can optionally tweak before submitting — e.g., new seed, edited prompt)
- Result is a new pool segment + tr_candidates row; old candidate remains

**Split transition** (M7 Task 45 — revised):
- Clone junction rows: for every row in `tr_candidates WHERE transition_id = orig_id`, insert two new rows with `transition_id = tr1_id` and `tr2_id`, same `pool_segment_id`, preserve the original `added_at` so display ordering is stable, `source='split-inherit'`
- Copy selected cache to both halves' `selected_transitions/{tr1_id}_slot_0.mp4` and `selected_transitions/{tr2_id}_slot_0.mp4`
- Apply trim split math as before
- **No large file copies** — pool files stay put, only junction rows + the tiny cache are written

**Duplicate transition**:
- Same as split but with a single destination tr
- Clone junction rows for the new tr (preserve `added_at`), copy selected cache

**Delete transition** (soft-delete):
- Junction rows remain (soft-deletes are recoverable from the bin)
- On hard-delete: remove junction rows; `pool_segments` rows and files are NOT deleted by default (can be shared with other trs or live as standalone pool items)

**Rename a pool segment** (new UI affordance, optional):
- Update `pool_segments.label` — user-facing display name changes
- Filename on disk never changes — label is purely metadata
- `created_by` and `original_filename` are immutable — renaming never rewrites attribution or the import's original name

**Tag a pool segment**:
- Insert a row into `pool_segment_tags` with `pool_segment_id`, `tag`, `tagged_by = <authenticated user>`, `tagged_at = now()`
- Idempotent: `INSERT OR IGNORE` — same user tagging the same segment with the same tag twice is a no-op

**Untag a pool segment**:
- Delete the matching row from `pool_segment_tags`

**Query segments by tag** (pool browser filter):
- Indexed lookup: `SELECT ps.* FROM pool_segments ps JOIN pool_segment_tags t ON t.pool_segment_id = ps.id WHERE t.tag = ?`
- AND across tags: `WHERE ps.id IN (SELECT pool_segment_id FROM pool_segment_tags WHERE tag = ? INTERSECT SELECT pool_segment_id FROM pool_segment_tags WHERE tag = ?)`

**Garbage collection** (manual):
- `POST /api/projects/:name/pool/gc` — for each `pool_segments` row: if `kind='generated'` AND no `tr_candidates` row references it → delete row + file
- `kind='imported'` rows are never auto-deleted (user's own asset, stays in pool as a standalone)

### No migration

Greenfield. Delete any existing `transition_candidates/` directories and rebuild from generation. Schema ships with `tr_candidates` from day one — no legacy fallback path, no dual-read logic.

---

## API changes

| Endpoint | Change |
|---|---|
| `GET /api/projects/:name/keyframes` (the big fetcher) | Candidates for each tr come from `tr_candidates` join `pool_segments`, not filesystem scan. Response shape unchanged. |
| `GET /api/projects/:name/pool` | Reads from `pool_segments` table; returns `label`, `original_filename`, `kind`, duration/size metadata. Existing filesystem scan replaced by DB query. |
| `POST /api/projects/:name/generate-transition-candidates` | Write to pool; insert `pool_segments` + `tr_candidates` rows |
| `POST /api/projects/:name/pool/import` (new or existing upload endpoint) | Rename uploaded file to `import_{uuid}.{ext}`; insert `pool_segments` row preserving `original_filename` |
| `POST /api/projects/:name/select-transitions` | Body now sends `pool_segment_id` (UUID) instead of a rank integer. Backend writes `transitions.selected = pool_segment_id`, resolves to pool_path, refreshes cache |
| `POST /api/projects/:name/split-transition` | Clone junction rows, no file copies |
| `POST /api/projects/:name/assign-pool-video` | Insert `tr_candidates` row pointing at existing `pool_segments` row |
| `POST /api/projects/:name/insert-pool-item` | Resolves via `pool_segments` rows |
| (new) `POST /api/projects/:name/pool/rename` | Update `pool_segments.label` |
| (new) `POST /api/projects/:name/pool/tag` | Insert `pool_segment_tags` row (idempotent) |
| (new) `POST /api/projects/:name/pool/untag` | Delete matching `pool_segment_tags` row |
| (new) `GET /api/projects/:name/pool/tags` | List all distinct tags in use (for tag-picker UI) |
| (new) `GET /api/projects/:name/pool/gc-preview` | Preview garbage-collectible files |
| (new) `POST /api/projects/:name/pool/gc` | Execute garbage collection |

Frontend changes: minimal. The candidates panel still shows `v1`, `v2`, etc. — the rank-to-URL resolution just moves from filename-pattern to junction lookup. The pool panel renders `pool_segments.label` (or `original_filename` as fallback) instead of the raw filename.

---

## Cross-branch generation (M6 interaction)

When two users on different branches generate candidates for the same transition, the pool + junction model handles it cleanly:

- **Pool files are branch-shared** (per M6 asset model). Both users write their new candidate videos into the same `pool/segments/` directory. UUID naming guarantees no filename collision: `cand_<alice-uuid>.mp4` and `cand_<bob-uuid>.mp4` coexist.
- **`pool_segments` rows diverge per branch** (alice's DB has her row, bob's has his), but both reference files that exist physically on disk for both.
- **`tr_candidates` rows diverge per branch**, each pointing at their own `pool_segment_id`.
- **At merge time** (three-way SQL diff):
  - `pool_segments` — different PKs (different UUIDs), both rows auto-merge. Result: both candidates in the merged pool.
  - `tr_candidates` — different PKs (different `pool_segment_id`), both junction rows auto-merge. Result: tr has both candidates in its candidate list, ordered by `added_at`.
  - No rank conflict (rank is derived, not stored).
  - `transitions.selected` is the `pool_segment_id` of the chosen candidate. If only one user changed `selected`, it auto-merges. If both did, the value is a UUID pointing at a real row — standard row-level conflict UI: "Alice picked `cand_<alice>`, Bob picked `cand_<bob>`, choose one."

Because `selected` stores a stable `pool_segment_id` rather than a rank, the selection semantics never silently shift when new candidates appear in the merged list — Alice's pick stays pointed at Alice's candidate no matter what else gets merged in.

This is the key payoff of (a) deriving rank and (b) making `selected` a pool_segment_id: generation across branches is purely additive at the junction level, and selection state is stable under merge.

---

## Benefits

- **Cheap splits**: M7 clip-trim split becomes pure DB operations (junction row copy + selected cache copy) — no candidate directory duplication
- **Cross-tr sharing**: candidate can be associated with multiple trs by inserting multiple junction rows
- **Unified asset model**: generated candidates and user-imported media live in the same pool
- **Provenance tracking**: junction row's `prompt` and `source` columns preserve generation lineage
- **Garbage collection**: clear "unreferenced file" definition — no junction rows AND not flagged as imported
- **No variant rank drift**: junction rows are authoritative; filesystem scans no longer determine `selected` semantics
- **Plays well with M6 (git-style VCS)**: pool files are shared across branches, junction rows diverge per branch — same pattern as the asset/project.db split

---

## Trade-offs

- **Migration complexity**: moving files + inserting rows on every existing project. Must be idempotent, rollback-safe.
- **Additional junction table**: one more table to migrate, back up, version. Small cost.
- **Selected-video cache still exists**: `selected_transitions/{tr_id}_slot_N.mp4` remains as a duplicated file. Dropping it is follow-up work (requires updating render path to read from pool directly).
- **Sequenced before M7 split**: M7's metadata-only split depends on the junction table. Phases A–C must land before Task 45's split-transition handler is implemented. Split-blocking; trim-drag-UI is not blocked.

---

## Dependencies

- `sqlite3` schema additions (`tr_candidates` table + index)
- No new external libraries
- Plays nicely with M6 git-style VCS (pool files are branch-shared, junction rows are per-branch) — see `local.git-version-control.md` "Shared Asset Storage" section

---

## Phasing

### Phase A — Schema + junction table
1. Add `tr_candidates` table with indexes on `transition_id` and `pool_path`
2. Add helper functions in `db.py`: `add_tr_candidate`, `get_tr_candidates`, `remove_tr_candidate`, `clone_tr_candidates` (for split/duplicate)
3. No behavior change yet — junction table is written but not read

### Phase B — Generation pipeline writes to pool
1. Update `_handle_generate_transition_candidates` to write to `pool/segments/` and insert junction rows
2. Dual-read: `GET /api/projects/:name/keyframes` reads candidates from junction table first, falls back to filesystem scan for migrated-but-not-yet-migrated rows
3. Verify frontend candidate URLs resolve correctly via pool paths

### Phase C — Migration script
1. Write and test `migrate_candidates_to_pool(project_dir)` on sample projects
2. Gate behind a one-time migration flag (write `meta:candidate_pool_migrated = true` on completion)
3. Run on all existing projects; verify idempotency

### Phase D — Cheap splits
1. Update split handler to use junction-row cloning instead of directory copy
2. Update duplicate handler likewise
3. Benchmark split performance (expect ~100x speedup on trs with large candidate pools)

### Phase E — Drop filesystem fallback
1. Remove the fallback filesystem scan from `GET /api/projects/:name/keyframes`
2. Junction table is the sole source of candidate truth

### Phase F (optional) — Drop selected-video cache
1. Update render path to resolve `selected` → `pool_path` and read directly
2. Remove `selected_transitions/` cache
3. Requires touching many render code paths — separate follow-up

---

## Testing Strategy

- Fresh project: generate candidates → verify pool files + junction rows → select variant → verify render uses correct file
- Migration: project with 10+ trs, each with 3–5 candidates → run migration → verify all candidates moved, junction rows inserted, render still works
- Idempotent migration: run twice → second run is a no-op
- Split after migration: verify split creates junction rows without file copies; both halves render correctly
- Cross-tr share: insert same pool_path into two trs' junction rows → both render from the same file
- Garbage collection: delete a tr → verify orphaned candidates detected → run gc → verify files removed (or preserved if user-imported)

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Unified pool | Yes | Existing `pool/segments/` already exists — extend it rather than maintain two systems |
| Two tables (`pool_segments` + `tr_candidates`) | Yes | Pool files can exist without any tr association (imports, detached generations); junction is strictly the association layer |
| `selected` column form | **`pool_segment_id` (TEXT)**, not rank | Stable under merge and under insertion of new candidates with earlier `added_at`; rank is a derived display label, not a semantic identity |
| Rank storage | **Derived from `added_at`, not stored** | Cross-branch generation is purely additive at merge time — no rank conflicts; `v1`/`v2`/`v3` is a render-time label only |
| Generation provenance | `pool_segments.generation_params` JSON | Captures provider, model, prompt, negative_prompt, seed, ingredients, params; enables "regenerate with same settings" and "iterate on this candidate"; null for imports |
| Provenance location | `pool_segments`, not `tr_candidates` | Intrinsic to how the file was made; shared across all tr attachments |
| Selected-video cache | Keep (for now) | Minimizes render-path changes; dropping is Phase F |
| Pool file naming | UUID-addressed — always. `cand_{uuid4}.mp4` for generated, `import_{uuid4}.{ext}` for imports | Decoupled from tr identity; no filename collisions across trs/branches/users; original filenames preserved in DB |
| Import filename preservation | `pool_segments.original_filename` + `original_filepath` | User's original name AND source path kept as DB metadata; useful for "where did this come from?" provenance in long-running projects. Disk filename is always UUID-based; `original_filepath` is informational only. |
| Attribution | `pool_segments.created_by` (separate from `label`) | Immutable record of who generated/imported; renaming the label doesn't erase authorship |
| Tagging | Normalized `pool_segment_tags` table (not JSON) | Feature-film projects may have 10,000+ segments; normalized table gives indexed queries (`WHERE tag = ?`), merge-friendly row-level ops, and per-tag attribution (`tagged_by`, `tagged_at`) |
| GC policy | Manual endpoint, conservative defaults | Never auto-delete user-imported files; explicit admin action |
| Relation to M6 (git VCS) | Pool files live in branch-shared asset storage; pool_segments + tr_candidates rows live in project.db (per-branch) | Matches M6's "assets shared, DB per branch" model cleanly; merges additive on both tables |

---

## Future Considerations

- **Content-addressed naming** (e.g., SHA-256 hash as filename) — automatic dedup if two runs produce byte-identical candidates. Nice-to-have; not required.
- **Cross-project pool** — a global pool shared across projects in an org. Candidate reuse across sibling projects. Requires M6 to land first.
- **Candidate tagging** — tags on junction rows ("prefer", "rejected", "reference") for richer browsing than the current candidates panel.
- **Pool browser in UI** — show all pool segments, filter by tr association / source / tag. Adjacent to the existing bin panel.
- **Audio segment pool** — same pattern for audio clips and audio track sources.

---

**Status**: Design Specification  
**Recommendation**: Ship **before M7's split work**. The metadata-only split model in `local.clip-trim-and-snap.md` depends on the junction table and unified pool. Sequence: Phases A → B → C first, then resume M7 Task 45 with the junction-clone split approach; Phases D+ can follow in parallel with later M7 tasks.  
**Related Documents**:
- [`local.clip-trim-and-snap.md`](local.clip-trim-and-snap.md) — M7 work that depends on this migration's split primitives
- [`local.git-version-control.md`](local.git-version-control.md) — shared asset storage model that this migration aligns with
