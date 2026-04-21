# Finalize Range

**Concept**: Lock a timeline range as "final" with an input-graph snapshot + rendered frame hashes, so unintended upstream changes surface as loud regressions.
**Created**: 2026-04-21
**Status**: Design Specification

---

## Overview

Users mark a range on the timeline as **finalized**. The backend (a) snapshots the dependency graph for that range into a checkpoint, (b) pre-renders the range's frames and stores their hashes, and (c) soft-blocks edits that would invalidate the seal. On full-project final render, the range's output is hashed and compared to the stored hashes; any divergence surfaces as an explicit diff the user must acknowledge.

This is regression testing for finished creative work — the same discipline a software project gets from Jest snapshot tests or a Bazel content-addressed cache.

---

## Problem Statement

In a video editor, a user finishes a section, moves on, and inadvertently changes something upstream (a motion prompt, a track-level color grade, a shared keyframe, a Veo seed) that silently alters the "finished" section's output. The user then exports the final render without noticing the regression. The first time they see it is after the export ships — or never.

Without explicit protection:
- "Finished" is an emotional label, not an enforced state.
- Globals that affect many ranges (motion prompt, tracks, audio intelligence) can bleed into supposedly-done work.
- AI generation is non-deterministic across model revisions; re-rendering the "same" inputs can drift.
- There's no audit trail for when a range was sealed vs. modified.

---

## Solution

Hybrid of three patterns (see Key Design Decisions for research citations):

1. **Input-graph lock** (Nix/Bazel model) — snapshot the clips + global params that produce the range's output. Immediate invalidation detection.
2. **Output-hash verification** (Jest snapshot model) — store frame hashes at lock time, verify on render. Catches non-determinism the input lock can't see.
3. **Versioning over mutation** (Nuke/Flame model) — re-finalizing creates `v2`; `v1` stays in history. Every seal is auditable.

The storage layer reuses the existing **checkpoints** system (full SQLite snapshots) rather than the deprecated `vcs/` object store.

### Alternatives rejected

- **Output-hash only**: silent drift wouldn't be detected until the user actually rendered; no explicit "you just broke a seal" signal.
- **Input-graph only**: misses non-determinism from Veo model revisions, unpinned global state, or floating-point drift in the render pipeline.
- **Wire up the `vcs/` content-addressed store**: cleaner long-term but not yet connected to any API. Adds a dependency on M6 that we don't need. Checkpoints already work.
- **Full-project revert to checkpoint on restore**: throws away unrelated in-progress work. Splice-style revert (see below) matches user intent.

---

## Implementation

### Data model

**New table** `finalizations`:

```sql
CREATE TABLE finalizations (
  id TEXT PRIMARY KEY,
  range_start_seconds REAL NOT NULL,
  range_end_seconds REAL NOT NULL,
  pinned_clip_ids TEXT NOT NULL,       -- JSON: ["kf_abc", "tr_xyz", ...]
  pinned_global_state TEXT NOT NULL,   -- JSON: { motionPrompt, trackConfigs, audioIntelligenceVersion, ... }
  checkpoint_filename TEXT NOT NULL,   -- FK to checkpoints.filename
  frame_hashes TEXT,                   -- JSON: [{ frame: 0, sha256: "..." }, ...], null until render completes
  version INTEGER NOT NULL DEFAULT 1,  -- increments on re-finalize of overlapping range
  status TEXT NOT NULL DEFAULT 'pending_render',  -- 'pending_render' | 'locked' | 'invalidated'
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  invalidated_reason TEXT              -- set when status flips to 'invalidated'
);
```

### Flow: create a finalization

1. User drags a range on the timeline + clicks **Finalize**.
2. Backend:
   - Create a named checkpoint: `"Finalize {start}s–{end}s v{N}"`
   - Capture `pinned_clip_ids` — every keyframe/transition whose timeline position overlaps `[start, end]` (partial overlap counts)
   - Capture `pinned_global_state` — serialize motion prompt + track configs for tracks containing pinned clips + audio intelligence cut
   - Insert `finalizations` row with `status='pending_render'`
   - Enqueue background render of `[start, end]`
3. Background render completes → compute SHA-256 per frame → store in `frame_hashes` → `status='locked'`

### Flow: edit guards

Before persisting a mutation that touches a clip, check active finalizations:

```
for each finalization where status='locked':
  if mutation.clip_id in finalization.pinned_clip_ids:
    → surface warning modal: "This edit will break finalized range {start}–{end} v{n}. Continue?"
    → if confirmed: set finalization.status='invalidated', log reason, proceed
```

Global state changes (motion prompt, track configs) check whether they intersect *any* locked finalization's pinned global keys. Same modal flow.

### Flow: full-project final render verification

On export / final render, after the pipeline emits frames:

```
for each finalization where status='locked':
  re-hash the frames in [range_start, range_end]
  compare to stored frame_hashes
  if mismatch:
    → surface a "Finalization regressed" dialog
    → show frame-level diff (or side-by-side sample frames)
    → user must either: accept new → create v{n+1}, OR revert → splice old checkpoint state back in for that range
```

