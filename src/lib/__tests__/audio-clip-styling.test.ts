/**
 * Tests for getClipColors — the variant_kind → tailwind-class map.
 * The color lives off pool_segments.variant_kind (server-owned data);
 * asserting the mapping here lets us regress it without needing a full
 * clip render, and it keeps the M13 'lipsync' slot honest once that
 * milestone actually sets variant_kind on its generated clips.
 */

import { describe, it, expect } from 'vitest'

import { getClipColors } from '../audio-clip-styling'

describe('getClipColors', () => {
  it('maps music to purple', () => {
    const c = getClipColors('music')
    expect(c.bg).toContain('purple')
    expect(c.borderDefault).toContain('purple')
    expect(c.borderSelected).toContain('purple')
  })

  it('maps lipsync to teal (M13 reserved slot)', () => {
    const c = getClipColors('lipsync')
    expect(c.bg).toContain('teal')
    expect(c.borderDefault).toContain('teal')
  })

  it('falls back to cyan for unknown variant', () => {
    const c = getClipColors('unknown_future_kind')
    expect(c.bg).toContain('cyan')
  })

  it('falls back to cyan when variant is null', () => {
    const c = getClipColors(null)
    expect(c.bg).toContain('cyan')
  })

  it('falls back to cyan when variant is undefined', () => {
    const c = getClipColors(undefined)
    expect(c.bg).toContain('cyan')
  })
})
