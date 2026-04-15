# Task 40: SQL Diff Engine

**Objective**: Row-level SQL diff engine comparing two DB snapshots by commit hash
**Milestone**: M6 — Git-Style Version Control
**Priority**: P3
**Repo**: scenecraft-engine
**Estimated Hours**: 8
**Status**: Not Started

---

## Context

To support git-style version control for projects, we need a diffing engine that can compare the state of two database snapshots (identified by commit hashes) and produce a structured changeset. This is the foundation for merge preview, rebase, and conflict detection. The diff operates at the row level — each entire row is the atomic change unit — and supports both two-way and three-way diffing.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Define the set of diffable tables: keyframes, transitions, effects, tracks, meta, narrative_sections (workspace_views at project-level only). Explicitly exclude suppressions and audio intelligence/beats tables (vestigial).
2. Implement a snapshot loader that, given a commit hash, loads all rows from each diffable table in the corresponding DB snapshot.
3. Implement two-way diff: for each table, compare rows by primary key (id column). Classify each row as added (present in target only), deleted (present in base only), or modified (present in both, contents differ). The entire row is the change unit.
4. Implement three-way diff for merge: given base, ours, and theirs commit hashes, compute diff(base→ours) and diff(base→theirs). Classify each change as auto-mergeable or conflict.
5. Implement conflict detection rules: same row modified in both sides = conflict; delete + modify on same row = conflict; same timestamp but different IDs = conflict; meta table changed in both sides = always conflict.
6. Define the structured changeset response format (added rows, deleted rows, modified rows per table, plus conflict annotations for three-way diffs).
7. Implement API endpoint: `POST /api/projects/:name/diff` with body `{base_commit, target_commit}` returning the structured changeset. Optionally accept a `three_way_base` for three-way diffs.
8. Write unit tests for two-way diff, three-way diff, and each conflict rule.

## Verification

- [ ] Two-way diff correctly identifies added, deleted, and modified rows across all diffable tables
- [ ] Three-way diff correctly classifies changes as auto-mergeable vs conflict
- [ ] Conflict rules enforced: same-row-modified, delete+modify, same-timestamp-different-ID, meta-always-conflict
- [ ] Excluded tables (suppressions, audio intelligence/beats) are never included in diffs
- [ ] API endpoint returns structured changeset with correct shape
- [ ] Unit tests pass for all diff scenarios

---

**Dependencies**: Task 36
