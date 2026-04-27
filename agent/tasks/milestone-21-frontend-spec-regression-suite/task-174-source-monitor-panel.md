# Task 174: source-monitor-panel spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.source-monitor-panel`](../../specs/local.source-monitor-panel.md)
**Estimated Time**: 14 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the source monitor panel: media preview, scrubbing, in/out point marking, and pool segment interaction.

## Test File

`src/components/editor/__tests__/spec-source-monitor-panel.test.tsx`

## Coverage Plan

- **Panel rendering**: renders with selected pool segment; empty state when no selection
- **Video preview**: correct source URL; play/pause toggle; scrub via click/drag
- **In/out points**: mark in; mark out; clear marks; range highlight
- **Pool segment display**: metadata rendering (duration, filename, resolution)
- **Keyboard shortcuts**: I/O for in/out; space for play/pause; J/K/L for shuttle
- **Insert from monitor**: insert clip at playhead from marked range; uses pool segment ID
- **Integration**: select pool item -> source monitor updates -> mark in/out -> insert into timeline

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run` passes for this file
- [ ] Video element behavior mocked
