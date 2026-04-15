# Task 42: Merge Preview

**Objective**: Merge preview flow showing three-way diff results before applying changes
**Milestone**: M6 — Git-Style Version Control
**Priority**: P3
**Repo**: scenecraft-engine + scenecraft
**Estimated Hours**: 6
**Status**: Not Started

---

## Context

Merges should never be blind — users must always see a preview of what will change before committing to a merge. This task builds both the backend endpoint that computes a three-way diff and summary, and the frontend panel that displays auto-merged changes, conflicts, and summary statistics. The merge only executes after the user explicitly confirms and all conflicts are resolved.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Implement backend endpoint: `POST /api/projects/:name/merge/preview` that computes the three-way diff (using Task 40's diff engine) and returns: auto-merged changes, conflicts, and summary stats (counts of added/modified/deleted/conflicting rows per table).
2. Build the frontend merge preview panel component showing: auto-merged changes highlighted in green, conflicts highlighted in red, unchanged items in gray.
3. Display summary stats at the top of the panel (e.g., "12 auto-merged, 3 conflicts, 45 unchanged").
4. Add an "Accept merge" button that is only enabled when all conflicts have been resolved (no unresolved conflicts remain).
5. On "Accept merge": call the rebase engine (Task 41) to execute the rebase, create the final merge commit, and advance the main ref.
6. Handle error states: rebase failure after preview (e.g., concurrent changes), network errors, partial conflict resolution.
7. Write tests for the merge preview endpoint and integration tests for the full preview-then-merge flow.

## Verification

- [ ] Merge preview endpoint returns correct auto-merged changes, conflicts, and summary stats
- [ ] Frontend panel correctly color-codes auto-merged (green), conflicts (red), and unchanged (gray)
- [ ] "Accept merge" button is disabled when unresolved conflicts exist
- [ ] "Accept merge" button is enabled only when all conflicts are resolved
- [ ] Confirmed merge executes rebase, creates final commit, and advances main ref
- [ ] Error states are handled gracefully
- [ ] Tests pass for preview endpoint and full merge flow

---

**Dependencies**: Task 40, Task 41, Task 34
