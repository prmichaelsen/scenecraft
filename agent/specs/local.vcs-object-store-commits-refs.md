# Spec: VCS Object Store, Commits, Refs, Branches, and Sessions

> **🤖 Agent Directive**: This is a retroactive black-box spec documenting the
> content-addressed VCS subsystem as currently implemented in
> `scenecraft-engine/src/scenecraft/vcs/`. It is a specification of observable
> behavior, not a redesign. When behavior is ambiguous, undecided, or the code
> silently does something not obviously intended, the spec flags it as
> `undefined` with a linked Open Question — to be resolved by the user before
> any refactor or reimplementation.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive)

---

## Purpose

Define the observable behavior of scenecraft's content-addressed version
control layer: the SHA-256 object store, commit DAG, branch refs, branch
lifecycle operations, and per-user working-copy sessions.

## Source

- **Mode**: `--from-draft` (retroactive, reverse-engineered from source +
  audit-2 §1F)
- **Primary sources**:
  - `scenecraft-engine/src/scenecraft/vcs/objects.py` — object store,
    commits, refs
  - `scenecraft-engine/src/scenecraft/vcs/sessions.py` — session lifecycle
  - `scenecraft-engine/src/scenecraft/vcs/branches.py` — branches,
    uncommitted-change detection, checkout
  - `scenecraft-engine/src/scenecraft/vcs/bootstrap.py` — `sessions.db`
    schema, initial `refs/main` creation
- **Cross-ref**: `agent/reports/audit-2-architectural-deep-dive.md` §1F
  (unit catalog), §2 (invariants), §3 leaks #7 and #11

---

## Scope

### In Scope

- **Object store**: write-once content-addressed SQLite-blob snapshots
  keyed by SHA-256, stored under `<project_dir>/objects/<hash>.db`
- **Commits**: immutable JSON objects under
  `<project_dir>/commits/<hash>.json` with `{hash, db_hash, parents,
  author, message, timestamp}`; deterministic hash over canonical JSON
- **Refs**: one file per branch under `<project_dir>/refs/<branch>`
  holding a single commit hash (or empty string for an unadvanced branch);
  nested paths supported (`refs/alice/feature-x`)
- **Branches**: create, list, delete, checkout, name-validation regex
  `^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$`, 1–100 chars
- **Sessions**: per-user working-copy DB files tied to
  `(username, org, project, branch)`, reuse when branch tip unchanged,
  prune after `max_age_days` (default 7)
- **Uncommitted-change detection**: snapshot-and-compare against the
  session's recorded `commit_hash`

### Out of Scope

- **Diff / rebase / merge engines** — not implemented; any behavior
  beyond first-parent linear walk (`list_commits`) is `undefined`
- **Authentication** — JWT / API keys covered by a separate spec; this
  spec takes `username` / `org` as trusted inputs
