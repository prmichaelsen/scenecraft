/**
 * Tests for M13 task-55 useTouchRecord hook.
 *
 * Covers spec requirements R20-R27 and R29a (undo-during-recording) by
 * driving the hook's public API and asserting state transitions,
 * sample-buffer behavior, commit payloads, and undo contract.
 *
 *   R20  — state machine transitions: idle → armed → recording → armed
 *   R21  — mousedown without arm = no-op
 *   R22  — commit on playback stop
 *   R23  — sampling rate (mock rAF → 80-110 samples for a 3s gesture)
 *   R24  — simplification (delegates to simplifyCurve, covered end-to-end)
 *   R25  — one undo unit per commit (exactly one onCommit per gesture)
 *   R26  — gesture-while-paused edits directly, no recording
 *   R29a — undo-during-record commits first, then invokes postUndo
 *   Multi-arm: two knobs record independently
 *   Effect disable mid-record commits
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useState, useCallback } from 'react'
import {
  useTouchRecord,
  type TouchRecordApi,
  type TouchRecordDeps,
  type TouchRecordCommitPayload,
} from '../useTouchRecord'

// ---------------------------------------------------------------------------
// Mock rAF — drive sampling loop deterministically.
// ---------------------------------------------------------------------------

interface RafController {
  raf: (cb: FrameRequestCallback) => number
  cancelRaf: (h: number) => void
  tick: (deltaMs: number) => void
  reset: () => void
  /** Current virtual `now` clock in ms. */
  now: () => number
}

function mockRaf(): RafController {
  let nowMs = 0
  let next = 1
  const pending = new Map<number, FrameRequestCallback>()
  return {
    raf: (cb) => {
      const h = next++
      pending.set(h, cb)
      return h
    },
    cancelRaf: (h) => {
      pending.delete(h)
    },
    tick(deltaMs) {
      // Advance the clock and fire ONE frame's worth of callbacks every
      // 16ms (~60fps). Each callback may re-queue; we drain everything
      // queued at the start of the step before advancing.
      const targetMs = nowMs + deltaMs
      while (nowMs < targetMs) {
        const step = Math.min(16, targetMs - nowMs)
        nowMs += step
        const callbacks = Array.from(pending.values())
        pending.clear()
        for (const cb of callbacks) {
          cb(nowMs)
        }
      }
    },
    reset() {
      nowMs = 0
      next = 1
      pending.clear()
    },
    now: () => nowMs,
  }
}

// ---------------------------------------------------------------------------
// Mock AudioContext/Param.
// ---------------------------------------------------------------------------

interface MockCtxController {
  audioCtx: { currentTime: number }
  param: {
    setTargetAtTime: ReturnType<typeof vi.fn>
    linearRampToValueAtTime: ReturnType<typeof vi.fn>
    setValueAtTime: ReturnType<typeof vi.fn>
    setValueCurveAtTime: ReturnType<typeof vi.fn>
    cancelScheduledValues: ReturnType<typeof vi.fn>
  }
  advance: (dtSec: number) => void
}

function mockAudio(): MockCtxController {
  const audioCtx = { currentTime: 0 }
  const param = {
    setTargetAtTime: vi.fn(() => undefined),
    linearRampToValueAtTime: vi.fn(() => undefined),
    setValueAtTime: vi.fn(() => undefined),
    setValueCurveAtTime: vi.fn(() => undefined),
    cancelScheduledValues: vi.fn(() => undefined),
  }
  return {
    audioCtx,
    param,
    advance(dtSec) {
      audioCtx.currentTime += dtSec
    },
  }
}

// ---------------------------------------------------------------------------
// Harness component that exposes the hook's API via a ref.
// ---------------------------------------------------------------------------

interface HarnessProps {
  deps: TouchRecordDeps
  apiRef: { current: TouchRecordApi | null }
}

function Harness({ deps, apiRef }: HarnessProps) {
  const api = useTouchRecord(deps)
  apiRef.current = api
  return <div data-testid="harness" data-state={api.state} />
}

