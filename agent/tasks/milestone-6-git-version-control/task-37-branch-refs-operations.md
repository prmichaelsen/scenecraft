# Task 37: Branch Refs & Operations

**Objective**: Implement branch reference storage, creation, checkout, and deletion operations
**Milestone**: M6 — Git-Style Version Control
**Priority**: P2
**Repo**: scenecraft-engine
**Estimated Hours**: 6
**Status**: Not Started

---

## Context

Branches allow users to work on different versions of a project in parallel without affecting each other. Branch refs are simple text files that store the commit hash of the branch tip, mirroring Git's lightweight ref model. This task implements the full branch lifecycle: creation, listing, switching (checkout), and deletion. Checkout involves creating a new working copy from the branch tip's database snapshot.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Define the branch ref storage format:
   - Refs are stored as plain text files at `orgs/{org}/projects/{project}/refs/{branch_name}`
   - Each file contains a single line: the commit hash the branch points to
   - User branches use nested paths: `refs/prmichaelsen/color-pass`

2. Create the `main` branch ref automatically on project initialization, pointing to the initial commit (or empty if no commits yet).

3. Implement API endpoints:
   - `POST /api/projects/:name/branches` — accepts `{ name, from_branch? }`. Creates a new ref file pointing to the same commit as the source branch (defaults to current branch). Creates a new working copy from that commit's DB snapshot.
   - `GET /api/projects/:name/branches` — lists all branches by scanning the `refs/` directory recursively. Returns branch name, commit hash, and whether it's the current branch.
   - `POST /api/projects/:name/checkout` — accepts `{ branch }`. Switches the active branch for the current session.
   - `DELETE /api/projects/:name/branches/:name` — deletes the branch ref file. Prevents deletion of `main` and the currently checked-out branch.

4. Implement branch creation logic:
   - Validate branch name (no spaces, no special chars except `/` for namespacing)
   - Create the ref file pointing to the source branch's current commit
   - Create a new working copy by restoring the commit's DB snapshot from the object store
   - Update the session to track the new branch

5. Implement checkout logic:
   - Check for uncommitted changes in the current working copy (compare working DB hash to last commit's DB hash)
   - If uncommitted changes exist, return a warning and require a `force: true` flag to proceed
   - Copy the target branch tip's DB snapshot from the object store to a new working copy
   - Update the session's active branch reference

6. Write unit tests covering: branch creation, ref file format, checkout flow, uncommitted change detection, branch deletion guards, and nested branch names.

## Verification

- [ ] Branch refs are stored as plain text files containing commit hashes
- [ ] `main` branch is created automatically on project init
- [ ] `POST /api/projects/:name/branches` creates a new branch ref and working copy
- [ ] `GET /api/projects/:name/branches` lists all branches including nested user branches
- [ ] `POST /api/projects/:name/checkout` switches the active branch and creates a new working copy
- [ ] Checkout warns when uncommitted changes are detected
- [ ] `DELETE /api/projects/:name/branches/:name` prevents deletion of `main` and current branch
- [ ] Nested branch names (e.g., `prmichaelsen/color-pass`) work correctly
- [ ] Unit tests pass

---

**Dependencies**: Task 36
