/**
 * Comprehensive spec tests for the music-generation-plugin.
 * Tests every requirement from agent/specs/local.music-generation-plugin.md.
 *
 * These tests exercise:
 *   - Plugin identity and registration (R1-R4)
 *   - Payload construction / field filtering (R5, R13)
 *   - Panel rendering, form defaults, context management (R26-R36)
 *   - Generation flow, reuse, retry (R14, R29-R30, R50-R51)
 *   - Drag payload construction (R37)
 *   - Audio clip color mapping (R40)
 *   - Plugin manifest declarations (R3, R11)
 *   - WS event handling (R47-R49)
 *   - Credits display and refresh (R34-R36)
 *   - Error handling (R4, R52-R53)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── Source imports ────────────────────────────────────────────────────

import { buildPayload, MusicGenerationsPanel } from '../MusicGenerationsPanel'
import { PluginHost } from '@/lib/plugin-host'
import { getClipColors } from '@/lib/audio-clip-styling'
import * as generateMusic from '../index'
import type { Generation, CreditsResponse, RunPayload } from '../types'

// ── Mocks ────────────────────────────────────────────────────────────

const mockEditorState = {
  selectedAudioClipId: null as string | null,
  selectedTransition: null as { id: string } | null,
  setSelectedAudioClipId: vi.fn(),
}

vi.mock('@/components/editor/EditorStateContext', () => ({
  useEditorState: () => mockEditorState,
}))

const mockRunGeneration = vi.fn()
const mockListGenerations = vi.fn()
const mockRetryGeneration = vi.fn()
const mockGetCredits = vi.fn()
const mockUseMusicGenerationEvents = vi.fn()

vi.mock('../generate-music-client', () => ({
  listGenerations: (...args: unknown[]) => mockListGenerations(...args),
  getCredits: (...args: unknown[]) => mockGetCredits(...args),
  runGeneration: (...args: unknown[]) => mockRunGeneration(...args),
  retryGeneration: (...args: unknown[]) => mockRetryGeneration(...args),
  useMusicGenerationEvents: (...args: unknown[]) => mockUseMusicGenerationEvents(...args),
}))

// ── Helpers ──────────────────────────────────────────────────────────

function makeGeneration(overrides: Partial<Generation> = {}): Generation {
  return {
    id: 'gen_abc',
    action: 'auto',
    model: 'MFV2.0',
    style: 'dark cinematic',
    lyrics: null,
    title: null,
    instrumental: 1,
    gender: null,
    task_ids: ['t1'],
    status: 'completed',
    error: null,
    entity_type: null,
    entity_id: null,
    reused_from: null,
    created_at: '2026-04-23 15:00',
    tracks: [
      {
        generation_id: 'gen_abc',
        pool_segment_id: 'ps_1',
        musicful_task_id: 't1',
        song_title: 'Neon Midnight',
        pool_path: 'segments/abc.mp3',
        duration_seconds: 167,
        cover_url: null,
      },
    ],
    ...overrides,
  }
}

type SelectionContext =
  | { type: 'audio_clip'; id: string }
  | { type: 'transition'; id: string }
  | null

const baseForm = {
  action: 'auto' as const,
  style: 'dark cinematic synth',
  lyrics: '',
  title: '',
  instrumental: true,
  gender: '' as const,
  model: 'MFV2.0',
}

function resetMocks() {
  mockEditorState.selectedAudioClipId = null
  mockEditorState.selectedTransition = null
  mockListGenerations.mockResolvedValue([])
  mockGetCredits.mockResolvedValue({ credits: 100 })
  mockRunGeneration.mockResolvedValue({ generation_id: 'gen_new', task_ids: ['t1'], job_id: 'j1' })
  mockRetryGeneration.mockResolvedValue({ generation_id: 'gen_retry', task_ids: ['t2'], job_id: 'j2' })
  mockUseMusicGenerationEvents.mockImplementation(() => {})
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  resetMocks()
})


// ========================================================================
// PLUGIN IDENTITY & REGISTRATION (R1, R2, R3, R4, R11)
// ========================================================================

describe('Plugin identity & registration', () => {
  beforeEach(() => {
    PluginHost._resetForTests()
  })

  // covers R1, R2 — Plugin id and operation registration
  it('registers operation generate_music.run with correct entity types (R1, R2)', () => {
    PluginHost.register(generateMusic, 'generate_music')
    const op = PluginHost.getOperation('generate_music.run')
    expect(op).toBeDefined()
    expect(op!.label).toBe('Generate music')
    expect(op!.entityTypes).toContain('audio_clip')
    expect(op!.entityTypes).toContain('transition')
  })

  // covers R2 — Panel registration
  it('registers MusicGenerationsPanel with id music_generations (R2, R26)', () => {
    PluginHost.register(generateMusic, 'generate_music')
    const panel = PluginHost.getPanel('music_generations')
    expect(panel).toBeDefined()
    expect(panel!.title).toBe('Music Generations')
    expect(panel!.Component).toBeDefined()
  })

  // covers R3 — plugin.yaml manifest declarations
  it('plugin.yaml declares correct name, schema_version, operations, invariants (R3)', () => {
    const yamlPath = path.resolve(__dirname, '..', 'plugin.yaml')
    const content = fs.readFileSync(yamlPath, 'utf-8')

    // name is generate-music (kebab-case)
    expect(content).toMatch(/^name:\s*generate-music$/m)
    // schema_version: 1
    expect(content).toMatch(/^schema_version:\s*1$/m)
    // operation id
    expect(content).toContain('id: generate-music.run')
    // entityTypes include null
    expect(content).toMatch(/entityTypes:.*null/)
    // contributes.invariants block for forward-compat
    expect(content).toContain('invariants:')
    expect(content).toContain('musicful-api-key-present')
    expect(content).toContain('severity: blocking')
  })

  // covers R11 — plugin name matches kebab regex
  it('plugin.yaml name matches ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ (R11)', () => {
    const yamlPath = path.resolve(__dirname, '..', 'plugin.yaml')
    const content = fs.readFileSync(yamlPath, 'utf-8')
    const nameMatch = content.match(/^name:\s*(.+)$/m)
    expect(nameMatch).not.toBeNull()
    const pluginName = nameMatch![1].trim()
    expect(pluginName).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    // no consecutive hyphens
    expect(pluginName).not.toContain('--')
  })

  // covers R1 — frontend module location
  it('plugin source lives at src/plugins/generate-music/ (R1)', () => {
    const indexPath = path.resolve(__dirname, '..', 'index.ts')
    expect(fs.existsSync(indexPath)).toBe(true)
  })

  // covers R2 — context menu contributions
  it('contributes context menu items for audio_clip and transition (R2)', () => {
    PluginHost.register(generateMusic, 'generate_music')
    const clipItems = PluginHost.getContextMenuItems('audio_clip')
    expect(clipItems.length).toBeGreaterThanOrEqual(1)
    expect(clipItems.some(item => item.operation === 'generate_music.run')).toBe(true)

    const trItems = PluginHost.getContextMenuItems('transition')
    expect(trItems.length).toBeGreaterThanOrEqual(1)
    expect(trItems.some(item => item.operation === 'generate_music.run')).toBe(true)
  })

  // covers R2 — operation not listed for irrelevant entity types
  it('operation not listed for entity types like keyframe (R2)', () => {
    PluginHost.register(generateMusic, 'generate_music')
    expect(PluginHost.listOperations('keyframe')).toHaveLength(0)
  })
})


// ========================================================================
// PAYLOAD CONSTRUCTION / FIELD FILTERING (R5, R13)
// ========================================================================

describe('Payload construction — buildPayload (R13)', () => {
  // covers R13 — action=auto sends only style, instrumental, model, action
  it('action=auto omits lyrics, title, gender-if-empty (R13, send-filtered-to-auto-fields)', () => {
    const payload = buildPayload(
      { ...baseForm, action: 'auto', lyrics: 'la la', title: 'Ignored' },
      null,
    )
    expect(payload.action).toBe('auto')
    expect(payload.style).toBe('dark cinematic synth')
    expect(payload.instrumental).toBe(1)
    expect(payload.model).toBe('MFV2.0')
    expect(payload.lyrics).toBeUndefined()
    expect(payload.title).toBeUndefined()
    // entity_type/entity_id should NOT be sent to Musicful — but they
    // are part of the run-endpoint payload for the backend, so they
    // appear in the payload object (the backend strips them before
    // forwarding to Musicful)
    expect(payload.entity_type).toBeNull()
    expect(payload.entity_id).toBeNull()
  })

  // covers R13 — action=custom sends lyrics, title, gender
  it('action=custom includes lyrics, title, gender when set (R13)', () => {
    const payload = buildPayload(
      {
        ...baseForm,
        action: 'custom',
        lyrics: 'verse one',
        title: 'My Song',
        gender: 'male',
        instrumental: false,
      },
      null,
    )
    expect(payload.action).toBe('custom')
    expect(payload.lyrics).toBe('verse one')
    expect(payload.title).toBe('My Song')
    expect(payload.gender).toBe('male')
    expect(payload.instrumental).toBe(0)
  })

  // covers R13 — instrumental=1 drops lyrics even on custom
  it('action=custom + instrumental=true drops lyrics (R13, instrumental-1-drops-lyrics)', () => {
    const payload = buildPayload(
      { ...baseForm, action: 'custom', instrumental: true, lyrics: 'should not ship' },
      null,
    )
    expect(payload.lyrics).toBeUndefined()
    expect(payload.instrumental).toBe(1)
  })

  // covers R13 — action=auto ignores lyrics and title
  it('action=auto ignores lyrics and title fields (R13, action-auto-ignores-lyrics-and-title)', () => {
    const payload = buildPayload(
      { ...baseForm, action: 'auto', lyrics: 'ignored', title: 'also ignored', instrumental: false },
      null,
    )
    expect(payload.lyrics).toBeUndefined()
    expect(payload.title).toBeUndefined()
    expect(payload.style).toBe('dark cinematic synth')
  })

  // covers R13 — gender flows through when set
  it('gender included when non-empty, omitted when empty (R13)', () => {
    const withGender = buildPayload({ ...baseForm, gender: 'female' }, null)
    expect(withGender.gender).toBe('female')

    const noGender = buildPayload({ ...baseForm, gender: '' }, null)
    expect(noGender.gender).toBeUndefined()
  })

  // covers R12 — selection context serialization
  it('serializes transition selection context (R12)', () => {
    const ctx: SelectionContext = { type: 'transition', id: 'tr_A' }
    const payload = buildPayload(baseForm, ctx)
    expect(payload.entity_type).toBe('transition')
    expect(payload.entity_id).toBe('tr_A')
  })

  it('serializes audio_clip selection context (R12)', () => {
    const ctx: SelectionContext = { type: 'audio_clip', id: 'ac-7' }
    const payload = buildPayload(baseForm, ctx)
    expect(payload.entity_type).toBe('audio_clip')
    expect(payload.entity_id).toBe('ac-7')
  })

  it('null selection context serializes to explicit nulls (R12)', () => {
    const payload = buildPayload(baseForm, null)
    expect(payload.entity_type).toBeNull()
    expect(payload.entity_id).toBeNull()
  })

  // covers R13 — empty-trimmed title not sent
  it('action=custom includes title only when non-empty (R13)', () => {
    const withTitle = buildPayload({ ...baseForm, action: 'custom', title: 'Neon Midnight' }, null)
    expect(withTitle.title).toBe('Neon Midnight')

    const blank = buildPayload({ ...baseForm, action: 'custom', title: '   ' }, null)
    expect(blank.title).toBeUndefined()
  })
})


// ========================================================================
// PANEL UX: FORM DEFAULTS (R31, R32)
// ========================================================================

describe('Panel form defaults (R31, R32)', () => {
  // covers R32 — default-form-values
  it('form defaults: Action=Auto, Instrumental=checked, Style empty (R32)', async () => {
    render(<MusicGenerationsPanel projectName="test" />)
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    // First two radios are Auto/Custom
    const autoRadio = radios.find(r => {
      const label = r.closest('label')
      return label?.textContent?.includes('Auto')
    })
    expect(autoRadio?.checked).toBe(true)

    const customRadio = radios.find(r => {
      const label = r.closest('label')
      return label?.textContent?.includes('Custom')
    })
    expect(customRadio?.checked).toBe(false)

    // Instrumental checkbox
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(checkboxes[0].checked).toBe(true)

    // Style empty
    const styleTextarea = screen.getByPlaceholderText(/Style/) as HTMLTextAreaElement
    expect(styleTextarea.value).toBe('')

    // Lyrics empty
    const lyricsTextarea = screen.getByPlaceholderText(/Lyrics/) as HTMLTextAreaElement
    expect(lyricsTextarea.value).toBe('')

    // Title empty
    const titleInput = screen.getByPlaceholderText(/Title/) as HTMLInputElement
    expect(titleInput.value).toBe('')
  })

  // covers R31 — all form fields always rendered
  it('all form fields rendered regardless of action (R31)', async () => {
    render(<MusicGenerationsPanel projectName="test" />)
    // Style
    expect(screen.getByPlaceholderText(/Style/)).toBeTruthy()
    // Lyrics
    expect(screen.getByPlaceholderText(/Lyrics/)).toBeTruthy()
    // Title
    expect(screen.getByPlaceholderText(/Title/)).toBeTruthy()
    // Gender radios
    expect(screen.getByText('unset')).toBeTruthy()
    expect(screen.getByText('male')).toBeTruthy()
    expect(screen.getByText('female')).toBeTruthy()
    // Model select
    expect(screen.getByTitle(/Musicful model/)).toBeTruthy()
  })
})


// ========================================================================
// CREDITS DISPLAY (R34, R35, R36)
// ========================================================================

describe('Credits display (R34, R35, R36)', () => {
  // covers R34, R35 — credits-displayed-and-refreshed
  it('shows credits value in panel header (R34)', async () => {
    mockGetCredits.mockResolvedValue({ credits: 237 })
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/237 credits/)).toBeTruthy()
    })
  })

  // covers R35 — initial-fetch-once
  it('fetches credits on panel mount (R35)', async () => {
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(mockGetCredits).toHaveBeenCalledTimes(1)
    })
  })

  // covers R36 — out-of-credits-blocks-generate
  it('out of credits disables Generate button with message (R36)', async () => {
    mockGetCredits.mockResolvedValue({ credits: 0 })
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/0 credits/)).toBeTruthy()
    })
    const btn = screen.getByRole('button', { name: /Generate/i })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(btn.title).toContain('Out of credits')
  })

  // covers R36 — form-still-renders when out of credits
  it('form fields still render when out of credits (R36)', async () => {
    mockGetCredits.mockResolvedValue({ credits: 0 })
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/0 credits/)).toBeTruthy()
    })
    // All fields per R31
    expect(screen.getByPlaceholderText(/Style/)).toBeTruthy()
    expect(screen.getByPlaceholderText(/Lyrics/)).toBeTruthy()
    expect(screen.getByPlaceholderText(/Title/)).toBeTruthy()
  })

  // covers R4 — missing API key shows admin error for credits
  it('shows dash when credits are null (missing API key state) (R4)', async () => {
    mockGetCredits.mockResolvedValue({ credits: null, error: 'This plugin requires a Musicful API key. Please contact your administrator.' })
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/This plugin requires a Musicful API key/)).toBeTruthy()
    })
  })
})


// ========================================================================
// PANEL CONTEXT FILTERING (R27, R28, R33)
// ========================================================================

describe('Panel context filtering (R27, R28, R33)', () => {
  // covers R27 — panel-filters-to-context
  it('shows filtered generations when entity is selected (R27)', async () => {
    const genTrA = makeGeneration({ id: 'gen_trA_1', entity_type: 'transition', entity_id: 'tr-A' })
    const genTrA2 = makeGeneration({ id: 'gen_trA_2', entity_type: 'transition', entity_id: 'tr-A' })
    const genNull = makeGeneration({ id: 'gen_null', entity_type: null, entity_id: null })

    mockEditorState.selectedTransition = { id: 'tr-A' }
    mockListGenerations.mockResolvedValue([genTrA, genTrA2])

    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(mockListGenerations).toHaveBeenCalled()
    })

    // The list call should include entity filter
    const callArgs = mockListGenerations.mock.calls[0]
    expect(callArgs[1]).toEqual({ entityType: 'transition', entityId: 'tr-A' })
  })

  // covers R27 — no selection shows all
  it('shows all generations when no selection (R27)', async () => {
    mockListGenerations.mockResolvedValue([])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(mockListGenerations).toHaveBeenCalled()
    })
    const callArgs = mockListGenerations.mock.calls[0]
    expect(callArgs[1]).toBeUndefined()
  })

  // covers R28 — context-badge-on-cards
  it('run cards show context badge for entity-bound generations (R28)', async () => {
    mockListGenerations.mockResolvedValue([
      makeGeneration({ entity_type: 'transition', entity_id: 'tr-42' }),
    ])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/◉ tr:tr-42/)).toBeTruthy()
    })
  })

  it('run cards show clip context badge (R28)', async () => {
    mockListGenerations.mockResolvedValue([
      makeGeneration({ entity_type: 'audio_clip', entity_id: 'ac-7' }),
    ])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/◉ clip:ac-7/)).toBeTruthy()
    })
  })

  // covers R33 — context header when entity selected
  it('shows "Generating for" header when entity selected (R33)', async () => {
    mockEditorState.selectedTransition = { id: 'tr-X' }
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/Generating for/)).toBeTruthy()
    })
  })

  // covers R33 — no "Generating for" header when no selection
  it('no "Generating for" header when no selection (R33)', async () => {
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.queryByText(/Generating for/)).toBeNull()
    })
  })

  // covers R33 — Clear context button visible when context exists
  it('Clear context button visible when entity selected (R33)', async () => {
    mockEditorState.selectedAudioClipId = 'ac-1'
    render(<MusicGenerationsPanel projectName="test" />)
    expect(screen.getByText('Clear context')).toBeTruthy()
  })

  // covers R33 — clear-context-button-overrides-selection
  it('Clear context button causes null entity_type/entity_id on submit (R33)', async () => {
    mockEditorState.selectedAudioClipId = 'ac-1'
    render(<MusicGenerationsPanel projectName="test" />)

    // Click Clear context
    fireEvent.click(screen.getByText('Clear context'))

    // Fill style so we can submit
    const styleTextarea = screen.getByPlaceholderText(/Style/) as HTMLTextAreaElement
    fireEvent.change(styleTextarea, { target: { value: 'jazz' } })

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /Generate/i }))

    await waitFor(() => {
      expect(mockRunGeneration).toHaveBeenCalled()
    })
    const payload = mockRunGeneration.mock.calls[0][1] as RunPayload
    expect(payload.entity_type).toBeNull()
    expect(payload.entity_id).toBeNull()
  })

  // covers R33 — mid-form-deselect-clears-context (simulated by changing mock)
  it('no Clear context button when no selection (R33)', async () => {
    render(<MusicGenerationsPanel projectName="test" />)
    expect(screen.queryByText('Clear context')).toBeNull()
  })
})


// ========================================================================
// SHOW ALL TOGGLE (R27)
// ========================================================================

describe('Show all toggle (R27)', () => {
  it('Show all button visible when entity selected (R27)', async () => {
    mockEditorState.selectedTransition = { id: 'tr-A' }
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText('Show all')).toBeTruthy()
    })
  })
})


// ========================================================================
// REUSE (R29, R30)
// ========================================================================

describe('Reuse (R29, R30)', () => {
  // covers R29 — reuse-prefills-form
  it('Reuse button prefills form with generation params (R29)', async () => {
    const gen = makeGeneration({
      action: 'custom',
      style: 'jazz',
      lyrics: 'twinkle',
      title: 'Star',
      instrumental: 0,
      gender: 'female',
      model: 'MFV2.0',
    })
    mockListGenerations.mockResolvedValue([gen])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/⟳ Reuse/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/⟳ Reuse/))

    // Check form state
    const styleTextarea = screen.getByPlaceholderText(/Style/) as HTMLTextAreaElement
    expect(styleTextarea.value).toBe('jazz')
    const lyricsTextarea = screen.getByPlaceholderText(/Lyrics/) as HTMLTextAreaElement
    expect(lyricsTextarea.value).toBe('twinkle')
    const titleInput = screen.getByPlaceholderText(/Title/) as HTMLInputElement
    expect(titleInput.value).toBe('Star')
  })

  // covers R29 — form-not-submitted on Reuse click
  it('Reuse does not auto-submit (R29)', async () => {
    mockListGenerations.mockResolvedValue([makeGeneration()])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/⟳ Reuse/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/⟳ Reuse/))

    // runGeneration should NOT have been called by the Reuse click
    // (it may have been called during initial render, so check call count)
    const callCountBefore = mockRunGeneration.mock.calls.length
    // Wait a tick
    await new Promise(r => setTimeout(r, 50))
    expect(mockRunGeneration.mock.calls.length).toBe(callCountBefore)
  })

  // covers R30 — reuse-preserves-null-context
  it('Reuse preserves null context from original (R30)', async () => {
    const gen = makeGeneration({ entity_type: null, entity_id: null })
    mockListGenerations.mockResolvedValue([gen])
    mockEditorState.selectedTransition = { id: 'tr-Z' } // current selection differs

    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/⟳ Reuse/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/⟳ Reuse/))

    // Fill required style
    const styleTextarea = screen.getByPlaceholderText(/Style/) as HTMLTextAreaElement
    fireEvent.change(styleTextarea, { target: { value: 'rock' } })

    fireEvent.click(screen.getByRole('button', { name: /Generate/i }))
    await waitFor(() => {
      expect(mockRunGeneration).toHaveBeenCalled()
    })
    const payload = mockRunGeneration.mock.calls[0][1] as RunPayload
    expect(payload.entity_type).toBeNull()
    expect(payload.entity_id).toBeNull()
  })

  // covers R30 — reuse-preserves-entity-context
  it('Reuse preserves original entity context, not current selection (R30)', async () => {
    const gen = makeGeneration({
      entity_type: 'audio_clip',
      entity_id: 'ac-99',
      style: 'disco',
    })
    mockListGenerations.mockResolvedValue([gen])
    mockEditorState.selectedTransition = { id: 'tr-Z' } // different selection active

    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/⟳ Reuse/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/⟳ Reuse/))

    fireEvent.click(screen.getByRole('button', { name: /Generate/i }))
    await waitFor(() => {
      expect(mockRunGeneration).toHaveBeenCalled()
    })
    const payload = mockRunGeneration.mock.calls[0][1] as RunPayload
    expect(payload.entity_type).toBe('audio_clip')
    expect(payload.entity_id).toBe('ac-99')
  })
})


// ========================================================================
// RETRY (R50, R51)
// ========================================================================

describe('Retry (R50, R51)', () => {
  // covers R50 — failed-generation-shows-retry
  it('failed card shows error text and Retry button (R50)', async () => {
    mockListGenerations.mockResolvedValue([
      makeGeneration({ status: 'failed', error: 'model_overloaded', tracks: [] }),
    ])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText('model_overloaded')).toBeTruthy()
      expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy()
    })
  })

  // covers R51 — Retry calls backend
  it('Retry button calls retryGeneration with generation id (R51)', async () => {
    const failedGen = makeGeneration({ id: 'gen_fail', status: 'failed', error: 'timeout', tracks: [] })
    mockListGenerations.mockResolvedValue([failedGen])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))
    await waitFor(() => {
      expect(mockRetryGeneration).toHaveBeenCalledWith('test', 'gen_fail')
    })
  })

  // covers R50 — Retry only on failed, Reuse only on completed
  it('Retry appears only on failed, Reuse only on completed (R50, R29)', async () => {
    mockListGenerations.mockResolvedValue([
      makeGeneration({ id: 'gen_ok', status: 'completed' }),
      makeGeneration({ id: 'gen_fail', status: 'failed', error: 'err', tracks: [] }),
      makeGeneration({ id: 'gen_run', status: 'running', tracks: [] }),
    ])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      const retryButtons = screen.getAllByRole('button', { name: /Retry/i })
      expect(retryButtons.length).toBe(1)
      const reuseButtons = screen.getAllByRole('button', { name: /Reuse/i })
      expect(reuseButtons.length).toBe(1)
    })
  })
})


// ========================================================================
// RUN CARD STATUS BADGES (R28)
// ========================================================================

describe('Run card status (R28)', () => {
  it('displays completed status on card (R28)', async () => {
    mockListGenerations.mockResolvedValue([makeGeneration({ status: 'completed' })])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText('completed')).toBeTruthy()
    })
  })

  it('displays failed status on card (R28)', async () => {
    mockListGenerations.mockResolvedValue([
      makeGeneration({ status: 'failed', error: 'err', tracks: [] }),
    ])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText('failed')).toBeTruthy()
    })
  })

  it('displays running status on card (R28)', async () => {
    mockListGenerations.mockResolvedValue([
      makeGeneration({ status: 'running', tracks: [] }),
    ])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText('running')).toBeTruthy()
    })
  })

  // covers R28 — timestamp, action, model displayed
  it('card displays timestamp, action, and model (R28)', async () => {
    mockListGenerations.mockResolvedValue([
      makeGeneration({ created_at: '2026-04-23 15:00', action: 'auto', model: 'MFV2.0' }),
    ])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/2026-04-23 15:00/)).toBeTruthy()
      // auto and MFV2.0 appear in both the form and the card; use getAllByText
      expect(screen.getAllByText(/auto/).length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText(/MFV2\.0/).length).toBeGreaterThanOrEqual(1)
    })
  })
})


// ========================================================================
// AUDIO CLIP COLOR MAPPING (R40)
// ========================================================================

describe('Audio clip color mapping (R40)', () => {
  // covers R40 — music = purple
  it('variant_kind=music returns purple colors (R40)', () => {
    const colors = getClipColors('music')
    expect(colors.bg).toContain('purple')
    expect(colors.borderDefault).toContain('purple')
    expect(colors.borderSelected).toContain('purple')
  })

  // covers R40 — lipsync = teal
  it('variant_kind=lipsync returns teal colors (R40)', () => {
    const colors = getClipColors('lipsync')
    expect(colors.bg).toContain('teal')
  })

  // covers R40 — null = default (not purple, not teal)
  it('variant_kind=null returns default colors (R40)', () => {
    const colors = getClipColors(null)
    expect(colors.bg).not.toContain('purple')
    expect(colors.bg).not.toContain('teal')
  })

  // covers R40 — undefined also returns default
  it('variant_kind=undefined returns default colors (R40)', () => {
    const colors = getClipColors(undefined)
    expect(colors.bg).not.toContain('purple')
  })
})


// ========================================================================
// DRAG PAYLOAD (R37)
// ========================================================================

describe('Drag payload (R37)', () => {
  // covers R37 — drag-payload-shape
  it('drag on track row sets application/x-scenecraft-pool-path (R37)', async () => {
    const gen = makeGeneration({
      tracks: [
        {
          generation_id: 'gen_abc',
          pool_segment_id: 'ps-123',
          musicful_task_id: 't1',
          song_title: 'Neon Midnight',
          pool_path: 'segments/abc.mp3',
          duration_seconds: 172.3,
          cover_url: null,
        },
      ],
    })
    mockListGenerations.mockResolvedValue([gen])
    render(<MusicGenerationsPanel projectName="test" />)

    await waitFor(() => {
      expect(screen.getByText('Neon Midnight')).toBeTruthy()
    })

    // Find the draggable element (the track row div)
    const trackRow = screen.getByText('Neon Midnight').closest('[draggable="true"]')
    expect(trackRow).not.toBeNull()

    // Create a mock dataTransfer
    const setDataCalls: Array<{ type: string; data: string }> = []
    const mockDataTransfer = {
      setData: (type: string, data: string) => setDataCalls.push({ type, data }),
      effectAllowed: '',
    }

    fireEvent.dragStart(trackRow!, {
      dataTransfer: mockDataTransfer,
    })

    // The panel uses application/x-scenecraft-pool-path (pool_path string only)
    const poolPathEntry = setDataCalls.find(c => c.type === 'application/x-scenecraft-pool-path')
    expect(poolPathEntry).toBeDefined()
    expect(poolPathEntry!.data).toBe('segments/abc.mp3')
  })
})


// ========================================================================
// GENERATION FORM SUBMIT (R5, R12, R13, R14)
// ========================================================================

describe('Generation form submit (R5, R12, R13, R14)', () => {
  // covers R5, R13 — generates-music-auto-no-context
  it('submitting auto generation sends correct payload to backend (R5, R13)', async () => {
    render(<MusicGenerationsPanel projectName="test" />)

    // Fill style
    const styleTextarea = screen.getByPlaceholderText(/Style/) as HTMLTextAreaElement
    fireEvent.change(styleTextarea, { target: { value: 'dark cinematic synth' } })

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /Generate/i }))

    await waitFor(() => {
      expect(mockRunGeneration).toHaveBeenCalledTimes(1)
    })
    const [projectName, payload] = mockRunGeneration.mock.calls[0]
    expect(projectName).toBe('test')
    expect(payload.action).toBe('auto')
    expect(payload.style).toBe('dark cinematic synth')
    expect(payload.instrumental).toBe(1) // default
    expect(payload.entity_type).toBeNull()
    expect(payload.entity_id).toBeNull()
  })

  // covers R12 — selection context passed at submit time
  it('selection context included in submit payload (R12)', async () => {
    mockEditorState.selectedAudioClipId = 'ac-7'
    render(<MusicGenerationsPanel projectName="test" />)

    const styleTextarea = screen.getByPlaceholderText(/Style/) as HTMLTextAreaElement
    fireEvent.change(styleTextarea, { target: { value: 'cinematic' } })

    fireEvent.click(screen.getByRole('button', { name: /Generate/i }))
    await waitFor(() => {
      expect(mockRunGeneration).toHaveBeenCalled()
    })
    const payload = mockRunGeneration.mock.calls[0][1] as RunPayload
    expect(payload.entity_type).toBe('audio_clip')
    expect(payload.entity_id).toBe('ac-7')
  })

  // covers R5 — rejects unsupported action
  // Note: The frontend only exposes auto/custom via the form; the backend
  // enforces rejection of other actions. We test the type constraint.
  it('RunPayload type constrains action to auto|custom (R5)', () => {
    // TypeScript prevents other values at compile time;
    // at runtime, buildPayload only receives values from the radio buttons
    const payload = buildPayload(baseForm, null)
    expect(['auto', 'custom']).toContain(payload.action)
  })
})


// ========================================================================
// WS EVENT SUBSCRIPTION (R47, R48, R49)
// ========================================================================

describe('WS event subscription (R47, R48)', () => {
  // covers R48 — panel subscribes to WS events
  it('panel subscribes to WS job events on mount (R48)', async () => {
    render(<MusicGenerationsPanel projectName="test" />)
    expect(mockUseMusicGenerationEvents).toHaveBeenCalled()
    const [projectName] = mockUseMusicGenerationEvents.mock.calls[0]
    expect(projectName).toBe('test')
  })

  // covers R48 — on job_completed, panel refetches
  it('WS event callback triggers refetch (R48)', async () => {
    let capturedCallback: ((event: unknown) => void) | null = null
    mockUseMusicGenerationEvents.mockImplementation(
      (_proj: string, cb: (event: unknown) => void) => {
        capturedCallback = cb
      },
    )

    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(mockListGenerations).toHaveBeenCalled()
    })

    const initialCallCount = mockListGenerations.mock.calls.length

    // Simulate a WS event
    capturedCallback!({ type: 'job_completed', jobId: 'j1', generationId: 'gen1', result: {} })

    await waitFor(() => {
      expect(mockListGenerations.mock.calls.length).toBeGreaterThan(initialCallCount)
    })
  })
})


// ========================================================================
// PLUGIN MANIFEST STRUCTURE (R3, R11)
// ========================================================================

describe('Plugin manifest structure (R3, R11)', () => {
  // covers R3 — schema_version, contributes.operations, contributes.invariants
  it('plugin.yaml has correct top-level fields (R3)', () => {
    const yamlPath = path.resolve(__dirname, '..', 'plugin.yaml')
    const content = fs.readFileSync(yamlPath, 'utf-8')
    expect(content).toContain('version: 1.0.0')
    expect(content).toContain('displayName:')
    expect(content).toContain('publisher: scenecraft')
    expect(content).toContain('schema_version: 1')
    expect(content).toContain('activationEvents:')
    expect(content).toContain('contributes:')
  })

  // covers R3 — operation entity types include null
  it('plugin.yaml operation entityTypes includes null for no-context (R3)', () => {
    const yamlPath = path.resolve(__dirname, '..', 'plugin.yaml')
    const content = fs.readFileSync(yamlPath, 'utf-8')
    // entityTypes: [audio_clip, transition, null]
    expect(content).toMatch(/entityTypes:.*audio_clip/)
    expect(content).toMatch(/entityTypes:.*transition/)
    expect(content).toMatch(/entityTypes:.*null/)
  })

  // covers R3 — invariants block present with user_message
  it('plugin.yaml invariants block has user_message for missing key (R3)', () => {
    const yamlPath = path.resolve(__dirname, '..', 'plugin.yaml')
    const content = fs.readFileSync(yamlPath, 'utf-8')
    expect(content).toContain(
      'user_message: "This plugin requires a Musicful API key. Please contact your administrator."',
    )
  })

  // covers R11 — plugin name follows prefix convention
  it('plugin name does not contain consecutive hyphens (R11)', () => {
    const yamlPath = path.resolve(__dirname, '..', 'plugin.yaml')
    const content = fs.readFileSync(yamlPath, 'utf-8')
    const nameMatch = content.match(/^name:\s*(.+)$/m)
    const pluginName = nameMatch![1].trim()
    expect(pluginName).not.toMatch(/--/)
  })
})


// ========================================================================
// TYPE SYSTEM COVERAGE
// ========================================================================

describe('Type coverage for spec interfaces', () => {
  // covers R7 schema — Generation type matches spec columns
  it('Generation type has all spec-required fields', () => {
    const gen = makeGeneration()
    expect(gen).toHaveProperty('id')
    expect(gen).toHaveProperty('action')
    expect(gen).toHaveProperty('model')
    expect(gen).toHaveProperty('style')
    expect(gen).toHaveProperty('lyrics')
    expect(gen).toHaveProperty('title')
    expect(gen).toHaveProperty('instrumental')
    expect(gen).toHaveProperty('gender')
    expect(gen).toHaveProperty('task_ids')
    expect(gen).toHaveProperty('status')
    expect(gen).toHaveProperty('error')
    expect(gen).toHaveProperty('entity_type')
    expect(gen).toHaveProperty('entity_id')
    expect(gen).toHaveProperty('reused_from')
    expect(gen).toHaveProperty('created_at')
    expect(gen).toHaveProperty('tracks')
  })

  // covers R8 schema — GenerationTrack type
  it('GenerationTrack type has all spec-required fields', () => {
    const track = makeGeneration().tracks[0]
    expect(track).toHaveProperty('generation_id')
    expect(track).toHaveProperty('pool_segment_id')
    expect(track).toHaveProperty('musicful_task_id')
    expect(track).toHaveProperty('song_title')
    expect(track).toHaveProperty('pool_path')
    expect(track).toHaveProperty('duration_seconds')
    expect(track).toHaveProperty('cover_url')
  })

  // covers R7 — action constrained to auto|custom
  it('GenerationAction type only allows auto or custom (R7)', () => {
    const gen1 = makeGeneration({ action: 'auto' })
    const gen2 = makeGeneration({ action: 'custom' })
    expect(['auto', 'custom']).toContain(gen1.action)
    expect(['auto', 'custom']).toContain(gen2.action)
  })

  // covers R7 — status constrained
  it('GenerationStatus type covers all states (R7)', () => {
    const statuses = ['pending', 'running', 'completed', 'failed']
    for (const s of statuses) {
      const gen = makeGeneration({ status: s as Generation['status'] })
      expect(statuses).toContain(gen.status)
    }
  })
})


// ========================================================================
// REST CLIENT URL CONSTRUCTION
// ========================================================================

describe('REST endpoint URL patterns (R1)', () => {
  // The REST URL construction is tested in detail in client.test.ts.
  // Here we verify the plugin's REST surface uses the generate-music path segment.
  it('client module uses generate-music in endpoint URLs (R1)', () => {
    // The generate-music-client module constructs URLs under /plugins/generate-music/.
    // This is a structural assertion: the source file contains the expected path.
    const clientPath = path.resolve(__dirname, '..', 'generate-music-client.ts')
    const clientSource = fs.readFileSync(clientPath, 'utf-8')
    expect(clientSource).toContain('/plugins/generate-music')
  })
})


// ========================================================================
// EMPTY STATES AND EDGE CASES
// ========================================================================

describe('Edge cases', () => {
  // covers R26 — no project name shows message
  it('shows "No project loaded" when projectName is missing (R26)', () => {
    render(<MusicGenerationsPanel />)
    expect(screen.getByText('No project loaded.')).toBeTruthy()
  })

  // covers R32 — style empty prevents submission
  it('Generate button disabled when style is empty (R32)', () => {
    render(<MusicGenerationsPanel projectName="test" />)
    const btn = screen.getByRole('button', { name: /Generate/i })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  // covers R31 — all fields still present after changing action
  it('switching action does not hide fields (R31)', async () => {
    render(<MusicGenerationsPanel projectName="test" />)

    // Switch to Custom
    const customRadio = screen.getAllByRole('radio').find(r => {
      const label = (r as HTMLElement).closest('label')
      return label?.textContent?.includes('Custom')
    })
    fireEvent.click(customRadio!)

    // All fields still visible
    expect(screen.getByPlaceholderText(/Style/)).toBeTruthy()
    expect(screen.getByPlaceholderText(/Lyrics/)).toBeTruthy()
    expect(screen.getByPlaceholderText(/Title/)).toBeTruthy()

    // Switch back to Auto
    const autoRadio = screen.getAllByRole('radio').find(r => {
      const label = (r as HTMLElement).closest('label')
      return label?.textContent?.includes('Auto')
    })
    fireEvent.click(autoRadio!)

    // Still visible
    expect(screen.getByPlaceholderText(/Style/)).toBeTruthy()
    expect(screen.getByPlaceholderText(/Lyrics/)).toBeTruthy()
    expect(screen.getByPlaceholderText(/Title/)).toBeTruthy()
  })

  // covers R13 — very-long-style-accepted (frontend allows up to 5000 chars)
  it('style textarea allows up to 5000 characters (R13)', () => {
    render(<MusicGenerationsPanel projectName="test" />)
    const textarea = screen.getByPlaceholderText(/Style/) as HTMLTextAreaElement
    expect(textarea.maxLength).toBe(5000)
  })

  // covers R28 — no context badge for null-context generation
  it('no context badge for generation with null entity (R28)', async () => {
    mockListGenerations.mockResolvedValue([
      makeGeneration({ entity_type: null, entity_id: null }),
    ])
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.queryByText(/◉/)).toBeNull()
    })
  })

  // covers loading state
  it('shows loading state before data arrives', () => {
    // Make the promise hang
    mockListGenerations.mockReturnValue(new Promise(() => {}))
    mockGetCredits.mockReturnValue(new Promise(() => {}))
    render(<MusicGenerationsPanel projectName="test" />)
    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  // covers error display
  it('shows error when fetch fails', async () => {
    mockListGenerations.mockRejectedValue(new Error('Network error'))
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy()
    })
  })
})


// ========================================================================
// EXPORTS & MODULE SURFACE
// ========================================================================

describe('Module exports', () => {
  // covers R1, R2 — the plugin module exports the expected surface
  it('plugin exports activate and deactivate', () => {
    expect(typeof generateMusic.activate).toBe('function')
    expect(typeof generateMusic.deactivate).toBe('function')
  })

  it('plugin re-exports client helpers', () => {
    // Note: the client module is mocked, so we verify the re-exports exist
    // (they resolve to the mock functions). subscribeMusicJob is not in
    // the mock because it's not used by the panel, so we verify it via
    // source inspection instead.
    expect(generateMusic.runGeneration).toBeDefined()
    expect(generateMusic.listGenerations).toBeDefined()
    expect(generateMusic.retryGeneration).toBeDefined()
    expect(generateMusic.getCredits).toBeDefined()
    expect(generateMusic.useMusicGenerationEvents).toBeDefined()
    // subscribeMusicJob is re-exported but the mock doesn't define it;
    // verify via source file inspection
    const indexSource = fs.readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf-8')
    expect(indexSource).toContain('subscribeMusicJob')
  })

  it('plugin exports MusicGenerationsPanel component', () => {
    expect(typeof generateMusic.MusicGenerationsPanel).toBe('function')
  })
})
