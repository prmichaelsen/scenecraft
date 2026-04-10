# Task 12: V2 Layout Polish

**Milestone**: [M2 - Dynamic Panel Layout](../../milestones/milestone-2-dynamic-panel-layout.md)  
**Design Reference**: [Dynamic Panel Layout](../../design/local.dynamic-panel-layout.md)  
**Estimated Time**: 4-6 hours  
**Dependencies**: [Task 3: EditorLayout Shell](task-3-editor-layout-shell.md)  
**Status**: Not Started  

---

## Objective

Polish the v2 dockview layout to production quality — fix remaining visual issues, improve UX details, and ensure all panels work correctly within the dockview shell.

---

## Context

The v2 layout shell is functional but has rough edges from rapid iteration. This task collects all known polish items to bring it to parity with the v1 layout quality.

---

## Steps

### 1. Fix Collapsed Panel Empty Space

The collapsed panel bar still shows empty space to the right of the vertical tab headers. Investigate whether `dv-view-container` display:none is being applied correctly, and whether the group width is actually shrinking to match the header-only width. May need to set `overflow: hidden` on the group or use `maxWidth` constraints.

### 2. Fix Uncollapse Not Restoring Width

The expand (▶) button doesn't properly restore the panel to its previous width. Debug the `collapsedState` map — the group ID may change when dockview re-layouts. Consider using panel IDs instead of group IDs to track collapsed state, or listen for group change events.

### 3. Properties Panel Polish

- Auto-activate the Properties tab when a KF/TR is selected (use `api.getPanel('properties')?.api.setActive()`)
- Wire remaining callbacks through EditorStateContext: onKeyframeDelete, onKeyframeDataChange, onDuplicate, onMoveLeft/Right, onUnlink, onTransitionDelete, onTransitionDataChange, onDuplicateToNext/Prev
- Pass `keyframes` and `currentTime` to TransitionPanel via context
- Pass `audioDescriptions` and `audioEvents` to KeyframePanel via context

### 4. Default Layout Proportions

Fine-tune the default column widths based on typical screen sizes:
- Timeline center: flex (takes remaining)
- Properties column: test at 360px, 400px — pick what looks best for settings form
- Right sidebar: test at 220px, 240px — pick what fits sections list
- Ensure proportions look good at 1920x1080 and 1440x900

### 5. Tab Styling Consistency

- Ensure tab font size, padding, and colors match across all groups
- Active tab underline color should match the editor's blue accent (#3b82f6)
- Verify collapsed vertical tabs are readable and properly styled
- Test drag-and-drop tab appearance (drop zone indicators)

### 6. Panel Content Scroll

Verify all panels scroll correctly inside dockview:
- Settings panel (long form)
- Bin panel (many items)
- Sections panel (many sections)
- Checkpoints panel
- Logs panel (virtualized)

The DockPanel wrapper with `[&>*]:!h-full` may need adjustment for panels that have their own scroll containers.

### 7. Workspace View Persistence

- Test auto-save: resize panels, reload page, verify layout restores
- Test named views: save, switch, delete
- Test "Default" button in Workspace menu resets correctly
- Handle edge case: saved layout references a component that no longer exists (graceful fallback to default)

### 8. Left Sidebar Toggle

- Add a toggle button (◫) in the editor header to show/hide the left sidebar
- When shown, the left sidebar should expand to 200px
- Wire to `group.api.setVisible(true/false)` on the left sidebar group

### 9. Right Sidebar Toggle

- Add a hamburger (☰) button in the editor header
- Dropdown lists available right sidebar views (Sections, future)
- Toggles right sidebar visibility

---

## Verification

- [ ] Collapsed panels show only vertical tab bar with no empty space
- [ ] Expanding a collapsed panel restores its previous width
- [ ] Clicking KF/TR in timeline auto-activates Properties tab
- [ ] Properties panel shows full KF/TR editing functionality
- [ ] All panel actions work (delete, duplicate, data change, etc.)
- [ ] Default layout proportions look good at common screen sizes
- [ ] Tab styling is consistent across all groups
- [ ] All panels scroll correctly
- [ ] Workspace auto-save and restore works across reloads
- [ ] Named workspace views can be saved, loaded, and deleted
- [ ] Left sidebar toggle works
- [ ] Right sidebar toggle works
- [ ] No regressions in v1 layout (default without ?layout=v2)

---

**Next Task**: None  
**Related Design Docs**: [local.dynamic-panel-layout.md](../../design/local.dynamic-panel-layout.md)  
