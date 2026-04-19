# Task 67: VCS Integration — Diffable Tables + Merge Conflicts

**Objective**: Add `characters` and `transition_lipsyncs` to the VCS diff engine; handle case-insensitive character name collisions as merge conflicts
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P2
**Repo**: scenecraft-engine
**Estimated Hours**: 4
**Status**: Not Started

---

## Context

With the Git-style VCS system (M6), all editable state passes through a row-level diff engine. Characters and lipsync rows need to be diffed, merged, and rebased like keyframes and transitions. The case-insensitive unique name constraint on characters introduces a new kind of merge conflict that the standard row-level engine doesn't natively detect — we need to surface it as an application-level conflict.

This task depends on M6 task-40 (SQL diff engine) landing first. If M6 is not yet complete, implement provisionally by adding the tables to the (future) `DIFFABLE_TABLES` set and document the expected merge behavior without full integration.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — VCS integration sections
- [Git-Style Version Control](../../design/local.git-version-control.md) — Merge + Conflict Rules

## Steps

1. Add `'characters'` and `'transition_lipsyncs'` to the `DIFFABLE_TABLES` set in the VCS diff module.

2. Row-level diff semantics for these tables:
   - Characters: add/modify/delete treated normally; `last_modified_by` column surfaced in merge UI
   - Transition lipsyncs: append-only — rows are never modified, so only add/delete need handling at merge time
   - Standard "modify on both sides" conflict rules apply to characters

3. Application-level character name conflict detection:
   - After row-level diff produces its conflicts/merges, run a post-pass over the merged `characters` set
   - If two non-deleted characters have the same `LOWER(name)`, emit an application-level conflict: "Both branches created character '{name}' independently (IDs: {a, b}). Rename one or keep both with different names."
   - Resolution options in the merge UI: rename A, rename B, or mark one as deleted

4. Update the merge preview UI (if within scope of M6) to show the new conflict type.

5. Unit tests covering:
   - Two branches add different characters → auto-merge
   - Both branches add a character named "Jane" (different IDs) → application-level conflict surfaces
   - Both branches add the same character (same ID, same name, different voice_id) → standard row-level modify conflict
   - Both branches add different lipsyncs to the same transition → both rows merged in
   - `active_lipsync_id` differs between branches → standard row-level conflict on the transition

## Verification

- [ ] Diff output for a sample merge shows character add/modify/delete correctly
- [ ] Same-name character creation on two branches surfaces as an application-level conflict
- [ ] Lipsync rows append-merge correctly
- [ ] Tests pass

---

**Dependencies**: Task 57 (characters schema), Task 58 (lipsyncs schema), M6 Task-40 (SQL diff engine — soft dependency)
