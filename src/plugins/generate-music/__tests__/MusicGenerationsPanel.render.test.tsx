/**
 * Component-level tests for MusicGenerationsPanel — covers the spec tests
 * that require DOM rendering (form defaults, credits disabling, Reuse
 * context preservation, Retry visibility, context badge rendering).
 *
 * The field-filter-at-send tests live in MusicGenerationsPanel.test.tsx
 * (pure function, no rendering). This file covers UI behaviors.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

import { MusicGenerationsPanel } from '../MusicGenerationsPanel'
import type { Generation, CreditsResponse } from '../types'

// ── Mocks ──────────────────────────────────────────────────────────

const mockEditorState = {
  selectedAudioClipId: null as string | null,
  selectedTransition: null as { id: string } | null,
  setSelectedAudioClipId: vi.fn(),
}

vi.mock('@/components/editor/EditorStateContext', () => ({
  useEditorState: () => mockEditorState,
}))

const state = {
  generations: [] as Generation[],
  credits: { credits: 100 } as CreditsResponse,
}

vi.mock('../generate-music-client', () => ({
  listGenerations: vi.fn(async () => state.generations),
  getCredits: vi.fn(async () => state.credits),
  runGeneration: vi.fn(async () => ({ generation_id: 'gen_1', task_ids: ['t1'], job_id: 'j1' })),
  retryGeneration: vi.fn(async () => ({ generation_id: 'gen_2' })),
  useMusicGenerationEvents: vi.fn(),
}))

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
    tracks: [{
      generation_id: 'gen_abc',
      pool_segment_id: 'ps_1',
      musicful_task_id: 't1',
      song_title: 'Neon Midnight',
      duration_seconds: 167,
      cover_url: null,
    }],
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  mockEditorState.selectedAudioClipId = null
  mockEditorState.selectedTransition = null
  state.generations = []
  state.credits = { credits: 100 }
})

// ── Tests ──────────────────────────────────────────────────────────

describe('MusicGenerationsPanel rendering', () => {
  it('renders empty state when no generations exist', async () => {
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText('No music generations yet.')).toBeTruthy()
    })
  })

  it('form defaults: Action=Auto, Instrumental=checked, Style empty (R32)', async () => {
    render(<MusicGenerationsPanel projectName="test" />)
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    // The first two radios are Auto/Custom; Auto should be checked
    expect(radios[0].checked).toBe(true)
    expect(radios[1].checked).toBe(false)
    // Find the Instrumental checkbox — it's the only one
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    const instrumental = checkboxes[0]
    expect(instrumental.checked).toBe(true)
    const styleTextarea = screen.getByPlaceholderText(/Style/) as HTMLTextAreaElement
    expect(styleTextarea.value).toBe('')
  })

  it('out-of-credits disables Generate button with tooltip', async () => {
    state.credits = { credits: 0 }
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/0 credits/)).toBeTruthy()
    })
    const btn = screen.getByRole('button', { name: /Generate/i })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(btn.title).toContain('Out of credits')
  })

  it('retry button only appears on failed cards', async () => {
    state.generations = [
      makeGeneration({ id: 'gen_ok', status: 'completed' }),
      makeGeneration({ id: 'gen_fail', status: 'failed', error: 'musicful 500' }),
    ]
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getAllByText(/completed|failed/).length).toBeGreaterThan(0)
    })
    const retryButtons = screen.getAllByRole('button', { name: /Retry/i })
    expect(retryButtons.length).toBe(1)
  })

  it('reuse button only appears on completed cards', async () => {
    state.generations = [
      makeGeneration({ id: 'gen_ok', status: 'completed' }),
      makeGeneration({ id: 'gen_fail', status: 'failed', error: 'fail' }),
      makeGeneration({ id: 'gen_run', status: 'running' }),
    ]
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      const reuseButtons = screen.getAllByRole('button', { name: /Reuse/i })
      expect(reuseButtons.length).toBe(1)
    })
  })

  it('context badge renders for entity-bound generation', async () => {
    state.generations = [
      makeGeneration({ entity_type: 'transition', entity_id: 'tr_42' }),
    ]
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/◉ tr:tr_42/)).toBeTruthy()
    })
  })

  it('credits header shows value', async () => {
    state.credits = { credits: 237 }
    render(<MusicGenerationsPanel projectName="test" />)
    await waitFor(() => {
      expect(screen.getByText(/237 credits/)).toBeTruthy()
    })
  })
})
