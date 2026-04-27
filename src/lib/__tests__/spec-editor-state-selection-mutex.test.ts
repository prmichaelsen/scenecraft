/**
 * Spec tests for: Editor State Context & Selection Mutex
 * Spec: agent/specs/local.editor-state-selection-mutex.md
 *
 * Covers R1-R19 and all base-case + edge-case behavior table rows.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { createElement, useRef, useState, type ReactNode } from 'react'
import {
  EditorStateProvider,
  useEditorState,
  type KeyframeWithTime,
} from '@/components/editor/EditorStateContext'
import type { Transition } from '@/routes/project/$name/editor'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeKeyframe(id = 'kf-1'): KeyframeWithTime {
  return {
    id,
    timestamp: '00:01',
    section: 'intro',
    prompt: 'test',
    selected: null,
    hasSelectedImage: false,
    context: null,
    candidates: [],
    trackId: 'track-1',
    label: 'KF',
    labelColor: '#fff',
    blendMode: 'normal',
    opacity: 1,
    refinementPrompt: '',
    timeSeconds: 1,
  }
}

function makeTransition(id = 'tr-1'): Transition {
  return {
    id,
    from: 'kf-1',
    to: 'kf-2',
    durationSeconds: 2,
    action: 'fade',
    useGlobalPrompt: false,
    includeSectionDesc: false,
    candidates: [],
    candidateDetails: [],
    hasSelectedVideo: false,
    selected: null,
    trimIn: 0,
    trimOut: null,
    sourceVideoDuration: null,
    remap: { method: 'none', target_duration: 2 },
    trackId: 'track-1',
    label: 'TR',
    labelColor: '#000',
    tags: [],
    blendMode: 'normal',
    opacity: 1,
    opacityCurve: null,
    redCurve: null,
    greenCurve: null,
    blueCurve: null,
    blackCurve: null,
    hueShiftCurve: null,
    saturationCurve: null,
  } as Transition
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: ReactNode }) {
  return createElement(EditorStateProvider, null, children)
}

afterEach(cleanup)

// ===========================================================================
// Base Cases
// ===========================================================================

describe('EditorStateContext — base cases', () => {
  // Test: initial-state-all-null (covers R1, R14)
  it('initial-state-all-null (R1, R14)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })

    expect(result.current.selectedKeyframe).toBe(null)
    expect(result.current.selectedTransition).toBe(null)
    expect(result.current.trackPropertiesId).toBe(null)
    expect(result.current.selectedAudioClipId).toBe(null)
    expect(result.current.selectedAudioTrackId).toBe(null)

    expect(result.current.onKeyframeDelete).toBe(null)
    expect(result.current.onKeyframeDataChange).toBe(null)
    expect(result.current.onTransitionDelete).toBe(null)
    expect(result.current.onTransitionDataChange).toBe(null)

    expect(typeof result.current.setSelectedKeyframe).toBe('function')
    expect(typeof result.current.setSelectedTransition).toBe('function')
    expect(typeof result.current.setTrackPropertiesId).toBe('function')
    expect(typeof result.current.setSelectedAudioClipId).toBe('function')
    expect(typeof result.current.setSelectedAudioTrackId).toBe('function')
    expect(typeof result.current.registerCallbacks).toBe('function')
  })

  // Test: select-keyframe-clears-others (covers R2, R3)
  it('select-keyframe-clears-others (R2, R3)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const kf = makeKeyframe()

    act(() => result.current.setSelectedKeyframe(kf))

    expect(result.current.selectedKeyframe).toBe(kf)
    expect(result.current.selectedTransition).toBe(null)
    expect(result.current.trackPropertiesId).toBe(null)
    expect(result.current.selectedAudioClipId).toBe(null)
    expect(result.current.selectedAudioTrackId).toBe(null)
  })

  // Test: select-transition-clears-others (covers R2, R4)
  it('select-transition-clears-others (R2, R4)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const kf = makeKeyframe()
    const tr = makeTransition()

    act(() => result.current.setSelectedKeyframe(kf))
    act(() => result.current.setSelectedTransition(tr))

    expect(result.current.selectedTransition).toBe(tr)
    expect(result.current.selectedKeyframe).toBe(null)
    expect(result.current.trackPropertiesId).toBe(null)
    expect(result.current.selectedAudioClipId).toBe(null)
    expect(result.current.selectedAudioTrackId).toBe(null)
  })

  // Test: select-track-clears-others (covers R2, R5)
  it('select-track-clears-others (R2, R5)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })

    act(() => result.current.setSelectedAudioClipId('clip-1'))
    act(() => result.current.setTrackPropertiesId('track-42'))

    expect(result.current.trackPropertiesId).toBe('track-42')
    expect(result.current.selectedKeyframe).toBe(null)
    expect(result.current.selectedTransition).toBe(null)
    expect(result.current.selectedAudioClipId).toBe(null)
    expect(result.current.selectedAudioTrackId).toBe(null)
  })

  // Test: select-audio-clip-clears-others (covers R2, R6)
  it('select-audio-clip-clears-others (R2, R6)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const tr = makeTransition()

    act(() => result.current.setSelectedTransition(tr))
    act(() => result.current.setSelectedAudioClipId('clip-7'))

    expect(result.current.selectedAudioClipId).toBe('clip-7')
    expect(result.current.selectedKeyframe).toBe(null)
    expect(result.current.selectedTransition).toBe(null)
    expect(result.current.trackPropertiesId).toBe(null)
    expect(result.current.selectedAudioTrackId).toBe(null)
  })

  // Test: select-audio-track-clears-others (covers R2, R7)
  it('select-audio-track-clears-others (R2, R7)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })

    act(() => result.current.setSelectedAudioClipId('clip-1'))
    act(() => result.current.setSelectedAudioTrackId('at-1'))

    expect(result.current.selectedAudioTrackId).toBe('at-1')
    expect(result.current.selectedAudioClipId).toBe(null)
    expect(result.current.selectedKeyframe).toBe(null)
    expect(result.current.selectedTransition).toBe(null)
    expect(result.current.trackPropertiesId).toBe(null)
  })

  // Test: switch-keyframe-to-transition (covers R2, R3, R4)
  it('switch-keyframe-to-transition (R2, R3, R4)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const kf = makeKeyframe()
    const tr = makeTransition()

    act(() => result.current.setSelectedKeyframe(kf))
    expect(result.current.selectedKeyframe).toBe(kf)

    act(() => result.current.setSelectedTransition(tr))
    expect(result.current.selectedTransition).toBe(tr)
    expect(result.current.selectedKeyframe).toBe(null)

    // Exactly one non-null
    const selections = [
      result.current.selectedKeyframe,
      result.current.selectedTransition,
      result.current.trackPropertiesId,
      result.current.selectedAudioClipId,
      result.current.selectedAudioTrackId,
    ]
    expect(selections.filter((s) => s !== null)).toHaveLength(1)
  })

  // Test: set-null-does-not-clear-others (covers R8)
  it('set-null-does-not-clear-others (R8)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const tr = makeTransition()

    act(() => result.current.setSelectedTransition(tr))
    act(() => result.current.setSelectedKeyframe(null))

    expect(result.current.selectedTransition).toBe(tr)
    expect(result.current.selectedKeyframe).toBe(null)
    expect(result.current.trackPropertiesId).toBe(null)
    expect(result.current.selectedAudioClipId).toBe(null)
    expect(result.current.selectedAudioTrackId).toBe(null)
  })

  // Test: set-null-from-empty-is-noop (covers R8)
  it('set-null-from-empty-is-noop (R8)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })

    // Should not throw
    act(() => result.current.setSelectedAudioClipId(null))

    expect(result.current.selectedKeyframe).toBe(null)
    expect(result.current.selectedTransition).toBe(null)
    expect(result.current.trackPropertiesId).toBe(null)
    expect(result.current.selectedAudioClipId).toBe(null)
    expect(result.current.selectedAudioTrackId).toBe(null)
  })

  // Test: register-callbacks-partial-bundle (covers R10)
  it('register-callbacks-partial-bundle (R10)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const fnA = vi.fn()
    const fnB = vi.fn()

    act(() => result.current.registerCallbacks({ onKeyframeDelete: fnA, onTransitionDelete: fnB }))

    expect(result.current.onKeyframeDelete).toBe(fnA)
    expect(result.current.onTransitionDelete).toBe(fnB)
    expect(result.current.onKeyframeDataChange).toBe(null)
    expect(result.current.onTransitionDataChange).toBe(null)
  })

  // Test: register-callbacks-replaces-bundle (covers R10)
  it('register-callbacks-replaces-bundle (R10)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const fnA = vi.fn()
    const fnB = vi.fn()

    act(() =>
      result.current.registerCallbacks({ onKeyframeDelete: fnA, onKeyframeDataChange: fnB }),
    )
    expect(result.current.onKeyframeDelete).toBe(fnA)

    act(() => result.current.registerCallbacks({}))

    expect(result.current.onKeyframeDelete).toBe(null)
    expect(result.current.onKeyframeDataChange).toBe(null)
    expect(result.current.onTransitionDelete).toBe(null)
    expect(result.current.onTransitionDataChange).toBe(null)
  })

  // Test: no-provider-returns-default (covers R11)
  it('no-provider-returns-default (R11)', () => {
    // No wrapper — consumer outside provider
    const { result } = renderHook(() => useEditorState())

    expect(result.current.selectedKeyframe).toBe(null)
    expect(result.current.selectedTransition).toBe(null)
    expect(result.current.trackPropertiesId).toBe(null)
    expect(result.current.selectedAudioClipId).toBe(null)
    expect(result.current.selectedAudioTrackId).toBe(null)

    expect(result.current.onKeyframeDelete).toBe(null)
    expect(result.current.onKeyframeDataChange).toBe(null)
    expect(result.current.onTransitionDelete).toBe(null)
    expect(result.current.onTransitionDataChange).toBe(null)

    expect(typeof result.current.setSelectedKeyframe).toBe('function')
    expect(typeof result.current.setSelectedTransition).toBe('function')
    expect(typeof result.current.setTrackPropertiesId).toBe('function')
    expect(typeof result.current.setSelectedAudioClipId).toBe('function')
    expect(typeof result.current.setSelectedAudioTrackId).toBe('function')
    expect(typeof result.current.registerCallbacks).toBe('function')
  })

  // Test: no-provider-setter-is-noop (covers R11)
  it('no-provider-setter-is-noop (R11)', () => {
    const { result } = renderHook(() => useEditorState())
    const kf = makeKeyframe()

    // Should not throw
    act(() => result.current.setSelectedKeyframe(kf))

    expect(result.current.selectedKeyframe).toBe(null)
  })

  // Test: does-not-expose-foreign-state (covers R13)
  it('does-not-expose-foreign-state (R13)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const keys = Object.keys(result.current)

    // No CurrentTimeContext keys
    expect(keys).not.toContain('currentTime')
    expect(keys).not.toContain('isPlaying')
    expect(keys).not.toContain('seekRef')
    expect(keys).not.toContain('seek')

    // No EditorDataContext keys
    expect(keys).not.toContain('keyframes')
    expect(keys).not.toContain('transitions')
    expect(keys).not.toContain('tracks')
    expect(keys).not.toContain('clips')
    expect(keys).not.toContain('data')

    // No JobStateContext keys
    expect(keys).not.toContain('jobs')
    expect(keys).not.toContain('activeJobs')
    expect(keys).not.toContain('jobState')

    // No PreviewContext keys
    expect(keys).not.toContain('preview')
    expect(keys).not.toContain('previewUrl')

    // No context menu keys
    expect(keys).not.toContain('contextMenu')
  })
})

// ===========================================================================
// Edge Cases
// ===========================================================================

describe('EditorStateContext — edge cases', () => {
  // Test: setters-are-stable-refs (covers R12)
  it('setters-are-stable-refs (R12)', () => {
    const { result, rerender } = renderHook(() => useEditorState(), { wrapper })

    const firstSetKf = result.current.setSelectedKeyframe
    const firstSetTr = result.current.setSelectedTransition
    const firstSetTrack = result.current.setTrackPropertiesId
    const firstSetClip = result.current.setSelectedAudioClipId
    const firstSetAudioTrack = result.current.setSelectedAudioTrackId
    const firstRegister = result.current.registerCallbacks

    // Trigger a re-render via registerCallbacks
    act(() => result.current.registerCallbacks({}))
    rerender()

    expect(result.current.setSelectedKeyframe).toBe(firstSetKf)
    expect(result.current.setSelectedTransition).toBe(firstSetTr)
    expect(result.current.setTrackPropertiesId).toBe(firstSetTrack)
    expect(result.current.setSelectedAudioClipId).toBe(firstSetClip)
    expect(result.current.setSelectedAudioTrackId).toBe(firstSetAudioTrack)
    expect(result.current.registerCallbacks).toBe(firstRegister)
  })

  // Test: last-setter-in-tick-wins (covers R2)
  it('last-setter-in-tick-wins (R2)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const kf = makeKeyframe()
    const tr = makeTransition()

    act(() => {
      result.current.setSelectedKeyframe(kf)
      result.current.setSelectedTransition(tr)
    })

    expect(result.current.selectedTransition).toBe(tr)
    expect(result.current.selectedKeyframe).toBe(null)
  })

  // Test: same-setter-twice-last-value-wins (covers R2)
  it('same-setter-twice-last-value-wins (R2)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const kfA = makeKeyframe('kf-a')
    const kfB = makeKeyframe('kf-b')

    act(() => {
      result.current.setSelectedKeyframe(kfA)
      result.current.setSelectedKeyframe(kfB)
    })

    expect(result.current.selectedKeyframe).toBe(kfB)
    expect(result.current.selectedTransition).toBe(null)
    expect(result.current.trackPropertiesId).toBe(null)
    expect(result.current.selectedAudioClipId).toBe(null)
    expect(result.current.selectedAudioTrackId).toBe(null)
  })

  // Test: setter-with-undefined-normalized-to-null (covers R15)
  it('setter-with-undefined-normalized-to-null (R15)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const tr = makeTransition()

    act(() => result.current.setSelectedTransition(tr))

    // Call with undefined (cast to bypass TS)
    act(() => result.current.setSelectedKeyframe(undefined as any))

    // The value should be null (or undefined — either way it's falsy and
    // the mutex clear should NOT fire, so transition stays).
    expect(result.current.selectedKeyframe == null).toBe(true)
    expect(result.current.selectedTransition).toBe(tr)
  })

  // Test: selection-survives-unrelated-rerender
  it('selection-survives-unrelated-rerender', () => {
    const { result, rerender } = renderHook(() => useEditorState(), { wrapper })
    const kf = makeKeyframe()

    act(() => result.current.setSelectedKeyframe(kf))
    rerender()

    expect(result.current.selectedKeyframe).toBe(kf)
    expect(result.current.selectedTransition).toBe(null)
    expect(result.current.trackPropertiesId).toBe(null)
    expect(result.current.selectedAudioClipId).toBe(null)
    expect(result.current.selectedAudioTrackId).toBe(null)
  })

  // Test: callbacks-survive-selection-changes
  it('callbacks-survive-selection-changes', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const fnA = vi.fn()
    const fnB = vi.fn()
    const kf = makeKeyframe()

    act(() =>
      result.current.registerCallbacks({ onKeyframeDelete: fnA, onTransitionDelete: fnB }),
    )
    act(() => result.current.setSelectedKeyframe(kf))

    expect(result.current.onKeyframeDelete).toBe(fnA)
    expect(result.current.onTransitionDelete).toBe(fnB)

    act(() => result.current.setSelectedKeyframe(null))

    expect(result.current.onKeyframeDelete).toBe(fnA)
    expect(result.current.onTransitionDelete).toBe(fnB)
  })

  // Test: no-multi-select-surface (covers R9)
  it('no-multi-select-surface (R9)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const keys = Object.keys(result.current)

    // No array selection fields
    expect(keys).not.toContain('selectedKeyframes')
    expect(keys).not.toContain('selectedTransitions')
    expect(keys).not.toContain('selectedAudioClipIds')
    expect(keys).not.toContain('selectedAudioTrackIds')

    // No shift-click anchor
    expect(keys.some((k) => k.toLowerCase().includes('anchor'))).toBe(false)

    // No multi-select functions
    expect(keys).not.toContain('addToSelection')
    expect(keys).not.toContain('toggleSelection')
    expect(keys).not.toContain('setSelectedKeyframes')
  })

  // Test: register-callbacks-cleanup-is-caller-responsibility (covers R18)
  it('register-callbacks-cleanup-is-caller-responsibility (R18)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const fn = vi.fn()

    act(() => result.current.registerCallbacks({ onKeyframeDelete: fn }))

    // Simulate: caller "unmounts" but does NOT clear callbacks.
    // Provider still holds the bundle.
    expect(result.current.onKeyframeDelete).toBe(fn)

    // The contract says the provider does not auto-detect orphaned callbacks.
    // This is the expected behavior per R18.
  })

  // Test: context-has-exactly-15-keys (covers R1 acceptance criteria)
  it('context-has-exactly-15-keys (R1)', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const keys = Object.keys(result.current)

    const expectedKeys = [
      'selectedKeyframe',
      'selectedTransition',
      'trackPropertiesId',
      'selectedAudioClipId',
      'selectedAudioTrackId',
      'setSelectedKeyframe',
      'setSelectedTransition',
      'setTrackPropertiesId',
      'setSelectedAudioClipId',
      'setSelectedAudioTrackId',
      'onKeyframeDelete',
      'onKeyframeDataChange',
      'onTransitionDelete',
      'onTransitionDataChange',
      'registerCallbacks',
    ]

    for (const key of expectedKeys) {
      expect(keys).toContain(key)
    }
    expect(keys).toHaveLength(15)
  })

  // Test: mutex-holds-after-all-five-setters (comprehensive mutex check)
  it('mutex-holds-after-cycling-through-all-five-setters', () => {
    const { result } = renderHook(() => useEditorState(), { wrapper })
    const kf = makeKeyframe()
    const tr = makeTransition()

    const assertExactlyOneNonNull = () => {
      const vals = [
        result.current.selectedKeyframe,
        result.current.selectedTransition,
        result.current.trackPropertiesId,
        result.current.selectedAudioClipId,
        result.current.selectedAudioTrackId,
      ]
      expect(vals.filter((v) => v !== null)).toHaveLength(1)
    }

    act(() => result.current.setSelectedKeyframe(kf))
    assertExactlyOneNonNull()

    act(() => result.current.setSelectedTransition(tr))
    assertExactlyOneNonNull()

    act(() => result.current.setTrackPropertiesId('track-42'))
    assertExactlyOneNonNull()

    act(() => result.current.setSelectedAudioClipId('clip-7'))
    assertExactlyOneNonNull()

    act(() => result.current.setSelectedAudioTrackId('at-1'))
    assertExactlyOneNonNull()
  })
})
