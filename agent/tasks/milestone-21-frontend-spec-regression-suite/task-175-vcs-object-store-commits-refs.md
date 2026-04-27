# Task 175: vcs-object-store-commits-refs spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.vcs-object-store-commits-refs`](../../specs/local.vcs-object-store-commits-refs.md)
**Estimated Time**: 10 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the VCS (version control system) client: object store interaction, commit/ref operations, branch listing, and checkout.

## Test File

`src/lib/__tests__/spec-vcs-object-store-commits-refs.test.ts`

## Coverage Plan

- **VCS client API calls**: correct endpoints for list-branches, create-branch, checkout, commit, log
- **Object store**: blob/tree/commit object model; hash computation if client-side
- **Ref management**: HEAD resolution; branch pointer updates; detached HEAD handling
- **Commit operations**: create commit with message; commit tree construction
- **Branch operations**: create, delete, switch; current branch tracking
- **Error handling**: conflict on checkout with uncommitted changes; missing ref; auth failures
- **Integration**: branch list -> select branch -> checkout -> UI updates

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run` passes for this file
- [ ] Fetch calls mocked for all VCS endpoints
