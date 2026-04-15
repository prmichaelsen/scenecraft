# Git-Style Version Control for Scenecraft

**Concept**: Full Git data model applied to SQLite project state — commits, branches, merge, rebase, DAG history — enabling multi-user collaboration with branch-based workflows  
**Created**: 2026-04-15  
**Status**: Active  

---

## Overview

Replace the existing checkpoint system with a Git-style version control layer operating on SQLite database snapshots. Each commit is an immutable, content-addressed DB snapshot. Branches are named pointers to commits. Users edit working copies tied to their session and branch. Merging uses three-way SQL-level diffing with a visual conflict resolution UI.

This is the foundation for multi-user collaboration: users branch, edit independently, and merge their changes — the same workflow developers use with Git, applied to film/video project state.

---

## Problem Statement

- **No collaboration**: only one user can edit a project at a time
- **No branching**: can't experiment on a separate copy and merge back
- **Flat history**: checkpoints are timestamp-ordered snapshots with no parent/child relationships, no DAG, no merge capability
- **No auth**: API is wide open — no user identity, no attribution
- **ID collisions**: sequential IDs (`kf_001`) would collide across branches

---

## Data Model

### Objects (Content-Addressed DB Snapshots)

Each commit points to a DB snapshot stored by its content hash.

```
project/
  objects/
    a3f8c2e9...db    # SHA-256 of the DB file contents
    b7d1e4f3...db
    ...
```

- Immutable once written
- Deduplicated by content (identical states share the same object)
- Created via `sqlite3.backup()` + hash

### Commits

```python
{
    "hash": "c4a9b2...",          # SHA-256 of this commit's serialized metadata
    "db_hash": "a3f8c2...",       # points to the DB snapshot in objects/
    "parents": ["b7d1e4..."],     # one parent (normal) or two (merge commit)
    "author": "prmichaelsen",     # from SSH identity
    "message": "Add sunset keyframes to act 2",
    "timestamp": "2026-04-15T14:30:00Z"
}
```

- Stored in `commits/` directory (one JSON file per commit, named by hash)
- Initial commit has `parents: []`
- Merge commit has `parents: [ours_hash, theirs_hash]`

### Branches (Refs)

```
project/
  refs/
    main                          # contains: c4a9b2...
    prmichaelsen/color-pass       # contains: d8e3f1...
    jane/audio-sync               # contains: f2a7c9...
```

- Plain text files containing a commit hash
- Advancing a branch = overwriting the file with a new hash
- `main` is the default/canonical branch
- Branches are **explicitly created** by the user (not implicit on second user open)
- Branch naming: `{username}/{branch-name}` (e.g., `prmichaelsen/color-pass`)
- Each user opening a project gets their own independent working copy (branch) by default
- Co-editing (multiple users on same branch) is opt-in, P5 future feature
- Branches can be deleted after merging
- No limit on active branches per project

### Sessions

```sql
-- sessions.db (server-level, not per-project)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,           -- session UUID
    user TEXT NOT NULL,            -- username (from SSH identity)
    project TEXT NOT NULL,         -- project name
    branch TEXT NOT NULL,          -- branch name (e.g., "main")
    commit_hash TEXT NOT NULL,     -- commit this working copy is based on
    working_copy TEXT NOT NULL,    -- path to the live DB file
    created_at TEXT NOT NULL,
    last_active TEXT NOT NULL
);
```

- Each active editing session has its own working copy DB
- When a user opens a project on a branch, the server:
  1. Looks up the branch's latest commit
  2. Copies that commit's DB snapshot to a working copy path
  3. Records the session in `sessions.db`
- All API calls for that session route to their working copy, not a shared `project.db`

### HEAD

Not a file — derived from the session. The user's HEAD is their session's `{branch, commit_hash}`.

### Directory Structure

```
.scenecraft/
  orgs/
    acme-studio/
      org.db                        # org settings, membership
      projects/
        music-video-1/
          objects/                   # content-addressed DB snapshots
            a3f8c2e9...db
            b7d1e4f3...db
          refs/                     # branch pointers
            main
            prmichaelsen/color-pass
          commits/                  # commit metadata
          assets/                   # shared images, videos, audio
            selected_keyframes/
            keyframe_candidates/
            transition_videos/
        commercial-spot/
          ...
    indie-collective/
      ...
  users/
    prmichaelsen/
      user.db                       # user prefs, saved workspaces
      sessions/                     # active working copies
        music-video-1--main.db
        music-video-1--color-pass.db
    jane/
      user.db
      sessions/
        music-video-1--audio-sync.db
  sessions.db                       # global session index
  server.db                         # server config, user registry
```

- **Orgs** own projects. Projects live under their org.
- **Users** have their own directory for preferences, working copies, and session state.
- **Assets** are shared across all branches within a project (immutable once generated).
- **Working copies** live under the user's directory, not the project — so two users on the same branch have isolated DBs.

---

## Authentication

### SSH-Based Identity

Users are identified by their SSH access to the server.

