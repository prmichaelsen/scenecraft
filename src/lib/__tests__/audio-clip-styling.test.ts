/**
 * Tests for getClipColorClass — the variant_kind → tailwind-class map.
 * The color lives off pool_segments.variant_kind (server-owned data);
 * asserting the mapping here lets us regress it without needing a full
 * clip render, and it keeps the M13 'lipsync' slot honest once that
 * milestone actually sets variant_kind on its generated clips.
 */

import { describe, it, expect } from 'vitest'

import {
  DEFAULT_CLIP_COLOR,
  VARIANT_KIND_COLORS,
  getClipColorClass,
} from '../audio-clip-styling'

describe('getClipColorClass', () => {
  it('maps music to purple', () => {
    expect(getClipColorClass('music')).toBe(VARIANT_KIND_COLORS.music)
    expect(getClipColorClass('music')).toContain('purple')
  })

  it('maps lipsync to teal (M13 reserved slot)', () => {
    expect(getClipColorClass('lipsync')).toBe(VARIANT_KIND_COLORS.lipsync)
    expect(getClipColorClass('lipsync')).toContain('teal')
  })

  it('falls back to default for unknown variant', () => {
    expect(getClipColorClass('unknown_future_kind')).toBe(DEFAULT_CLIP_COLOR)
  })

  it('falls back to default when variant is null', () => {
    expect(getClipColorClass(null)).toBe(DEFAULT_CLIP_COLOR)
  })

  it('falls back to default when variant is undefined', () => {
    expect(getClipColorClass(undefined)).toBe(DEFAULT_CLIP_COLOR)
  })
})
