# Spec: pool_segments Media Registry + variant_kind Discriminator

> **Agent Directive**: This is a retroactive black-box spec describing the
> observable behavior of the `pool_segments` table, its candidate junctions
> (`tr_candidates`, `audio_candidates`), the `pool_segment_tags` table, and
> the `variant_kind` / `derived_from` / `context_entity_*` columns as they
> exist today in `scenecraft-engine/src/scenecraft/db.py`. Behavior that the
> current source leaves ambiguous is flagged as `undefined` and linked to an
> Open Question.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive — describes shipped behavior as of M16)

---

## Purpose

Describe the contract of the content-addressed media pool (`pool_segments`)
and its `variant_kind` discriminator: how media enters the pool, how
candidates attach to timeline entities (keyframes via `tr_candidates`,
audio clips via `audio_candidates`), how derivation and provenance are
recorded (`derived_from`, `context_entity_{type,id}`), how tagging works,
and how `variant_kind` gates UI affordances such as clip coloring and the
candidates-tab visibility filter.

---

## Source

**Mode**: `--from-draft` (retroactive audit)
**Primary sources**:
- `scenecraft-engine/src/scenecraft/db.py` — schema (lines 254–296, 349–357, 1137–1158) and DAL (`add_pool_segment`, `get_pool_segment`, `list_pool_segments`, `update_pool_segment_label`, `delete_pool_segment`, `add_pool_segment_tag`, `remove_pool_segment_tag`, `get_pool_segment_tags`, `list_all_tags`, `find_segments_by_tag`, `add_tr_candidate`, `remove_tr_candidate`, `get_tr_candidates`, `clone_tr_candidates`, `count_tr_candidate_refs`, `find_gc_candidates`, `add_audio_candidate`, `get_audio_candidates`, `assign_audio_candidate`, `remove_audio_candidate`, `get_audio_clip_effective_path`, `set_pool_segment_context`)
- `scenecraft/src/lib/audio-clip-styling.ts` — `VARIANT_KIND_COLORS` map (music / lipsync / foley)
- `agent/reports/audit-2-architectural-deep-dive.md` §1B (data model)

---

## Scope

### In Scope
- `pool_segments` table columns, PK, uniqueness, and indexes.
- Lifecycle: insert via `add_pool_segment`, read, label edit, hard-delete.
- `variant_kind` discriminator values: `NULL` (user-imported / un-typed) vs
  the known derived set (`'music'`, `'foley'`, `'lipsync'`) and their UI
  consequences (clip colors, candidates-tab filter).
- `derived_from` content-derivation chain (pool → pool FK).
- `context_entity_type` / `context_entity_id` weak-reference provenance
  (M16 polymorphic entity selection at generation time).
- `pool_segment_tags` — normalized (segment, tag) junction with `tagged_by`
  / `tagged_at`; add / remove / list / search.
- `tr_candidates` — keyframe/transition → pool junction: PK
  `(transition_id, slot, pool_segment_id)`, `source` domain, `added_at`
  ordering, clone-on-split.
- `audio_candidates` — audio_clip → pool junction: PK
  `(audio_clip_id, pool_segment_id)`, `source` domain, selection
  promotion via `audio_clips.selected`, clear-on-remove behavior.
- GC: `find_gc_candidates` (kind='generated' with no tr_candidates refs).
- `get_audio_clip_effective_path` — selection resolver that prefers
  `pool_segments.pool_path` over `audio_clips.source_path`.

### Out of Scope
- Plugin sidecar tables (`generate_music__*`, `generate_foley__*`,
  `audio_isolations`, `isolation_stems`) — separate specs.
- `audio_clips` / `audio_tracks` / `transitions` full schema — separate
  specs; this spec only references `audio_clips.selected` FK to pool and
  `transitions` as a foreign identifier.
- ffprobe probe command details and file-on-disk layout — this spec treats
  probe-derived fields (`duration_seconds`, `width`, `height`, `byte_size`)
  as caller-supplied inputs.
- The `/api/pool/...` HTTP surface — separate spec.
- VCS interaction (pool files under `.scenecraft/` objects store).

---

## Requirements

### Table Structure

- **R1**: `pool_segments.id` is a 32-char hex UUID, generated server-side
  on insert, and is the primary key.
- **R2**: `pool_segments.pool_path` is `NOT NULL UNIQUE`. Two rows with
  the same `pool_path` cannot coexist.
- **R3**: `pool_segments.kind` is `NOT NULL` and restricted to
  `'generated' | 'imported'` by the DAL (asserted in `add_pool_segment`).
- **R4**: `pool_segments.created_by` is `NOT NULL` (default `''`). It is a
  free-form string (e.g., plugin id, `'user'`, `'chat'`); not validated
  against a closed set.
- **R5**: `pool_segments.created_at` is an ISO-8601 UTC string stamped at
  insert time. It is not updated by label edits.
- **R6**: `pool_segments.generation_params` is a JSON TEXT column; `NULL`
  for imported segments, JSON-serialized dict for generated segments. On
  read it is parsed back to a dict (or `None`).
- **R7**: `pool_segments.label` is `NOT NULL DEFAULT ''`; editable via
  `update_pool_segment_label`.
- **R8**: Probed media metadata (`duration_seconds`, `width`, `height`,
  `byte_size`) is nullable; populated by caller at insert (typically from
  `ffprobe`) and never auto-refreshed.

### variant_kind Discriminator

- **R9**: `variant_kind` is a nullable TEXT column. `NULL` means "regular
  user-imported / untyped segment". The known non-null domain at time of
  writing is `{'music', 'foley', 'lipsync'}` — the set the frontend's
  `VARIANT_KIND_COLORS` map recognizes.
- **R10**: The schema does NOT constrain `variant_kind` to an enum: any
  TEXT value inserts successfully. Unknown values fall through to the
  default clip-color branch on the frontend.
- **R11**: An index exists on `variant_kind` restricted to non-null rows
  (partial index `idx_pool_segments_variant_kind`).
- **R12**: The candidates-tab UI filters to segments where
  `variant_kind IS NULL` (untyped / user-imported only). Derived variants
  (music/foley/lipsync) are surfaced by their owning plugin panel, not
  the generic candidates tab.
- **R13**: `get_audio_clips` (list endpoint DAL) bulk-resolves
  `variant_kind` for each clip's `selected` pool_segment and exposes it
  as a derived field on the returned clip dict. Clips with no `selected`
  FK return `variant_kind: None`.

