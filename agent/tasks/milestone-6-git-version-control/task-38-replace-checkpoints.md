# Task 38: Replace Checkpoints with Commit System

**Objective**: Migrate the existing checkpoint system to use the new commit-based version control backend
**Milestone**: M6 — Git-Style Version Control
**Priority**: P2
**Repo**: scenecraft-engine
**Estimated Hours**: 4
**Status**: Not Started

---

## Context

The current checkpoint system stores project snapshots as `project.db.checkpoint-*` files alongside a `checkpoints.yaml` manifest. This was a stopgap before the full version control system. Now that the object store and commit engine exist, checkpoints should be replaced by commits — giving users the same save/restore functionality but with proper history, dedup, and branch awareness. Existing projects with old-style checkpoints need a one-time migration path.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Migrate the checkpoint creation API:
   - `POST /api/projects/:name/checkpoint` now internally calls the commit endpoint (`POST /api/projects/:name/commit`) with the provided message
   - Maintain the same request/response contract so the frontend transition is seamless

2. Migrate the checkpoint listing API:
   - `GET /api/projects/:name/checkpoints` now returns the commit history for the current branch
   - Map commit objects to the existing checkpoint response format (name, timestamp, message)

3. Migrate the checkpoint restore API:
   - `POST /api/projects/:name/checkpoint/restore` now creates a working copy from the specified commit's DB snapshot in the object store
   - Accept either a commit hash or a legacy checkpoint name for backward compatibility

4. Implement backward compatibility migration:
   - On project load, detect if old-style checkpoint files (`project.db.checkpoint-*`) and `checkpoints.yaml` exist
   - If found, offer a one-time migration: import each checkpoint as a commit (in chronological order, chaining parents)
   - After successful migration, remove old checkpoint files and `checkpoints.yaml`
   - Log migration status for debugging

5. Remove the old checkpoint file management code:
   - Remove `project.db.checkpoint-*` file creation/deletion logic
   - Remove `checkpoints.yaml` read/write logic
   - Clean up any helpers that directly manipulate checkpoint files

6. Update the `CheckpointsPanel` frontend component to use the new commit-based API:
   - Update API call URLs and request/response handling
   - Display commit hash (abbreviated) alongside checkpoint name
   - Keep the existing UI layout and interactions intact

## Verification

- [ ] `POST /api/projects/:name/checkpoint` creates a commit in the object store
- [ ] `GET /api/projects/:name/checkpoints` returns commit history in the expected format
- [ ] `POST /api/projects/:name/checkpoint/restore` restores from a commit's DB snapshot
- [ ] Old-style checkpoint files are detected and migrated to commits on first load
- [ ] Migration preserves chronological order and parent chain
- [ ] Old checkpoint files and `checkpoints.yaml` are removed after migration
- [ ] CheckpointsPanel frontend works with the new API without visual regressions
- [ ] Projects without old checkpoints are unaffected

---

**Dependencies**: Task 36, Task 37
