# Task 36: Object Store & Commit Engine

**Objective**: Implement a content-addressed object store and commit system for project database snapshots
**Milestone**: M6 — Git-Style Version Control
**Priority**: P2
**Repo**: scenecraft-engine
**Estimated Hours**: 8
**Status**: Not Started

---

## Context

The commit engine is the core of the version control system. It captures the state of a project's SQLite database at a point in time by storing a content-addressed snapshot in the object store. Each commit references a database snapshot hash, parent commit(s), author, and message. Commit hashes are derived from the serialized metadata, ensuring immutability. This mirrors Git's object model but is tailored for SQLite-based project state.

This task provides the foundation that branches, checkout, and history features all build upon.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Create the content-addressed object store directory at `orgs/{org}/projects/{project}/objects/`.

2. Implement the DB snapshot flow:
   - Use `sqlite3.backup()` to copy the working copy database to a temporary file
   - Compute the SHA-256 hash of the temporary file
   - Rename/move the file to `objects/{hash}.db`
   - If the hash already exists (dedup), skip the write and discard the temp file

3. Define the commit metadata schema as a JSON object:
   ```json
   {
     "hash": "<commit_hash>",
     "db_hash": "<sha256 of the DB snapshot>",
     "parents": ["<parent_commit_hash>"],
     "author": "<username>",
     "message": "<commit message>",
     "timestamp": "<ISO 8601>"
   }
   ```

4. Implement commit hash computation:
   - Serialize the commit metadata (excluding the `hash` field) to a canonical JSON string (sorted keys, no extra whitespace)
   - Compute SHA-256 of the serialized string
   - Set the `hash` field to the result

5. Store commit metadata as JSON files in `orgs/{org}/projects/{project}/commits/{hash}.json`.

6. Implement API endpoints:
   - `POST /api/projects/:name/commit` — accepts `{ message }`, creates a DB snapshot, builds commit metadata, stores both, updates the current branch ref to point to the new commit. Returns the commit object.
   - `GET /api/projects/:name/commits` — lists commits reachable from the current branch ref, walking parent pointers. Supports `?limit=N` pagination.
   - `GET /api/projects/:name/commits/:hash` — returns the full commit metadata for a specific commit.

7. Handle the initial commit case (no parents) and ensure the `main` ref is updated after each commit.

8. Write unit tests covering: snapshot creation, dedup behavior, commit hash integrity, parent chain traversal, and API responses.

## Verification

- [ ] `POST /api/projects/:name/commit` creates a DB snapshot in `objects/` and a commit file in `commits/`
- [ ] Duplicate DB snapshots are not stored twice (dedup by hash)
- [ ] Commit hash is deterministic and matches the SHA-256 of the canonical metadata
- [ ] `GET /api/projects/:name/commits` returns the commit history in reverse chronological order
- [ ] `GET /api/projects/:name/commits/:hash` returns the correct commit detail
- [ ] Parent chain is correctly maintained across multiple commits
- [ ] Initial commit (no parents) is handled correctly
- [ ] The current branch ref is updated to the new commit hash after each commit
- [ ] Unit tests pass

---

**Dependencies**: Task 29, Task 33
