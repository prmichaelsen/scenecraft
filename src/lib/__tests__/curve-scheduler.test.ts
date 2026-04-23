import { describe, it, expect, vi } from 'vitest'
import {
  normalizedToNative,
  scheduleCurve,
  rescheduleFromSeek,
  scheduleCurveBatch,
  BezierSampler,
  sampleCurveAt,
  type AudioParamLike,
  type AudioContextLike,
  type CurvePoint,
  type EffectCurveLite,
} from '../curve-scheduler'
import type { EffectParamSpec } from '../audio-effect-types'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type Spy<F extends (...args: never[]) => unknown> = ReturnType<typeof vi.fn<F>>

interface MockParam extends AudioParamLike {
  setValueAtTime: Spy<(value: number, startTime: number) => unknown>
  linearRampToValueAtTime: Spy<(value: number, endTime: number) => unknown>
  setValueCurveAtTime: Spy<
    (values: Float32Array, startTime: number, duration: number) => unknown
  >
  cancelScheduledValues: Spy<(cancelTime: number) => unknown>
}

const makeMockParam = (): MockParam => ({
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  setValueCurveAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
})

const makeCtx = (currentTime = 0): AudioContextLike => ({ currentTime })

const linearSpec: EffectParamSpec = {
  name: 'x',
  label: 'X',
  animatable: true,
  range: { min: 0, max: 1 },
  scale: 'linear',
  default: 0,
}

const dbSpec: EffectParamSpec = {
  name: 'threshold',
  label: 'Threshold',
  animatable: true,
  range: { min: -60, max: 12 },
  scale: 'db',
  default: 0,
}

const hzSpec: EffectParamSpec = {
  name: 'freq',
  label: 'Frequency',
  animatable: true,
  range: { min: 20, max: 20000 },
  scale: 'hz',
  default: 1000,
}

const logSpec: EffectParamSpec = {
  name: 'rate',
  label: 'Rate',
  animatable: true,
  range: { min: 0.1, max: 10 },
  scale: 'log',
  default: 1,
}

// ---------------------------------------------------------------------------
// normalizedToNative
// ---------------------------------------------------------------------------