**Flow**:
1. Admin registers users: `scenecraft user add <username> --pubkey <path>`
2. User SSHs into server, runs `scenecraft token` → generates JWT
3. JWT encodes `{username, pubkey_fingerprint, issued_at, expires_at}`
4. Browser stores JWT in localStorage, sends as `Authorization: Bearer <token>` header
5. Server validates JWT signature on every API request

**User storage** (server-level):
```sql
CREATE TABLE users (
    username TEXT PRIMARY KEY,
    pubkey_fingerprint TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    created_at TEXT NOT NULL,
    role TEXT DEFAULT 'editor'     -- 'admin' | 'editor' | 'viewer'
);
```

**No external auth providers** — everything self-hosted on the instance.

---

## Operations

### Commit

```
User edits working copy → "Commit" →
  1. Hash working copy DB → store in objects/
  2. Create commit object (db_hash, parent=current branch tip, author, message)
  3. Store commit in commits/
  4. Update branch ref to new commit hash
  5. Update session's commit_hash
```

### Branch

```
User creates branch "prmichaelsen/experiment" →
  1. Create ref file: refs/prmichaelsen/experiment → current commit hash
  2. Create new working copy from that commit's DB snapshot
  3. Create new session entry pointing to the new branch
```

### Checkout

```
User switches to branch "main" →
  1. If working copy has uncommitted changes: warn / auto-commit / discard
  2. Look up main's latest commit
  3. Copy that commit's DB snapshot to a new working copy
  4. Update session to point to main
```

### Diff

Compare two commits by loading their DB snapshots and performing **row-level** SQL diffing (entire row, not field-level):

```python
def diff_commits(base_hash, target_hash):
    base_db = load_object(base_hash)
    target_db = load_object(target_hash)
    
    changes = {}
    for table in DIFFABLE_TABLES:
        base_rows = {row['id']: row for row in query(base_db, table)}
        target_rows = {row['id']: row for row in query(target_db, table)}
        
        added = {id: row for id, row in target_rows.items() if id not in base_rows}
        deleted = {id: row for id, row in base_rows.items() if id not in target_rows}
        modified = {id: (base_rows[id], target_rows[id]) 
                    for id in base_rows.keys() & target_rows.keys()
                    if base_rows[id] != target_rows[id]}
        
        changes[table] = {"added": added, "deleted": deleted, "modified": modified}
    return changes
```

### Merge (Rebase-Style)

Merging is done by **replaying the branch on top of main** (rebase semantics). This keeps history linear and avoids merge commits.

```
1. Find fork point (merge base between branch and main)
2. Collect branch commits from fork point to branch tip
3. For each commit, compute its SQL changeset (diff vs its parent)
4. Apply each changeset sequentially onto main's tip
5. Conflicts at any step → show merge preview UI, user resolves
6. Create new commit objects (new hashes, rebased parents)
7. Fast-forward main to the final rebased commit
```

### Conflict Rules

- **Same row modified on both sides** (by primary key): conflict
- **Delete on A + modify on B** (same row): conflict
- **Same timestamp, different IDs**: conflict (overlapping keyframes)
- **Meta/settings changed on both sides**: always conflict
- **Non-conflicting changes**: auto-merge (but always preview before applying)
- **New rows on only one side**: auto-merge if no conflict

---

## Merge UI

Implemented as a **dockview workspace view** (not a separate page) — coexists with the editor and can be saved/restored like any layout.

Three-column layout with conflict resolution:

```
+------------------+------------------+------------------+
|   Base (ancestor) |   Branch A (ours) |  Branch B (theirs)|
|                  |                  |                  |
| [Timeline+Preview]| [Timeline+Preview]| [Timeline+Preview]|
|                  |                  |                  |
+------------------+------------------+------------------+
|              Conflict Resolution Panel                 |
|  ┌──────────────────────────────────────────────────┐  |
|  │ KF kf_a3f8: prompt changed on both sides        │  |
|  │ [Take Left] [Take Right] [Take Both]            │  |
|  │                                                  │  |
|  │ TR tr_b7d1: deleted on A, modified on B         │  |
|  │ [Accept Delete] [Keep Modified]                 │  |
|  └──────────────────────────────────────────────────┘  |
+--------------------------------------------------------+
|              Merged Result Preview                      |
+--------------------------------------------------------+
```

- Three-column layout: base (common ancestor), left (ours), right (theirs)
- Timeline highlights: green (added), yellow (modified), red (deleted)
- Preview panels show rendered output at selected keyframe
- Conflict list with per-row resolution: take left / take right / take both
- **Field-level cherry-picking**: for row conflicts, user can pick individual fields from each side
- "Take all left" / "Take all right" bulk actions
- Real-time preview of merged result updates as conflicts are resolved
- Change list/table view alongside visual timeline diff

### Merge Flow

1. Compute diff (auto-merge non-conflicting changes)
2. **Always show preview** — user reviews auto-merged changes + conflicts
3. User resolves conflicts
4. User confirms merge
5. Pre-merge checkpoint (commit) is created automatically for rollback safety

---

## Prerequisites

### UUID Migration

Sequential IDs (`kf_001`, `tr_001`) must migrate to UUIDs before branching — otherwise branches creating keyframes independently will collide.

