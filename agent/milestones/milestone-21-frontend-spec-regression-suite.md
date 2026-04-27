# Milestone 21: Frontend Spec Regression Suite

**Goal**: Write unit + integration tests against all 23 frontend specs to lock in current behavior. Each spec gets a dedicated test file; every requirement with a testable observable effect gets at least one test. Tests run under vitest with happy-dom.
**Duration**: ~4-5 weeks (12 tasks, ~120 dev hours)
**Dependencies**: None blocking. Specs committed; vitest configured.
**Status**: Not Started

---

## Overview

The scenecraft frontend has 23 specs and 25 existing test files, but coverage is spotty — 12 specs have significant gaps (6 have zero tests). This milestone closes those gaps.

**Per-task contract**:
- One test file at `src/lib/__tests__/spec-<slug>.test.ts` (or `src/components/editor/__tests__/spec-<slug>.test.tsx` for component-heavy specs)
- Every requirement `Rn` maps to >=1 test, docstring annotated with the requirement ID
- Pure-UI behavior that can't be tested without a real browser gets a `// NOTE: requires browser` comment, not a test
- Integration tests hit the actual module exports (not mocks) wherever possible; mock only external I/O (fetch, WebSocket, WebSerial, WebAudio nodes)

**What counts as e2e here**: Since there's no Cypress/Playwright, "e2e" means integration tests that exercise the full module stack (e.g., fetchPeaks -> cache -> component render, or chat-client -> WS handler -> state update). Not HTTP-through-browser, but deeper than unit-testing a single function.

---

## Tasks

12 tasks covering the 12 gap specs. Tasks are grouped by domain.

| # | Spec | Reqs | Existing tests | Est hrs |
|---|------|------|----------------|---------|
| 170 | light-show-dmx-output | 40 | 0 | 12 |
| 171 | light-show-scene-editor | 50 | 0 | 14 |
| 172 | video-and-transition-tracks | 43 | 0 | 12 |
| 173 | waveform-cache-and-rendering | 22 | 0 | 8 |
| 174 | source-monitor-panel | 53 | 0 | 14 |
| 175 | vcs-object-store-commits-refs | 37 | 0 | 10 |
| 176 | chat-panel-and-job-state | 60 | 9 (partial) | 14 |
| 177 | chat-tool-dispatch-and-elicitation | 31 | 9 (partial) | 10 |
| 178 | auth-jwt-api-keys-double-gate | 20 | 9 (partial) | 6 |
| 179 | editor-state-selection-mutex | 19 | 5 (partial) | 6 |
| 180 | music-generation-plugin | 56 | 26 (partial) | 10 |
| 181 | panel-layout-and-plugin-panel-host | 59 | 19 (partial) | 10 |

**Total estimated**: ~126 dev hours

---

## Success Criteria

- [ ] Test file exists for every gap spec (12 files)
- [ ] `npx vitest run` exits 0
- [ ] Every spec requirement has >=1 covering test or an explicit `// NOTE:` explaining why not
- [ ] No spec requirement silently omitted
- [ ] Existing tests not broken by new additions

---

## Non-Goals

- Cypress/Playwright browser tests (no setup exists)
- Testing specs that already have adequate coverage (the 11 "no gap" specs)
- Refactoring existing code to make it more testable
- Visual regression testing

---

## Notes

- vitest runs with `happy-dom` environment — WebAudio, WebSerial, and Canvas APIs need mocking
- Light show specs (T170-T171) will need EnttecPro + WebSerial mocks and Three.js/R3F test utilities
- Chat specs (T176-T178) share a WS mock pattern — extract to a shared fixture
- The engine has an equivalent M18 (18 tasks, 193 hours) — this is the frontend counterpart
