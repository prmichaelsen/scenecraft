# Task 43: Merge Workspace View

**Objective**: Dockview workspace layout for side-by-side merge conflict resolution
**Milestone**: M6 — Git-Style Version Control
**Priority**: P3
**Repo**: scenecraft
**Estimated Hours**: 8
**Status**: Not Started

---

## Context

Resolving merge conflicts requires a rich visual workspace where the user can compare the base, left (ours/main), and right (theirs/branch) states side by side. This task builds a dedicated dockview-based workspace layout with three comparison columns, a conflict resolution panel, and a merged-result preview — enabling users to resolve conflicts visually at both the row and field level.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Create a new dockview workspace layout for merge resolution with three columns: base (common ancestor), left (ours/main), right (theirs/branch).
2. Each column contains a read-only timeline panel and a preview panel showing that branch's state.
3. Implement timeline visual diff rendering: green for added keyframes/transitions, yellow for modified, red for deleted.
4. Preview panels render keyframe images for visual comparison between branches.
5. Build the conflict resolution panel below the three columns: list all conflicts with per-row controls.
6. Per-conflict controls: "Take Left", "Take Right", "Take Both" buttons for each conflicting row.
7. Implement field-level cherry-picking: expand a conflict row to see individual field diffs and pick values from either side.
8. Add bulk actions: "Take all left" and "Take all right" buttons for batch resolution.
9. Build the merged-result preview panel (fourth panel) that shows a real-time preview of the merged state as conflicts are resolved.
10. Add a change list/table view alongside the visual timeline diff for a structured overview of all changes.
11. Wire up conflict resolution state: track which conflicts are resolved, update the merge preview (Task 42) accordingly, enable "Accept merge" only when all conflicts are resolved.
12. Write tests for conflict resolution controls, field-level cherry-picking, bulk actions, and merged-result preview updates.

## Verification

- [ ] Three-column layout renders base, left, and right states correctly
- [ ] Timeline visual diff shows correct color coding (green/yellow/red) for changes
- [ ] Preview panels display rendered keyframe images for visual comparison
- [ ] Per-conflict "Take Left" / "Take Right" / "Take Both" controls work correctly
- [ ] Field-level cherry-picking allows selecting individual field values from either side
- [ ] Bulk actions ("Take all left" / "Take all right") resolve all conflicts at once
- [ ] Merged-result preview updates in real-time as conflicts are resolved
- [ ] Change list/table view shows structured overview of all changes
- [ ] "Accept merge" only enabled when all conflicts are resolved
- [ ] Tests pass for all conflict resolution scenarios

---

**Dependencies**: Task 42, Task 39
