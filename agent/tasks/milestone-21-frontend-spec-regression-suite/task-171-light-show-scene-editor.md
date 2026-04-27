# Task 171: light-show-scene-editor spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.light-show-scene-editor`](../../specs/local.light-show-scene-editor.md)
**Estimated Time**: 14 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the light show 3D scene editor: scene definitions, fixture state mutation, override application, beat-reactive context, SceneRunner tick loop, and REST client.

## Test File

`src/plugins/light_show/__tests__/spec-light-show-scene-editor.test.ts`

## Coverage Plan

- **Scene definitions**: each hardcoded scene produces valid FixtureState mutations over time
- **SceneRunner tick loop**: scene.apply called each frame; override application wins per-channel; beat context populated from playhead/beats refs
- **Fixture state**: initial states (full-on white), pan/tilt rotation order (YXZ), moving_head vs par behavior
- **Override merge**: overrides keyed by fixture ID; per-channel granularity (null = scene-driven); clear semantics
- **Beat tracking**: lastBeatIdx linear scan; beatAge/lastBeatIntensity/beatIndex derivation; scrub-back resets
- **REST client**: fetchFixtures/fetchOverrides/fetchScreens mock responses; error handling; polling interval
- **WS subscription**: subscribePluginEvent('light_show', 'changed') triggers re-fetch
- **Diag display**: tick counter, time, beat label, override count updated every 15 frames

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run` passes for this file
- [ ] Three.js/R3F internals mocked where needed (useFrame, Canvas)
