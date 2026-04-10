# Task 7: Sidebars and Toggle Controls

**Milestone**: [M2 - Dynamic Panel Layout](../../milestones/milestone-2-dynamic-panel-layout.md)  
**Design Reference**: [Dynamic Panel Layout](../../design/local.dynamic-panel-layout.md)  
**Estimated Time**: 3-4 hours  
**Dependencies**: [Task 4: Preview and Timeline panels](task-4-preview-timeline-panels.md)  
**Status**: Not Started  

---

## Objective

Add the left sidebar (empty collapsible placeholder), right sidebar (Sections panel + Chat panel), and toggle buttons ([◫] for left, [☰] hamburger for right) in the top-right corner of the editor.

---

## Steps

### 1. Add Left Sidebar Group

In the default layout builder, add an empty panel group on the far left. It should be collapsible (can be hidden entirely). The [◫] button toggles its visibility.

### 2. Add Right Sidebar Group

Add NarrativeSectionPanel as the top panel and a Chat placeholder as the bottom panel in a right sidebar group. The right sidebar is toggled via a [☰] hamburger button.

### 3. Create Toggle Buttons

Add [◫] and [☰] buttons to the top-right corner of the editor (or in the dockview header area):
- [◫] toggles left sidebar group visibility
- [☰] opens a dropdown menu listing available right sidebar views (Sections, future views). Selecting one shows/adds that panel in the right sidebar.

### 4. Migrate NarrativeSectionPanel

Wrap the existing NarrativeSectionPanel as a dockview panel. Remove `showSections` state flag and its independent rendering from the old layout.

### 5. Create Chat Placeholder Panel

Create a minimal `ChatPanel.tsx` placeholder (just a styled container with "Chat coming soon" or similar). This will be implemented fully in a separate milestone.

---

## Verification

- [ ] Left sidebar renders as collapsible empty column
- [ ] [◫] button toggles left sidebar open/closed
- [ ] Right sidebar shows Sections (top) and Chat (bottom)
- [ ] [☰] button opens dropdown menu with "Sections" option
- [ ] NarrativeSectionPanel works inside dockview (sections load, edit, save)
- [ ] Right sidebar can be collapsed independently
- [ ] Top portion of right sidebar can be collapsed to give chat full height

---

**Next Task**: [Task 8: Workspace views and theme](task-8-workspace-views-theme.md)  
**Related Design Docs**: [local.dynamic-panel-layout.md](../../design/local.dynamic-panel-layout.md)  
