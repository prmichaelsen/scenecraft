# Task 31: Admin CLI

**Objective**: Implement CLI commands for managing orgs, users, and token generation
**Milestone**: M6 — Git-Style Version Control
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 4
**Status**: Not Started

---

## Context

Server administrators need CLI tools to manage the scenecraft instance — creating orgs, registering users with their SSH public keys, and performing basic listing operations. These commands operate directly on the `.scenecraft/` directory and its databases. The `scenecraft token` command bridges auth (Task 30) with the CLI surface.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Implement `scenecraft init`:
   - Create the `.scenecraft/` directory structure (delegates to Task 29 bootstrap logic)
   - Initialize `server.db` with schema
   - Create the first org and admin user
   - Print a summary of what was created

2. Implement `scenecraft org create <name>`:
   - Create the org directory at `.scenecraft/orgs/<name>/`
   - Initialize `org.db` inside the org directory
   - Create subdirectories for projects
   - Register the org in `server.db` orgs table

3. Implement `scenecraft org list`:
   - Query `server.db` orgs table
   - Display org names, creation dates, and member counts in a formatted table

4. Implement `scenecraft user add <username> --pubkey <path>`:
   - Read the SSH public key from the provided file path
   - Compute the pubkey fingerprint
   - Register the user in `server.db` users table
   - Create the user directory at `.scenecraft/users/<username>/`
   - Initialize `user.db` inside the user directory
   - Create the `sessions/` subdirectory

5. Implement `scenecraft user list`:
   - Query `server.db` users table
   - Display usernames, roles, fingerprints, and creation dates in a formatted table

6. Implement `scenecraft token` CLI wrapper:
   - This is the CLI entry point for the token generation logic implemented in Task 30
   - Parse any CLI flags (e.g., `--expires` for custom expiration)
   - Call the token generation function and print the result

7. Set up the CLI framework (e.g., `argparse` or `click`) with subcommand routing for all commands above.

8. Write tests for each CLI command, verifying correct database state and directory creation.

## Verification

- [ ] `scenecraft init` creates the full directory structure and databases
- [ ] `scenecraft org create foo` creates `.scenecraft/orgs/foo/` with `org.db`
- [ ] `scenecraft org list` displays all registered orgs
- [ ] `scenecraft user add alice --pubkey ~/.ssh/id_rsa.pub` registers the user and creates user directory
- [ ] `scenecraft user list` displays all registered users with their roles
- [ ] `scenecraft token` outputs a JWT for the current user
- [ ] All commands provide helpful error messages for invalid input
- [ ] Tests pass for all CLI commands

---

**Dependencies**: Task 29, Task 30
