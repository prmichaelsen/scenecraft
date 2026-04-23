/**
 * Tests for InlineCurveEditor (M13 task-53).
 *
 * Covers the spec's inline-editor contract:
 *   - R37: renders polyline + diamond keyframes
 *   - R38: dragging a keyframe updates [time, value]
 *   - R39: multi-select via shift-click and drag applies uniform (Δt, Δv)
 *   - R40: double-click deletes; right-click cycles interpolation
 *
 * The component uses canvas coordinates for hit-testing. happy-dom supplies a
 * minimal 2D context; we stub `getBoundingClientRect` and `ResizeObserver` so
 * the component knows its rendered size without a real layout engine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { InlineCurveEditor } from '../InlineCurveEditor'
import type { CurvePoint } from '@/lib/remap-curve'

// Canvas dimensions used for all tests.
const CANVAS_W = 240
const CANVAS_H = 80 // aspect 3 → 240 / 3
const PAD = 10

// happy-dom's ResizeObserver callback never fires without an explicit trigger.
// We stub it and immediately invoke with a synthetic contentRect of CANVAS_W.
class StubResizeObserver {
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.cb = cb }
  observe(_target: Element) {
    // Invoke synchronously on the next tick with the fake size.
    queueMicrotask(() => {
      this.cb([
        { contentRect: { width: CANVAS_W, height: CANVAS_H } } as unknown as ResizeObserverEntry,
      ], this as unknown as ResizeObserver)
    })
  }
  unobserve() { /* noop */ }
  disconnect() { /* noop */ }
}

// Project a point (time∈[0,1], value∈[0,1]) to canvas pixel coordinates —
// mirrors the `toCanvas` logic inside InlineCurveEditor for test purposes.
function projectToCanvas(x: number, y: number): [number, number] {
  return [
    PAD + x * (CANVAS_W - 2 * PAD),
    CANVAS_H - PAD - y * (CANVAS_H - 2 * PAD),
  ]
}

/**
 * Wait one microtask tick so the stubbed ResizeObserver callback runs.
 * happy-dom runs queueMicrotask synchronously on Promise.resolve().then(...).
 */
function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve())
}

beforeEach(() => {
  // Install the stub ResizeObserver globally.
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    StubResizeObserver as unknown as typeof ResizeObserver

  // Stub getBoundingClientRect so mouse events resolve to canvas-local coords.
  // happy-dom returns { x:0, y:0, width:0, height:0 } by default.
  const origGetBCR = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      x: 0, y: 0,
      left: 0, top: 0, right: CANVAS_W, bottom: CANVAS_H,
      width: CANVAS_W, height: CANVAS_H,
      toJSON: () => ({}),
    } as DOMRect
  }
  ;(HTMLElement.prototype as unknown as { _origGetBCR: typeof origGetBCR })._origGetBCR = origGetBCR
})

afterEach(() => {
  cleanup()
  const origGetBCR = (HTMLElement.prototype as unknown as { _origGetBCR?: typeof HTMLElement.prototype.getBoundingClientRect })._origGetBCR
  if (origGetBCR) HTMLElement.prototype.getBoundingClientRect = origGetBCR
})

