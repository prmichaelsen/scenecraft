import { describe, expect, it } from 'vitest'
import { createAudioMixer } from '../audio-mixer'
import type { AudioTrack } from '../audio-client'

const t = (id: string, clips: Array<{ id: string; start_time: number; end_time: number }> = []): AudioTrack => ({
  id,
  name: id,
  display_order: 0,
  enabled: true,
  hidden: false,
  muted: false,
  volume_curve: [[0, 0], [1, 0]],
  clips: clips.map((c) => ({
    id: c.id,
    track_id: id,
    source_path: `audio_staging/${c.id}.m4a`,
    start_time: c.start_time,
    end_time: c.end_time,
    source_offset: 0,
    volume_curve: [[0, 0], [1, 0]],
    muted: false,
    remap: { method: 'linear', target_duration: 0 },
  })),
})

describe('createAudioMixer', () => {
  it('returns an object with the full public API', () => {
    const m = createAudioMixer('p', [])
    expect(typeof m.play).toBe('function')
    expect(typeof m.pause).toBe('function')
    expect(typeof m.seek).toBe('function')
    expect(typeof m.updateClip).toBe('function')
    expect(typeof m.updateTrack).toBe('function')
    expect(typeof m.rebuild).toBe('function')
    expect(typeof m.dispose).toBe('function')
  })

  it('trackCount reflects input', () => {
    expect(createAudioMixer('p', []).trackCount).toBe(0)
    expect(createAudioMixer('p', [t('a')]).trackCount).toBe(1)
    expect(createAudioMixer('p', [t('a'), t('b')]).trackCount).toBe(2)
  })

  it('all methods are callable without throwing', () => {
    const m = createAudioMixer('p', [t('a', [{ id: 'c1', start_time: 0, end_time: 1 }])])
    expect(() => m.play()).not.toThrow()
    expect(() => m.pause()).not.toThrow()
    expect(() => m.seek(1.5)).not.toThrow()
    expect(() => m.updateClip('c1')).not.toThrow()
    expect(() => m.updateTrack('a')).not.toThrow()
    expect(() => m.rebuild([t('b')])).not.toThrow()
    expect(() => m.dispose()).not.toThrow()
  })

  it('rebuild updates trackCount', () => {
    const m = createAudioMixer('p', [t('a')])
    expect(m.trackCount).toBe(1)
    m.rebuild([t('a'), t('b'), t('c')])
    expect(m.trackCount).toBe(3)
  })

  it('dispose is idempotent and subsequent operations no-op safely', () => {
    const m = createAudioMixer('p', [t('a')])
    m.dispose()
    expect(() => m.dispose()).not.toThrow()
    expect(() => m.play()).not.toThrow()
  })

  it('after dispose, rebuild is a no-op (trackCount stays 0)', () => {
    const m = createAudioMixer('p', [t('a'), t('b')])
    m.dispose()
    m.rebuild([t('a'), t('b'), t('c')])
    expect(m.trackCount).toBe(0)
  })
})
