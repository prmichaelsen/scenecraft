# Task 39: Branch UI

**Objective**: Add a branch selector dropdown and branch management UI to the editor header
**Milestone**: M6 — Git-Style Version Control
**Priority**: P2
**Repo**: scenecraft
**Estimated Hours**: 6
**Status**: Not Started

---

## Context

With the branch system in place on the backend, users need a way to view, create, and switch branches from the editor. The branch selector is a high-visibility UI element in the editor header bar that shows the current branch and provides quick access to branch operations. This is the primary interface for the branching workflow and must feel responsive and intuitive.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Add a branch selector dropdown to the editor header bar, positioned next to the workspace menu:
   - Display the current branch name with a branch icon
   - `main` branch gets special styling (e.g., distinct color or badge) to distinguish it from feature branches

2. Populate the dropdown with the list of all branches from `GET /api/projects/:name/branches`:
   - Show branch name, abbreviated commit hash, and an indicator for the current branch
   - Sort: current branch first, then `main`, then alphabetical

3. Implement branch switching:
   - Clicking a different branch in the dropdown calls `POST /api/projects/:name/checkout`
   - Show a loading state during checkout
   - On success, reload all editor data (keyframes, timeline, settings) to reflect the new branch state
   - On failure (e.g., uncommitted changes), show a confirmation dialog asking whether to force checkout or cancel

4. Add a "Create branch" option at the bottom of the dropdown:
   - Opens a modal with a name input field
   - Auto-prefix the branch name with `{username}/` (from auth context)
   - Allow the user to override the prefix
   - "Create from" shows the current branch name (read-only for now)
   - On submit, call `POST /api/projects/:name/branches` and switch to the new branch

5. Add visual branch indicator:
   - Show a colored dot or icon next to the branch name in the header
   - `main` uses a distinct style (e.g., blue/primary color)
   - User branches use a secondary style
   - Optionally show "unsaved changes" indicator if working copy differs from last commit

6. Handle edge cases:
   - Project with no commits yet (disable branch creation, show "No commits" state)
   - Long branch names (truncate with tooltip)
   - Rapid branch switching (debounce/disable during checkout)

## Verification

- [ ] Branch selector dropdown appears in the editor header
- [ ] Current branch name is displayed and highlighted
- [ ] Dropdown lists all branches from the API
- [ ] Clicking a branch triggers checkout and reloads editor data
- [ ] Uncommitted changes prompt a confirmation dialog before checkout
- [ ] "Create branch" modal auto-prefixes with username
- [ ] New branch creation works and switches to the new branch
- [ ] `main` branch has distinct visual styling
- [ ] Long branch names are truncated with a tooltip
- [ ] Branch selector is disabled/loading during checkout operations

---

**Dependencies**: Task 34, Task 37
