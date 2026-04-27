# Task 180: music-generation-plugin spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.music-generation-plugin`](../../specs/local.music-generation-plugin.md)
**Estimated Time**: 10 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the music generation plugin UI and data flow. Existing `plugin-host.test.ts` covers 26 tests on the plugin host generics — this task tests the music-generation-specific requirements.

## Test File

`src/plugins/music_generation/__tests__/spec-music-generation-plugin.test.ts`

## Coverage Plan

- **Plugin panel rendering**: generation form; prompt input; duration/genre/style controls
- **Generation flow**: submit prompt -> WS job created -> progress updates -> completion -> audio clip placed
- **Job management**: cancel generation; retry failed generation; concurrent generation limit
- **Musicful integration**: correct API payload construction; API key handling
- **Audio placement**: generated audio placed as pool segment; auto-insert as audio clip on track
- **Plugin manifest**: correct contributes declarations; REST endpoint registration
- **Settings**: generation parameters persistence per-project
- **Error handling**: API errors; timeout; invalid prompt; quota exceeded
- **Integration**: fill form -> generate -> job progress renders -> audio lands in pool -> placed on timeline

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run` passes for this file
- [ ] Musicful API calls mocked
