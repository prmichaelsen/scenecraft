# Project Versioning with Git

**Concept**: Git-based version control per `.beatlab_work/` project — save, restore, branch, and diff project states from the synthesizer UI
**Created**: 2026-03-28
**Status**: Superseded (2026-04-26) — see [`local.git-version-control.md`](local.git-version-control.md)
**Last Updated**: 2026-04-26 (marked superseded during doc sync)

---

> **⚠️ This document is superseded.**
>
> This was the first draft of version-controlling project state. It predates
> the pivot from "beatlab-synthesizer with a per-project `.beatlab_work/` git
> repo" to scenecraft's actual M6 design: a purpose-built content-addressed
> object store under `.scenecraft/` with SSH auth, JWT sessions, branch refs,
> and a commit engine that operates on SQLite project state (not YAML).
>
> The checkpoint system (shipped predecessor) saves named project snapshots;
> the full git-style workflow is being built in M6. See
> [`local.git-version-control.md`](local.git-version-control.md) for the
> authoritative current design.
>
> Retained as a historical record of the earlier approach; do not treat as
> current architecture.

---

## Overview

Each project in `.beatlab_work/` becomes its own git repository. Users can save named versions (commits), restore previous states, branch for experimentation, and see diffs of what changed. This turns the project directory — YAML, selected keyframes, candidate images, transition videos — into a fully version-controlled document.

The synthesizer UI exposes these operations through a version history panel, eliminating the need for manual git commands or fear of destructive edits.

---

## Problem Statement

- **No undo for destructive operations**: Regenerating keyframe candidates, reassigning selections, or editing prompts overwrites previous state. If a bulk regeneration produces worse results, there's no way back.
- **No experimentation**: Users can't try two different keyframe arrangements side-by-side. Every change is permanent and linear.
- **No audit trail**: There's no record of what changed, when, or why. The YAML file is the only source of truth with no history.
- **Binary assets are expensive**: Keyframe images (Imagen) and transition videos (Veo) cost GPU time and money. Losing them to an accidental overwrite is painful.

---

## Solution

Initialize a git repository inside each project directory on creation. The beatlab server exposes git operations as REST endpoints. The synthesizer provides a version history UI.

**Architecture:**

```
.beatlab_work/
└── beyond_the_veil_v26_radio_v14/
    ├── .git/                          ← per-project repo
    ├── narrative_keyframes.yaml       ← tracked (text, diffable)
    ├── beats.json                     ← tracked
    ├── selected_keyframes/            ← tracked (binary, essential)
    │   ├── kf_001.png
    │   └── ...
    ├── keyframe_candidates/           ← tracked (binary, expensive)
    │   └── candidates/
    │       └── section_kf_001/
    │           ├── v1.png
    │           └── ...
    └── transition_candidates/         ← tracked (binary, expensive)
        └── tr_001/
            └── slot_0/
                ├── v1.mp4
                └── ...
```

All files are tracked — including binaries. Video and image files are tied to IDs (keyframe IDs, transition IDs) that are local to the branch, so they must travel with the commit history.

**No remote needed.** This is local-only version control on the mounted volume. No push, no clone, no transfer overhead.

---

## Implementation

### Component 1: Git Initialization

On project creation (or first API call), the beatlab server initializes a git repo if `.git/` doesn't exist.

```python
# In api_server.py or a project lifecycle hook
def ensure_git_repo(project_dir: Path):
    git_dir = project_dir / ".git"
    if not git_dir.exists():
        subprocess.run(["git", "init"], cwd=project_dir, check=True)
        subprocess.run(["git", "add", "-A"], cwd=project_dir, check=True)
        subprocess.run(["git", "commit", "-m", "Initial project state"], cwd=project_dir, check=True)
```

### Component 2: Beatlab Server Endpoints

#### `POST /api/projects/:name/version/commit`

Save current state as a named version.

```json
// Request
{ "message": "Selected keyframes for intro section" }

// Response
{ "success": true, "sha": "a1b2c3d", "message": "Selected keyframes for intro section" }
```

Implementation: `git add -A && git commit -m "<message>"`. If nothing changed, returns `{ "success": true, "noChanges": true }`.

#### `GET /api/projects/:name/version/history`

List commit history.

