# Task 41: Rebase Engine

**Objective**: Rebase engine that replays branch commits on top of main's tip for linear history
**Milestone**: M6 — Git-Style Version Control
**Priority**: P3
**Repo**: scenecraft-engine
**Estimated Hours**: 8
**Status**: Not Started

---

## Context

Rebase is the primary strategy for integrating branch changes back into main, ensuring a clean linear history with no merge commits. The engine walks the commit graph to find the fork point, collects branch-only commits, and replays each commit's changeset onto the current base. If a conflict arises at any step, the rebase pauses and returns conflict details so the user can resolve them before continuing.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Implement fork-point detection (merge base): walk parent pointers from both the branch tip and the main tip until a common ancestor is found.
2. Collect the ordered list of branch commits from fork point to branch tip by traversing parent pointers.
3. For each branch commit in order: compute its SQL changeset by diffing against its parent commit (using the diff engine from Task 40).
4. Apply each changeset onto the current base state. If the changeset applies cleanly, create a new commit object with the rebased parent.
5. If a conflict is detected at any step: pause the rebase, return conflict details (which commit, which rows, what the conflicts are) to the caller.
6. After all commits are successfully replayed: update the branch ref to point to the new rebased tip.
7. Implement pre-rebase safety: before starting the rebase, auto-create a backup commit on the target branch so the user can roll back if needed.
8. Implement API endpoint: `POST /api/projects/:name/rebase` with body `{branch, onto}` returning success with new commit history or conflict details.
9. Write tests for: simple rebase with no conflicts, rebase with conflicts at various steps, fork-point detection with divergent histories, rollback safety commit creation.

## Verification

- [ ] Fork-point detection correctly finds the common ancestor for divergent branch histories
- [ ] Branch commits are collected in correct chronological order
- [ ] Clean rebase replays all commits and updates branch ref
- [ ] Conflicting rebase pauses and returns accurate conflict details
- [ ] Pre-rebase backup commit is created for rollback safety
- [ ] API endpoint returns correct response for both success and conflict cases
- [ ] Tests pass for all rebase scenarios

---

**Dependencies**: Task 40, Task 37