describe('normalizedToNative', () => {
  it('linear: 0.5 is the midpoint of [min, max]', () => {
    expect(normalizedToNative(0.5, 'linear', { min: 0, max: 100 })).toBe(50)
    expect(normalizedToNative(0, 'linear', { min: 0, max: 100 })).toBe(0)
    expect(normalizedToNative(1, 'linear', { min: 0, max: 100 })).toBe(100)
  })

  it('linear: supports negative ranges', () => {
    expect(normalizedToNative(0.5, 'linear', { min: -1, max: 1 })).toBe(0)
    expect(normalizedToNative(0.25, 'linear', { min: -1, max: 1 })).toBe(-0.5)
  })

  it('db: -60..+12 @ 0.5 maps linearly in dB space (matches spec R17)', () => {
    // (min + max) / 2 = (-60 + 12) / 2 = -24
    expect(normalizedToNative(0.5, 'db', { min: -60, max: 12 })).toBe(-24)
  })

  it('hz: 20..20000 @ 0.5 maps geometrically → ~632 Hz (geo-mean)', () => {
    // sqrt(20 * 20000) ≈ 632.4555
    const v = normalizedToNative(0.5, 'hz', { min: 20, max: 20000 })
    expect(v).toBeCloseTo(632.4555, 1)
  })

  it('hz: endpoints exact', () => {
    expect(normalizedToNative(0, 'hz', { min: 20, max: 20000 })).toBeCloseTo(20, 5)
    expect(normalizedToNative(1, 'hz', { min: 20, max: 20000 })).toBeCloseTo(20000, 5)
  })

  it('log: behaves geometrically', () => {
    const v = normalizedToNative(0.5, 'log', { min: 1, max: 100 })
    // sqrt(1 * 100) = 10
    expect(v).toBeCloseTo(10, 4)
  })

  it('clamps out-of-range inputs to [0, 1]', () => {
    expect(normalizedToNative(-0.5, 'linear', { min: 0, max: 10 })).toBe(0)
    expect(normalizedToNative(1.5, 'linear', { min: 0, max: 10 })).toBe(10)
  })

  it('falls back to linear when log/hz range has non-positive min', () => {
    expect(normalizedToNative(0.5, 'log', { min: 0, max: 10 })).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// scheduleCurve — interpolation-mode-schedules-correct-audioparam-call (R19)
// ---------------------------------------------------------------------------

describe('scheduleCurve', () => {
  const twoPointCurve: CurvePoint[] = [
    { time: 0, value: 0 },
    { time: 1, value: 1 },
  ]

  it('always cancels scheduled values first (R16)', () => {
    const p = makeMockParam()
    scheduleCurve(
      p,
      { points: twoPointCurve, interpolation: 'linear' },
      linearSpec,
      0,
      1,
    )
    expect(p.cancelScheduledValues).toHaveBeenCalledWith(0)
  })

  it('bezier → setValueCurveAtTime once with a Float32Array (R19)', () => {
    const p = makeMockParam()
    scheduleCurve(
      p,
      { points: twoPointCurve, interpolation: 'bezier' },
      linearSpec,
      0,
      1,
    )
    expect(p.setValueCurveAtTime).toHaveBeenCalledTimes(1)
    const [arr, startTime, duration] = p.setValueCurveAtTime.mock.calls[0]
    expect(arr).toBeInstanceOf(Float32Array)
    expect(arr.length).toBeGreaterThanOrEqual(2)
    expect(startTime).toBe(0)
    expect(duration).toBe(1)
    // No linear ramps or step writes for bezier.
    expect(p.linearRampToValueAtTime).not.toHaveBeenCalled()
    expect(p.setValueAtTime).not.toHaveBeenCalled()
  })

  it('linear → setValueAtTime(first) + linearRampToValueAtTime per point (R19)', () => {
    const p = makeMockParam()
    scheduleCurve(
      p,
      { points: twoPointCurve, interpolation: 'linear' },
      linearSpec,
      10,
      1,
    )
    expect(p.setValueAtTime).toHaveBeenCalledTimes(1)
    expect(p.setValueAtTime).toHaveBeenCalledWith(0, 10) // startTime + first.time(=0)
    expect(p.linearRampToValueAtTime).toHaveBeenCalledTimes(1)
    expect(p.linearRampToValueAtTime).toHaveBeenCalledWith(1, 11) // startTime + 1
    expect(p.setValueCurveAtTime).not.toHaveBeenCalled()
  })

  it('step → setValueAtTime at each point, no ramps (R19)', () => {
    const p = makeMockParam()
    const pts: CurvePoint[] = [
      { time: 0, value: 0 },
      { time: 0.5, value: 0.5 },
      { time: 1, value: 1 },
    ]
    scheduleCurve(p, { points: pts, interpolation: 'step' }, linearSpec, 5, 1)
    expect(p.setValueAtTime).toHaveBeenCalledTimes(3)
    expect(p.setValueAtTime).toHaveBeenNthCalledWith(1, 0, 5)
    expect(p.setValueAtTime).toHaveBeenNthCalledWith(2, 0.5, 5.5)
    expect(p.setValueAtTime).toHaveBeenNthCalledWith(3, 1, 6)
    expect(p.linearRampToValueAtTime).not.toHaveBeenCalled()
    expect(p.setValueCurveAtTime).not.toHaveBeenCalled()
  })

  it('converts normalized values to native units before scheduling (R17)', () => {
    const p = makeMockParam()
    // dB scale, range [-60, 12], value 0.5 → -24 dB
    scheduleCurve(
      p,
      {
        points: [{ time: 0, value: 0 }, { time: 1, value: 0.5 }],
        interpolation: 'linear',
      },
      dbSpec,
      0,
      1,
    )
    expect(p.setValueAtTime).toHaveBeenCalledWith(-60, 0) // first
    expect(p.linearRampToValueAtTime).toHaveBeenCalledWith(-24, 1)
  })

  it('empty curve: cancels but does not schedule anything', () => {
    const p = makeMockParam()
    scheduleCurve(
      p,
      { points: [], interpolation: 'linear' },
      linearSpec,
      0,
      1,
    )
    expect(p.cancelScheduledValues).toHaveBeenCalledTimes(1)
    expect(p.setValueAtTime).not.toHaveBeenCalled()
    expect(p.linearRampToValueAtTime).not.toHaveBeenCalled()
    expect(p.setValueCurveAtTime).not.toHaveBeenCalled()
  })

  it('bezier densely samples hz scale into Float32Array in native Hz', () => {
    const p = makeMockParam()
    scheduleCurve(
      p,
      {
        points: [{ time: 0, value: 0 }, { time: 1, value: 1 }],
        interpolation: 'bezier',
      },
      hzSpec,
      0,
      1,
    )
    const [arr] = p.setValueCurveAtTime.mock.calls[0]
    const first = (arr as Float32Array)[0]
    const last = (arr as Float32Array)[(arr as Float32Array).length - 1]
    expect(first).toBeCloseTo(20, 1)
    expect(last).toBeCloseTo(20000, 0)
  })

  it('unsorted points are sorted before scheduling', () => {
    const p = makeMockParam()
    scheduleCurve(
      p,
      {
        points: [{ time: 1, value: 1 }, { time: 0, value: 0 }],
        interpolation: 'linear',
      },
      linearSpec,
      0,
      1,
    )
    // First schedule call targets first.time (0), value 0.
    expect(p.setValueAtTime).toHaveBeenCalledWith(0, 0)
    expect(p.linearRampToValueAtTime).toHaveBeenCalledWith(1, 1)
  })
})

// ---------------------------------------------------------------------------
// rescheduleFromSeek — seek-during-curve-playback-reschedules (R18)
// ---------------------------------------------------------------------------

describe('rescheduleFromSeek', () => {
  const longCurve: EffectCurveLite = {
    points: [
      { time: 0, value: 0 },
      { time: 2, value: 0.2 },
      { time: 5, value: 0.5 },
      { time: 8, value: 0.8 },
      { time: 10, value: 1 },
    ],
    interpolation: 'linear',
  }

  it('cancels existing schedule (R18)', () => {
    const p = makeMockParam()
    rescheduleFromSeek(p, longCurve, linearSpec, 5, makeCtx(0))
    expect(p.cancelScheduledValues).toHaveBeenCalledWith(0)
  })

  it('excludes points where time < seek (R18)', () => {
    const p = makeMockParam()
    // Seek to 5.0 → points at time 0, 2 should be dropped; 5, 8, 10 remain.
    rescheduleFromSeek(p, longCurve, linearSpec, 5, makeCtx(100))
    // Anchor at ctxStart=100 with evaluated value at seek=5 → 0.5.
    expect(p.setValueAtTime).toHaveBeenCalledWith(0.5, 100)
    // Ramps to the two remaining future points (p=5 is anchored; p=8, p=10 ramp).
    const rampCalls = p.linearRampToValueAtTime.mock.calls
    expect(rampCalls.length).toBe(2)
    expect(rampCalls[0]).toEqual([0.8, 103]) // ctxStart + (8 - 5)
    expect(rampCalls[1]).toEqual([1, 105]) // ctxStart + (10 - 5)
  })

  it('mid-segment seek: anchor value is interpolated at seek time', () => {
    const p = makeMockParam()
    // Seek to 6.5 (between points at t=5 value=0.5 and t=8 value=0.8).
    // Linear interp at 6.5: 0.5 + ((6.5-5)/(8-5)) * (0.8-0.5) = 0.5 + 0.5*0.3 = 0.65
    rescheduleFromSeek(p, longCurve, linearSpec, 6.5, makeCtx(0))
    const anchorCall = p.setValueAtTime.mock.calls[0]
    expect(anchorCall[0]).toBeCloseTo(0.65, 5)
    expect(anchorCall[1]).toBe(0) // ctxStart
    // Only future points at t=8, t=10 remain to ramp to.
    expect(p.linearRampToValueAtTime).toHaveBeenCalledTimes(2)
    expect(p.linearRampToValueAtTime).toHaveBeenNthCalledWith(1, 0.8, 1.5)
    expect(p.linearRampToValueAtTime).toHaveBeenNthCalledWith(2, 1, 3.5)
  })

  it('seek past the last point: anchors at last value, no further schedule', () => {
    const p = makeMockParam()
    rescheduleFromSeek(p, longCurve, linearSpec, 999, makeCtx(0))
    expect(p.setValueAtTime).toHaveBeenCalledWith(1, 0) // clamped to last
    expect(p.linearRampToValueAtTime).not.toHaveBeenCalled()
    expect(p.setValueCurveAtTime).not.toHaveBeenCalled()
  })

  it('empty curve: cancels and does not schedule anything', () => {
    const p = makeMockParam()
    rescheduleFromSeek(
      p,
      { points: [], interpolation: 'linear' },
      linearSpec,
      5,
      makeCtx(0),
    )
    expect(p.cancelScheduledValues).toHaveBeenCalledTimes(1)
    expect(p.setValueAtTime).not.toHaveBeenCalled()
    expect(p.linearRampToValueAtTime).not.toHaveBeenCalled()
    expect(p.setValueCurveAtTime).not.toHaveBeenCalled()
  })

  it('step interpolation: only future points scheduled with setValueAtTime', () => {
    const p = makeMockParam()
    const curve: EffectCurveLite = {
      points: [
        { time: 0, value: 0 },
        { time: 3, value: 0.3 },
        { time: 7, value: 0.7 },
      ],
      interpolation: 'step',
    }
    rescheduleFromSeek(p, curve, linearSpec, 4, makeCtx(10))
    // Anchor at seek (step eval = value of nearest-left point = 0.3) @ ctxStart=10
    expect(p.setValueAtTime).toHaveBeenNthCalledWith(1, 0.3, 10)
    // Only t=7 is future.
    expect(p.setValueAtTime).toHaveBeenNthCalledWith(2, 0.7, 13)
    expect(p.linearRampToValueAtTime).not.toHaveBeenCalled()
  })

  it('bezier interpolation: schedules dense Float32Array from seek to last', () => {
    const p = makeMockParam()
    const curve: EffectCurveLite = {
      points: [
        { time: 0, value: 0 },
        { time: 5, value: 0.5 },
        { time: 10, value: 1 },
      ],
      interpolation: 'bezier',
    }
    rescheduleFromSeek(p, curve, linearSpec, 3, makeCtx(20))
    // Anchor call first.
    expect(p.setValueAtTime).toHaveBeenCalledTimes(1)
    // Then a dense curve from ctxStart=20 covering duration=10-3=7.
    expect(p.setValueCurveAtTime).toHaveBeenCalledTimes(1)
    const [arr, startTime, duration] = p.setValueCurveAtTime.mock.calls[0]
    expect(arr).toBeInstanceOf(Float32Array)
    expect(startTime).toBe(20)
    expect(duration).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// BezierSampler
// ---------------------------------------------------------------------------

describe('BezierSampler', () => {
  it('produces a Float32Array of at least 2 samples', () => {
    const arr = BezierSampler.sample(
      [{ time: 0, value: 0 }, { time: 1, value: 1 }],
      0,
      1,
      linearSpec,
    )
    expect(arr).toBeInstanceOf(Float32Array)
    expect(arr.length).toBeGreaterThanOrEqual(2)
  })

  it('endpoint samples match endpoint values (native units)', () => {
    const arr = BezierSampler.sample(
      [{ time: 0, value: 0 }, { time: 1, value: 1 }],
      0,
      1,
      { ...linearSpec, range: { min: 10, max: 110 } },
    )
    expect(arr[0]).toBeCloseTo(10, 3)
    expect(arr[arr.length - 1]).toBeCloseTo(110, 3)
  })

  it('empty points returns zero-filled array', () => {
    const arr = BezierSampler.sample([], 0, 1, linearSpec)
    expect(arr.every((v) => v === 0)).toBe(true)
  })

  it('respects custom sampleRate', () => {
    const arr = BezierSampler.sample(
      [{ time: 0, value: 0 }, { time: 2, value: 1 }],
      0,
      2,
      linearSpec,
      50,
    )
    // 50 Hz * 2s = 100 samples.
    expect(arr.length).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// sampleCurveAt
// ---------------------------------------------------------------------------

describe('sampleCurveAt', () => {
  const pts: CurvePoint[] = [
    { time: 0, value: 0 },
    { time: 1, value: 1 },
  ]

  it('linear midpoint = 0.5', () => {
    expect(sampleCurveAt(pts, 'linear', 0.5)).toBeCloseTo(0.5, 5)
  })

  it('step midpoint returns left-point value', () => {
    expect(sampleCurveAt(pts, 'step', 0.999)).toBe(0)
  })

  it('bezier midpoint is 0.5 (smoothstep symmetric at u=0.5)', () => {
    expect(sampleCurveAt(pts, 'bezier', 0.5)).toBeCloseTo(0.5, 5)
  })

  it('clamps below range', () => {
    expect(sampleCurveAt(pts, 'linear', -1)).toBe(0)
  })

  it('clamps above range', () => {
    expect(sampleCurveAt(pts, 'linear', 5)).toBe(1)
  })

  it('single-point curve behaves as a constant', () => {
    expect(sampleCurveAt([{ time: 3, value: 0.42 }], 'linear', 0)).toBe(0.42)
    expect(sampleCurveAt([{ time: 3, value: 0.42 }], 'linear', 100)).toBe(0.42)
  })

  it('empty curve returns 0', () => {
    expect(sampleCurveAt([], 'linear', 0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// scheduleCurveBatch
// ---------------------------------------------------------------------------

describe('scheduleCurveBatch', () => {
  it('schedules every target with the given startTime/duration', () => {
    const p1 = makeMockParam()
    const p2 = makeMockParam()
    const curve: EffectCurveLite = {
      points: [{ time: 0, value: 0 }, { time: 1, value: 1 }],
      interpolation: 'step',
    }
    scheduleCurveBatch(
      [
        { param: p1, curve, spec: linearSpec },
        { param: p2, curve, spec: logSpec },
      ],
      2,
      1,
    )
    expect(p1.setValueAtTime).toHaveBeenCalledTimes(2)
    expect(p2.setValueAtTime).toHaveBeenCalledTimes(2)
    expect(p1.cancelScheduledValues).toHaveBeenCalled()
    expect(p2.cancelScheduledValues).toHaveBeenCalled()
  })
})