```json
// Request: GET /api/projects/beyond_the_veil/version/history?limit=20

// Response
{
  "commits": [
    { "sha": "a1b2c3d", "message": "Selected keyframes for intro section", "date": "2026-03-28T10:30:00Z", "short": "a1b2c3d" },
    { "sha": "e4f5g6h", "message": "Initial project state", "date": "2026-03-27T14:00:00Z", "short": "e4f5g6h" }
  ],
  "branch": "main",
  "branches": ["main", "experiment-dreamy-transitions"]
}
```

Implementation: `git log --format=...` parsed to JSON.

#### `POST /api/projects/:name/version/checkout`

Restore a previous version.

```json
// Request
{ "sha": "e4f5g6h" }

// Response
{ "success": true, "sha": "e4f5g6h", "message": "Initial project state" }
```

Implementation: `git checkout <sha> -- .` to restore files without moving HEAD, then auto-commit as "Restored to: <original message>". This keeps history linear and avoids detached HEAD confusion.

**Alternative**: `git checkout <sha>` with detached HEAD for true time-travel, but this is confusing for non-git users. The "restore as new commit" approach is safer.

#### `POST /api/projects/:name/version/branch`

Create or switch branches.

```json
// Request (create)
{ "name": "experiment-dreamy-transitions", "create": true }

// Request (switch)
{ "name": "main" }

// Response
{ "success": true, "branch": "experiment-dreamy-transitions" }
```

Implementation: `git checkout -b <name>` or `git checkout <name>`.

#### `GET /api/projects/:name/version/diff`

Show what changed since last commit (or between two commits).

```json
// Request: GET /api/projects/beyond_the_veil/version/diff
// Request: GET /api/projects/beyond_the_veil/version/diff?from=a1b2c3d&to=e4f5g6h

// Response
{
  "files": [
    { "path": "narrative_keyframes.yaml", "status": "modified", "additions": 5, "deletions": 3 },
    { "path": "selected_keyframes/kf_015.png", "status": "added", "binary": true }
  ],
  "summary": { "filesChanged": 2, "insertions": 5, "deletions": 3 }
}
```

#### `POST /api/projects/:name/version/delete-branch`