- **Legacy `checkpoints` table** (`db.py:679`) — a parallel pre-VCS
  snapshot system still present on core schema; acknowledged but not
  specified here. Coexistence is known; cleanup is a follow-up
  (audit-2 leak #7)
- **Multi-parent commits (merge commits)** — `parents` is a list in the
  data shape, but nothing in the current code creates more than one
  parent, and `list_commits` only follows `parents[0]`
- **Remote push/pull** — none; VCS is strictly local to the server
  filesystem

---

## Requirements

### R1 — Content-addressed object store

**R1.1** Snapshots are keyed by the SHA-256 of the snapshot file bytes
(post-`sqlite3.backup()`), in lowercase hex.

**R1.2** Snapshots are written via `sqlite3.backup()` into a temp file
in `<project_dir>/objects/`, then atomically renamed to
`<hash>.db`. If a file with that name already exists, the temp file is
deleted and the existing file is kept unchanged (write-once / dedup).

**R1.3** `load_snapshot(project_dir, db_hash)` returns the absolute path
`<project_dir>/objects/<db_hash>.db` and raises `FileNotFoundError` if
missing.

**R1.4** `copy_snapshot_to(project_dir, db_hash, dest)` copies the stored
snapshot to `dest` using `shutil.copy2`, creating `dest.parent` if
needed.

### R2 — Commits

**R2.1** `create_commit` writes a JSON file at
`<project_dir>/commits/<hash>.json` containing
`{hash, db_hash, parents, author, message, timestamp}`.

**R2.2** The commit hash is `sha256(canonical_json)` where
`canonical_json = json.dumps(meta, sort_keys=True, separators=(",",":"))`
over the *pre-hash* metadata
`{db_hash, parents, author, message, timestamp}`. Two commits with
identical fields produce identical hashes and overwrite each other on
disk (but not in the DAG — parents + timestamp make real duplicates
vanishingly unlikely).

**R2.3** `timestamp` is `datetime.now(tz=UTC).isoformat()`; its
monotonicity is not enforced.

**R2.4** Commits are immutable: no code path mutates
`<hash>.json` after write. (Callers CAN overwrite by computing an
identical hash; this is by definition indistinguishable and therefore
a non-mutation.)

**R2.5** `get_commit(project_dir, hash)` returns the parsed JSON dict or
`None` if the file is missing.

**R2.6** `list_commits(project_dir, head_hash, limit=50)` walks
`parents[0]` (first-parent), stops at `limit`, stops on missing commit,
and stops on cycle (tracked via a `seen` set), returning the commits in
first-encountered order (newest first).

### R3 — Refs (branch pointers)

**R3.1** A ref is a file at `<project_dir>/refs/<branch>` whose content
is the commit hash (stripped of whitespace) or the empty string.

**R3.2** `get_ref(branch)` returns the stripped file content, or `""` if
the ref file does not exist.

**R3.3** `set_ref(branch, commit_hash)` overwrites the ref atomically
at the file level (single `write_text`). There is no cross-ref
atomicity — multiple refs cannot be updated together.

**R3.4** `list_refs()` returns `{relative_path: commit_hash}` for every
file under `refs/` (including nested paths like `alice/feature-x`).

**R3.5** The `main` ref is created at project bootstrap as an empty
file (`refs/main` with content `""`) and must always exist thereafter.

### R4 — Branch lifecycle

**R4.1** Branch names are validated against regex
`^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$`, non-empty, ≤ 100 chars.
Invalid names raise `BranchError`.

**R4.2** `create_branch(name, from_branch="main")`:
- Rejects existing branch names with `BranchError`
- Rejects missing `from_branch` with `BranchError`
- Copies `from_branch`'s current commit hash (may be `""`) into the new
  ref
- Does **not** touch sessions or working copies
- Returns `{name, commit_hash, from_branch}`

**R4.3** `list_branches(current_branch=None)` returns a list of
`{name, commitHash, isCurrent}` sorted alphabetically by `name`.

**R4.4** `delete_branch(name, current_branch=None)`:
- Rejects `name == "main"` with `BranchError`
- Rejects `name == current_branch` with `BranchError`
- Rejects missing branch with `BranchError`
- Unlinks the ref file
- Best-effort removes now-empty parent directories up to (but not
  including) `refs/`

**R4.5** `has_uncommitted_changes(project_dir, session)`:
- Returns `True` if the session's recorded `commit_hash` is empty or
  falsy
- Returns `True` if the commit referenced by `commit_hash` does not
  exist in the object store (dangling commit)
- Returns `False` if the working copy file does not exist
- Otherwise snapshots the working copy (via `store_snapshot`, which
  may write a new object as a side effect) and returns
  `current_hash != commit["db_hash"]`

**R4.6** `checkout_branch(session_id, target_branch, force=False)`:
- Validates target branch name and existence
- Looks up session by id; raises `BranchError` if missing
- If `not force` and `has_uncommitted_changes` → raises
  `BranchError("Working copy has uncommitted changes. …")`
- Computes new working-copy path
  `<sc_root>/users/<username>/sessions/<project>--<branch-slashes-as-dashes>.db`
- If the target branch's tip commit is non-empty, the referenced commit
  MUST exist; otherwise raises
  `BranchError("Branch <name> points to missing commit <hash>")`
- If the target tip is empty, creates an empty DB at the new WC path
  (with a single `meta` table)
- Copies the stored snapshot to the new WC path (overwriting any file
  at that path)
- Attempts to `unlink()` the old WC only when its path differs from the
  new one; `OSError` is swallowed silently
- Updates `sessions.branch / commit_hash / working_copy / last_active`
  atomically within a single connection's commit
- Returns the updated session row as a dict

### R5 — Sessions

**R5.1** A session row in `<sc_root>/sessions.db` has
`{id, username, org, project, branch, commit_hash, working_copy,
created_at, last_active}`. `commit_hash` defaults to `''` and `branch`
defaults to `'main'`.

**R5.2** `create_session(username, org, project, project_dir,
branch='main')`:
- Looks up an existing row for the `(username, org, project, branch)`
  tuple
- If found **and** `row.commit_hash == current_branch_tip` **and**
  `row.working_copy` file exists → touches `last_active` and returns
  with `reused=True`
- Otherwise deletes the stale row (unlinking its WC file if present)
  and creates a new session
- New session id is `uuid.uuid4().hex[:12]` (12 hex chars / 48 bits)
- WC path:
  `<sc_root>/users/<username>/sessions/<project>--<branch-slashes-as-dashes>.db`
- If branch has a tip commit, copies that commit's `db_hash` snapshot
  to the WC
- If branch has no tip, tries legacy `project.db` locations
  (`<project_dir>.parent/<project>/project.db`,
  `<project_dir>/project.db`, `<project_dir>.parent/project.db`); if
  none found, creates an empty DB with a single `meta` table
- Returns `{id, username, org, project, branch, commit_hash,
  working_copy, reused}`

**R5.3** `get_session(session_id)` returns the row dict or `None`.

**R5.4** `get_session_for_user(username, org, project, branch)`
returns the row dict or `None`.

**R5.5** `touch_session(session_id)` updates `last_active` to
now-UTC-isoformat.

**R5.6** `list_sessions()` returns all rows ordered by
`last_active DESC`.

**R5.7** `prune_sessions(max_age_days=7)`:
- Deletes rows where `last_active < now - max_age_days`
- Unlinks each deleted row's WC file if it exists
- Returns the count of deleted rows
- No global lock; concurrent prune + checkout races are `undefined`
  (see OQ-5)

**R5.8** `delete_session(session_id)`:
- Returns `False` if the session is not found
- Otherwise unlinks the WC file (if present) and deletes the row;
  returns `True`

### R6 — High-level `commit_working_copy`

**R6.1** `commit_working_copy(source_db, branch, author, message)`:
1. Snapshots `source_db` into the object store → `db_hash`
2. Reads `get_ref(branch)` → `parent` (may be `""`)
3. `parents = [parent] if parent else []` — first commit on branch has
   an empty parent list
4. Creates the commit
5. Calls `set_ref(branch, commit_hash)`
6. Returns the full commit dict

**R6.2** Steps 1–5 are **not transactional**. A crash between step 4
(commit written) and step 5 (ref advanced) leaves the commit orphaned
in the store; re-running `commit_working_copy` with identical bytes
will dedup the snapshot, re-hash an identical commit metadata (same
parents, author, message; DIFFERENT timestamp), and produce a new
commit hash.

---

## Interfaces / Data Shapes

### Commit JSON

```json
{
  "hash":      "<sha256-hex>",
  "db_hash":   "<sha256-hex>",
  "parents":   ["<sha256-hex>", ...],
  "author":    "<string>",
  "message":   "<string>",
  "timestamp": "<ISO-8601 UTC, e.g. 2026-04-27T12:34:56.789012+00:00>"
}
```

Canonicalization for hashing uses **all fields except `hash`**, encoded
with `json.dumps(..., sort_keys=True, separators=(",",":"))`.

### Session row

```
id            TEXT PRIMARY KEY      -- uuid4.hex[:12]
username      TEXT NOT NULL
org           TEXT NOT NULL
project       TEXT NOT NULL
branch        TEXT NOT NULL DEFAULT 'main'
commit_hash   TEXT NOT NULL DEFAULT ''
working_copy  TEXT NOT NULL         -- absolute path to WC .db
created_at    TEXT NOT NULL         -- ISO-8601 UTC
last_active   TEXT NOT NULL         -- ISO-8601 UTC
```

### Filesystem layout

```
<project_dir>/
  objects/<sha256>.db       # content-addressed DB snapshots
  commits/<sha256>.json     # commit metadata
  refs/<branch>             # plain text: commit hash or ""
  refs/<ns>/<branch>        # nested branch paths allowed

<sc_root>/
  sessions.db               # session registry (SQLite)
  users/<name>/sessions/<project>--<branch-dashes>.db   # working copies
```

### Python signatures (public surface)

```python
# objects.py
store_snapshot(project_dir: Path, source_db: Path) -> str
load_snapshot(project_dir: Path, db_hash: str) -> Path    # raises FileNotFoundError
copy_snapshot_to(project_dir: Path, db_hash: str, dest: Path) -> None
create_commit(project_dir, db_hash, parents, author, message) -> dict
get_commit(project_dir: Path, commit_hash: str) -> dict | None
list_commits(project_dir: Path, head_hash: str, limit: int = 50) -> list[dict]
get_ref(project_dir: Path, branch: str) -> str
set_ref(project_dir: Path, branch: str, commit_hash: str) -> None
list_refs(project_dir: Path) -> dict[str, str]
commit_working_copy(project_dir, source_db, branch, author, message) -> dict

# branches.py
validate_branch_name(name: str) -> None                   # raises BranchError
branch_exists(project_dir: Path, branch: str) -> bool
create_branch(project_dir, name, from_branch="main") -> dict
list_branches(project_dir, current_branch=None) -> list[dict]
delete_branch(project_dir, name, current_branch=None) -> None
has_uncommitted_changes(project_dir, session) -> bool
checkout_branch(sc_root, session_id, target_branch, project_dir, force=False) -> dict

# sessions.py
create_session(sc_root, username, org, project, project_dir, branch="main") -> dict
get_session(sc_root, session_id) -> dict | None
get_session_for_user(sc_root, username, org, project, branch) -> dict | None
touch_session(sc_root, session_id) -> None
list_sessions(sc_root) -> list[dict]
prune_sessions(sc_root, max_age_days=7) -> int
delete_session(sc_root, session_id) -> bool
```

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1  | Snapshot an unseen DB | Writes `<hash>.db`; returns hex SHA-256 | `store-snapshot-writes-new-object` |
| 2  | Snapshot an already-stored DB (identical bytes) | No-op on disk; returns same hash (dedup) | `store-snapshot-dedupes` |
| 3  | Load an existing snapshot | Returns path to `<hash>.db` | `load-snapshot-returns-path` |
| 4  | Load a missing snapshot | Raises `FileNotFoundError` | `load-snapshot-missing-raises` |
| 5  | Copy a stored snapshot to dest | `dest` exists; bytes identical to source | `copy-snapshot-to-dest` |
| 6  | Create a commit | JSON file written; hash deterministic | `create-commit-deterministic-hash`, `create-commit-immutable-fields` |
| 7  | Identical metadata twice produces same hash | File overwritten; hash unchanged | `identical-metadata-same-hash` |
| 8  | Get existing commit | Returns parsed dict | `get-commit-returns-dict` |
| 9  | Get missing commit | Returns `None` | `get-commit-missing-returns-none` |
| 10 | Walk parents with `list_commits` | Returns first-parent chain newest-first; respects `limit` | `list-commits-walks-first-parents`, `list-commits-respects-limit` |
| 11 | Cycle in parent chain | Walk terminates via `seen` set | `list-commits-breaks-cycle` |
| 12 | Missing commit mid-chain | Walk stops at the break | `list-commits-stops-on-missing-parent` |
| 13 | `get_ref` on missing branch | Returns `""` | `get-ref-missing-returns-empty` |
| 14 | `set_ref` on new branch | Creates file; `get_ref` returns hash | `set-ref-creates-file` |
| 15 | `list_refs` across nested paths | Returns `{relative_path: hash}` for all ref files | `list-refs-includes-nested` |
| 16 | `main` ref present at bootstrap | `get_ref("main")` returns `""`, file exists | `main-ref-always-exists` |
| 17 | Valid branch name | Passes validation | `validate-branch-name-accepts-valid` |
| 18 | Invalid branch name (special chars, leading slash, empty, >100 chars) | Raises `BranchError` | `validate-branch-name-rejects-invalid` |
| 19 | `create_branch` from `main` | Ref written; returns `{name, commit_hash, from_branch}` | `create-branch-copies-from-ref` |
| 20 | `create_branch` when name exists | Raises `BranchError` | `create-branch-rejects-existing` |
| 21 | `create_branch` from missing source | Raises `BranchError` | `create-branch-rejects-missing-source` |
| 22 | `list_branches` sort + `isCurrent` flag | Alphabetically sorted; exactly one `isCurrent=true` when set | `list-branches-sorted-and-marked` |
| 23 | `delete_branch('main')` | Raises `BranchError` | `delete-branch-rejects-main` |
| 24 | `delete_branch(current)` | Raises `BranchError` | `delete-branch-rejects-current` |
| 25 | `delete_branch` missing | Raises `BranchError` | `delete-branch-rejects-missing` |
| 26 | `delete_branch` success | Ref file removed; empty parent dirs cleaned up to `refs/` | `delete-branch-cleans-empty-parents` |
| 27 | `has_uncommitted_changes` clean WC | Returns `False` when WC hash equals commit `db_hash` | `uncommitted-false-when-clean` |
| 28 | `has_uncommitted_changes` dirty WC | Returns `True` when WC hash differs | `uncommitted-true-when-dirty` |
| 29 | `has_uncommitted_changes` no commit on branch | Returns `True` | `uncommitted-true-when-no-baseline` |
| 30 | `has_uncommitted_changes` dangling commit_hash | Returns `True` | `uncommitted-true-when-commit-missing` |
| 31 | `has_uncommitted_changes` WC file missing | Returns `False` | `uncommitted-false-when-wc-missing` |
| 32 | `checkout_branch` clean, branch exists | Session updated; new WC copied from tip commit | `checkout-updates-session` |
| 33 | `checkout_branch` dirty, `force=False` | Raises `BranchError`; no session change | `checkout-refuses-on-dirty` |
| 34 | `checkout_branch` dirty, `force=True` | Proceeds; WC replaced with tip snapshot | `checkout-force-discards-changes` |
| 35 | `checkout_branch` missing target | Raises `BranchError` | `checkout-rejects-missing-target` |
| 36 | `checkout_branch` missing session | Raises `BranchError` | `checkout-rejects-missing-session` |
| 37 | `checkout_branch` branch tip points to missing commit | Raises `BranchError`; no session mutation | `checkout-rejects-dangling-tip` |
| 38 | `checkout_branch` target has empty tip (no commits) | Empty DB created at new WC path; session advanced | `checkout-empty-branch-creates-empty-db` |
| 39 | `checkout_branch` old WC unlink fails (OSError) | Old WC lingers; new WC valid; no error raised | `checkout-swallows-old-wc-unlink-error` |
| 40 | `create_session` new user/project/branch, branch has tip | Copies tip snapshot to WC; inserts row; `reused=False` | `create-session-fresh-from-tip` |
| 41 | `create_session` reuse when branch unchanged and WC exists | `reused=True`; `last_active` touched; no copy | `create-session-reuses-when-unchanged` |
| 42 | `create_session` stale (branch advanced) | Deletes old row + WC; creates fresh | `create-session-replaces-stale` |
| 43 | `create_session` branch has no tip, legacy `project.db` exists | Copies legacy DB to WC | `create-session-copies-legacy-project-db` |
| 44 | `create_session` branch has no tip, no legacy DB | Creates empty DB with `meta` table | `create-session-creates-empty-db` |
| 45 | `prune_sessions(max_age_days=N)` | Rows older than cutoff deleted; WC files unlinked; count returned | `prune-sessions-deletes-stale` |
| 46 | `delete_session` found | Row removed; WC unlinked; returns `True` | `delete-session-removes-and-returns-true` |
| 47 | `delete_session` missing | Returns `False` | `delete-session-missing-returns-false` |
| 48 | `commit_working_copy` first commit on branch | `parents=[]`; ref advanced | `commit-working-copy-first-commit` |
| 49 | `commit_working_copy` subsequent commit | `parents=[prev_tip]`; ref advanced | `commit-working-copy-advances-ref` |
| 50 | Two concurrent `commit_working_copy` calls on same branch | `undefined` — last `set_ref` wins; earlier commit becomes orphan reachable only by hash | → [OQ-1](#open-questions) |
| 51 | `delete_branch` races with `checkout_branch` to same branch | `undefined` — no lock between ref check and mutate | → [OQ-2](#open-questions) |
| 52 | Checkout when new WC file is OS-locked by another process | `undefined` — new-WC `copy2` may fail with OSError mid-op; session row not updated; old WC still referenced | → [OQ-3](#open-questions) |
| 53 | `commit_working_copy` first commit on a branch (no prior ref) | `parents=[]` (explicitly empty list, NOT `[""]`) | `commit-working-copy-first-commit` |
| 54 | Switching to a branch whose WC file was externally deleted between create_session and checkout | `undefined` — `has_uncommitted_changes` returns `False` (WC missing), checkout proceeds and repopulates WC from tip | → [OQ-4](#open-questions) |
| 55 | Object-store file for a commit's `db_hash` is missing | `undefined` — `checkout_branch` via `copy_snapshot_to` raises `FileNotFoundError` (not wrapped as `BranchError`) | → [OQ-5](#open-questions) |
| 56 | Branch name contains Unicode letters (e.g. "feature-ß") | Rejected by `_BRANCH_NAME_RE` — `BranchError`. Current regex is ASCII-only | `validate-branch-name-rejects-unicode` |
| 57 | Branch name with valid Unicode intent but caller expected support | `undefined` whether this is desired behavior or a bug | → [OQ-6](#open-questions) |
| 58 | Writing a ref while another process reads it | File-level atomicity from `write_text` on the same filesystem; concurrent readers see either old or new content, never torn | `set-ref-atomic-on-same-fs` |
| 59 | Multi-ref atomicity (update two branches together) | Not supported — each `set_ref` is a separate file write | `set-ref-no-multi-ref-atomicity` |
| 60 | Coexistence with legacy `checkpoints` table | Out of scope for this spec; VCS does not read/write the checkpoints table | `vcs-ignores-checkpoints-table` |

---

## Behavior (step-by-step)

### Commit

1. Caller invokes `commit_working_copy(source_db, branch, author, message)`.
2. `store_snapshot` runs `sqlite3.backup` from `source_db` to a
   freshly-named temp file in `<project_dir>/objects/`.
3. The temp file's SHA-256 is computed.
4. If `<hash>.db` exists, the temp file is unlinked; else the temp file
   is renamed to `<hash>.db`.
5. `parent = get_ref(branch)`; `parents = [parent] if parent else []`.
6. `timestamp = datetime.now(tz=UTC).isoformat()`.
7. `canonical = json.dumps({db_hash, parents, author, message,
   timestamp}, sort_keys=True, separators=(",", ":"))`.
8. `commit_hash = sha256(canonical)`.
9. `commits/<commit_hash>.json` is written (pretty-printed, indent=2)
   containing all fields including `hash`.
10. `set_ref(branch, commit_hash)` overwrites the ref file.
11. Commit dict returned to caller.

### Checkout

1. Caller invokes `checkout_branch(session_id, target_branch)`.
2. Branch name validated.
3. Target branch existence checked.
4. Session row loaded; missing → `BranchError`.
5. `has_uncommitted_changes` checked unless `force=True`.
6. New WC path computed:
   `<sc_root>/users/<user>/sessions/<project>--<branch with '/' → '--'>.db`.
7. Target tip read.
8. If tip is non-empty, commit must exist; its `db_hash` is copied to the
   new WC path.
9. If tip is empty, a fresh empty DB is created at the new WC path.
10. If the old WC path differs from the new one and the old file
    exists, `unlink()` is attempted; `OSError` is silently swallowed.
11. Session row updated with new branch / commit_hash / working_copy
    / last_active.
12. Re-read row returned.

### Session reuse

1. `create_session` looks up an existing row for the
   `(username, org, project, branch)` tuple.
2. Read branch tip.
3. If `row.commit_hash == tip` AND WC file exists → touch and reuse.
4. Else delete any old WC file and old row; fall through to create a
   new session.

---

## Acceptance Criteria

- [ ] SHA-256 hashes of stored objects match the file bytes exactly
- [ ] Two snapshots of identical DB content produce identical hashes
      and exactly one file on disk
- [ ] A commit's hash is byte-deterministic given its fields
- [ ] First commit on a new branch has `parents == []`
- [ ] `refs/main` exists from project bootstrap and cannot be deleted
- [ ] `validate_branch_name` accepts exactly the regex
      `^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$` with length 1..100
- [ ] `has_uncommitted_changes` correctly distinguishes clean / dirty /
      no-baseline / dangling / WC-missing
- [ ] `checkout_branch` refuses on dirty unless `force=True`
- [ ] `create_session` reuses only when branch tip matches row and WC
      exists; otherwise replaces
- [ ] `prune_sessions` unlinks WC files and returns count
- [ ] All Open Questions are resolved OR explicitly accepted as
      `undefined` by the user

---

## Tests

### Base Cases

#### Test: store-snapshot-writes-new-object (covers R1.1, R1.2)

**Given**: A fresh project dir with empty `objects/`, and a valid SQLite
file `source.db`.
**When**: `store_snapshot(project_dir, source.db)` is called.
**Then**:
- **returns-hex-hash**: The return value is a 64-char lowercase hex string.
- **object-file-exists**: `<project_dir>/objects/<hash>.db` exists.
- **bytes-match-hash**: SHA-256 of that file equals the returned hash.
- **no-temp-remains**: No stray `tmp*.db` files left in `objects/`.

#### Test: store-snapshot-dedupes (covers R1.2)

**Given**: `store_snapshot` was previously called on identical DB bytes.
**When**: Called again with the same source content.
**Then**:
- **same-hash**: Return value equals prior hash.
- **single-file**: Still only one `<hash>.db` in `objects/`.
- **mtime-unchanged**: The existing file's mtime is not updated
  (dedup skips the rename).

#### Test: load-snapshot-returns-path (covers R1.3)

**Given**: An object with hash H is stored.
**When**: `load_snapshot(project_dir, H)` is called.
**Then**:
- **returns-path**: Returns `<project_dir>/objects/<H>.db` as a `Path`.

#### Test: load-snapshot-missing-raises (covers R1.3)

**Given**: No object with hash `H` is stored.
**When**: `load_snapshot(project_dir, H)` is called.
**Then**:
- **raises-fnf**: `FileNotFoundError` raised, mentioning hash `H`.

#### Test: copy-snapshot-to-dest (covers R1.4)

**Given**: Object with hash `H` stored; `dest` path is inside a
nonexistent directory.
**When**: `copy_snapshot_to(project_dir, H, dest)` is called.
**Then**:
- **dest-parent-created**: `dest.parent` exists afterwards.
- **dest-exists**: `dest` is a file.
- **bytes-identical**: `dest` bytes equal `objects/<H>.db` bytes.

#### Test: create-commit-deterministic-hash (covers R2.1, R2.2)

**Given**: Metadata `{db_hash, parents, author, message, timestamp}`.
**When**: A commit is created with those fields.
**Then**:
- **hash-equals-sha**: Returned hash equals
  `sha256(json.dumps(meta, sort_keys=True, separators=(",",":")))`.
- **commit-file-exists**: `commits/<hash>.json` exists.
- **file-contains-hash-field**: Parsed JSON contains `hash` equal to the
  returned hash.

#### Test: create-commit-immutable-fields (covers R2.4)

**Given**: A commit was created.
**When**: The commit file's bytes are inspected again later (no
intervening write).
**Then**:
- **bytes-unchanged**: File bytes are byte-for-byte identical to the
  bytes written at creation.

#### Test: identical-metadata-same-hash (covers R2.2)

**Given**: Two `create_commit` calls with identical fields (same
timestamp forced).
**When**: Both return.
**Then**:
- **same-hash**: Returned hashes are equal.
- **single-file**: Only one file in `commits/`.

#### Test: get-commit-returns-dict (covers R2.5)

**Given**: A commit with hash `H` exists.
**When**: `get_commit(project_dir, H)`.
**Then**:
- **returns-dict**: Result is a dict containing `hash`, `db_hash`,
  `parents`, `author`, `message`, `timestamp`.

#### Test: get-commit-missing-returns-none (covers R2.5)

**Given**: No commit with hash `H`.
**When**: `get_commit(project_dir, H)`.
**Then**:
- **returns-none**: Result is `None` (no exception).

#### Test: list-commits-walks-first-parents (covers R2.6)

**Given**: Linear chain `A ← B ← C` where `C` is the head.
**When**: `list_commits(project_dir, C)`.
**Then**:
- **returns-newest-first**: Returns `[C, B, A]`.
- **length-matches**: Length equals 3.

#### Test: list-commits-respects-limit (covers R2.6)

**Given**: Chain of 10 commits.
**When**: `list_commits(project_dir, head, limit=3)`.
**Then**:
- **length-3**: Exactly 3 commits returned.

#### Test: get-ref-missing-returns-empty (covers R3.2)

**Given**: No ref file at `refs/foo`.
**When**: `get_ref(project_dir, "foo")`.
**Then**:
- **returns-empty-str**: Returns `""`.

#### Test: set-ref-creates-file (covers R3.3)

**Given**: No ref file at `refs/foo`.
**When**: `set_ref(project_dir, "foo", "abc123")`.
**Then**:
- **file-exists**: `refs/foo` exists.
- **round-trips**: `get_ref(project_dir, "foo") == "abc123"`.

#### Test: list-refs-includes-nested (covers R3.4)

**Given**: `refs/main`, `refs/alice/feature-x`, `refs/bob/wip`.
**When**: `list_refs(project_dir)`.
**Then**:
- **contains-all-keys**: Result keys include `main`, `alice/feature-x`,
  `bob/wip`.
- **values-match**: Each value equals the stripped file content.

#### Test: main-ref-always-exists (covers R3.5)

**Given**: A freshly bootstrapped project.
**When**: `get_ref(project_dir, "main")`.
**Then**:
- **file-exists**: `refs/main` file exists.
- **returns-empty-string**: Returns `""` (no commit yet).

#### Test: validate-branch-name-accepts-valid (covers R4.1)

**Given**: Names `"main"`, `"feature-x"`, `"alice/wip"`,
`"a/b/c/d"`, `"A_1"`, 100-char string of valid chars.
**When**: `validate_branch_name(name)` for each.
**Then**:
- **no-raise**: None raise.

#### Test: validate-branch-name-rejects-invalid (covers R4.1)

**Given**: Names `""`, `"/foo"`, `"foo/"`, `"foo bar"`,
`"foo..bar"`, `"foo#"`, `None`, 101-char valid-char string.
**When**: `validate_branch_name(name)` for each.
**Then**:
- **raises-brancherror**: Each raises `BranchError`.

#### Test: create-branch-copies-from-ref (covers R4.2)

**Given**: `main` points to commit `X`.
**When**: `create_branch(project_dir, "feature-x")`.
**Then**:
- **ref-exists**: `refs/feature-x` exists.
- **ref-value**: `get_ref("feature-x") == X`.
- **returns-struct**: Returns `{"name": "feature-x",
  "commit_hash": X, "from_branch": "main"}`.

#### Test: create-branch-rejects-existing (covers R4.2)

**Given**: `refs/feature-x` already exists.
**When**: `create_branch(project_dir, "feature-x")`.
**Then**:
- **raises-brancherror**: `BranchError` with message mentioning
  "already exists".
- **ref-unchanged**: `refs/feature-x` bytes unchanged.

#### Test: create-branch-rejects-missing-source (covers R4.2)

**Given**: `refs/src-branch` does not exist.
**When**: `create_branch(project_dir, "new",
from_branch="src-branch")`.
**Then**:
- **raises-brancherror**: `BranchError`.
- **no-new-ref**: `refs/new` does not exist.

#### Test: list-branches-sorted-and-marked (covers R4.3)

**Given**: Branches `main`, `feature-b`, `alice/wip`.
**When**: `list_branches(project_dir, current_branch="feature-b")`.
**Then**:
- **sorted-alpha**: Names appear in sorted order.
- **exactly-one-current**: Exactly one entry has `isCurrent=True`, and
  its `name` is `"feature-b"`.

#### Test: delete-branch-rejects-main (covers R4.4)

**Given**: `refs/main` exists.
**When**: `delete_branch(project_dir, "main")`.
**Then**:
- **raises-brancherror**: `BranchError("Cannot delete the 'main' branch")`.
- **main-still-exists**: `refs/main` still present.

#### Test: delete-branch-rejects-current (covers R4.4)

**Given**: `refs/feature-x` exists; `current_branch="feature-x"`.
**When**: `delete_branch(project_dir, "feature-x",
current_branch="feature-x")`.
**Then**:
- **raises-brancherror**: `BranchError`.
- **ref-unchanged**: `refs/feature-x` still exists.

#### Test: delete-branch-rejects-missing (covers R4.4)

**Given**: No `refs/foo`.
**When**: `delete_branch(project_dir, "foo")`.
**Then**:
- **raises-brancherror**: `BranchError` mentioning "not found".

#### Test: delete-branch-cleans-empty-parents (covers R4.4)

**Given**: `refs/alice/feature-x` is the only file under `refs/alice/`.
**When**: `delete_branch(project_dir, "alice/feature-x")`.
**Then**:
- **ref-removed**: `refs/alice/feature-x` gone.
- **parent-removed**: `refs/alice/` directory removed.
- **refs-root-preserved**: `refs/` itself remains.

#### Test: uncommitted-false-when-clean (covers R4.5)

**Given**: Session recorded commit `C` with `db_hash=H`; WC is a
byte-identical snapshot.
**When**: `has_uncommitted_changes(project_dir, session)`.
**Then**:
- **returns-false**: `False`.

#### Test: uncommitted-true-when-dirty (covers R4.5)

**Given**: WC content mutated since last commit.
**When**: `has_uncommitted_changes`.
**Then**:
- **returns-true**: `True`.

#### Test: uncommitted-true-when-no-baseline (covers R4.5)

**Given**: `session.commit_hash == ""`.
**When**: `has_uncommitted_changes`.
**Then**:
- **returns-true**: `True`.

#### Test: uncommitted-true-when-commit-missing (covers R4.5)

**Given**: `session.commit_hash = "deadbeef"`; no such commit on disk.
**When**: `has_uncommitted_changes`.
**Then**:
- **returns-true**: `True`.

#### Test: uncommitted-false-when-wc-missing (covers R4.5)

**Given**: `session.working_copy` path does not exist.
**When**: `has_uncommitted_changes`.
**Then**:
- **returns-false**: `False`.

#### Test: checkout-updates-session (covers R4.6)

**Given**: Clean session on `main`; branch `feature-x` exists with
tip `T` (commit present).
**When**: `checkout_branch(sc_root, session_id, "feature-x",
project_dir)`.
**Then**:
- **session-branch-updated**: Row's `branch == "feature-x"`.
- **session-commit-updated**: Row's `commit_hash == T`.
- **new-wc-path**: Row's `working_copy` ends with
  `<project>--feature-x.db`.
- **wc-exists**: That file exists.
- **wc-bytes-match-commit**: Its bytes equal the stored object for
  the commit's `db_hash`.

#### Test: checkout-refuses-on-dirty (covers R4.6)

**Given**: Session is dirty (WC hash != commit `db_hash`).
**When**: `checkout_branch(..., force=False)`.
**Then**:
- **raises-brancherror**: `BranchError` with "uncommitted changes".
- **session-unchanged**: Session row's `branch`, `commit_hash`,
  `working_copy` unchanged.
- **wc-bytes-unchanged**: WC file bytes unchanged.

#### Test: checkout-force-discards-changes (covers R4.6)

**Given**: Dirty session; target `feature-x`.
**When**: `checkout_branch(..., force=True)`.
**Then**:
- **session-advanced**: Session row points to `feature-x` / its tip.
- **wc-overwritten**: WC bytes equal tip commit's stored object.

#### Test: checkout-rejects-missing-target (covers R4.6)

**Given**: No `refs/missing`.
**When**: `checkout_branch(..., "missing")`.
**Then**:
- **raises-brancherror**: `BranchError` ("Branch not found").
- **session-unchanged**: No mutation.

#### Test: checkout-rejects-missing-session (covers R4.6)

**Given**: `session_id="nope"` not in `sessions.db`.
**When**: `checkout_branch(..., session_id="nope", ...)`.
**Then**:
- **raises-brancherror**: `BranchError` ("Session not found").

#### Test: commit-working-copy-first-commit (covers R6.1)

**Given**: `refs/feature-x` exists with empty content.
**When**: `commit_working_copy(project_dir, source_db,
"feature-x", author, message)`.
**Then**:
- **parents-empty-list**: Returned commit's `parents == []`.
- **ref-advanced**: `get_ref("feature-x")` equals returned hash.
- **object-stored**: `objects/<db_hash>.db` exists.

#### Test: commit-working-copy-advances-ref (covers R6.1)

**Given**: `refs/main` points to `P`.
**When**: `commit_working_copy(..., "main", ...)`.
**Then**:
- **parents-is-prev**: Returned `parents == [P]`.
- **ref-moved**: `get_ref("main") == returned.hash`.

#### Test: create-session-fresh-from-tip (covers R5.2)

**Given**: No prior session row; branch `main` has tip `T` with commit
present.
**When**: `create_session(sc_root, alice, org, project, project_dir)`.
**Then**:
- **row-inserted**: A new row exists.
- **reused-false**: Returned `reused == False`.
- **id-12-hex**: Returned `id` matches `^[0-9a-f]{12}$`.
- **wc-copied**: WC file bytes equal the tip commit's stored object.

#### Test: create-session-reuses-when-unchanged (covers R5.2)

**Given**: A prior session for the same tuple with matching
`commit_hash` and existing WC.
**When**: `create_session(...)` called again.
**Then**:
- **reused-true**: Returned `reused == True`.
- **id-stable**: Returned `id` equals prior row's `id`.
- **last-active-touched**: Row's `last_active` advanced.
- **no-new-wc-write**: WC mtime unchanged.

#### Test: create-session-replaces-stale (covers R5.2)

**Given**: Prior row exists with `commit_hash != current tip` OR WC
file missing.
**When**: `create_session(...)`.
**Then**:
- **old-row-gone**: Prior id no longer returnable via `get_session`.
- **new-row-present**: A fresh id is returned.
- **old-wc-unlinked**: Old WC path does not exist.

#### Test: create-session-copies-legacy-project-db (covers R5.2)

**Given**: Branch has no tip; legacy `project.db` exists at one of
the fallback locations.
**When**: `create_session(...)`.
**Then**:
- **wc-bytes-match-legacy**: WC bytes equal legacy `project.db` bytes.

#### Test: create-session-creates-empty-db (covers R5.2)

**Given**: Branch has no tip; no legacy `project.db`.
**When**: `create_session(...)`.
**Then**:
- **wc-exists**: WC file exists.
- **has-meta-table**: `SELECT name FROM sqlite_master WHERE type='table'
  AND name='meta'` returns a row.

#### Test: prune-sessions-deletes-stale (covers R5.7)

**Given**: 3 sessions: two with `last_active` > 7 days old, one recent.
**When**: `prune_sessions(sc_root, max_age_days=7)`.
**Then**:
- **count-2**: Returns `2`.
- **rows-deleted**: Only the recent session remains.
- **wcs-unlinked**: Old WC files no longer on disk.

#### Test: delete-session-removes-and-returns-true (covers R5.8)

**Given**: A session exists with WC on disk.
**When**: `delete_session(session_id)`.
**Then**:
- **returns-true**: Returns `True`.
- **row-gone**: `get_session` returns `None`.
- **wc-unlinked**: WC file does not exist.

#### Test: delete-session-missing-returns-false (covers R5.8)

**Given**: No such session id.
**When**: `delete_session("nope")`.
**Then**:
- **returns-false**: Returns `False`.

#### Test: vcs-ignores-checkpoints-table (covers out-of-scope boundary)

**Given**: A working copy DB contains rows in the legacy `checkpoints`
table.
**When**: Any VCS operation (`store_snapshot`, `commit_working_copy`,
`checkout_branch`) executes.
**Then**:
- **no-checkpoints-reads**: No SQL queries against the `checkpoints`
  table originate from `scenecraft/vcs/*`.
- **no-checkpoints-writes**: No VCS code path writes to the
  `checkpoints` table.
- **snapshot-bytes-include-checkpoints**: The snapshot's contents do
  contain the checkpoints table (because it's in the source DB), but
  VCS code does not interact with it.

### Edge Cases

#### Test: list-commits-breaks-cycle (covers R2.6)

**Given**: A malformed chain where commit `A.parents[0] == A`
(self-loop).
**When**: `list_commits(project_dir, A)`.
**Then**:
- **terminates**: Returns within bounded time.
- **length-1**: Returns exactly `[A]`.

#### Test: list-commits-stops-on-missing-parent (covers R2.6)

**Given**: Chain `A ← B ← C`; commit file for `A` deleted from disk.
**When**: `list_commits(project_dir, C)`.
**Then**:
- **length-2**: Returns `[C, B]` (stops when parent `A` is missing).
- **no-exception**: No exception raised.

#### Test: set-ref-atomic-on-same-fs (covers R3.3)

**Given**: A reader thread is repeatedly reading `refs/main` while a
writer overwrites it.
**When**: The writer calls `set_ref("main", new_hash)` N times.
**Then**:
- **no-partial-reads**: No reader ever observes a hash that is neither
  the old nor the new complete value.

_Note_: Backed only by `Path.write_text` semantics on the underlying
filesystem (typically POSIX `write(2)` up to PIPE_BUF for short
strings). The code does not use a `rename`-based atomic swap.

#### Test: set-ref-no-multi-ref-atomicity (covers R3.3)

**Given**: Two refs need to be updated together.
**When**: Caller invokes `set_ref("a", X)` and `set_ref("b", Y)`.
**Then**:
- **no-joint-guarantee**: A concurrent reader may observe `a=X` and
  `b=oldY`, or `a=oldX` and `b=Y`, or both-new, or both-old.
- **no-api-for-joint**: No public VCS function exposes a joint update.

#### Test: checkout-rejects-dangling-tip (covers R4.6)

**Given**: `refs/feature-x` points to hash `T`, but
`commits/T.json` was deleted out-of-band.
**When**: `checkout_branch(..., "feature-x")`.
**Then**:
- **raises-brancherror**: `BranchError` mentioning "missing commit".
- **session-unchanged**: Session row unchanged.
- **wc-unchanged**: Old WC bytes unchanged.

#### Test: checkout-empty-branch-creates-empty-db (covers R4.6)

**Given**: Branch exists with empty tip.
**When**: `checkout_branch(..., that_branch)`.
**Then**:
- **wc-file-created**: New WC path exists.
- **has-meta-table**: `meta` table present; no other user tables.
- **session-commit-empty**: Row's `commit_hash == ""`.

#### Test: checkout-swallows-old-wc-unlink-error (covers R4.6, audit-2 leak #11)

**Given**: Clean session; old WC is locked (e.g. SQLite handle held
open) so `unlink()` raises `OSError` on Windows / Linux w/ mandatory
locking. New WC path differs from old.
**When**: `checkout_branch(...)`.
**Then**:
- **no-error-propagated**: The function returns normally.
- **new-wc-valid**: New WC exists and matches the tip.
- **old-wc-lingers**: Old WC file still present on disk (orphaned;
  will be cleaned only by `prune_sessions` or manual delete).

#### Test: validate-branch-name-rejects-unicode (covers R4.1)

**Given**: Name `"feature-ß"`, `"feat-日本"`, `"emoji-🔥"`.
**When**: `validate_branch_name(name)`.
**Then**:
- **raises-brancherror**: Each raises `BranchError`.

_Note_: Whether this is desired is tracked in [OQ-6](#open-questions).

---

## Non-Goals

- No merge, rebase, cherry-pick, or conflict-resolution engines.
- No content-level diff between commits (byte-identity only).
- No remote repositories, push/pull, or federation.
- No cryptographic signing of commits (only SHA-256 content hashing).
- No GC of unreachable objects/commits — `store_snapshot`'s dedup is
  the only disk-space bound.
- No concurrency primitives beyond SQLite's own row-level locking in
  `sessions.db`. Cross-process coordination of ref writes is left to
  the caller / OS.
- No schema compatibility check between a working copy and the object
  it was derived from (checkout blindly overwrites).

---

## Open Questions

### OQ-1 — Concurrent commits on the same branch

Two concurrent `commit_working_copy` calls against the same branch have
no locking between `get_ref` (step 2) and `set_ref` (step 5). The
second call's `set_ref` wins; the first commit becomes orphaned (still
present in `commits/` and `objects/`, but not pointed to by any ref and
reachable only if the caller kept the hash).

**Needs decision**:
- Is this acceptable (rely on single-writer-per-branch convention)?
- Should `set_ref` become CAS (expect-old-hash → write-new-hash)?
- Should commits coordinate via a project-level lockfile?

### OQ-2 — Ref update race with branch delete

`delete_branch` and `checkout_branch` / `commit_working_copy` against
the same branch have no cross-operation coordination. A delete racing
with a checkout can result in: checkout validates existence, delete
removes the ref, checkout's `copy_snapshot_to` succeeds but the
session ends up with a `branch` field naming a now-nonexistent ref.

**Needs decision**: Is session-to-ref integrity a required invariant,
or is "ref gone, session points at it" acceptable (with the WC still
valid bytes-wise)?

### OQ-3 — Session WC locked during checkout

If the new WC path is locked by another process when `copy_snapshot_to`
is called (e.g. a previous session still has a SQLite connection open
to that exact path — note R5.2 puts all of a user's branches on
collision-free paths, but branch-name collisions like
`feature/x` vs `feature--x` after slash substitution could collide
in theory), `shutil.copy2` raises an exception mid-checkout. Session
row is NOT updated, old WC is NOT unlinked (unlink step is never
reached), caller sees exception.

**Needs decision**: Is the current "raise through" behavior intended,
or should the code retry / rename around / report a `BranchError`?

### OQ-4 — Switching to a branch whose WC file was externally deleted

If the new-WC target path was externally deleted between session
creation and checkout, `copy_snapshot_to` simply recreates it (via
`shutil.copy2`). This is observable as a silent re-materialization.

**Needs decision**: Is this silent re-creation desirable? Should the
code emit a warning / log?

### OQ-5 — Object store file missing for a commit's `db_hash`

If `commits/<T>.json` exists but `objects/<db_hash>.db` was deleted,
`checkout_branch` raises `FileNotFoundError` (from `load_snapshot` via
`copy_snapshot_to`) — NOT a `BranchError`. The exception escapes past
the error-handling contract the rest of `checkout_branch` uses.

**Needs decision**: Should this be wrapped as `BranchError("Object
store corrupted: missing db_hash for commit <T>")`? Or is the raw
`FileNotFoundError` intended as a "this is catastrophic, don't hide
it" signal?

### OQ-6 — Unicode branch names

The regex `^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$` is ASCII-only.
Unicode letters are rejected.

**Needs decision**: Is ASCII-only intentional (filesystem-portability
concern for cross-platform sync)? Or is this a bug that should be
fixed with `re.UNICODE` + a Unicode-letter character class?

### OQ-7 — Commit-ref transaction

R6.2 notes that `commit_working_copy` is not transactional across
store-commit-ref. A crash between `create_commit` and `set_ref`
orphans the commit.

**Needs decision**: Acceptable as-is (orphans are harmless, space
bounded by dedup), or should there be a WAL-style "pending-commit"
state that's cleaned up at startup?

### OQ-8 — Multi-parent (merge) commits

`create_commit`'s signature accepts `parents: list[str]` of arbitrary
length, but no caller produces more than one, and `list_commits` only
walks `parents[0]`.

**Needs decision**: Should the spec forbid `len(parents) > 1` (raise
on input) until merge is implemented? Or preserve the shape for
forward-compat?

---

## Related Artifacts

- `agent/reports/audit-2-architectural-deep-dive.md` — §1F VCS unit
  catalog; §2 invariants "Immutable VCS"; §3 leaks #7 (checkpoints ↔
  commits coexistence) and #11 (session WC unlink swallows OSError)
- `agent/specs/local.source-monitor-panel.md` — frontend consumer of
  some VCS data (indirect)
- Auth spec (to be created) — will own `username` / `org` validation
  that this spec treats as trusted inputs
- Source files:
  - `scenecraft-engine/src/scenecraft/vcs/objects.py`
  - `scenecraft-engine/src/scenecraft/vcs/sessions.py`
  - `scenecraft-engine/src/scenecraft/vcs/branches.py`
  - `scenecraft-engine/src/scenecraft/vcs/bootstrap.py`
