# Task 80: Focus Mode (Shift+F Toggle + Primary Flag)

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 5 hours
**Dependencies**: Task 76 (panel registration)
**Status**: Not Started

---

## Objective

Add a `primary?: boolean` flag to `GroupNode`, wire up a global `Shift+F` hotkey that collapses all non-primary groups (snapshots the layout, restores on second press), and add an ellipsis-menu entry for toggling a group's `primary` flag.

---

## Context

Users want to maximize the core editing surface (Preview + Timeline) by hiding all ancillary panels with one keystroke. The behavior matches DaVinci Resolve's `Shift+F` and IntelliJ's "Hide All Tool Windows" — collapse all the non-primary groups and remember the previous state for restore.

---

## Steps

1. **Type addition** in `scenecraft/src/components/panel-layout/types.ts`:
   ```ts
   export type GroupNode = {
     type: 'group'
     id: string
     tabs: PanelId[]
     activeTab: PanelId
     collapsed?: boolean
     preCollapseSize?: number
     primary?: boolean               // NEW
   }
   ```

2. **Default-layout update** in `EditorPanelLayout.tsx`:
   - Mark `preview-group` and `timeline-group` with `primary: true`.

3. **Focus Mode state** — living in `EditorPanelLayout.tsx` (or a new `FocusModeContext`):
   ```ts
   const [focusSnapshot, setFocusSnapshot] = useState<LayoutNode | null>(null)
   const inFocusMode = focusSnapshot !== null
   ```
   Do NOT persist `focusSnapshot` (ephemeral UI state).

4. **Toggle function**:
   ```ts
   function toggleFocusMode() {
     if (focusSnapshot) {
       // Restore
       setLayout(focusSnapshot)
       setFocusSnapshot(null)
     } else {
       // Snapshot + collapse all non-primary
       setFocusSnapshot(layout)
       setLayout(collapseAllNonPrimary(layout))
     }
   }

   function collapseAllNonPrimary(node: LayoutNode): LayoutNode {
     if (node.type === 'group') {
       return node.primary ? node : { ...node, collapsed: true }
     }
     return {
       ...node,
       children: [
         collapseAllNonPrimary(node.children[0]),
         collapseAllNonPrimary(node.children[1]),
       ] as [LayoutNode, LayoutNode],
     }
   }
   ```

5. **Hotkey binding**:
   - Global `keydown` listener in `EditorPanelLayout.tsx`.
   - Bail if the target is an `INPUT`, `TEXTAREA`, or `contentEditable` element.
   - On `Shift+F` (no cmd/ctrl/meta), call `toggleFocusMode()`, preventDefault.

6. **Ellipsis menu entry** in `PanelGroup.tsx` (line 230-269 is where the menu is defined):
   - Between the existing "Add Panel" section and "Close Group", add a divider + one new item:
     ```tsx
     <div className="border-t border-gray-700 my-1" />
     <button
       className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-blue-600/40"
       onClick={() => { onToggleMarkPrimary(group.id); setMenuOpen(false) }}
     >
       {group.primary ? 'Unmark as Primary' : 'Mark as Primary'}
     </button>
     ```
   - Thread `onToggleMarkPrimary` through `PanelGroupProps` → `PanelLayout` → `EditorPanelLayout` → a handler that calls `update(path, (n) => ({ ...n, primary: !n.primary }))`.

7. **Persistence**:
   - `primary` IS persisted in the saved workspace view (part of `GroupNode` shape).
   - `focusSnapshot` is ephemeral — never written to workspace view.
   - When the user toggles primary inside Focus Mode, the change takes effect on restore (not immediately — or decide it does; document either way).

8. **Toast feedback** (optional, nice-to-have): show a small transient "Focus Mode: ON" / "Focus Mode: OFF" toast when toggled, matching other hotkey-triggered toasts in the editor.

9. **Tests**:
   - Unit test `collapseAllNonPrimary` against sample trees.
   - Component test: press `Shift+F` on a mounted `PanelLayout` — non-primary groups become collapsed; press again — restored.
   - Hotkey bails when typing in an input.
   - Ellipsis-menu "Mark as Primary" toggles the flag on the right group.
   - Persistence: saving + reloading a layout preserves `primary` but not `focusSnapshot`.

---

## Verification

- [ ] `primary?: boolean` added to `GroupNode`.
- [ ] Default layout marks `preview-group` + `timeline-group` as primary.
- [ ] `Shift+F` collapses all non-primary; second press restores.
- [ ] Hotkey bails in text inputs.
- [ ] Ellipsis menu shows "Mark/Unmark as Primary" and toggles the flag.
- [ ] `primary` persists in workspace view; snapshot does not.
- [ ] Tests pass.

---

**Next Task**: [Task 81: Missing-source recovery](task-81-missing-source-recovery.md)