### Flow: splice revert

"Restore range from finalization" is not a full-project checkpoint restore. It reads the checkpoint's snapshot, extracts the rows matching `pinned_clip_ids` + `pinned_global_state` keys, and overwrites just those in the current project state. Everything outside the pinned set is preserved.

### Flow: revive an older version (append-only)

Reviving `v{k}` while `v{n}` (n > k) exists **does not** flip an active pointer. It:

1. Performs a splice-revert using `v{k}`'s checkpoint (restores the pinned content back into the working project)
2. Creates a new finalization row `v{n+1}` with the restored state — a fresh checkpoint, re-captured pinned graph, re-rendered frame hashes
3. Marks `v{n+1}` as the current sealed version for that range; `v{k}` and `v{n}` both remain in history

Why append-only: history is only trustworthy if it's immutable. An "active version pointer" lets users silently swap what "current" means, which defeats the regression-detection purpose. Every user intent becomes a durable row.

### API surface (additions to `api_server.py`)

- `GET  /api/projects/{p}/finalizations` → list
- `POST /api/projects/{p}/finalize` → `{ range_start, range_end }` → creates + enqueues render
- `POST /api/projects/{p}/finalizations/{id}/revert` → splice restore (no new version; current sealed version remains the latest)
- `POST /api/projects/{p}/finalizations/{id}/revive` → splice restore + append as v{n+1} (reviving older versions; see flow above)
- `POST /api/projects/{p}/finalizations/{id}/accept-drift` → acknowledge output-hash mismatch, create new version
- `POST /api/projects/{p}/finalizations/{id}/invalidate` → manually break seal
- Mutation endpoints that touch pinned content check finalizations server-side and return a conflict response with the finalization ID; the UI surfaces the modal.

### UI touchpoints

- **Timeline ruler**: amber/gold overlay on finalized ranges with version label + status icon (locked / pending / invalidated / regressed).
- **Warning modal** (Logic Pro Freeze pattern): "Editing X will break finalized range Y v{n}. Continue / Cancel."
- **Regression dialog** (Jest-snapshot pattern): "Finalized range Y v{n} drifted. Accept new output as v{n+1} / Revert to v{n} / Cancel render."
- **Finalizations panel**: see below.

### Finalizations panel

A new dockable panel (`finalizations` in the `PanelRegistry` alongside `checkpoints`, `bin`, etc.) that surfaces the history and lets the user browse/compare/revive.

**Two view modes**, toggleable at the top:

1. **At Playhead** (default) — filters to finalizations whose `[range_start, range_end]` contains the current playhead time. Updates live as the playhead moves. Useful for "show me what's been sealed at this point in the timeline."
2. **All** — full list of every finalization row, grouped by range (e.g., "32s–48s: v1, v2, v3"), sortable by date / range start / status.

