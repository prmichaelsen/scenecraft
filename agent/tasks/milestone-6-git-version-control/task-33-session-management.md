# Task 33: Session Management

**Objective**: Implement per-user, per-branch working copy sessions with isolated database snapshots
**Milestone**: M6 — Git-Style Version Control
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 8
**Status**: Not Started

---

## Context

In a multi-user system, each user needs an isolated working copy of the project database when they open a branch. This prevents concurrent edits from colliding at the database level. When a user opens a project on a branch, the server copies the branch tip's committed DB snapshot into a per-user session directory. All API requests for that user are then routed to their session's working copy. This is analogous to `git checkout` creating a working tree from a commit.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Create the `sessions.db` schema:
   - Table: `sessions`
   - Columns: `id` (UUID), `user` (username), `project` (project name), `org` (org name), `branch` (branch name), `commit_hash` (the commit this session was created from), `working_copy` (absolute path to the session's DB file), `created_at`, `last_active`

2. Implement session creation logic:
   - When a user opens a project on a branch, look up the branch's latest commit
   - Copy that commit's DB snapshot to `users/{username}/sessions/{project}--{branch}.db`
   - Insert a record into `sessions.db`
   - Return the session ID to the caller

3. Implement session resume logic:
   - Before creating a new session, check if a working copy already exists for this user/project/branch combination
   - If the existing session's `commit_hash` matches the branch tip, reuse it (update `last_active`)
   - If the branch has advanced, the session is stale — either warn the user or create a fresh copy

4. Refactor `get_db(project_dir)` to accept a session-specific DB path:
   - The current `get_db()` returns a connection to a shared `project.db`
   - Modify it to accept an optional `db_path` parameter
   - When a session is active, pass the session's working copy path instead of the shared project DB

5. Implement API server session routing:
   - Every API request must include a session ID (from JWT claims or a dedicated header)
   - Look up the session in `sessions.db` to determine the working copy DB path
   - Route the request to that session's isolated database
   - Update `last_active` timestamp on each request

6. Implement `scenecraft session list` CLI command:
   - Query `sessions.db` for all active sessions
   - Display session ID, user, project, org, branch, commit hash, and last active time

7. Implement `scenecraft session prune` CLI command:
   - Delete sessions that have been inactive beyond a configurable threshold (e.g., 7 days)
   - Remove the working copy DB files from disk
   - Remove the session records from `sessions.db`

8. Write tests for:
   - Session creation from a branch tip commit
   - Session resume when branch has not advanced
   - Session invalidation when branch has advanced
   - API routing to correct working copy
   - Session pruning of stale sessions

## Verification

- [ ] Opening a project on a branch creates a session with a working copy DB at the expected path
- [ ] The working copy DB is a copy of the branch tip commit's snapshot
- [ ] Subsequent requests use the session's working copy, not the shared project DB
- [ ] Reopening the same project/branch reuses the existing session if the branch has not advanced
- [ ] `get_db()` correctly routes to session DB when a session path is provided
- [ ] API requests without a valid session receive an appropriate error
- [ ] `scenecraft session list` shows all active sessions
- [ ] `scenecraft session prune` removes stale sessions and their DB files
- [ ] Tests pass for all session lifecycle scenarios

---

**Dependencies**: Task 29, Task 30