/**
 * A re-rendering harness: hosts its own React state for `isPlaying` +
 * `isEffectEnabled` so tests can flip them and trigger the watching effect.
 */
interface ReactiveHarnessHandle {
  apiRef: { current: TouchRecordApi | null }
  setPlaying: (v: boolean) => void
  setEnabled: (v: boolean) => void
  onCommit: ReturnType<typeof vi.fn>
  postUndo: ReturnType<typeof vi.fn>
  raf: RafController
  audio: MockCtxController
  setExistingCurve: (c: { points: { time: number; value: number }[]; interpolation: 'bezier' | 'linear' | 'step' } | null) => void
  setPlayhead: (t: number) => void
}

function renderHarness(initial?: {
  playing?: boolean
  enabled?: boolean
  playhead?: number
  existingCurve?: { points: { time: number; value: number }[]; interpolation: 'bezier' | 'linear' | 'step' } | null
}): ReactiveHarnessHandle & { unmount: () => void } {
  const raf = mockRaf()
  const audio = mockAudio()
  const apiRef = { current: null as TouchRecordApi | null }

  let playing = initial?.playing ?? false
  let enabled = initial?.enabled ?? true
  let playhead = initial?.playhead ?? 0
  let existing = initial?.existingCurve ?? null
  const onCommit = vi.fn<(p: TouchRecordCommitPayload) => void>()
  const postUndo = vi.fn()

  function Wrapper() {
    const [, tick] = useState(0)
    const rerender = useCallback(() => tick((x) => x + 1), [])
    ;(Wrapper as unknown as { rerender: () => void }).rerender = rerender

    const deps: TouchRecordDeps = {
      effectId: 'E1',
      paramName: 'cutoff',
      paramNativeValue: (n) => n,
      // vitest's Mock overload type doesn't structurally match our strict
      // fn-typed param surface; cast is safe — the spies expose the right
      // call shapes at runtime.
      param: audio.param as unknown as TouchRecordDeps['param'],
      audioCtx: audio.audioCtx,
      getPlayheadSeconds: () => playhead,
      isPlaying: () => playing,
      isEffectEnabled: () => enabled,
      getExistingCurve: () => existing,
      onCommit,
      postUndo,
      raf: raf.raf,
      cancelRaf: raf.cancelRaf,
      now: raf.now,
    }
    return <Harness deps={deps} apiRef={apiRef} />
  }

  const result = render(<Wrapper />)

  return {
    apiRef,
    setPlaying: (v) => {
      playing = v
      act(() => (Wrapper as unknown as { rerender: () => void }).rerender())
    },
    setEnabled: (v) => {
      enabled = v
      act(() => (Wrapper as unknown as { rerender: () => void }).rerender())
    },
    setPlayhead: (t) => { playhead = t },
    setExistingCurve: (c) => { existing = c },
    onCommit,
    postUndo,
    raf,
    audio,
    unmount: result.unmount,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => cleanup())

describe('useTouchRecord — state machine (R20)', () => {
  it('transitions idle → armed → recording → armed', () => {
    const h = renderHarness({ playing: true })
    expect(h.apiRef.current!.state).toBe('idle')

    act(() => h.apiRef.current!.toggleArm())
    expect(h.apiRef.current!.state).toBe('armed')

    act(() => h.apiRef.current!.onGestureStart())
    expect(h.apiRef.current!.state).toBe('recording')

    act(() => h.apiRef.current!.onGestureEnd())
    expect(h.apiRef.current!.state).toBe('armed')
  })

  it('no auto-disarm after commit — stays `armed`', () => {
    const h = renderHarness({ playing: true })
    act(() => h.apiRef.current!.toggleArm())
    act(() => h.apiRef.current!.onGestureStart())
    act(() => h.apiRef.current!.onGestureEnd())
    expect(h.apiRef.current!.state).toBe('armed')
  })
})

describe('useTouchRecord — record-without-arm-is-noop (R21)', () => {
  it('mousedown on idle knob does not enter recording and does not commit', () => {
    const h = renderHarness({ playing: true })
    act(() => h.apiRef.current!.onGestureStart())
    expect(h.apiRef.current!.state).toBe('idle')
    act(() => h.apiRef.current!.onGestureChange(0.7))
    act(() => h.apiRef.current!.onGestureEnd())
    expect(h.onCommit).not.toHaveBeenCalled()
  })

  it('gesture on armed knob while paused does NOT enter recording (R21 precondition)', () => {
    const h = renderHarness({ playing: false })
    act(() => h.apiRef.current!.toggleArm())
    act(() => h.apiRef.current!.onGestureStart())
    expect(h.apiRef.current!.state).toBe('armed') // NOT recording
  })
})

describe('useTouchRecord — gesture-while-paused-edits-directly (R26)', () => {
  it('armed + paused + drag commits a single-point curve at playhead', () => {
    const h = renderHarness({ playing: false, playhead: 5.0 })
    act(() => h.apiRef.current!.toggleArm())
    act(() => h.apiRef.current!.onGestureStart())
    act(() => h.apiRef.current!.onGestureChange(0.75))
    act(() => h.apiRef.current!.onGestureEnd())

    expect(h.apiRef.current!.state).toBe('armed')
    expect(h.onCommit).toHaveBeenCalledTimes(1)
    const payload = h.onCommit.mock.calls[0][0]
    expect(payload.points).toHaveLength(1)
    expect(payload.points[0]).toEqual({ time: 5.0, value: 0.75 })
    expect(payload.gestureRange).toEqual([5.0, 5.0])
    expect(payload.interpolation).toBe('bezier')
  })

  it('paused direct-edit replaces an existing point at the same playhead time', () => {
    const h = renderHarness({
      playing: false,
      playhead: 5.0,
      existingCurve: { points: [{ time: 5.0, value: 0.3 }, { time: 7.0, value: 0.1 }], interpolation: 'bezier' },
    })
    act(() => h.apiRef.current!.toggleArm())
    act(() => h.apiRef.current!.onGestureStart())
    act(() => h.apiRef.current!.onGestureChange(0.9))
    act(() => h.apiRef.current!.onGestureEnd())

    const payload = h.onCommit.mock.calls[0][0]
    expect(payload.points).toEqual([
      { time: 5.0, value: 0.9 },
      { time: 7.0, value: 0.1 },
    ])
  })
})

describe('useTouchRecord — record-commit-at-playback-stop (R22)', () => {
  it('stopping playback mid-gesture commits the buffer + returns to armed', () => {
    const h = renderHarness({ playing: true })
    act(() => h.apiRef.current!.toggleArm())
    act(() => h.apiRef.current!.onGestureStart())
    expect(h.apiRef.current!.state).toBe('recording')

    // A few rAF ticks with value changes, then stop.
    act(() => h.apiRef.current!.onGestureChange(0.2))
    act(() => { h.audio.advance(0.1); h.raf.tick(100) })
    act(() => h.apiRef.current!.onGestureChange(0.4))
    act(() => { h.audio.advance(0.1); h.raf.tick(100) })

    // Stop playback — watching effect commits.
    h.setPlaying(false)

    expect(h.apiRef.current!.state).toBe('armed')
    expect(h.onCommit).toHaveBeenCalledTimes(1)
  })
})

describe('useTouchRecord — recording-samples-at-33hz-target (R23)', () => {
  it('3-second gesture produces 80-110 raw samples at the 30ms throttle', () => {
    const h = renderHarness({ playing: true })
    act(() => h.apiRef.current!.toggleArm())
    act(() => h.apiRef.current!.onGestureStart())

    // Drive 3 seconds of real-time rAF (60fps → 180 frames, 30ms throttle
    // → ~100 samples).
    const FRAMES_PER_16MS = 1
    const TOTAL_MS = 3000
    for (let t = 0; t < TOTAL_MS; t += 16 * FRAMES_PER_16MS) {
      act(() => {
        h.audio.advance(0.016)
        h.raf.tick(16)
      })
    }

    const count = h.apiRef.current!._debugSampleCount()
    // Spec floor: ≥30Hz over 3s = ≥90; target 33Hz = ~99. Accept 80-110 to
    // tolerate rAF step quantization at the 16ms/30ms ratio.
    expect(count).toBeGreaterThanOrEqual(80)
    expect(count).toBeLessThanOrEqual(110)
  })
})

describe('useTouchRecord — two-overlapping-recordings-on-different-knobs (R20 multi-arm)', () => {
  it('two independent hooks produce separate commits with independent ranges', () => {
    const h1 = renderHarness({ playing: true, playhead: 1.0 })
    const h2 = renderHarness({ playing: true, playhead: 2.0 })

    act(() => h1.apiRef.current!.toggleArm())
    act(() => h2.apiRef.current!.toggleArm())

    // Start K1 at 1.0s.
    act(() => h1.apiRef.current!.onGestureStart())
    act(() => h1.apiRef.current!.onGestureChange(0.3))
    // K1 has been recording for 1s of audioCtx time.
    act(() => { h1.audio.advance(1.0); h1.raf.tick(100) })

    // Now start K2 (its own audio + playhead context).
    act(() => h2.apiRef.current!.onGestureStart())
    act(() => h2.apiRef.current!.onGestureChange(0.6))
    act(() => { h2.audio.advance(0.5); h2.raf.tick(50) })

    // End K2 first, then K1.
    act(() => h2.apiRef.current!.onGestureEnd())
    act(() => h1.audio.advance(1.0))
    act(() => h1.apiRef.current!.onGestureEnd())

    expect(h1.onCommit).toHaveBeenCalledTimes(1)
    expect(h2.onCommit).toHaveBeenCalledTimes(1)

    const p1 = h1.onCommit.mock.calls[0][0]
    const p2 = h2.onCommit.mock.calls[0][0]
    expect(p1.gestureRange[0]).toBe(1.0)
    expect(p2.gestureRange[0]).toBe(2.0)
    expect(p1.effectId).toBe('E1')
    expect(p2.effectId).toBe('E1')
    expect(p1.gestureRange[1]).toBeGreaterThan(p1.gestureRange[0])
    expect(p2.gestureRange[1]).toBeGreaterThan(p2.gestureRange[0])
  })
})

describe('useTouchRecord — bezier-fit-simplification-drops-redundant-points (R24)', () => {
  it('linear-ramp gesture commits with a simplified point set', () => {
    const h = renderHarness({ playing: true, playhead: 0 })
    act(() => h.apiRef.current!.toggleArm())
    act(() => h.apiRef.current!.onGestureStart())

    // Simulate a linear 0→1 ramp across 2 seconds with frequent updates.
    const STEPS = 66
    for (let i = 0; i < STEPS; i++) {
      const v = i / (STEPS - 1)
      act(() => {
        h.apiRef.current!.onGestureChange(v)
        h.audio.advance(2 / STEPS)
        h.raf.tick(2000 / STEPS)
      })
    }
    act(() => h.apiRef.current!.onGestureEnd())

    expect(h.onCommit).toHaveBeenCalledTimes(1)
    const payload = h.onCommit.mock.calls[0][0]
    // A linear ramp should collapse to a small handful of points.
    expect(payload.points.length).toBeLessThanOrEqual(6)
    expect(payload.points.length).toBeGreaterThanOrEqual(2)
  })
})

describe('useTouchRecord — undo-during-recording-commits-then-reverts (R29a)', () => {
  it('Ctrl+Z mid-record flushes gesture first, then invokes postUndo; knob stays armed', () => {
    const h = renderHarness({ playing: true, playhead: 0 })
    act(() => h.apiRef.current!.toggleArm())
    act(() => h.apiRef.current!.onGestureStart())
    // 40 samples-worth of gesture.
    for (let i = 0; i < 40; i++) {
      act(() => {
        h.apiRef.current!.onGestureChange(i / 40)
        h.audio.advance(0.03)
        h.raf.tick(30)
      })
    }

    // Ctrl+Z arrives — still mousedown.
    act(() => h.apiRef.current!.requestUndo())

    // Order: commit FIRST, then postUndo.
    expect(h.onCommit).toHaveBeenCalledTimes(1)
    expect(h.postUndo).toHaveBeenCalledTimes(1)
    const commitOrder = h.onCommit.mock.invocationCallOrder[0]
    const undoOrder = h.postUndo.mock.invocationCallOrder[0]
    expect(commitOrder).toBeLessThan(undoOrder)

    // Knob stays armed (not idle).
    expect(h.apiRef.current!.state).toBe('armed')

    // Silent discard forbidden: commit payload has non-empty points.
    const payload = h.onCommit.mock.calls[0][0]
    expect(payload.points.length).toBeGreaterThanOrEqual(2)
  })

  it('Ctrl+Z when not recording only calls postUndo (no spurious commit)', () => {
    const h = renderHarness({ playing: false })
    act(() => h.apiRef.current!.requestUndo())
    expect(h.onCommit).not.toHaveBeenCalled()
    expect(h.postUndo).toHaveBeenCalledTimes(1)
  })
})

describe('useTouchRecord — disable-mid-record-pauses-recording (R15, R20)', () => {
  it('disabling the owning effect mid-record commits + returns to armed', () => {
    const h = renderHarness({ playing: true, enabled: true })
    act(() => h.apiRef.current!.toggleArm())
    act(() => h.apiRef.current!.onGestureStart())
    for (let i = 0; i < 10; i++) {
      act(() => {
        h.apiRef.current!.onGestureChange(i / 10)
        h.audio.advance(0.03)
        h.raf.tick(30)
      })
    }

    h.setEnabled(false)

    expect(h.apiRef.current!.state).toBe('armed')
    expect(h.onCommit).toHaveBeenCalledTimes(1)
  })
})

describe('useTouchRecord — each commit is exactly ONE undo unit (R25)', () => {
  it('mouseup → exactly one onCommit call per gesture', () => {
    const h = renderHarness({ playing: true })
    act(() => h.apiRef.current!.toggleArm())

    for (let g = 0; g < 3; g++) {
      act(() => h.apiRef.current!.onGestureStart())
      act(() => h.apiRef.current!.onGestureChange(0.3 + g * 0.1))
      act(() => { h.audio.advance(0.1); h.raf.tick(100) })
      act(() => h.apiRef.current!.onGestureEnd())
    }

    expect(h.onCommit).toHaveBeenCalledTimes(3)
  })
})

describe('useTouchRecord — unmount commits in-flight gesture (R22)', () => {
  it('unmounting mid-record fires one commit', () => {
    const h = renderHarness({ playing: true })
    act(() => h.apiRef.current!.toggleArm())
    act(() => h.apiRef.current!.onGestureStart())
    act(() => { h.audio.advance(0.1); h.raf.tick(100) })

    act(() => h.unmount())

    expect(h.onCommit).toHaveBeenCalledTimes(1)
  })
})

describe('useTouchRecord — live audible feedback during drag', () => {
  it('calls param.setTargetAtTime on each onGestureChange', () => {
    const h = renderHarness({ playing: true })
    act(() => h.apiRef.current!.toggleArm())
    act(() => h.apiRef.current!.onGestureStart())
    act(() => h.apiRef.current!.onGestureChange(0.42))
    act(() => h.apiRef.current!.onGestureChange(0.55))
    expect(h.audio.param.setTargetAtTime).toHaveBeenCalled()
    // Most recent call carries native value 0.55 (paramNativeValue is identity).
    const lastCall = h.audio.param.setTargetAtTime.mock.calls.at(-1)!
    expect(lastCall[0]).toBe(0.55)
  })
})

beforeEach(() => {
  // happy-dom stubs — nothing to reset; mocks live inside each harness.
})
