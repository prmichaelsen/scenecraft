# Task 29: .scenecraft Directory Structure

**Objective**: Create the `.scenecraft/` root directory structure and bootstrap logic for server initialization
**Milestone**: M6 — Git-Style Version Control
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 4
**Status**: Not Started

---

## Context

The `.scenecraft/` directory is the foundational data layer for the entire version control system. It mirrors Git's `.git/` concept — a hidden directory at the server root that holds all orgs, projects, users, sessions, and metadata. Every subsequent task in this milestone depends on this directory structure existing and being correctly initialized.

All SQLite databases (server.db, org.db, user.db) must be created with their schemas during the bootstrap process. The `scenecraft init` command is the entry point that sets everything up.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Define the full `.scenecraft/` directory tree layout:
   - `.scenecraft/orgs/{name}/org.db`
   - `.scenecraft/orgs/{name}/projects/{name}/objects/`
   - `.scenecraft/orgs/{name}/projects/{name}/refs/`
   - `.scenecraft/orgs/{name}/projects/{name}/commits/`
   - `.scenecraft/orgs/{name}/projects/{name}/assets/`
   - `.scenecraft/users/{name}/user.db`
   - `.scenecraft/users/{name}/sessions/`
   - `.scenecraft/sessions.db`
   - `.scenecraft/server.db`

2. Create the `server.db` schema with the following tables:
   - `users` — columns: `username`, `pubkey_fingerprint`, `pubkey`, `created_at`, `role`
   - `orgs` — columns: `name`, `created_at`
   - `org_members` — columns: `org`, `username`, `role`, `joined_at`

3. Create the `org.db` schema for per-org settings storage.

4. Create the `user.db` schema for user preferences and saved workspaces.

5. Implement the `scenecraft init` bootstrap command that:
   - Creates the full `.scenecraft/` directory tree
   - Initializes `server.db` with the schema defined above
   - Creates the first org (e.g., `default`)
   - Creates the first admin user (derived from the current OS user)

6. Add validation to prevent double-initialization (detect existing `.scenecraft/` and warn or abort).

7. Write unit tests for directory creation, schema initialization, and idempotency.

## Verification

- [ ] `scenecraft init` creates the complete `.scenecraft/` directory tree
- [ ] `server.db` exists and contains `users`, `orgs`, `org_members` tables with correct schemas
- [ ] A default org directory is created under `.scenecraft/orgs/`
- [ ] An admin user is registered in `server.db` with the current OS username
- [ ] `org.db` is created inside the default org directory
- [ ] `user.db` is created inside the admin user's directory
- [ ] Running `scenecraft init` a second time does not corrupt existing data
- [ ] Unit tests pass

---

**Dependencies**: None
