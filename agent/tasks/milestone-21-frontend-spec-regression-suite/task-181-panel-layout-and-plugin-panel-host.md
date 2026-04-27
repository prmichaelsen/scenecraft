# Task 181: panel-layout-and-plugin-panel-host spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.panel-layout-and-plugin-panel-host`](../../specs/local.panel-layout-and-plugin-panel-host.md)
**Estimated Time**: 10 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the panel layout system and plugin panel host. Existing `MacroPanel.test.tsx` covers 19 tests — this task fills the remaining ~40 requirement gaps across the layout manager and plugin panel host.

## Test File

`src/components/editor/__tests__/spec-panel-layout-and-plugin-panel-host.test.tsx`

## Coverage Plan

- **Layout manager**: panel registration; panel ordering; show/hide toggle; resize handles
- **Panel zones**: left/right/bottom/center zones; zone assignment; zone overflow behavior
- **Plugin panel host**: renders plugin-contributed panels; panel ID -> component mapping
- **Panel persistence**: layout saved to localStorage or project settings; restore on reload
- **Drag-and-drop reorder**: panels can be reordered within a zone; cross-zone move
- **Panel menu**: right-click context menu; close panel; reset layout
- **Default layout**: editor ships with default panel arrangement; reset restores defaults
- **Plugin panels**: plugins declare panels in manifest.contributes; host renders them lazily
- **Panel focus**: click panel -> focused; keyboard shortcuts scoped to focused panel
- **Integration**: register plugin panel -> appears in layout -> user rearranges -> layout persists -> reload restores

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run` passes for this file
- [ ] React components rendered via @testing-library/react
