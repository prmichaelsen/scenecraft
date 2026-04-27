# Task 172: video-and-transition-tracks spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.video-and-transition-tracks`](../../specs/local.video-and-transition-tracks.md)
**Estimated Time**: 12 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the video track and transition track data model, timeline rendering, and interaction layer.

## Test File

`src/lib/__tests__/spec-video-and-transition-tracks.test.ts`

## Coverage Plan

- **Track data model**: video track creation, ordering, visibility, lock state
- **Transition model**: transition between keyframes, duration, type, prompt metadata
- **Keyframe model**: source image, timestamp, prompt, generation state
- **Timeline layout**: keyframe positioning, transition span calculation, overlap rules
- **Track operations**: add/remove/reorder tracks; drag-and-drop reorder
- **Keyframe operations**: add/delete/duplicate/restore; batch delete; split transitions
- **REST client calls**: verify correct endpoints called for each operation
- **Selection state**: keyframe selection, multi-select, deselect-on-click-away
- **Candidate pattern**: generation produces candidates, user promotes to keyframe

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run` passes for this file
