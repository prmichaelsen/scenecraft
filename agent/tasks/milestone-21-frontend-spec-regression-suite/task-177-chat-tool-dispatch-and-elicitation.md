# Task 177: chat-tool-dispatch-and-elicitation spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.chat-tool-dispatch-and-elicitation`](../../specs/local.chat-tool-dispatch-and-elicitation.md)
**Estimated Time**: 10 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the chat tool dispatch pipeline: tool_use message handling, elicitation flows (user confirmation / parameter gathering), and tool_result rendering.

## Test File

`src/lib/__tests__/spec-chat-tool-dispatch-and-elicitation.test.ts`

## Coverage Plan

- **Tool dispatch**: WS message with tool_use -> correct handler invoked by tool name
- **Elicitation flow**: tool requests user input -> UI renders elicitation form -> user responds -> response sent back
- **Confirmation gate**: destructive tools require confirmation; allowlist tools skip confirmation
- **Tool result rendering**: success results displayed inline; error results show error styling
- **WS round-trip tools**: mix_render_request, bounce_audio_request, master_bus_effects_changed handlers
- **Frontend-executed tools**: tools that run client-side (render, bounce) vs tools that complete server-side
- **Error handling**: tool execution failure; timeout; WS disconnect during tool execution
- **Integration**: assistant message with tool_use -> dispatch -> execute -> tool_result sent back -> assistant continues

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run` passes for this file
