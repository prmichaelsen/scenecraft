# Task 5: Migrate Property Panels and Extract Color Grading

**Milestone**: [M2 - Dynamic Panel Layout](../../milestones/milestone-2-dynamic-panel-layout.md)  
**Design Reference**: [Dynamic Panel Layout](../../design/local.dynamic-panel-layout.md)  
**Estimated Time**: 4-6 hours  
**Dependencies**: [Task 4: Preview and Timeline panels](task-4-preview-timeline-panels.md)  
**Status**: Not Started  

---

## Objective

Wrap KeyframePanel and TransitionPanel as dockview panels in the properties column, extract color grading controls from TransitionPanel into a standalone ColorGradingPanel tab, and implement context-sensitive tab activation.

---

## Steps

### 1. Wrap KeyframePanel as Dockview Panel

Create a thin wrapper that receives `params` from dockview (projectName, selected keyframe, callbacks) and renders the existing KeyframePanel. Remove the self-managed width/resize handle — dockview handles layout.

### 2. Wrap TransitionPanel as Dockview Panel

Same wrapper pattern. Remove width/resize handle.

### 3. Extract ColorGradingPanel

Pull color grading curve editors (saturation, RGB, black, hue shift, opacity, invert) out of TransitionPanel into `src/components/editor/ColorGradingPanel.tsx`. This panel operates on the currently selected transition's curves.

### 4. Register All Three in Properties Group

In the default layout builder, add all three panels with `direction: 'within'` so they appear as tabs: `[KF] [TR] [Color]`.

### 5. Context-Sensitive Tab Activation

When user clicks a keyframe in the timeline, call `api.getPanel('keyframeProps')?.api.setActive()`. When clicking a transition, activate the TR tab. Color grading tab is manually selected by the user.

### 6. Remove Old Panel Rendering from Timeline.tsx

Delete the ternary branches for selectedKeyframe/selectedTransition and the inline SuppressionEditorPanel, TrackSettingsPanel, RuleEditorPanel, EffectEditor, AudioDescriptionPanel. These become additional tabs or get their own task.

---

## Verification

- [ ] KF/TR/ColorGrade appear as tabs in the properties column
- [ ] Clicking a keyframe activates the KF tab
- [ ] Clicking a transition activates the TR tab
- [ ] Color grading tab shows curve editors for the selected transition
- [ ] All existing KF/TR panel functionality works (candidates, prompts, delete, etc.)
- [ ] No width/resize handle remnants from old panel code

---

**Next Task**: [Task 6: Migrate utility panels](task-6-utility-panels.md)  
**Related Design Docs**: [local.dynamic-panel-layout.md](../../design/local.dynamic-panel-layout.md)  
