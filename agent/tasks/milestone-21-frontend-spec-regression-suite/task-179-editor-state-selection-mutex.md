# Task 179: editor-state-selection-mutex spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.editor-state-selection-mutex`](../../specs/local.editor-state-selection-mutex.md)
**Estimated Time**: 6 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the editor selection state machine: single/multi-select, selection mutex (only one entity type selected at a time), and selection-dependent UI state.

## Test File

`src/lib/__tests__/spec-editor-state-selection-mutex.test.ts`

## Coverage Plan

- **Single select**: click entity -> selected; click another -> previous deselected
- **Multi-select**: shift+click or cmd+click adds to selection; same type only
- **Selection mutex**: selecting a keyframe clears audio clip selection and vice versa; only one entity type at a time
- **Deselect**: click empty area -> all deselected; Escape -> all deselected
- **Selection state shape**: selectedKeyframes, selectedClips, selectedTransitions — only one non-empty at a time
- **Selection-dependent UI**: inspector panel updates; delete key acts on selection; copy/paste scoped to selection type
- **Edge cases**: select during drag (no-op); select during playback; rapid click between types

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run` passes for this file
