# Milestone 2: Dynamic Panel Layout

**Goal**: Replace the mutually-exclusive side panel system with a dockview-powered layout supporting resizable splits, draggable tabs, and saveable workspace views  
**Duration**: 2-3 weeks  
**Dependencies**: None  
**Status**: Not Started  

---

## Overview

The current editor uses 12+ boolean state flags and a 13-deep ternary chain in Timeline.tsx to render one panel at a time. This milestone replaces that with a dockview-react layout where all panels coexist, are independently resizable, draggable between regions, and arrangeable into saved workspace presets.

---

## Deliverables

### 1. EditorLayout Shell
- `EditorLayout.tsx` with DockviewReact setup, component registration, and default layout builder
- `useEditorLayout` hook exposing the dockview API ref

### 2. Panel Components
- Preview and Timeline extracted as standalone dockview panels
- KF/TR properties migrated, Color Grading extracted as its own tab
- All utility panels (Bin, Logs, Checkpoints, Versions, Settings) migrated
- Sections panel in right sidebar, Chat placeholder in bottom-right

### 3. Layout Features
- Left sidebar toggle ([◫]) and right sidebar hamburger menu ([☰])
- Workspace save/restore (YAML to localStorage)
- Dark theme CSS customization for dockview chrome

---

## Success Criteria

- [ ] Default 4-column layout renders: left sidebar, center (preview+timeline), properties, right sidebar
- [ ] All 12+ existing panels render correctly inside dockview
- [ ] Panels can be dragged between groups
- [ ] Panel groups can be split by dragging tabs to edges
- [ ] Workspace layouts save to localStorage as YAML and restore on reload
- [ ] Sidebar toggle buttons show/hide left and right sidebars
- [ ] Context-sensitive tab activation (click KF → KF tab, click TR → TR tab)
- [ ] Color grading works as independent tab
- [ ] No regressions in existing panel functionality

---

## Tasks

1. [Task 3: Install dockview and create EditorLayout shell](../tasks/milestone-2-dynamic-panel-layout/task-3-editor-layout-shell.md) - Install dockview-react, create EditorLayout.tsx with component map and default layout
2. [Task 4: Extract Preview and Timeline panels](../tasks/milestone-2-dynamic-panel-layout/task-4-preview-timeline-panels.md) - Extract preview canvas and timeline tracks into standalone dockview panel components
3. [Task 5: Migrate property panels and extract Color Grading](../tasks/milestone-2-dynamic-panel-layout/task-5-property-panels.md) - Wrap KF/TR panels, extract color grading into own tab
4. [Task 6: Migrate utility panels](../tasks/milestone-2-dynamic-panel-layout/task-6-utility-panels.md) - Migrate Bin, Logs, Checkpoints, Versions, Settings into dockview
5. [Task 7: Sidebars and toggle controls](../tasks/milestone-2-dynamic-panel-layout/task-7-sidebars-toggles.md) - Add left sidebar placeholder, right sidebar with Sections, toggle buttons
6. [Task 8: Workspace views and theme](../tasks/milestone-2-dynamic-panel-layout/task-8-workspace-views-theme.md) - YAML workspace save/restore, dark theme CSS for dockview chrome

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation Strategy |
|------|--------|-------------|---------------------|
| Dockview CSS conflicts with Tailwind | Medium | Medium | Scope dockview styles, override CSS variables |
| Panel state management complexity | High | Low | Panels keep their own state; dockview only manages layout |
| Large Timeline.tsx refactor breaks things | High | Medium | Migrate incrementally — one panel at a time, test after each |

---

**Next Milestone**: TBD  
**Blockers**: None  
**Notes**: Design doc at agent/design/local.dynamic-panel-layout.md  
