# Task: Dockview Dead-Code Removal

**Milestone**: Unassigned (cleanup PR; does not block any active milestone)
**Design Reference**: None — pure dead-code deletion
**Estimated Time**: 1-2 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Remove all dockview-related dead code from the frontend and purge stale "dockview" references from active design/task/clarification documents. Confirmed via clarification-10 research: the active editor route uses `EditorPanelLayout` + the custom `@/components/panel-layout/`; `EditorLayout.tsx` has zero importers; `dockview-react` is a dependency with no active callers.

---

## Context

Milestone 2 task-3 ("Install dockview and create EditorLayout shell") landed a dockview-based layout that was later superseded by a custom in-house panel system (`scenecraft/src/components/panel-layout/`). The dockview path was never removed, leaving:

- A dead dependency in `package.json` (install bloat)
- Dead code in `EditorLayout.tsx` (~1000 lines) that future agents will mistake for active code when searching the codebase
- A dead CSS file in `styles/dockview-theme.css`
- Stale references in design/task/clarification docs that mention "dockview panel" as the panel contribution pattern

Clarification-10 research pass (2026-04-23) confirmed all of the above. This task removes the dead code and purges the stale references.

---

## Steps

### 1. Verify zero active importers (safety check)

Before deleting anything:

```bash
cd scenecraft
grep -rn "from 'dockview" src/ --include="*.tsx" --include="*.ts"
grep -rn "EditorLayout" src/ --include="*.tsx" --include="*.ts" | grep -v EditorPanelLayout
grep -rn "dockview-theme\|dockview.css" src/ --include="*.tsx" --include="*.ts" --include="*.css"
```

Expected: every match is inside `EditorLayout.tsx` or `styles/dockview-theme.css`. If any match is elsewhere, stop and investigate — something's wiring into dockview that wasn't caught during the clarification-10 research.

### 2. Delete dead files

```bash
rm scenecraft/src/components/editor/EditorLayout.tsx
rm scenecraft/src/styles/dockview-theme.css
```

### 3. Remove the dependency

Edit `scenecraft/package.json`:

```diff
-  "dockview-react": "^5.2.0",
```

Run `npm install` (or `bun install` if the project uses bun) to update the lockfile.

### 4. Verify build + typecheck still pass

```bash
cd scenecraft
npm run typecheck  # or whatever the project uses
npm run build
```

Both must pass without new errors. If TypeScript complains about missing imports, something was using `EditorLayout` and step 1 missed it — revert and re-investigate.

### 5. Purge stale "dockview" references in active docs

Find them:

```bash
grep -rln "dockview\|Dockview\|DOCKVIEW" agent/
```

Expected matches (at time of writing):

- `agent/clarifications/clarification-8-audio-isolation-plugin.md` — "dockview panel" references
- `agent/clarifications/clarification-9-audio-isolation-stems-and-panel.md` — "dockview panel" references
- `agent/clarifications/clarification-10-musicful-music-generation-plugin.md` — "Already decided in c8+c9" line + other body references
- `agent/milestones/milestone-11-audio-isolation-plugin.md` — panel/dockview language
- `agent/tasks/milestone-11-audio-isolation-plugin/task-101-plugin-host-scaffolding.md`
- `agent/tasks/milestone-11-audio-isolation-plugin/task-102-backend-plugin.md`
- `agent/tasks/milestone-11-audio-isolation-plugin/task-103-frontend-plugin.md`
- `agent/tasks/milestone-11-audio-isolation-plugin/task-104-audio-clip-panel.md`
- `agent/tasks/milestone-11-audio-isolation-plugin/task-104b-drag-to-timeline.md`
- `agent/design/local.audio-isolation-plugin.md`
- `agent/design/local.custom-panel-layout.md` (if it still mentions dockview as a comparison)
- Other milestone docs or patterns that reference dockview as "the" panel system

Replacement language:
- "dockview panel" → "panel registered in `EditorPanelLayout`'s `PanelRegistry`"
- "dockview layout" → "custom `PanelLayout`"
- References to `IDockviewPanelProps` / `DockviewApi` → remove entirely (no replacement needed in design docs)

Don't rewrite history: leave dockview mentions intact in *completed* task docs (e.g. `task-3-editor-layout-shell.md` describing its own implementation) and changelog entries. Only purge forward-looking design/task/clarification docs that would misdirect future work.

### 6. Optional: update panel-layout docs if they don't exist

If `scenecraft/src/components/panel-layout/` lacks a `README.md` or a design doc in `agent/design/`, add a short `local.custom-panel-layout.md` (or update the existing one) capturing:

- The `LayoutNode` / `PanelRegistry` / `PanelDef` API
- How panels register
- `PanelLayoutHandle` (imperative ref for `activatePanel` + `setGroupLocked`)

Future plugin-api integration (M16+) will cite this doc.

### 7. Commit

Single commit, conventional message:

```
refactor(panel): remove dockview dead code

- Delete src/components/editor/EditorLayout.tsx (unused; superseded by EditorPanelLayout)
- Delete src/styles/dockview-theme.css (unused)
- Remove dockview-react dependency from package.json
- Purge stale "dockview" references from forward-looking design/task/clarification docs

Active panel system is the custom src/components/panel-layout/ — EditorPanelLayout
has been the real layout since M2 task-4+ landed. Confirmed via clarification-10
research (2026-04-23): zero importers of EditorLayout or dockview-react outside
themselves.
```

---

## Verification

- [ ] `grep -rn "dockview" scenecraft/src/` returns zero matches
- [ ] `npm run typecheck` and `npm run build` pass
- [ ] `grep -rn "dockview" scenecraft/agent/` only returns historical references in completed task docs or changelog (no forward-looking design/task/clarification matches)
- [ ] `package.json` + lockfile no longer contain `dockview-react`
- [ ] Editor route loads in dev server without errors

---

## Notes

- This is a *dead-code removal*, not a feature change. No user-visible behavior changes.
- Keep the commit small and focused — don't pull in unrelated refactors.
- If M11 tasks are mid-ship and reference dockview in their in-progress specs, coordinate with whoever owns M11 before editing those docs. Safe play: purge refs in clarifications + milestone doc + completed tasks; touch active M11 task docs only if their current wording will misdirect the implementer.
