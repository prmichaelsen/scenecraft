# Task 6: Migrate Utility Panels

**Milestone**: [M2 - Dynamic Panel Layout](../../milestones/milestone-2-dynamic-panel-layout.md)  
**Design Reference**: [Dynamic Panel Layout](../../design/local.dynamic-panel-layout.md)  
**Estimated Time**: 3-4 hours  
**Dependencies**: [Task 3: EditorLayout Shell](task-3-editor-layout-shell.md)  
**Status**: Not Started  

---

## Objective

Migrate BinPanel, LogPanel, CheckpointsPanel, VersionHistoryPanel, and SettingsPanel into dockview as tabs in the properties column bottom group. Remove their boolean state flags and ternary branches from Timeline.tsx.

---

## Steps

### 1. Wrap Each Panel as Dockview Component

For each of BinPanel, LogPanel, CheckpointsPanel, VersionHistoryPanel, SettingsPanel:
- Create a thin dockview wrapper that passes `params` (projectName, callbacks)
- Remove self-managed width and resize handles
- Remove `onClose` prop — closing is handled by dockview tab close

### 2. Register in Default Layout

Add all 5 panels to the properties column bottom group using `direction: 'within'` (tabs). Default active tab: Bin.

### 3. Remove Boolean State Flags

Delete from Timeline.tsx / EditorLayout:
- `showBin`, `setShowBin`
- `showLogs`, `setShowLogs`
- `showCheckpoints`, `setShowCheckpoints`
- `showVersions`, `setShowVersions`
- `showSettings`, `setShowSettings`

### 4. Remove closeAllPanels References

The `closeAllPanels()` function becomes unnecessary — panels are always rendered. Remove it and all callers.

### 5. Update Controls Bar Buttons

The controls bar buttons (Bin, Versions, Checkpoints, Settings, Logs) should now activate their respective dockview panel tab instead of toggling boolean state:

```typescript
// Old: onClick={() => { const was = showBin; closeAllPanels(); if (!was) setShowBin(true) }}
// New: onClick={() => editorApi.getPanel('bin')?.api.setActive() }
```

---

## Verification

- [ ] Bin, Logs, Checkpoints, Versions, Settings all render as tabs
- [ ] Controls bar buttons activate the correct tab
- [ ] All panel functionality works (create checkpoint, restore version, etc.)
- [ ] BinPanel pool selection and insert still work
- [ ] No `showBin`/`showLogs`/etc. state flags remain
- [ ] `closeAllPanels` function removed

---

**Next Task**: [Task 7: Sidebars and toggles](task-7-sidebars-toggles.md)  
**Related Design Docs**: [local.dynamic-panel-layout.md](../../design/local.dynamic-panel-layout.md)  
