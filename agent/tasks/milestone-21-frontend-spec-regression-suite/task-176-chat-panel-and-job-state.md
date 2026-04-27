# Task 176: chat-panel-and-job-state spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.chat-panel-and-job-state`](../../specs/local.chat-panel-and-job-state.md)
**Estimated Time**: 14 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the ChatPanel component and job state management. Existing `chat-client.test.ts` covers 9 tests — this task fills the remaining ~51 requirement gaps.

## Test File

`src/components/editor/__tests__/spec-chat-panel-and-job-state.test.tsx`

## Coverage Plan

- **ChatPanel rendering**: message list; input area; send button; loading indicator; scroll-to-bottom
- **Message types**: user messages, assistant messages, tool_use blocks, tool_result blocks, error messages
- **Job state display**: pending/running/completed/failed states; progress percentage; cancel button
- **Job lifecycle**: start -> progress updates via WS -> completion/failure; multi-job display
- **Confirmation gate**: destructive tool shows confirmation dialog; user approves/denies; allowlist bypass
- **WS message handling**: chat_response, job_progress, job_complete, job_failed message types
- **Input handling**: enter to send; shift+enter for newline; disabled during generation
- **Streaming**: partial assistant responses rendered incrementally
- **History**: conversation persistence; scroll-back loading
- **Integration**: type message -> send -> WS dispatches -> job starts -> progress renders -> completion updates message list

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run` passes for this file
- [ ] WebSocket mocked; React component rendered via @testing-library/react
