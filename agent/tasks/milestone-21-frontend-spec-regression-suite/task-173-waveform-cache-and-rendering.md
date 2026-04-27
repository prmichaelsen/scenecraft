# Task 173: waveform-cache-and-rendering spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.waveform-cache-and-rendering`](../../specs/local.waveform-cache-and-rendering.md)
**Estimated Time**: 8 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the waveform peak fetch/cache/render pipeline: `fetchPeaks`, in-memory cache, concurrent-request dedup, cache invalidation, float16 decode, and canvas tile rendering.

## Test File

`src/lib/__tests__/spec-waveform-cache-and-rendering.test.ts`

## Coverage Plan

- **fetchPeaks**: correct URL construction; resolution parameter; response parsing
- **Cache**: hit/miss behavior keyed by `${project}:${clipId}:${resolution}`; invalidatePeaks evicts correctly
- **Concurrent dedup**: multiple simultaneous fetchPeaks for same key share one Promise; second call doesn't re-fetch
- **Float16 decode**: ArrayBuffer of float16 values correctly decoded to Float32Array; edge cases (0, subnormals, Inf, NaN)
- **Canvas tiling**: TILE_WIDTH_CSS_PX = 2048; tile count derivation from total width; devicePixelRatio sizing
- **Draw loop**: max-pool-to-pixel; mirrored vertical lines about midpoint; width < 16 renders nothing
- **Component lifecycle**: fetch on mount; re-fetch on clip change; loading state (no paint); error state (opacity 0)
- **Integration**: fetchPeaks -> cache check -> fetch -> decode -> canvas draw end-to-end with mocked fetch

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run` passes for this file
- [ ] Canvas API mocked (happy-dom doesn't implement Canvas fully)
