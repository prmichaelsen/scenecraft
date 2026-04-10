# Task 8: Workspace Views and Theme

**Milestone**: [M2 - Dynamic Panel Layout](../../milestones/milestone-2-dynamic-panel-layout.md)  
**Design Reference**: [Dynamic Panel Layout](../../design/local.dynamic-panel-layout.md)  
**Estimated Time**: 3-4 hours  
**Dependencies**: [Task 7: Sidebars and toggles](task-7-sidebars-toggles.md)  
**Status**: Not Started  

---

## Objective

Implement workspace layout save/restore using YAML serialization to localStorage, and customize dockview's CSS to match the editor's dark theme.

---

## Steps

### 1. Workspace Save/Restore

Use `api.toJSON()` to serialize the layout and `js-yaml` (already a dep) to convert to YAML for human-readable storage in localStorage:

- `saveWorkspace(api, name)` — serialize layout to YAML, store in `beatlab-workspaces` localStorage key
- `loadWorkspace(api, name)` — parse YAML from localStorage, call `api.fromJSON()`
- Auto-save on `api.onDidLayoutChange` to `_autosave` workspace
- On `onReady`, try loading `_autosave` workspace first, fall back to default layout

### 2. Workspace Switcher UI

Add a small dropdown or button group in the editor header that lets users:
- Save current layout as a named workspace
- Switch between saved workspaces
- Delete saved workspaces
- Reset to default layout

### 3. Theme Dockview Chrome

Dockview uses CSS variables for theming. Override them to match the editor's dark theme (bg-gray-900, border-gray-800, text-gray-300, etc.):

- Tab bar background, tab active/inactive states
- Group header styling
- Resize handle colors
- Drag overlay styling
- Focus/active indicators

Create `src/styles/dockview-theme.css` with overrides, import in EditorLayout.

### 4. Hide Dockview Default Tab Close Buttons (Optional)

For panels that shouldn't be closeable (Preview, Timeline), configure dockview to hide the close button on those panel tabs.

---

## Verification

- [ ] Layout persists across page reloads (auto-save/restore works)
- [ ] Users can save a named workspace
- [ ] Users can switch between saved workspaces
- [ ] "Reset to default" restores the original layout
- [ ] Dockview tabs match the dark theme (no white/light artifacts)
- [ ] Resize handles are visible but subtle (matching gray-800)
- [ ] Drag overlay styling matches the theme
- [ ] YAML is used for serialization (not JSON)

---

**Next Task**: None (milestone complete)  
**Related Design Docs**: [local.dynamic-panel-layout.md](../../design/local.dynamic-panel-layout.md)  
