# Task 35: Project Size View

**Objective**: Add an API endpoint and frontend panel showing disk usage breakdown for a project
**Milestone**: M6 — Git-Style Version Control
**Priority**: P1
**Repo**: scenecraft
**Estimated Hours**: 3
**Status**: Not Started

---

## Context

As projects accumulate keyframes, transition videos, and object store data, users need visibility into how much disk space their project consumes. This is especially important before the version control system introduces additional storage for commits and branches. A size breakdown helps users understand where space is being used and make informed decisions about cleanup.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Create a new API endpoint `GET /api/projects/:name/size` that returns a JSON breakdown of disk usage.

2. Backend implementation: walk the project directory and sum file sizes by category:
   - `selected_keyframes/` — finalized keyframe images
   - `keyframe_candidates/` — candidate images from generation
   - `transition_videos/` — rendered transition video files
   - `objects/` — content-addressed object store (commit snapshots)
   - `refs/` — branch reference files
   - `commits/` — commit metadata files
   - Other/miscellaneous files (DB, config, etc.)

3. Return the response in the format:
   ```json
   {
     "total_bytes": 123456789,
     "categories": {
       "selected_keyframes": 40000000,
       "keyframe_candidates": 50000000,
       "transition_videos": 30000000,
       "objects": 2000000,
       "other": 1456789
     },
     "branch_breakdown": {
       "main": 80000000,
       "prmichaelsen/color-pass": 43456789
     }
   }
   ```

4. If branches exist, compute per-branch breakdown by associating working copies and their assets with their respective branches.

5. Frontend: create a project size info panel (accessible from settings or a dedicated info tab) that displays:
   - Total project size (human-readable: MB/GB)
   - Bar chart or list showing per-category breakdown
   - Per-branch breakdown if branches exist

6. Add a refresh button to re-fetch size data on demand.

## Verification

- [ ] `GET /api/projects/:name/size` returns correct disk usage totals
- [ ] Category breakdown matches actual file sizes on disk
- [ ] Per-branch breakdown is included when branches exist
- [ ] Frontend panel displays size data in a human-readable format
- [ ] Refresh button re-fetches and updates the display
- [ ] Large projects (many assets) return results within a reasonable time

---

**Dependencies**: Task 29
