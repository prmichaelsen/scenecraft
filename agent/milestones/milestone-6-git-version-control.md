# Milestone 6: Git-Style Version Control

**Goal**: Replace the checkpoint system with a full Git data model — commits, branches, merge, rebase — operating on SQLite project state, with SSH-based auth and multi-user support  
**Duration**: 5-6 weeks  
**Dependencies**: None (no blockers from M2/M3/M4)  
**Status**: Not Started  

---

## Overview

Implement Git-style version control for scenecraft projects. Each commit is an immutable, content-addressed SQLite DB snapshot. Branches are named pointers to commits. Users authenticate via SSH keys and get per-session working copies. Merging uses rebase semantics (replay branch on main) with row-level SQL diffing and a three-column conflict resolution UI.

This is a cross-repo feature: backend (scenecraft-engine) handles auth, CLI, object store, sessions, diff/merge logic. Frontend (scenecraft) handles branch UI, merge workspace view, and auth flow.

---

## Deliverables

### 1. Infrastructure & Auth (P1)
- `.scenecraft/` directory structure with orgs, users, projects
- SSH-based auth: user registry, JWT token generation, API middleware
- Admin CLI: `scenecraft init`, `org create`, `user add`, `token`
- UUID migration for all entity IDs (kf, tr, track, effect, audio clip)
- Session management with per-session working copy routing
- Frontend JWT auth flow (token storage, API headers)
- Project size view

### 2. Object Store, Commits & Branches (P2)
- Content-addressed object store (`objects/` directory, SHA-256)
- Commit engine (create, store, parent pointers, DAG)
- Branch refs (create, checkout, switch, delete)
- Replace checkpoints with commits
- Branch UI in editor (selector, create, switch)

### 3. Diff & Merge (P3)
- SQL-level row-level diff engine (6 diffable tables)
- Rebase: replay branch commits on main
- Merge preview with auto-merge + conflict highlighting
- Three-column merge workspace view (base/ours/theirs)
- Conflict resolution (per-row, field-level cherry-pick, bulk actions)

---

## Success Criteria

- [ ] Admin can create orgs, add users, users can generate JWT tokens via SSH
- [ ] All API endpoints require valid JWT
- [ ] All entity IDs are UUIDs with prefix format (`kf_{hex8}`)
- [ ] Users get isolated working copies per session/branch
- [ ] Commits create immutable, content-addressed DB snapshots
- [ ] Branches can be created, checked out, switched, deleted
- [ ] Editor shows branch selector and supports branch operations
- [ ] SQL diff correctly identifies added/deleted/modified rows across 6 tables
- [ ] Rebase replays branch commits on main with conflict detection
- [ ] Merge workspace view shows three-column layout with real-time merged preview
- [ ] Pre-merge checkpoint (commit) is auto-created for rollback safety

---

## Tasks

### P1 — Infrastructure & Auth
1. [Task 29: `.scenecraft` directory structure & server bootstrap](../tasks/milestone-6-git-version-control/task-29-scenecraft-directory-structure.md) (scenecraft-engine)
2. [Task 30: SSH-based auth system](../tasks/milestone-6-git-version-control/task-30-ssh-auth-system.md) (scenecraft-engine)
3. [Task 31: Admin CLI](../tasks/milestone-6-git-version-control/task-31-admin-cli.md) (scenecraft-engine)
4. [Task 32: UUID migration](../tasks/milestone-6-git-version-control/task-32-uuid-migration.md) (scenecraft-engine)
5. [Task 33: Session management & working copy routing](../tasks/milestone-6-git-version-control/task-33-session-management.md) (scenecraft-engine)
6. [Task 34: Frontend JWT auth flow](../tasks/milestone-6-git-version-control/task-34-frontend-jwt-auth.md) (scenecraft)
7. [Task 35: Project size view](../tasks/milestone-6-git-version-control/task-35-project-size-view.md) (scenecraft)

### P2 — Object Store, Commits & Branches
8. [Task 36: Content-addressed object store & commit engine](../tasks/milestone-6-git-version-control/task-36-object-store-commit-engine.md) (scenecraft-engine)
9. [Task 37: Branch refs & operations](../tasks/milestone-6-git-version-control/task-37-branch-refs-operations.md) (scenecraft-engine)
10. [Task 38: Replace checkpoints with commits](../tasks/milestone-6-git-version-control/task-38-replace-checkpoints.md) (scenecraft-engine)
11. [Task 39: Branch UI in editor](../tasks/milestone-6-git-version-control/task-39-branch-ui.md) (scenecraft)

### P3 — Diff & Merge
12. [Task 40: SQL-level row-level diff engine](../tasks/milestone-6-git-version-control/task-40-sql-diff-engine.md) (scenecraft-engine)
13. [Task 41: Rebase engine](../tasks/milestone-6-git-version-control/task-41-rebase-engine.md) (scenecraft-engine)
14. [Task 42: Merge preview & auto-merge](../tasks/milestone-6-git-version-control/task-42-merge-preview.md) (scenecraft-engine + scenecraft)
15. [Task 43: Merge workspace view](../tasks/milestone-6-git-version-control/task-43-merge-workspace-view.md) (scenecraft)

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation Strategy |
|------|--------|-------------|---------------------|
| UUID migration breaks existing asset path references | High | Low | Clean slate — no existing scenecraft projects to migrate |
| SQL diff performance on large DBs | Medium | Low | DBs are small; optimize later if needed |
| Rebase conflict resolution UX complexity | Medium | Medium | Start with row-level, add field-level cherry-pick incrementally |
| JWT token management UX | Low | Low | Simple CLI flow; token persists in browser localStorage |

---

**Design Document**: [agent/design/local.git-version-control.md](../design/local.git-version-control.md)  
**Clarification**: [agent/clarifications/clarification-1-collaborative-branching-merging.md](../clarifications/clarification-1-collaborative-branching-merging.md)  
**Next Milestone**: TBD  
**Blockers**: None  