### Content Derivation — derived_from

- **R14**: `derived_from` is a nullable TEXT FK referencing
  `pool_segments(id)`. `NULL` means the segment is an original (imported
  or generated from nothing-in-pool).
- **R15**: `derived_from` is set at insert time by the generating plugin
  (via `add_pool_segment` callers; the column is settable from the DAL
  but there is no dedicated `set_derived_from` helper).
- **R16**: Chains are arbitrary depth. A lipsync output derived from a
  transition candidate's video is `derived_from` → that candidate's
  pool_segment id.
- **R17**: A partial index `idx_pool_segments_derived_from` exists for
  non-null rows.
- **R18**: `derived_from` FK carries `ON DELETE SET NULL`. Hard-deleting a
  parent promotes every dependent segment to a root (its `derived_from`
  becomes NULL). Inserting with a non-existent `derived_from` raises
  `sqlite3.IntegrityError` (FK enforcement assumes `PRAGMA foreign_keys=ON`
  for project.db). (Resolves OQ-1, OQ-2.)

### Weak-Reference Provenance — context_entity_*

- **R19**: `context_entity_type` and `context_entity_id` are nullable
  TEXT columns. They are polymorphic (no FK; no type check); the type
  discriminates what the id references (e.g., `'transition'`,
  `'audio_clip'`, `'keyframe'`).
- **R20**: They are stamped after insert via `set_pool_segment_context`.
- **R21**: `context_entity_*` is independent of `derived_from`:
  `context_entity_*` records "which entity was selected when this
  segment was generated" while `derived_from` records "which pool
  segment's content this was derived from". A segment may have one,
  both, or neither.
- **R22**: `set_pool_segment_context` optionally co-writes
  `variant_kind`. When `variant_kind` is passed (not `None`), it is
  written; when omitted/`None`, `variant_kind` is not touched.

### Tags — pool_segment_tags

- **R23**: `pool_segment_tags` has composite PK
  `(pool_segment_id, tag)`; duplicate `(segment, tag)` inserts are
  no-ops via `INSERT OR IGNORE`.
- **R24**: `add_pool_segment_tag` is idempotent: same `(seg, tag)` twice
  is a no-op (tagged_by / tagged_at of the first insert are preserved).
- **R25**: `remove_pool_segment_tag` deletes exactly the
  `(segment, tag)` row; silently no-ops if the row does not exist.
- **R26**: `get_pool_segment_tags` returns rows ordered by `tagged_at`
  ascending.
- **R27**: `list_all_tags` returns distinct tags with usage counts,
  ordered by count descending.
- **R28**: `find_segments_by_tag` returns pool_segments joined on the
  tags table, newest-first.
- **R29**: Deleting a pool_segment via `delete_pool_segment` also deletes
  its tag rows (same transaction).

### Candidate Junctions

#### tr_candidates (keyframes/transitions → pool)

- **R30**: `tr_candidates` PK is `(transition_id, slot, pool_segment_id)`.
  The same pool_segment can appear in multiple `(tr, slot)` tuples.
- **R31**: `tr_candidates.source` is restricted by DAL to
  `{'generated', 'imported', 'split-inherit', 'cross-tr-copy'}`.
- **R32**: `add_tr_candidate` is idempotent via `INSERT OR IGNORE` on the
  composite PK.
- **R33**: `get_tr_candidates(transition_id, slot)` returns rows joined
  to pool_segments, ordered by `added_at ASC` (stable rank for v1/v2/v3
  enumeration).
- **R34**: `clone_tr_candidates(src_tr, dst_tr, new_source)` copies all
  junction rows for `src_tr` to `dst_tr` preserving slot + added_at; by
  default `new_source='split-inherit'`. Returns number of source rows
  read (not rows inserted — duplicate PKs under
  `INSERT OR IGNORE` are counted).
- **R35**: `count_tr_candidate_refs(pool_segment_id)` returns the number
  of tr_candidates rows referencing a segment.

#### audio_candidates (audio_clips → pool)

- **R36**: `audio_candidates` PK is `(audio_clip_id, pool_segment_id)`.
- **R37**: `audio_candidates.source` is restricted by DAL to
  `{'generated', 'imported', 'chat_generation', 'plugin'}`.
- **R38**: `add_audio_candidate` is idempotent via `INSERT OR IGNORE`.
- **R39**: `get_audio_candidates(clip_id)` returns pool_segments joined
  newest-first (ORDER BY `added_at DESC`).
- **R40**: `assign_audio_candidate(clip_id, seg_id)` sets
  `audio_clips.selected = seg_id`. Passing `None` clears it (playback
  falls back to `audio_clips.source_path`).
- **R41**: `remove_audio_candidate(clip_id, seg_id)` deletes the junction
  row AND clears `audio_clips.selected` when it currently equals
  `seg_id`. Removing a non-selected candidate leaves `selected` alone.
- **R42**: `get_audio_clip_effective_path(clip)` returns
  `pool_segments.pool_path` for the clip's `selected` FK if present and
  the segment exists with a non-empty `poolPath`; otherwise returns
  `clip.source_path`.

### Garbage Collection