Delete a branch (with confirmation that it's not the current branch).

```json
// Request
{ "name": "experiment-dreamy-transitions" }

// Response
{ "success": true }
```

### Component 3: Synthesizer UI — Version History Panel

A new panel (alongside KeyframePanel, TransitionPanel, BinPanel) accessible from a toolbar button.

**Layout:**
```
┌─────────────────────────────┐
│ Version History        [×]  │
├─────────────────────────────┤
│ Branch: [main ▾]  [+ New]  │
├─────────────────────────────┤
│ [Save Version]              │
│                             │
│ ● a1b2c3d  10:30 AM        │
│   Selected keyframes for    │
│   intro section             │
│   [Restore] [Diff]         │
│                             │
│ ● e4f5g6h  2:00 PM (Mar 27)│
│   Initial project state     │
│   [Restore] [Diff]         │
│                             │
│ [Unsaved changes]           │
│   2 files modified          │
└─────────────────────────────┘
```

**Interactions:**
- **Save Version**: Opens a text input for commit message, then commits
- **Branch selector**: Dropdown showing all branches, switch on select
- **+ New branch**: Creates a branch from current state
- **Restore**: Restores files to that commit's state (as a new commit)
- **Diff**: Shows list of changed files between that commit and current state
- **Unsaved changes**: Shows `git status` — modified/added/deleted files since last commit

### Component 4: Auto-Save Points

Certain operations should auto-commit to ensure save points exist:

- After `select-keyframes` (keyframe selection is expensive to reproduce)
- After `generate-transition-action` (LLM call)
- After bulk operations (regenerate all transitions)

Auto-commits use a standard message format: `auto: <operation description>`.

The user can still manually save with a custom message at any time.

---

## Benefits

- **Non-destructive experimentation**: Branch, try things, discard or merge
- **Full undo**: Any state is recoverable, including binary assets
- **Audit trail**: See exactly what changed and when
- **Cheap branching**: Git branches are lightweight — instant creation, no file copying
- **Diffable YAML**: `narrative_keyframes.yaml` diffs show exactly which keyframes/transitions changed
- **No new dependencies**: Git is already on every machine
- **Works offline**: No server, no cloud, no network needed

---

## Trade-offs

- **Disk usage**: Every version of every binary file lives in `.git/objects`. A project with 300 candidate images and 70 transition videos across 10 commits could reach 10-20GB. Mitigated by: mounted volumes are cheap, `git gc` compresses, and a "purge old branches" command can reclaim space.
- **Commit speed**: `git add -A` on a project with many large binaries takes seconds, not milliseconds. Mitigated by: commits are user-initiated (not on every keystroke), and auto-commits happen after already-slow operations (generation).
- **Merge conflicts**: If branches diverge on `narrative_keyframes.yaml`, merging requires conflict resolution on YAML. Mitigated by: the "restore as new commit" approach avoids true merges. Branch-and-discard is the primary workflow, not branch-and-merge.
- **No partial restore**: Restoring a commit restores everything — you can't cherry-pick "just the keyframe selections from commit X". Mitigated by: the diff view lets users see what changed, and they can manually re-apply specific changes.

---

## Dependencies

- **git** — must be installed on the machine (standard on all Linux systems)
- **beatlab server** — endpoints added to `api_server.py`
- **beatlab-synthesizer** — new VersionHistoryPanel component
- No new pip or npm dependencies

---

## Testing Strategy

- **Init**: Create a project, verify `.git/` exists and initial commit is present
- **Commit**: Make changes to YAML, commit, verify `git log` shows the commit
- **Restore**: Commit state A, make changes to state B, commit B, restore A — verify files match state A and a new commit exists
- **Branch**: Create branch, make changes, switch back to main — verify main is unchanged
- **Binary tracking**: Add candidate images, commit, delete them, restore — verify images are back
- **Large repo**: Benchmark commit/checkout speed with 500+ binary files
- **Edge cases**: Commit with no changes, restore to current state, delete current branch (should fail)

---

## Migration Path

1. **Phase 1 — Backend endpoints**: Add git init, commit, history, checkout, branch, diff, delete-branch endpoints to beatlab server
2. **Phase 2 — Auto-init**: Existing projects get `git init` on first API call (lazy initialization)
3. **Phase 3 — Version History UI**: Build the VersionHistoryPanel in the synthesizer with save, restore, branch, diff
4. **Phase 4 — Auto-save points**: Add auto-commit hooks after expensive operations
5. **Phase 5 — Branch workflows**: Add merge/compare UI if users want to combine branches (deferred — branch-and-discard is sufficient initially)

---

## Key Design Decisions

### Version Control Model

| Decision | Choice | Rationale |
|---|---|---|
| Scope | One git repo per project directory | Projects are independent; no cross-project history needed |
| Binary tracking | Track all binaries in git (no LFS) | Local-only repo, no remote transfer. LFS adds complexity for no benefit |
| Restore mechanism | Restore as new commit (not detached HEAD) | Safer for non-git users; history stays linear; no "lost" states |
| Auto-commits | After expensive operations (selection, generation) | Save points exist even if user forgets to commit manually |

### Branching

| Decision | Choice | Rationale |
|---|---|---|
| Default workflow | Branch-and-discard, not branch-and-merge | YAML merge conflicts are confusing; experimentation doesn't need merging |
| Branch deletion | Explicit user action with confirmation | Branches contain expensive GPU-generated assets; accidental deletion is costly |
| Branch naming | User-provided names, no auto-generated names | Users should name experiments meaningfully |

### Disk Management

| Decision | Choice | Rationale |
|---|---|---|
| Garbage collection | Manual "purge" command, not automatic | Users should decide when to reclaim space; auto-gc could delete assets they want |
| `.gitignore` | Nothing ignored by default | Video files and candidates are tied to branch-local IDs; must travel with history |
| Backup | `beatlab archive` tars entire project including `.git` | Mounted volume snapshots are the primary backup; archive is secondary |

---

## Future Considerations

- **Compare branches side-by-side**: Show two branch states visually (e.g., keyframe grid from branch A vs branch B)
- **Cherry-pick operations**: Restore just the keyframe selections from a commit without restoring everything
- **Merge UI**: Visual YAML merge for `narrative_keyframes.yaml` if users want to combine branches
- **Tag releases**: Tag a "final" version for rendering/export
- **Git hooks**: Pre-commit validation (e.g., ensure YAML is valid before committing)
- **Shallow clone for backup**: If backup to object storage is added, shallow clone reduces transfer size
- **Project templates**: Branch from a template project to start new videos with shared assets

---

**Status**: Design Specification
**Recommendation**: Implement Phase 1 (backend endpoints) and Phase 2 (auto-init), then Phase 3 (UI)
**Related Documents**: [local.beatlab-server](local.beatlab-server.md), [local.keyframe-editor](local.keyframe-editor.md)