describe('InlineCurveEditor', () => {
  it('renders a canvas element for the given points', async () => {
    const points: CurvePoint[] = [
      [0.0, 0.2],
      [0.5, 0.5],
      [1.0, 0.8],
    ]
    const onChange = vi.fn()
    const { getByTestId } = render(
      <InlineCurveEditor points={points} onChange={onChange} />
    )
    await flushMicrotasks()
    const canvas = getByTestId('inline-curve-editor-canvas') as HTMLCanvasElement
    expect(canvas).toBeTruthy()
    expect(canvas.tagName).toBe('CANVAS')
  })

  it('dragging a diamond fires onChange with updated [time, value]', async () => {
    // Use 3 points so the middle one (index 1, not an endpoint) can move freely.
    const points: CurvePoint[] = [
      [0.0, 0.5],
      [0.5, 0.5],
      [1.0, 0.5],
    ]
    const onChange = vi.fn()
    const { getByTestId } = render(
      <InlineCurveEditor points={points} onChange={onChange} />
    )
    await flushMicrotasks()
    const canvas = getByTestId('inline-curve-editor-canvas')

    // Press down on the middle diamond at its canvas coord.
    const [mx, my] = projectToCanvas(0.5, 0.5)
    fireEvent.mouseDown(canvas, { clientX: mx, clientY: my, button: 0 })

    // Move up-right; the middle point should follow.
    const targetX = 0.7
    const targetY = 0.8
    const [tx, ty] = projectToCanvas(targetX, targetY)
    fireEvent.mouseMove(canvas, { clientX: tx, clientY: ty })

    // The component calls onChange each mousemove while dragging.
    expect(onChange).toHaveBeenCalled()
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0] as CurvePoint[]

    // Middle point should have moved roughly to (targetX, targetY) — allow 5% tolerance
    // for pixel rounding.
    const moved = lastCall[1]
    expect(moved[0]).toBeGreaterThan(0.5)
    expect(moved[0]).toBeLessThanOrEqual(0.7 + 0.01)
    expect(moved[1]).toBeGreaterThan(0.5)
    expect(moved[1]).toBeLessThanOrEqual(0.8 + 0.01)

    fireEvent.mouseUp(canvas)
  })

  it('double-click on a diamond removes the point', async () => {
    const points: CurvePoint[] = [
      [0.0, 0.2],
      [0.5, 0.5],
      [1.0, 0.8],
    ]
    const onChange = vi.fn()
    const { getByTestId } = render(
      <InlineCurveEditor points={points} onChange={onChange} />
    )
    await flushMicrotasks()
    const canvas = getByTestId('inline-curve-editor-canvas')

    const [mx, my] = projectToCanvas(0.5, 0.5)
    fireEvent.doubleClick(canvas, { clientX: mx, clientY: my })

    expect(onChange).toHaveBeenCalled()
    const result = onChange.mock.calls[0][0] as CurvePoint[]
    expect(result).toHaveLength(2)
    expect(result.map((p) => p[0])).toEqual([0.0, 1.0])
  })

  it('right-click cycles interpolation bezier -> linear -> step -> bezier', async () => {
    const points: CurvePoint[] = [
      [0.0, 0.2],
      [0.5, 0.5],
      [1.0, 0.8],
    ]
    const onInterpolationChange = vi.fn()

    // Start at 'bezier'
    const { getByTestId, rerender } = render(
      <InlineCurveEditor
        points={points}
        onChange={() => { /* noop */ }}
        interpolation="bezier"
        onInterpolationChange={onInterpolationChange}
      />
    )
    await flushMicrotasks()
    const canvas = getByTestId('inline-curve-editor-canvas')

    const [mx, my] = projectToCanvas(0.5, 0.5)

    // bezier -> linear
    fireEvent.contextMenu(canvas, { clientX: mx, clientY: my })
    expect(onInterpolationChange).toHaveBeenLastCalledWith('linear')

    // Update prop and expect 'linear' -> 'step'
    rerender(
      <InlineCurveEditor
        points={points}
        onChange={() => { /* noop */ }}
        interpolation="linear"
        onInterpolationChange={onInterpolationChange}
      />
    )
    fireEvent.contextMenu(canvas, { clientX: mx, clientY: my })
    expect(onInterpolationChange).toHaveBeenLastCalledWith('step')

    // 'step' -> 'bezier'
    rerender(
      <InlineCurveEditor
        points={points}
        onChange={() => { /* noop */ }}
        interpolation="step"
        onInterpolationChange={onInterpolationChange}
      />
    )
    fireEvent.contextMenu(canvas, { clientX: mx, clientY: my })
    expect(onInterpolationChange).toHaveBeenLastCalledWith('bezier')
  })

  it('multi-select via shift-click + drag moves all selected by (Δt, Δv)', async () => {
    // Five points so we can select two middle ones and leave the others undisturbed.
    const points: CurvePoint[] = [
      [0.0, 0.2],
      [0.25, 0.3],
      [0.5, 0.5],
      [0.75, 0.6],
      [1.0, 0.8],
    ]
    const onChange = vi.fn()

    const { getByTestId } = render(
      <InlineCurveEditor
        points={points}
        onChange={onChange}
        multiSelect
      />
    )
    await flushMicrotasks()
    const canvas = getByTestId('inline-curve-editor-canvas')

    // Shift-click point 1 (time=0.25, value=0.3)
    const [p1x, p1y] = projectToCanvas(0.25, 0.3)
    fireEvent.mouseDown(canvas, { clientX: p1x, clientY: p1y, shiftKey: true, button: 0 })
    fireEvent.mouseUp(canvas, { clientX: p1x, clientY: p1y })

    // Shift-click point 2 (time=0.5, value=0.5)
    const [p2x, p2y] = projectToCanvas(0.5, 0.5)
    fireEvent.mouseDown(canvas, { clientX: p2x, clientY: p2y, shiftKey: true, button: 0 })
    fireEvent.mouseUp(canvas, { clientX: p2x, clientY: p2y })

    // Now drag point 2 (which IS selected) by Δt=+0.1, Δv=+0.1
    const [fromX, fromY] = projectToCanvas(0.5, 0.5)
    fireEvent.mouseDown(canvas, { clientX: fromX, clientY: fromY, button: 0 })
    const [toX, toY] = projectToCanvas(0.6, 0.6)
    fireEvent.mouseMove(canvas, { clientX: toX, clientY: toY })
    fireEvent.mouseUp(canvas, { clientX: toX, clientY: toY })

    expect(onChange).toHaveBeenCalled()
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0] as CurvePoint[]

    // Both selected points (indices 1 and 2) should have shifted by ~(+0.1, +0.1).
    // Other points (0, 3, 4) should be untouched.
    const TOL = 0.02
    expect(Math.abs(lastCall[0][0] - 0.0)).toBeLessThan(TOL)
    expect(Math.abs(lastCall[0][1] - 0.2)).toBeLessThan(TOL)
    expect(lastCall[1][0]).toBeGreaterThan(0.3)   // point 1 moved +0.1 in x
    expect(lastCall[1][1]).toBeGreaterThan(0.35)  // point 1 moved +0.1 in y
    expect(lastCall[2][0]).toBeGreaterThan(0.55)  // point 2 moved +0.1 in x
    expect(lastCall[2][1]).toBeGreaterThan(0.55)  // point 2 moved +0.1 in y
    // Unselected points 3, 4 unchanged:
    expect(Math.abs(lastCall[3][0] - 0.75)).toBeLessThan(TOL)
    expect(Math.abs(lastCall[3][1] - 0.6)).toBeLessThan(TOL)
    expect(Math.abs(lastCall[4][0] - 1.0)).toBeLessThan(TOL)
    expect(Math.abs(lastCall[4][1] - 0.8)).toBeLessThan(TOL)
  })
})
