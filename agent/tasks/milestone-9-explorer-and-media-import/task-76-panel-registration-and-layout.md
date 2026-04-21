# Task 76: Panel Registration + Default Layout (Explorer Column)

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 4 hours
**Dependencies**: None for scaffolding; stub panel bodies are fine (Tasks 77 & 78 fill them)
**Status**: Not Started

---

## Objective

Register two new panel ids (`project`, `import`) in the frontend `PanelRegistry`, place them in the default layout as a collapsed Explorer column on the left edge of the root split, and ensure existing saved workspace views migrate to include the column.

---

## Context

This is the minimal frontend scaffolding so Tasks 77 and 78 have actual panel surfaces to fill. The panel components at this stage can be placeholders (single `<div>Project panel</div>` each) — full tree/list bodies come in their dedicated tasks.

---

## Steps

1. **Create stub components** in `scenecraft/src/components/editor/`:
   - `ProjectPanel.tsx` — `export function ProjectPanel() { return <div>Project panel (WIP)</div> }`
   - `ImportPanel.tsx` — `export function ImportPanel() { return <div>Import panel (WIP)</div> }`

2. **Register in `EditorPanelLayout.tsx`**:
   ```ts
   import { Folder, Link2 } from 'lucide-react'
   import { ProjectPanel } from './ProjectPanel'
   import { ImportPanel } from './ImportPanel'

   function ProjectPanelComponent() { return <Panel><ProjectPanel /></Panel> }
   function ImportPanelComponent()  { return <Panel><ImportPanel  /></Panel> }

   const panels: PanelRegistry = {
     // ...existing entries
     project: { component: ProjectPanelComponent, title: 'Project', icon: Folder },
     import:  { component: ImportPanelComponent,  title: 'Import',  icon: Link2 },
   }
   ```

3. **Update default layout** in `EditorPanelLayout.tsx`:
   ```ts
   const defaultLayout: LayoutNode = {
     type: 'split',
     direction: 'horizontal',
     ratio: 0.18,  // Explorer takes ~18% of the root width at 1600px viewport
     children: [
       {
         type: 'split',
         direction: 'vertical',
         ratio: 0.5,
         children: [
           { type: 'group', id: 'project-group', tabs: ['project'], activeTab: 'project', collapsed: true },
           { type: 'group', id: 'import-group',  tabs: ['import'],  activeTab: 'import',  collapsed: true },
         ],
       },
       { /* existing root content — preview-group + timeline-group + properties etc. */ },
     ],
   }
   ```

4. **Saved-layout migration** in the workspace-view loader (look in `EditorPanelLayout.tsx` or `routeLoader`):
   - On load, validate the layout via `validateLayout` (already present in `panel-layout/validate.ts`).
   - If the loaded layout does NOT contain an `Explorer column` (heuristic: no group with id `project-group` exists anywhere in the tree), wrap the existing root in a new horizontal split, inserting the Explorer column on the left.
   - Mark the new groups as `collapsed: true`.
   - Fire-and-forget `saveWorkspaceView(updated)` to persist.

5. **Width behavior**:
   - When expanded, the Explorer column should target ~275 px (user preference). Implement via:
     - Option A: record `preCollapseSize = 275` on the groups on first expansion so the panel library restores that size.
     - Option B: adjust the root `ratio` so the column is ~275 px at the current viewport width.
   - Prefer A — tracks the pixel target regardless of viewport.

6. **Visual smoke test**:
   - Start the dev server.
   - Default layout should show existing Preview/Timeline/Properties on the right, with two collapsed 34px bars on the far left (Explorer groups).
   - Clicking to expand each reveals the WIP placeholder text.
   - Expanded width ≈ 275 px.

---

## Verification

- [ ] `project` and `import` panel ids in `PanelRegistry` with `Folder` / `Link2` icons.
- [ ] Default layout places them in a vertical split under an Explorer column (leftmost under the root horizontal split).
- [ ] Both groups collapsed by default.
- [ ] Saved-layout migration inserts the column if absent.
- [ ] Expanded width ≈ 275 px.
- [ ] Dev-server smoke test: Explorer column visible, expand/collapse works, WIP placeholders render.

---

**Next Task**: [Task 77: Project panel](task-77-project-panel.md)
