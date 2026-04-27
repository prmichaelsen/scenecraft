# Task 170: light-show-dmx-output spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.light-show-dmx-output`](../../specs/local.light-show-dmx-output.md)
**Estimated Time**: 12 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the WebSerial DMX output pipeline: `enttec-pro.ts`, `dmx-mapper.ts`, and the DMX output wiring in `LightShow3DPanel.tsx`.

## Test File

`src/plugins/light_show/__tests__/spec-light-show-dmx-output.test.ts`

## Coverage Plan

Test every requirement in the spec. Key areas:

- **EnttecPro frame encoding**: verify START_OF_MSG, SEND_DMX_LABEL, data length, start code, END_OF_MSG byte positions and values for known channel inputs
- **EnttecPro state machine**: disconnected -> connecting -> connected -> disconnect; error transitions; cleanup on write failure
- **EnttecPro transmit loop**: coalesces rapid send() calls; respects TX_INTERVAL_MS cadence; stops on disconnect
- **WebSerial mock**: mock `navigator.serial.requestPort()` with FTDI vendor/product filter assertions; mock port.open/writable/getWriter
- **DMX mapper autoPatch**: contiguous address assignment; 6ch for both par and moving_head; respects explicit pins; collision handling; universe overflow
- **DMX mapper fixturesToDMX**: intensity/RGB/pan/tilt channel mapping; radian-to-255 conversion edge cases (0, -PI, PI, -PI/2, PI/2); clamping; par vs moving_head slot semantics (effects macro held at 0)
- **Integration**: SceneRunner useFrame -> fixturesToDMX -> EnttecPro.send wiring (mock useFrame tick)
- **Connect button**: renders only when `'serial' in navigator`; state-driven styling (green/yellow/red); toggle connect/disconnect

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run src/plugins/light_show/__tests__/spec-light-show-dmx-output.test.ts` passes
- [ ] WebSerial APIs fully mocked (no real hardware needed)