- **R43**: `find_gc_candidates` returns pool_segments rows with
  `kind='generated'` that are unreachable via any reference path.
  Segments with `kind='imported'` are never returned (user assets
  are never GC'd).
- **R44**: `find_gc_candidates` performs a full reachability query
  across ALL reference paths: `tr_candidates`, `audio_candidates`,
  `audio_clips.selected`, plugin sidecar tables
  (`generate_music__tracks.pool_segment_id`,
  `generate_foley__tracks.pool_segment_id`,
  `isolation_stems.pool_segment_id`, `transcribe__runs`), and the
  `derived_from` chain — if any downstream segment is kept, its
  ancestors are kept. (Resolves OQ-6.)
- **R45**: `delete_pool_segment` is hard-delete and performs a
  reference check across `tr_candidates`, `audio_candidates`,
  `audio_clips.selected`, plugin sidecar `*__tracks` tables (music,
  foley), `isolation_stems`, `transcribe__runs`, plus the
  `derived_from` incoming edge. Any live reference raises
  `PoolSegmentInUseError` and aborts. Otherwise deletes
  `pool_segment_tags` rows and the `pool_segments` row; does NOT
  delete the on-disk file (caller responsibility). (Resolves OQ-4.)
- **R45a**: `duration_seconds` and `byte_size` carry
  `CHECK (… >= 0)` constraints. Negative values raise
  `sqlite3.IntegrityError`. (Resolves OQ-5.)
- **R45b**: `_row_to_pool_segment` emits `variant_kind`,
  `derived_from`, `context_entity_type`, and `context_entity_id` as
  first-class fields. The redundant bulk-variant-kind resolver in
  `get_audio_clips` is removed. (Resolves OQ-8.)
- **R45c**: Broken-link pattern — a pool_segment row whose
  `pool_path` refers to a now-missing file persists in the DB.
  Clients detect the 404 at fetch time and render a
  "file missing — remove or reimport" placeholder in bin /
  waveform / preview. GC treats broken-link rows normally per
  reachability. (Resolves OQ-3.)
- **R45d**: Concurrent pool_segments DAL calls from the same
  `(user, project)` are out of scope per INV-1 (single-writer per
  user-project). No in-process lock is held across DAL calls.
  (Resolves OQ-7.)

### Soft vs Hard Delete

- **R46**: pool_segments has no `deleted_at` column — there is no soft
  delete. `delete_pool_segment` is permanent.
- **R47**: By contrast, `audio_clips` HAS `deleted_at` (soft delete);
  deleting an audio_clip does not cascade to `audio_candidates` rows —
  they are simply unreachable via the UI until restore.

---

## Interfaces / Data Shapes

### `pool_segments` row (camelCased by `_row_to_pool_segment`)

```
{
  id: str,                         // uuid hex
  poolPath: str,                   // unique on-disk path (relative)
  kind: 'generated' | 'imported',
  createdBy: str,                  // '' default; plugin-id / 'user' / ...
  originalFilename: str | null,
  originalFilepath: str | null,
  label: str,                      // '' default
  generationParams: dict | null,   // parsed JSON
  createdAt: str,                  // ISO-8601 UTC
  durationSeconds: float | null,
  width: int | null,
  height: int | null,
  byteSize: int | null,
  // M13/M16 columns — NOT currently emitted by _row_to_pool_segment
  // (see Open Questions); stored in DB but omitted from this DTO:
  //   variant_kind, derived_from, context_entity_type, context_entity_id
}
```

### DAL — core CRUD

```
add_pool_segment(project_dir, *, kind, created_by, pool_path,
  original_filename=None, original_filepath=None, label='',
  generation_params=None, duration_seconds=None, width=None,
  height=None, byte_size=None) -> str  # new seg id

get_pool_segment(project_dir, seg_id) -> dict | None
list_pool_segments(project_dir, kind=None) -> list[dict]  # newest first
update_pool_segment_label(project_dir, seg_id, label) -> None
delete_pool_segment(project_dir, seg_id) -> None  # hard delete
```

### DAL — variant/context

```
set_pool_segment_context(project_dir, seg_id, *,
  context_entity_type, context_entity_id,
  variant_kind=None  # when not None, co-writes variant_kind
) -> None
```

### DAL — tags

```
add_pool_segment_tag(project_dir, seg_id, tag, tagged_by) -> None
remove_pool_segment_tag(project_dir, seg_id, tag) -> None
get_pool_segment_tags(project_dir, seg_id) -> list[{tag, taggedBy, taggedAt}]
list_all_tags(project_dir) -> list[{tag, count}]
find_segments_by_tag(project_dir, tag) -> list[pool_segment]
```

### DAL — tr_candidates

```
add_tr_candidate(project_dir, *, transition_id, slot,
  pool_segment_id, source, added_at=None) -> None
remove_tr_candidate(project_dir, transition_id, slot, seg_id) -> None
get_tr_candidates(project_dir, transition_id, slot=0)
  -> list[pool_segment & {addedAt, junctionSource}]  # ASC
clone_tr_candidates(project_dir, *, source_transition_id,
  target_transition_id, new_source='split-inherit') -> int
count_tr_candidate_refs(project_dir, seg_id) -> int
find_gc_candidates(project_dir) -> list[pool_segment]
```

### DAL — audio_candidates

```
add_audio_candidate(project_dir, *, audio_clip_id, pool_segment_id,
  source, added_at=None) -> None
get_audio_candidates(project_dir, audio_clip_id)
  -> list[pool_segment & {addedAt, junctionSource}]  # DESC
assign_audio_candidate(project_dir, audio_clip_id, seg_id | None) -> None
remove_audio_candidate(project_dir, audio_clip_id, seg_id) -> None
get_audio_clip_effective_path(project_dir, audio_clip_dict) -> str
```

### Frontend `VARIANT_KIND_COLORS` (authoritative UI set)

```
'music'   -> purple
'lipsync' -> teal
'foley'   -> orange
*         -> cyan (DEFAULT_CLIP_COLORS)
```

---

## Behavior Table

| #  | Scenario                                                                   | Expected Behavior                                                            | Tests |
|----|-----------------------------------------------------------------------------|-------------------------------------------------------------------------------|-------|
| 1  | Insert an imported pool_segment with valid fields                           | Row inserted, new UUID returned, createdAt stamped                            | `insert-imported-segment-returns-uuid` |
| 2  | Insert a generated pool_segment with generationParams dict                  | generationParams serialized to JSON and parsed back on read                   | `generation-params-roundtrip` |
| 3  | Insert with `kind` outside {'generated','imported'}                         | Assertion error; no row inserted                                              | `rejects-bad-kind` |
| 4  | Insert two rows with the same pool_path                                     | Second insert raises `sqlite3.IntegrityError` on UNIQUE violation             | `duplicate-pool-path-rejected` |
| 5  | Read a segment that does not exist                                          | Returns None                                                                  | `get-missing-returns-none` |
| 6  | `list_pool_segments` with no filter                                         | All segments, newest-first                                                    | `list-all-newest-first` |
| 7  | `list_pool_segments(kind='imported')`                                       | Only imported segments                                                        | `list-filtered-by-kind` |
| 8  | `update_pool_segment_label`                                                 | Label updated; createdAt unchanged                                            | `update-label-preserves-createdat` |
| 9  | `delete_pool_segment`                                                       | Row + all tag rows removed; does NOT verify references                       | `delete-is-hard-and-cascades-tags` |
| 10 | `set_pool_segment_context` with variant_kind='music'                        | variant_kind + context_entity_* all written                                   | `set-context-with-variant-kind` |
| 11 | `set_pool_segment_context` without variant_kind arg                         | Only context_entity_* written; existing variant_kind untouched                | `set-context-preserves-variant-kind` |
| 12 | `set_pool_segment_context` with variant_kind='bogus-kind'                   | Value stored verbatim (no enum check); frontend falls back to default cyan   | `variant-kind-accepts-unknown-values` |
| 13 | Insert segment with `derived_from` = valid parent id                        | FK stored; chain readable by id                                               | `derived-from-stored` |
| 14 | Insert segment with `derived_from` = non-existent id                        | Raises `sqlite3.IntegrityError` (FK enforced; migration adds ON DELETE SET NULL) | `derived-from-bad-parent-raises-integrity` |
| 15 | Delete a segment that is referenced via `derived_from` by another           | Parent deleted; dependents' `derived_from` set to NULL (promoted to roots)    | `derived-from-parent-delete-sets-null` |
| 16 | `add_pool_segment_tag` same (seg, tag) twice                                | Second call is a no-op; first tagged_by/tagged_at preserved                   | `tag-idempotent` |
| 17 | `remove_pool_segment_tag` on absent tag                                     | Silent no-op                                                                  | `remove-tag-missing-noop` |
| 18 | `find_segments_by_tag` unknown tag                                          | Empty list                                                                    | `find-by-unknown-tag-empty` |
| 19 | `add_tr_candidate` with `source='bogus'`                                    | Assertion error; no row inserted                                              | `rejects-bad-tr-source` |
| 20 | `add_tr_candidate` same (tr, slot, seg) twice                               | Second call is a no-op via INSERT OR IGNORE                                   | `tr-candidate-idempotent` |
| 21 | `get_tr_candidates`                                                         | Joined pool_segment rows, ordered by added_at ASC                             | `tr-candidates-sorted-asc` |
| 22 | `clone_tr_candidates` preserves slot + added_at + rewrites source           | All src rows copied; target's source column = `new_source`                    | `clone-preserves-slot-added-at` |
| 23 | `count_tr_candidate_refs` on unreferenced segment                           | Returns 0                                                                     | `count-zero-for-unreferenced` |
| 24 | `find_gc_candidates`                                                        | Returns only kind='generated' with zero tr_candidates refs                    | `gc-excludes-imported-and-referenced` |
| 25 | `find_gc_candidates` — segment referenced ONLY by audio_candidates          | NOT returned (full reachability: audio_candidates consulted)                  | `gc-respects-audio-candidates` |
| 26 | `add_audio_candidate` with `source='bogus'`                                 | Assertion error; no row inserted                                              | `rejects-bad-audio-source` |
| 27 | `add_audio_candidate` same (clip, seg) twice                                | Second call is a no-op                                                        | `audio-candidate-idempotent` |
| 28 | `get_audio_candidates`                                                      | Joined pool_segments, newest-first (added_at DESC)                            | `audio-candidates-sorted-desc` |
| 29 | `assign_audio_candidate(clip, seg)`                                         | audio_clips.selected := seg                                                   | `assign-sets-selected` |
| 30 | `assign_audio_candidate(clip, None)`                                        | audio_clips.selected := NULL                                                  | `assign-none-clears-selected` |
| 31 | `remove_audio_candidate` when it is currently selected                      | Junction row deleted AND audio_clips.selected cleared                         | `remove-selected-clears-selection` |
| 32 | `remove_audio_candidate` when another segment is selected                   | Junction row deleted; selected left alone                                     | `remove-nonselected-preserves-selection` |
| 33 | `get_audio_clip_effective_path` with selected seg present                   | Returns pool_segments.pool_path                                               | `effective-path-prefers-selected` |
| 34 | `get_audio_clip_effective_path` with selected seg missing                   | Falls back to clip.source_path                                                | `effective-path-falls-back-when-missing` |
| 35 | `get_audio_clip_effective_path` with selected=None                          | Returns clip.source_path                                                      | `effective-path-default-to-source` |
| 36 | Clip's selected pool_segment has variant_kind='music'                       | Clip rendered with purple colors                                              | `clip-color-follows-variant-kind` |
| 37 | Clip's selected pool_segment has variant_kind=NULL                          | Clip rendered with default cyan                                               | `null-variant-kind-default-color` |
| 38 | Candidates tab listing for a keyframe                                       | Filters to pool_segments with variant_kind IS NULL                            | `candidates-tab-filters-variant-kind` |
| 39 | pool_path points to a file that has been deleted from disk                  | Row persists; client detects 404 and renders broken-link placeholder (bin / waveform / preview) | `broken-link-row-persists-client-detects` |
| 40 | Concurrent `add_pool_segment_tag` (same seg/tag, two connections)           | Both succeed (second is no-op); exactly one row; no exception                 | `concurrent-tag-add-no-error` |
| 41 | `delete_pool_segment` when referenced by tr_candidates (or other live refs) | Raises `PoolSegmentInUseError`; no row deleted                                 | `delete-raises-when-live-refs` |
| 42 | Insert pool_segment with negative `duration_seconds` / `byte_size`          | Raises `sqlite3.IntegrityError` (CHECK constraint ≥ 0); no row inserted        | `negative-metadata-rejected` |
| 43 | `generation_params` is an unserializable object                             | `json.dumps` raises; insert fails before SQL executes                         | `rejects-non-json-generation-params` |

---

## Behavior

### Insert flow

1. Caller invokes `add_pool_segment(kind=..., pool_path=..., ...)` with
   ffprobe-derived media metadata already gathered.
2. DAL asserts `kind in {'generated','imported'}`.
3. DAL generates a UUID4 hex id.
4. DAL `INSERT`s; if `pool_path` collides with an existing row, SQLite
   raises `IntegrityError` (UNIQUE constraint).
5. `generation_params` is serialized via `json.dumps` (or NULL).
6. `created_at` is stamped as ISO-8601 UTC now.
7. On commit, seg id is returned.

### Variant/context stamping (post-insert)

1. Generating plugin inserts the base row.
2. Plugin calls `set_pool_segment_context(seg_id,
   context_entity_type='transition', context_entity_id=<tr_id>,
   variant_kind='music'|'foley'|'lipsync')`.
3. Frontend clip rendering resolves `variant_kind` from the
   pool_segment referenced by `audio_clips.selected`; UI colors follow
   the `VARIANT_KIND_COLORS` map.

### Candidate attach flow (audio)

1. User drops a pool_segment onto an audio clip.
2. Frontend calls `add_audio_candidate(clip_id, seg_id,
   source='imported')`.
3. Frontend calls `assign_audio_candidate(clip_id, seg_id)` to promote.
4. Playback engine reads via `get_audio_clip_effective_path` which
   resolves to the selected pool_segment's `pool_path`.

### Candidate attach flow (keyframe/transition)

1. Imagen/Veo worker generates a video → adds a `pool_segments` row
   (kind='generated'), then adds a `tr_candidates` row
   `(tr_id, slot, seg_id, source='generated')`.
2. UI enumerates `get_tr_candidates(tr_id, slot)` for v1/v2/v3 rank.
3. User promotes candidate N → `transitions.selected_candidate` (out
   of scope for this spec; lives on the transitions table).

### Split / duplicate (tr_candidates cloning)

1. User splits transition T into T_left, T_right.
2. Caller invokes `clone_tr_candidates(src=T, dst=T_left,
   new_source='split-inherit')` and again for T_right.
3. Both inherit the full candidate list; promotion is independent
   thereafter.

### GC

1. Caller invokes `find_gc_candidates()` to preview.
2. Returns generated segments with zero `tr_candidates` rows.
3. Segments referenced only by `audio_candidates` / `isolation_stems` /
   plugin sidecars are NOT excluded — they will be listed as GC'able
   but may still be in use. Delete with care (see OQ-4 / OQ-6).

---

## Acceptance Criteria

- [ ] `pool_path` UNIQUE is enforced: duplicate insert raises
      `IntegrityError`.
- [ ] `kind` outside {'generated','imported'} raises `AssertionError`.
- [ ] Round-trip: insert → get → fields match; `generationParams` is a
      dict (not a JSON string).
- [ ] Label edit preserves `createdAt`.
- [ ] Hard-delete removes tag rows in the same commit; on-disk file is
      NOT touched by the DAL.
- [ ] `variant_kind` column accepts arbitrary TEXT; no enum.
- [ ] UI clip color follows the `VARIANT_KIND_COLORS` map, with cyan
      default for NULL / unknown values.
- [ ] `set_pool_segment_context` without `variant_kind` kwarg does NOT
      clobber an existing variant_kind.
- [ ] All four tr_candidate sources valid; all others asserted out.
- [ ] All four audio_candidate sources valid; all others asserted out.
- [ ] `remove_audio_candidate` clears `audio_clips.selected` iff the
      removed segment was selected.
- [ ] `find_gc_candidates` filters kind='imported' out and excludes
      segments with tr_candidates refs.
- [ ] `get_audio_clip_effective_path` prefers `pool_path` when selected
      segment exists with non-empty poolPath; falls back to
      `source_path` when `selected` is None OR the pool_segment is
      missing OR its poolPath is empty.
- [ ] Tag add is idempotent on `(seg, tag)` via `INSERT OR IGNORE`.

---

## Tests

### Base Cases

#### Test: insert-imported-segment-returns-uuid (covers R1, R3, R5)

**Given**: empty project.db with schema initialized
**When**: `add_pool_segment(kind='imported', created_by='user',
pool_path='pool/segments/abc.mp4')` is called
**Then** (assertions):
- **uuid-format**: return value is 32-char lowercase hex
- **row-exists**: `get_pool_segment(id)` returns a dict
- **kind-imported**: returned kind equals `'imported'`
- **created-at-iso**: `createdAt` parses as ISO-8601 with UTC tz
- **label-default-empty**: `label` equals `''`
- **generation-params-null**: `generationParams` is `None`

#### Test: generation-params-roundtrip (covers R6)

**Given**: project with schema
**When**: insert segment with
`generation_params={'prompt':'a cat','seed':7}`
**Then** (assertions):
- **stored-as-json**: underlying TEXT column contains a JSON string
- **parsed-on-read**: `get_pool_segment(id).generationParams` equals
  the original dict

#### Test: rejects-bad-kind (covers R3)

**Given**: schema ready
**When**: `add_pool_segment(kind='derived', ...)`
**Then** (assertions):
- **raises-assertion**: raises `AssertionError`
- **no-insert**: row count of `pool_segments` unchanged

#### Test: duplicate-pool-path-rejected (covers R2)

**Given**: one segment with `pool_path='pool/segments/x.mp4'`
**When**: insert another with the same pool_path
**Then** (assertions):
- **raises-integrity**: raises `sqlite3.IntegrityError`
- **count-still-one**: only one row with that pool_path

#### Test: get-missing-returns-none (covers R1)

**Given**: empty table
**When**: `get_pool_segment('deadbeef')`
**Then** (assertions):
- **returns-none**: returns `None` (not an empty dict)

#### Test: list-all-newest-first (covers R5)

**Given**: three segments inserted with increasing `created_at`
**When**: `list_pool_segments()`
**Then** (assertions):
- **order-desc-by-createdat**: rows ordered newest-first by `createdAt`
- **count-three**: length 3

#### Test: list-filtered-by-kind (covers R3)

**Given**: two imported, one generated
**When**: `list_pool_segments(kind='imported')`
**Then** (assertions):
- **only-imported**: all returned rows have `kind='imported'`
- **count-two**: length 2

#### Test: update-label-preserves-createdat (covers R7)

**Given**: segment with `createdAt = t0`
**When**: `update_pool_segment_label(id, 'new label')`
**Then** (assertions):
- **label-updated**: `get_pool_segment(id).label == 'new label'`
- **createdat-unchanged**: `createdAt` still equals `t0`

#### Test: delete-is-hard-and-cascades-tags (covers R29, R45, R46)

**Given**: segment with two tags
**When**: `delete_pool_segment(id)`
**Then** (assertions):
- **segment-gone**: `get_pool_segment(id)` returns `None`
- **tags-gone**: `pool_segment_tags` rows for that segment are deleted
- **no-softdelete-column**: `PRAGMA table_info(pool_segments)` has no
  `deleted_at` column

#### Test: set-context-with-variant-kind (covers R19, R20, R21, R22)

**Given**: a generated segment
**When**: `set_pool_segment_context(id,
context_entity_type='transition', context_entity_id='tr_1',
variant_kind='music')`
**Then** (assertions):
- **all-three-written**: context_entity_type='transition',
  context_entity_id='tr_1', variant_kind='music'
- **derived-from-untouched**: `derived_from` is still NULL

#### Test: set-context-preserves-variant-kind (covers R22)

**Given**: segment with variant_kind='music' already set
**When**: `set_pool_segment_context(id,
context_entity_type='keyframe', context_entity_id='kf_9')`
(no variant_kind kwarg)
**Then** (assertions):
- **context-updated**: context_entity_type/id updated
- **variant-kind-unchanged**: still `'music'`

#### Test: variant-kind-accepts-unknown-values (covers R10, R12)

**Given**: segment
**When**: `set_pool_segment_context(id,
context_entity_type=None, context_entity_id=None,
variant_kind='bogus-kind')`
**Then** (assertions):
- **stored-verbatim**: DB value equals `'bogus-kind'`
- **ui-falls-back-to-default**: `getClipColors('bogus-kind')` returns
  `DEFAULT_CLIP_COLORS`

#### Test: derived-from-stored (covers R14, R16)

**Given**: parent segment P inserted; child segment C inserted with
`derived_from=P.id` (via direct INSERT; no dedicated helper exists)
**When**: read C
**Then** (assertions):
- **fk-resolves**: the `derived_from` column on C equals `P.id`

#### Test: tag-idempotent (covers R23, R24)

**Given**: segment
**When**: `add_pool_segment_tag(id, 'vibe', 'user')` called twice with
different `tagged_by` on the second call
**Then** (assertions):
- **one-row**: exactly one tag row for (seg, 'vibe')
- **first-writer-wins**: `tagged_by` equals the first call's value

#### Test: remove-tag-missing-noop (covers R25)

**Given**: segment with no tags
**When**: `remove_pool_segment_tag(id, 'nope')`
**Then** (assertions):
- **no-exception**: does not raise
- **no-row-change**: tag count still 0

#### Test: find-by-unknown-tag-empty (covers R28)

**Given**: segments exist but none tagged `'missing'`
**When**: `find_segments_by_tag('missing')`
**Then** (assertions):
- **empty-list**: returns `[]`

#### Test: rejects-bad-tr-source (covers R31)

**Given**: valid seg + transition id
**When**: `add_tr_candidate(source='weird')`
**Then** (assertions):
- **raises-assertion**: raises `AssertionError`
- **no-row**: tr_candidates row count unchanged

#### Test: tr-candidate-idempotent (covers R30, R32)

**Given**: `add_tr_candidate(tr, 0, seg, 'generated')` already called
**When**: same call repeated
**Then** (assertions):
- **one-row**: exactly one tr_candidates row for that PK
- **no-exception**: second call does not raise

#### Test: tr-candidates-sorted-asc (covers R33)

**Given**: three tr_candidates rows with increasing added_at
**When**: `get_tr_candidates(tr, 0)`
**Then** (assertions):
- **order-asc**: returned in ascending added_at order
- **join-fields-present**: each dict carries pool_segment fields +
  `addedAt` + `junctionSource`

#### Test: clone-preserves-slot-added-at (covers R34)

**Given**: src tr has 2 candidates with slots [0, 1] and distinct
added_at values
**When**: `clone_tr_candidates(src, dst, new_source='split-inherit')`
**Then** (assertions):
- **slots-preserved**: dst has the same two (slot, added_at) tuples
- **source-rewritten**: each dst row's `source` equals
  `'split-inherit'`
- **return-count-two**: returns 2

#### Test: count-zero-for-unreferenced (covers R35)

**Given**: a segment referenced by nothing
**When**: `count_tr_candidate_refs(seg_id)`
**Then** (assertions):
- **zero**: returns 0

#### Test: gc-excludes-imported-and-referenced (covers R43)

**Given**: three segments — (A) generated unreferenced, (B) generated
referenced by tr_candidates, (C) imported unreferenced
**When**: `find_gc_candidates()`
**Then** (assertions):
- **includes-a**: A is in the result
- **excludes-b-referenced**: B is not
- **excludes-c-imported**: C is not

#### Test: rejects-bad-audio-source (covers R37)

**Given**: valid clip + seg
**When**: `add_audio_candidate(source='weird')`
**Then** (assertions):
- **raises-assertion**: raises `AssertionError`
- **no-row**: audio_candidates count unchanged

#### Test: audio-candidate-idempotent (covers R36, R38)

**Given**: one audio_candidates row for (clip, seg)
**When**: `add_audio_candidate(clip, seg, source='generated')` called
again
**Then** (assertions):
- **one-row**: exactly one row for (clip, seg)
- **no-exception**: second call does not raise

#### Test: audio-candidates-sorted-desc (covers R39)

**Given**: three audio_candidates rows with increasing added_at
**When**: `get_audio_candidates(clip_id)`
**Then** (assertions):
- **order-desc**: returned newest-first

#### Test: assign-sets-selected (covers R40)

**Given**: clip with `selected=NULL`
**When**: `assign_audio_candidate(clip, seg)`
**Then** (assertions):
- **selected-set**: `audio_clips.selected == seg`

#### Test: assign-none-clears-selected (covers R40)

**Given**: clip with `selected=seg_x`
**When**: `assign_audio_candidate(clip, None)`
**Then** (assertions):
- **selected-null**: `audio_clips.selected IS NULL`

#### Test: remove-selected-clears-selection (covers R41)

**Given**: clip with `selected = seg_x`; audio_candidates row for
(clip, seg_x) exists
**When**: `remove_audio_candidate(clip, seg_x)`
**Then** (assertions):
- **row-deleted**: junction row gone
- **selected-cleared**: `audio_clips.selected IS NULL`

#### Test: remove-nonselected-preserves-selection (covers R41)

**Given**: clip with `selected=seg_a`; junction rows for (clip,
seg_a) and (clip, seg_b)
**When**: `remove_audio_candidate(clip, seg_b)`
**Then** (assertions):
- **row-b-deleted**: junction row for seg_b gone
- **selected-still-a**: `audio_clips.selected == seg_a`

#### Test: effective-path-prefers-selected (covers R42)

**Given**: clip with `selected=seg_a`, `source_path='/tmp/orig.wav'`;
seg_a has `pool_path='pool/segments/a.wav'`
**When**: `get_audio_clip_effective_path(clip)`
**Then** (assertions):
- **returns-pool-path**: result equals `'pool/segments/a.wav'`

#### Test: effective-path-falls-back-when-missing (covers R42)

**Given**: clip with `selected=seg_deleted`,
`source_path='/tmp/orig.wav'`; seg_deleted is not in pool_segments
**When**: `get_audio_clip_effective_path(clip)`
**Then** (assertions):
- **returns-source-path**: result equals `'/tmp/orig.wav'`

#### Test: effective-path-default-to-source (covers R42)

**Given**: clip with `selected=None`, `source_path='/tmp/orig.wav'`
**When**: `get_audio_clip_effective_path(clip)`
**Then** (assertions):
- **returns-source-path**: result equals `'/tmp/orig.wav'`

#### Test: clip-color-follows-variant-kind (covers R9, R13)

**Given**: clip whose selected pool_segment has
`variant_kind='music'`
**When**: `getClipColors(clip.variant_kind)` (frontend)
**Then** (assertions):
- **bg-purple**: returned `bg` contains `purple`
- **border-purple**: returned `borderDefault` contains `purple`

#### Test: null-variant-kind-default-color (covers R9, R12)

**Given**: clip whose selected pool_segment has `variant_kind=NULL`
**When**: `getClipColors(null)`
**Then** (assertions):
- **bg-cyan**: returned `bg` contains `cyan`

#### Test: candidates-tab-filters-variant-kind (covers R12)

**Given**: pool has segments with variant_kinds `[NULL, 'music',
'foley', 'lipsync', NULL]`
**When**: candidates-tab listing endpoint is queried
**Then** (assertions):
- **only-null-variant**: returned ids correspond to the 2 NULL rows
- **no-derived-variants**: none of the 3 typed rows are returned

### Edge Cases

#### Test: rejects-non-json-generation-params (covers R6)

**Given**: an object that cannot be JSON-serialized (e.g., a set)
**When**: `add_pool_segment(generation_params={non-serializable})`
**Then** (assertions):
- **raises-typeerror**: `json.dumps` raises `TypeError`
- **no-row**: no `pool_segments` row created (INSERT never executes)

#### Test: gc-respects-audio-candidates (covers R43, R44, OQ-6)

**Given**: generated seg S referenced ONLY by an `audio_candidates`
row (no tr_candidates refs)
**When**: `find_gc_candidates()`
**Then** (assertions):
- **s-excluded**: S is NOT returned (audio_candidates is a live ref)

#### Test: gc-respects-audio-clips-selected (covers R44, OQ-6)

**Given**: generated seg S referenced ONLY by `audio_clips.selected`
(no junction rows)
**When**: `find_gc_candidates()`
**Then** (assertions):
- **s-excluded**: S is NOT returned

#### Test: gc-respects-plugin-sidecar-tables (covers R44, OQ-6)

**Given**: generated seg S referenced by
`generate_music__tracks.pool_segment_id` (or
`generate_foley__tracks` / `isolation_stems` / `transcribe__runs`)
**When**: `find_gc_candidates()`
**Then** (assertions):
- **s-excluded**: S is NOT returned for any of the sidecar tables

#### Test: gc-respects-derived-from-chain (covers R44, OQ-6)

**Given**: parent P (unreferenced directly) with descendant D that
IS referenced by `tr_candidates`
**When**: `find_gc_candidates()`
**Then** (assertions):
- **p-excluded**: P is NOT returned — kept because a downstream
  descendant is live

#### Test: derived-from-bad-parent-raises-integrity (covers R18, OQ-1)

**Given**: project.db with `PRAGMA foreign_keys=ON`; no row with
`id='deadbeef'`
**When**: direct INSERT of a pool_segment with `derived_from='deadbeef'`
**Then** (assertions):
- **raises-integrity**: raises `sqlite3.IntegrityError`
- **no-row**: no pool_segments row inserted

#### Test: derived-from-parent-delete-sets-null (covers R18, OQ-2)

**Given**: parent P inserted; child C with `derived_from=P.id`
**When**: `delete_pool_segment(P.id)` (no live references to P)
**Then** (assertions):
- **parent-gone**: `get_pool_segment(P.id)` returns `None`
- **child-promoted**: C's `derived_from` is `NULL`
- **child-survives**: C row still exists

#### Test: broken-link-row-persists-client-detects (covers R45c, OQ-3)

**Given**: pool_segment S whose `pool_path` file has been unlinked from
disk
**When**: DAL read and client fetch
**Then** (assertions):
- **row-persists**: `get_pool_segment(S.id)` still returns the row
- **effective-path-unchanged**: `get_audio_clip_effective_path` still
  returns S's `pool_path` (DAL does not validate on-disk presence)
- **client-placeholder**: client-side 404 handler surfaces a
  "file missing — remove or reimport" placeholder

#### Test: delete-raises-when-live-refs (covers R45, OQ-4)

**Given**: pool_segment S referenced by at least one of:
`tr_candidates`, `audio_candidates`, `audio_clips.selected`,
`generate_music__tracks`, `generate_foley__tracks`,
`isolation_stems`, `transcribe__runs`, or another segment's
`derived_from`
**When**: `delete_pool_segment(S.id)`
**Then** (assertions):
- **raises-in-use**: raises `PoolSegmentInUseError`
- **row-still-present**: `get_pool_segment(S.id)` still returns dict
- **tags-still-present**: any `pool_segment_tags` rows for S remain

#### Test: negative-metadata-rejected (covers R45a, OQ-5)

**Given**: schema with CHECK constraints applied
**When**: `add_pool_segment(duration_seconds=-1, byte_size=-1, …)`
**Then** (assertions):
- **raises-integrity**: raises `sqlite3.IntegrityError`
- **no-row**: pool_segments row count unchanged

#### Test: variant-kind-stamping-no-internal-lock (covers R45d, OQ-7)

**Given**: the DAL module for pool_segments
**When**: source is inspected for locking primitives
**Then** (assertions):
- **no-threading-lock**: `add_pool_segment` /
  `set_pool_segment_context` do not hold a threading.Lock /
  asyncio.Lock across the call (enforcement deferred to INV-1
  single-writer-per-(user,project) contract)

#### Test: dto-emits-m16-columns (covers R45b, OQ-8)

**Given**: a pool_segment with `variant_kind='music'`,
`derived_from=<parent_id>`, `context_entity_type='transition'`,
`context_entity_id='tr_1'`
**When**: `get_pool_segment(id)`
**Then** (assertions):
- **variant-kind-present**: dict includes `variantKind='music'`
- **derived-from-present**: dict includes `derivedFrom=<parent_id>`
- **context-entity-type-present**: dict includes
  `contextEntityType='transition'`
- **context-entity-id-present**: dict includes
  `contextEntityId='tr_1'`
- **get-audio-clips-no-bulk-resolve**: `get_audio_clips` reads
  variant_kind from the joined row, not via a second query

#### Test: concurrent-tag-add-no-error (covers R23)

**Given**: two SQLite connections to the same DB
**When**: both call `add_pool_segment_tag(seg, 'x', 'user')` back-to-back
**Then** (assertions):
- **no-exception**: neither call raises
- **one-row**: exactly one tag row for (seg, 'x')

#### Test: partial-index-on-variant-kind (covers R11)

**Given**: schema initialized
**When**: `sqlite_master` is queried for
`idx_pool_segments_variant_kind`
**Then** (assertions):
- **index-exists**: row is present
- **is-partial**: index SQL contains `WHERE variant_kind IS NOT NULL`

#### Test: partial-index-on-derived-from (covers R17)

**Given**: schema initialized
**When**: `sqlite_master` is queried for
`idx_pool_segments_derived_from`
**Then** (assertions):
- **index-exists**: row is present
- **is-partial**: index SQL contains `WHERE derived_from IS NOT NULL`

#### Test: list-all-tags-counts (covers R27)

**Given**: two segments; seg1 tagged `'a','b'`; seg2 tagged `'a'`
**When**: `list_all_tags()`
**Then** (assertions):
- **a-count-two**: entry for `'a'` has count 2
- **b-count-one**: entry for `'b'` has count 1
- **order-desc-by-count**: `'a'` precedes `'b'`

#### Test: get-tags-sorted-by-taggedat (covers R26)

**Given**: same segment tagged twice with increasing tagged_at
**When**: `get_pool_segment_tags(seg)`
**Then** (assertions):
- **order-asc**: returned in ascending `taggedAt` order

---

## Non-Goals

- Enforcing a closed enum on `variant_kind` — the schema intentionally
  leaves it open TEXT so future plugins can introduce new kinds without
  a migration. UI degrades to default color.
- Referential integrity for `context_entity_*` — polymorphic, no FK,
  no check. Dangling refs are tolerated.
- Cascading deletes for `tr_candidates` / `audio_candidates` when a
  pool_segment is hard-deleted. The DAL comment on
  `delete_pool_segment` states the caller is responsible.
- Soft delete on pool_segments. Intentional. `audio_clips` has
  `deleted_at` but pool_segments does not.
- On-disk file deletion — that is the caller's responsibility.
- Atomic undo of pool_segment insert/delete (undo-trigger coverage is
  limited to the `_undo_tracked_tables` list; `pool_segments` is not
  in it).

---

## Open Questions

### Resolved

**OQ-1 (resolved)**: Insert with `derived_from` pointing to a non-existent
pool_segment id. **Decision**: migration adds `derived_from REFERENCES
pool_segments(id) ON DELETE SET NULL`; `PRAGMA foreign_keys=ON` assumed
for project.db; insert with bad parent raises `sqlite3.IntegrityError`.
**Tests**: `derived-from-bad-parent-raises-integrity`.

**OQ-2 (resolved)**: Hard-deleting a parent pool_segment when descendants
carry `derived_from = parent.id`. **Decision**: ON DELETE SET NULL
semantics promotes descendants to roots; no orphan pointers post-migration.
**Tests**: `derived-from-parent-delete-sets-null`.

**OQ-3 (resolved)**: pool_path points to a file deleted from disk.
**Decision**: codify broken-link pattern — row persists; clients detect
404 on fetch and render "file missing — remove or reimport" placeholder;
GC still applies reachability rules normally. **Tests**:
`broken-link-row-persists-client-detects`.

**OQ-4 (resolved)**: `delete_pool_segment` with live references.
**Decision**: DAL performs reference check across all junction / sidecar
tables plus `derived_from` incoming edge; any live reference raises
`PoolSegmentInUseError`. **Tests**: `delete-raises-when-live-refs`.

**OQ-5 (resolved)**: Negative `duration_seconds` / `byte_size`.
**Decision**: add CHECK (>= 0) constraints at migration; violations raise
`sqlite3.IntegrityError`. **Tests**: `negative-metadata-rejected`.

**OQ-6 (resolved)**: `find_gc_candidates` audio blindness. **Decision**:
rewrite as full reachability query across all reference paths (tr /
audio / audio_clips.selected / plugin sidecar tables / isolation_stems /
transcribe runs / derived_from chain). **Tests**:
`gc-respects-audio-candidates`, `gc-respects-audio-clips-selected`,
`gc-respects-plugin-sidecar-tables`, `gc-respects-derived-from-chain`.

**OQ-7 (resolved)**: `variant_kind` post-insert race. **Decision**:
closed per INV-1 — concurrent writes from the same (user, project) are
out of scope. The "insert then stamp" handshake remains; no in-process
lock is introduced. **Tests**: `variant-kind-stamping-no-internal-lock`
(negative-assertion).

**OQ-8 (resolved)**: DTO incomplete. **Decision**: `_row_to_pool_segment`
includes `variant_kind`, `derived_from`, `context_entity_type`,
`context_entity_id`; redundant bulk-variant-kind resolve in
`get_audio_clips` removed. **Tests**: `dto-emits-m16-columns`.

---

## Related Artifacts

- **Audit**: `agent/reports/audit-2-architectural-deep-dive.md` §1B
- **Related specs**: `agent/specs/local.music-generation-plugin.md`
  (producer of `variant_kind='music'`),
  `agent/specs/local.source-monitor-panel.md`
- **Memory**: `project_plugins_own_sidecar_tables.md`,
  `project_future_stem_splitter_plugin.md`
- **Design (historical)**: `design/local.candidate-pool-migration.md`
  (referenced in schema comment)

---

**Namespace**: local
**Spec**: pool-segments-and-variant-kind
**Version**: 1.0.0
**Status**: Active (retroactive)
