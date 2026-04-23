import { describe, it, expect } from 'vitest'
import {
  SPECTRUM_BANDS,
  INSTRUMENT_PRESETS,
  formatHz,
  labelForFreq,
} from '../frequency-labels'

describe('SPECTRUM_BANDS', () => {
  it('has exactly 8 entries per spec R48', () => {
    expect(SPECTRUM_BANDS).toHaveLength(8)
  })

  it('includes every spec-mandated spectrum label', () => {
    const labels = SPECTRUM_BANDS.map(b => b.label)
    const expected = [
      'sub bass', 'bass', 'low-mids / mud', 'mids',
      'presence', 'attack / upper-mids', 'sibilance', 'air',
    ]
    expect(labels).toEqual(expected)
  })

  it('each value is the geometric mean of its range (within 1 Hz)', () => {
    for (const band of SPECTRUM_BANDS) {
      expect(band.hzRange).toBeDefined()
      const [min, max] = band.hzRange!
      const gmean = Math.sqrt(min * max)
      expect(Math.abs(band.value - gmean)).toBeLessThanOrEqual(1)
    }
  })
})

describe('INSTRUMENT_PRESETS', () => {
  it('has exactly 11 entries per spec R49', () => {
    expect(INSTRUMENT_PRESETS).toHaveLength(11)
  })

  it('includes every spec-mandated instrument label', () => {
    const labels = INSTRUMENT_PRESETS.map(b => b.label)
    expect(labels).toContain('Kick body')
    expect(labels).toContain('Kick click')
    expect(labels).toContain('Bass fundamental')
    expect(labels).toContain('Snare body')
    expect(labels).toContain('Snare crack')
    expect(labels).toContain('Vocal warmth')
    expect(labels).toContain('Vocal presence')
    expect(labels).toContain('Vocal sibilance')
    expect(labels).toContain('Guitar body')
    expect(labels).toContain('Guitar bite')
    expect(labels).toContain('Hi-hat / cymbals')
  })

  it('each value is the geometric mean of its range (within 1 Hz)', () => {
    for (const preset of INSTRUMENT_PRESETS) {
      expect(preset.hzRange).toBeDefined()
      const [min, max] = preset.hzRange!
      const gmean = Math.sqrt(min * max)
      expect(Math.abs(preset.value - gmean)).toBeLessThanOrEqual(1)
    }
  })
})

describe('formatHz', () => {
  it('formats values below 1000 as integer Hz', () => {
    expect(formatHz(120)).toBe('120 Hz')
    expect(formatHz(35)).toBe('35 Hz')
    expect(formatHz(999)).toBe('999 Hz')
  })

  it('formats values 1000+ as kHz with at most one decimal', () => {
    expect(formatHz(1200)).toBe('1.2 kHz')
    expect(formatHz(20000)).toBe('20 kHz')
    expect(formatHz(2828)).toBe('2.8 kHz')
    expect(formatHz(14142)).toBe('14.1 kHz')
  })

  it('drops trailing .0 for whole kHz values', () => {
    expect(formatHz(1000)).toBe('1 kHz')
    expect(formatHz(5000)).toBe('5 kHz')
  })

  it('rounds fractional Hz to nearest integer below 1000', () => {
    expect(formatHz(34.64)).toBe('35 Hz')
  })
})

describe('labelForFreq', () => {
  it('returns the spectrum band label for common anchor frequencies', () => {
    expect(labelForFreq(100)).toBe('bass')
    expect(labelForFreq(3000)).toBe('presence')
    expect(labelForFreq(30)).toBe('sub bass')
    expect(labelForFreq(15000)).toBe('air')
  })

  it('returns a label at band edges', () => {
    // 60 Hz: the transition from sub bass [20,60] to bass [60,250]. The
    // function picks the first matching band (sub bass ordered earlier).
    expect(labelForFreq(60)).toBe('sub bass')
    // 500 Hz: edge of low-mids [250,500] and start of mids [500,2000].
    expect(labelForFreq(500)).toBe('low-mids / mud')
  })

  it('returns null for frequencies outside every band', () => {
    expect(labelForFreq(10)).toBeNull()        // below sub bass (starts at 20)
    expect(labelForFreq(25000)).toBeNull()     // above air (ends at 20000)
  })
})