**Per-finalization card shows**:
- Range badge (`32.0s → 48.0s`) + version label (`v2`)
- Status chip (`locked` / `pending_render` / `invalidated` / `regressed`) with color coding
- Created timestamp + author
- Checkpoint link (optional inline expander showing what snapshot backs this row)
- Actions: **Diff** (compare two versions' pinned state), **Revive** (splice + append as new version), **Compare frames** (show stored frame hashes vs. current), **Invalidate** (manual seal break)

**Revive action** invokes the append-only flow above: splice-restore from this version's checkpoint → create v{n+1} → re-render → re-hash. The UI shows a confirmation: "Revive v1's state as new v3? v2 will remain in history."

**Panel registry wiring** (in `EditorPanelLayout.tsx`):
```typescript
finalizations: { component: FinalizationsPanelComponent, title: 'Finalizations' }
```
The panel uses `useCurrentTime()` to drive the "At Playhead" filter and `useEditorData()` to get `projectName` for API calls. It subscribes to finalization mutations via the existing scenecraft-socket so status flips (pending → locked after background render completes) update in real time.

---

## Key Design Decisions

### Decision 1: Hybrid input-graph + output-hash lock (Option D)

**Decision**: Store both a pinned input graph and rendered frame hashes.

**Rationale**: Input-graph alone misses non-determinism from AI model revisions (Veo) or floating-point drift. Output-hash alone surfaces regressions only at render time, leaving the user guessing what they changed. Combining gives immediate edit-time warnings plus render-time verification.

**Research precedent**: Bazel's two-layer model (Action Cache keyed by input hash + CAS keyed by output hash) is the exact pattern. Nuke embeds the input tree hash into rendered `.exr` files and warns on mismatch — the closest prior art in creative tooling. [Bazel caching](https://bazel.build/remote/caching), [Nuke Precomp docs](https://learn.foundry.com/nuke/content/reference_guide/other_nodes/precomp.html).

### Decision 2: Reuse existing checkpoints as the storage layer

**Decision**: A finalization references an existing checkpoint (`project.db.checkpoint-<ts>`) rather than building a separate version store.

**Rationale**: Checkpoints already capture full project state via SQLite backup API and have working create/restore/delete plumbing (`src/scenecraft/db.py`, `api_server.py`). The `src/scenecraft/vcs/` content-addressed object store is scaffolding, not hooked up. Adding a dependency on vcs/ doubles scope; checkpoints are a validated path.

### Decision 3: Splice-revert, not full-project revert

**Decision**: "Restore finalization" restores only the pinned content within the range, not the entire project.

**Rationale**: Finalization is range-scoped; users expect revert to match that scope. A full-project revert would throw away unrelated in-progress work (including other finalizations created later). Splice requires stable identity for pinned clips, which is satisfied by the UUID migration (task-32) already on the roadmap.

### Decision 4: Versioning over mutation — strictly append-only

**Decision**: Every user intent that seals or re-seals a range creates a new version row. Old versions are never mutated, hidden, or swapped out via an "active version pointer." Reviving v1 while v2 exists produces v3 (splice of v1's state), leaving both v1 and v2 in history.

**Rationale**: Audit trail is only trustworthy if it's immutable. An active-version pointer lets users silently swap what "current" means, which defeats regression detection — someone could "revert" a change with no visible record. Append-only makes every decision a durable, inspectable row. Matches Nuke's Write-node versioning and Flame's Multi-Version Clips exactly. Storage cost is one checkpoint per version, bounded by disk and cleanable via explicit user action.

### Decision 5: Warning modal, not hard block, on pinned-clip edits

**Decision**: Edits that touch pinned content surface a confirmation modal ("break the seal?"), not a hard refusal.

**Rationale**: Users own their projects; the tool should surface consequences, not override intent. Logic Pro's "unfreeze track?" prompt is the validated UX pattern. A hard block forces users to manually un-finalize before every tweak, which is friction without value.

### Decision 6: AI non-determinism is why output-hash exists

**Decision**: Even with pinned Veo seeds + ingredients, we still store and verify frame hashes.

**Rationale**: Google can revise the Veo model behind the same API version; "same input" can produce different output across model updates. Seed-pinning is necessary but not sufficient. The output hash catches this class of drift, which input-lock cannot.

### Decision 7: Defer the `vcs/` object store wiring

**Decision**: Finalize does not depend on activating the `src/scenecraft/vcs/` scaffolding.

**Rationale**: The vcs/ content-addressed store was designed for git-style commit/branch/merge but isn't connected to any API or UI. Wiring it up is a separate multi-week effort (M6). Finalize can ship now with checkpoints; if vcs/ is later activated, finalizations can migrate to reference commit hashes instead of checkpoint filenames without changing the external UX.

---

## Benefits

- **Regression safety for creative work** — "finished" becomes an enforced state, not a vibe.
- **Edit-time + render-time detection** — two independent signals catch different failure modes.
- **Audit trail** — every seal and every drift acceptance is recorded with timestamps.
- **Scoped revert** — splice semantics preserve unrelated in-progress work.
- **Zero new storage system** — reuses the existing checkpoints infrastructure.
- **Novel in AI-first tooling** — no competing AI video editor has this today (Runway, Pika, Captions.ai, Descript all lack range-locking).

---

## Trade-offs

- **Input-graph completeness is fuzzy**: deciding which global state "affects a range" requires an explicit allowlist that we'll have to grow as we find gaps. Start with (motion prompt, tracks overlapping pinned clips, audio intelligence cut) and expand.
- **Storage cost**: one full-project checkpoint per finalization version. For a 3-minute project with 10 finalized ranges × 2 versions each, that's ~20 SQLite backups. Manageable, but needs a cleanup UX long-term.
- **Non-determinism edge case**: if the user's render pipeline changes (new ffmpeg version, new effect library), *every* finalization's output hash drifts. We should support "mass re-baseline" when the user intentionally changes the pipeline.
- **UUID dependency**: splice revert requires stable clip IDs. Works cleanly once M6 task-32 (UUID migration) lands; before that, falls back to restoring the whole checkpoint.

---

## References

- [Bazel — Remote Caching](https://bazel.build/remote/caching)
- [Jest — Snapshot Testing](https://jestjs.io/docs/snapshot-testing)
- [Foundry Nuke — Precomp](https://learn.foundry.com/nuke/content/reference_guide/other_nodes/precomp.html)
- [Apple — Freeze tracks in Logic Pro](https://support.apple.com/guide/logicpro/freeze-tracks-lgcpf1cbfd51/10.7/mac/11.6)
- [Autodesk Flame — Working with Multi-Version Clips](https://help.autodesk.com/cloudhelp/2020/ENU/Flame-ImportingandExportingMedia/files/GUID-AA9323C2-DED2-4737-B6B4-00D5D3E5A8FC.htm)
- Internal: `agent/design/local.project-versioning.md` (checkpoint system design)
- Internal: `src/scenecraft/db.py` (checkpoints table, undo log)

---

**Status**: Design Specification
**Recommendation**: Implement once UUID migration (task-32) lands; falls back to full-project revert gracefully until then.
