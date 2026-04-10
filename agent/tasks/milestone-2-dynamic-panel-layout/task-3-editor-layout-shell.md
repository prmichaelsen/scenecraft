# Task 3: Install Dockview and Create EditorLayout Shell

**Milestone**: [M2 - Dynamic Panel Layout](../../milestones/milestone-2-dynamic-panel-layout.md)  
**Design Reference**: [Dynamic Panel Layout](../../design/local.dynamic-panel-layout.md)  
**Estimated Time**: 3-4 hours  
**Dependencies**: None  
**Status**: Not Started  

---

## Objective

Install dockview-react, create the EditorLayout component with component registration map, build the default layout, and wire it into the editor route. At the end of this task, the editor renders inside dockview with placeholder panels.

---

## Context

This is the foundation task. All subsequent panel migration tasks depend on EditorLayout existing with a working dockview instance. The goal is a working shell — placeholder content in each panel region — not fully migrated panels.

---

## Steps

### 1. Install dockview-react

```bash
npm install dockview-react
```

### 2. Create EditorLayout.tsx

Create `src/components/editor/EditorLayout.tsx`:

- Import `DockviewReact` and its CSS
- Define a `components` map with placeholder components for each panel slot
- Implement `onReady` handler that builds the default 4-column layout using `api.addPanel()` with position references
- Export `useEditorLayout` hook (React context) exposing the dockview `api` ref

### 3. Build Default Layout in onReady

Follow the layout from the design doc — 4 columns, 2 rows per column:

```
Left sidebar | Preview (top) / Timeline (bottom) | Properties KF/TR/Color (top) / Bin/Logs (bottom) | Right sidebar Sections (top) / Chat (bottom)
```

Use `direction: 'right'`, `direction: 'below'`, `direction: 'within'` to position panels relative to each other.

### 4. Wire into Editor Route

Replace the current `<Timeline />` usage in `src/routes/project/$name/editor.tsx` with `<EditorLayout />`. Pass through all data props via dockview panel `params`.

### 5. Verify Shell Renders

Each panel region should show a labeled placeholder (e.g., "Preview Panel", "Timeline Panel", "KF Props", etc.) in the correct position with resizable dividers.

---

## Verification

- [ ] `npm install dockview-react` succeeds
- [ ] EditorLayout.tsx created with DockviewReact and component map
- [ ] Default layout renders 4 columns with correct panel positions
- [ ] All dividers are resizable
- [ ] Editor route renders EditorLayout instead of raw Timeline
- [ ] No build errors

---

**Next Task**: [Task 4: Extract Preview and Timeline panels](task-4-preview-timeline-panels.md)  
**Related Design Docs**: [local.dynamic-panel-layout.md](../../design/local.dynamic-panel-layout.md)  
