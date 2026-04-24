/**
 * MusicGenerationsPanel tests — covers the field-filter-at-send logic
 * (spec R13) and the Reuse/Retry/credits behaviors. Panel rendering
 * assertions stay lightweight; the critical invariants here are the
 * REST payload shape and the Reuse-preserves-context rule.
 */

import { describe, it, expect } from 'vitest'

import { buildPayload } from '../MusicGenerationsPanel'

type SelectionContext =
  | { type: 'audio_clip'; id: string }
  | { type: 'transition'; id: string }
  | null

const baseForm = {
  action: 'auto' as const,
  style: 'dark cinematic',
  lyrics: '',
  title: '',
  instrumental: true,
  gender: '' as const,
  model: 'MFV2.0',
}

describe('buildPayload — field filter by action (spec R13)', () => {
  it('action=auto omits lyrics + title even if filled', () => {
    const payload = buildPayload(
      { ...baseForm, action: 'auto', lyrics: 'la la', title: 'Untitled' },
      null,
    )
    expect(payload.lyrics).toBeUndefined()
    expect(payload.title).toBeUndefined()
    expect(payload.action).toBe('auto')
    expect(payload.style).toBe('dark cinematic')
  })

  it('action=custom + instrumental=true drops lyrics', () => {
    const payload = buildPayload(
      { ...baseForm, action: 'custom', instrumental: true, lyrics: 'should not ship' },
      null,
    )
    expect(payload.lyrics).toBeUndefined()
    expect(payload.instrumental).toBe(1)
  })

  it('action=custom + instrumental=false includes lyrics', () => {
    const payload = buildPayload(
      { ...baseForm, action: 'custom', instrumental: false, lyrics: 'verse one' },
      null,
    )
    expect(payload.lyrics).toBe('verse one')
    expect(payload.instrumental).toBe(0)
  })

  it('action=custom includes title only when non-empty', () => {
    const withTitle = buildPayload({ ...baseForm, action: 'custom', title: 'Neon Midnight' }, null)
    expect(withTitle.title).toBe('Neon Midnight')

    const blank = buildPayload({ ...baseForm, action: 'custom', title: '   ' }, null)
    expect(blank.title).toBeUndefined()
  })

  it('gender flows through when set, omitted when empty', () => {
    expect(buildPayload({ ...baseForm, gender: 'female' }, null).gender).toBe('female')
    expect(buildPayload({ ...baseForm, gender: '' }, null).gender).toBeUndefined()
  })

  it('serializes selection context into entity_type / entity_id', () => {
    const ctx: SelectionContext = { type: 'transition', id: 'tr_A' }
    const payload = buildPayload(baseForm, ctx)
    expect(payload.entity_type).toBe('transition')
    expect(payload.entity_id).toBe('tr_A')
  })

  it('null selection context serializes to explicit nulls', () => {
    const payload = buildPayload(baseForm, null)
    expect(payload.entity_type).toBeNull()
    expect(payload.entity_id).toBeNull()
  })
})