- **Format**: prefixed short hex — `kf_{uuid4().hex[:8]}`, `tr_{uuid4().hex[:8]}`, `track_{uuid4().hex[:8]}`
- **Entities**: keyframes, transitions, tracks, effects, audio clips (suppressions are vestigial — skip)
- **Asset paths**: `selected_keyframes/{id}.png`, `keyframe_candidates/candidates/section_{id}/` use new UUIDs
- **ID generation**: server-side only (`uuid4()`) — client does not generate IDs
- **No migration needed**: no existing scenecraft projects (beatlab has a separate working dir)

### Shared Asset Storage

All branches share the same asset files on disk. Assets are immutable once generated.

- Candidate images are an append-only pool (`v1.png`, `v2.png`, ...) — DB `selected` column points at which variant is active
- Two branches selecting different candidates = different `selected` values, same asset files
- Asset names are content-addressable (hash-based) to avoid duplication
- **Garbage collection is manual** — no automatic cleanup after branch deletion
- **Project size view** is P1 — show disk usage across branches

### Diffable Tables

Based on clarification responses, the SQL diff engine covers:
- keyframes, transitions, effects, tracks, meta, narrative_sections
- workspace_views (project-level only, not per-user)
- Excluded: suppressions (vestigial), audio intelligence/beats (vestigial)

---

## Migration Path

### P1 — Infrastructure & Auth
1. `.scenecraft/` directory structure (orgs, users, projects)
2. SSH-based auth system (user registration, JWT tokens, API middleware)
3. Admin CLI: `scenecraft init`, `scenecraft org create`, `scenecraft user add`
4. UUID migration for all entity IDs (kf, tr, track, effect, audio clip)
5. `sessions.db` and session management
6. Per-session working copy routing in API server
7. Project size view (disk usage across branches)

### P2 — Object Store, Commits & Branches
8. Content-addressed object store (`objects/` directory)
9. Commit creation and storage (replaces checkpoints entirely)
10. Branch refs (`refs/` directory)
11. Branch creation, checkout, switching
12. Branch UI in editor (branch selector, create, switch)
13. `user.db` for per-user settings and saved workspaces

### P3 — Diff & Merge
14. SQL-level row-level diff engine
15. Merge preview with auto-merged changes highlighted
16. Merge workspace view (three-column: base, ours, theirs)
17. Conflict resolution UI (per-row + field-level cherry-pick + bulk actions)
18. Rebase (replay branch commits on main)
19. Merged result real-time preview

### P5 — Co-Editing (Future)
20. Real-time co-editing via WebSocket sync on same branch
21. Cursor/selection presence awareness

---

## Trade-offs

| Decision | Choice | Rationale |
|---|---|---|
| Full DB copy per commit | Yes | DBs aren't huge; simplicity over delta compression |
| Content-addressed storage | SHA-256 hash | Dedup identical states; integrity verification |
| Git model vs simpler | Full Git | "Git version management on film software would be golden" — user |
| Auth approach | SSH + JWT | Self-hosted, no external providers, org-friendly |
| Checkpoint migration | Replace entirely | Commits subsume checkpoints — restore = checkout old commit |
| Merge style | Rebase (replay on main) | Linear history, no merge commits |
| Diff granularity | Row-level | Simpler than field-level; whole row = one change unit |
| Conflict on same timestamp | Yes | Overlapping keyframes at same time are a conflict |
| Delete vs modify | Conflict | User decides — don't auto-resolve destructive changes |
| Orgs required | Yes | Single-user orgs for personal use; clean scoping model |
| User prefs storage | Separate `user.db` | Follows pattern: each scope owns its own DB |
| Session cleanup | Manual | Working copies persist; `scenecraft session prune` CLI |
| Asset GC | Manual | No auto-cleanup; project size view is P1 |
| ID format | `kf_{hex8}` prefix | Readable, type-identified, server-generated |

---

## Attribution

- `last_modified_by` column on entity tables (keyframes, transitions, effects, tracks)
- Pre-merge checkpoint is always created automatically for rollback safety
- Commit objects store author (username from SSH identity)

---

## Dependencies

- UUID migration (prerequisite — must complete first)
- `PyJWT` for token generation/validation
- `hashlib` (stdlib) for SHA-256 hashing
- `sqlite3` (stdlib) for backup API

---

## Open Questions

- Rebase: how to handle SQL changeset replay when schema evolves between commits?
- Large projects: should objects be compressed (gzip)?
- History depth: should old objects be prunable (shallow clone equivalent)?
- Offline editing: can users take a branch offline and sync later?
- Audio plugin architecture: future audio generation may need branch-aware asset storage

---

## Related Documents

- [Clarification 1: Collaborative Branching & Merging](../clarifications/clarification-1-collaborative-branching-merging.md)
- [Design: Dynamic Panel Layout](local.dynamic-panel-layout.md) — merge UI will need a dedicated layout view
- [Design: WebSocket State Sync](local.websocket-state-sync.md) — future co-editing on same branch

---

**Status**: Active  
**Priority**: New milestone (no blockers from M2/M3/M4)  
**Next**: Break into implementation tasks per priority tier  
