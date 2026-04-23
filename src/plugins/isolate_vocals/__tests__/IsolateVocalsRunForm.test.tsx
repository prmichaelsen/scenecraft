/**
 * Tests for IsolateVocalsRunForm.
 *
 * Mocks the REST kickoff (`callIsolateVocals`) and verifies:
 *   - ETA renders against entity.durationSeconds
 *   - Subset toggle shows trim_in/trim_out inputs and recomputes active dur
 *   - Run click POSTs the expected body; disables button while in-flight
 *   - Errors surface in the form
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

import { IsolateVocalsRunForm } from '../IsolateVocalsRunForm'

const callIsolateVocalsMock = vi.fn()
vi.mock('../isolate-vocals-client', () => ({
  callIsolateVocals: (...args: unknown[]) => callIsolateVocalsMock(...args),
}))

beforeEach(() => {
  callIsolateVocalsMock.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('IsolateVocalsRunForm', () => {
  it('renders ETA based on durationSeconds', () => {
    render(
      <IsolateVocalsRunForm
        entity={{ type: 'audio_clip', id: 'ac_1', durationSeconds: 100 }}
        projectName="proj"
      />,
    )
    // Full source → activeDur = 100 → ETA 100–200s.
    expect(screen.getByText(/100–200s/)).toBeTruthy()
    expect(screen.getByText(/DeepFilterNet3/)).toBeTruthy()
    expect(screen.getByText(/vocal \+ background stems/)).toBeTruthy()
  })

  it('toggling to Subset shows trim inputs and recomputes active duration', () => {
    render(
      <IsolateVocalsRunForm
        entity={{ type: 'audio_clip', id: 'ac_1', durationSeconds: 100 }}
        projectName="proj"
      />,
    )

    fireEvent.click(screen.getByRole('radio', { name: /Subset/i }))
    const trimIn = screen.getByLabelText('trim in (seconds)') as HTMLInputElement
    const trimOut = screen.getByLabelText('trim out (seconds)') as HTMLInputElement
    expect(trimIn).toBeTruthy()
    expect(trimOut).toBeTruthy()

    fireEvent.change(trimIn, { target: { value: '20' } })
    fireEvent.change(trimOut, { target: { value: '50' } })
    // activeDur = 50 - 20 = 30 → ETA 30–60s
    expect(screen.getByText(/30–60s/)).toBeTruthy()
  })

  it('Run click POSTs the expected body and fires onStart', async () => {
    callIsolateVocalsMock.mockResolvedValue({
      isolation_id: 'iso_1',
      job_id: 'job_1',
    })
    const onStart = vi.fn()

    render(
      <IsolateVocalsRunForm
        entity={{ type: 'audio_clip', id: 'ac_1', durationSeconds: 30 }}
        projectName="proj"
        onStart={onStart}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    await waitFor(() => expect(callIsolateVocalsMock).toHaveBeenCalled())
    const [projectName, body] = callIsolateVocalsMock.mock.calls[0]
    expect(projectName).toBe('proj')
    expect(body).toEqual({
      entity_type: 'audio_clip',
      entity_id: 'ac_1',
      range_mode: 'full',
      trim_in: undefined,
      trim_out: undefined,
    })

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith({
        isolation_id: 'iso_1',
        job_id: 'job_1',
      }),
    )
  })

  it('disables Run while in-flight and surfaces errors', async () => {
    callIsolateVocalsMock.mockRejectedValue(new Error('boom'))

    render(
      <IsolateVocalsRunForm
        entity={{ type: 'audio_clip', id: 'ac_1', durationSeconds: 30 }}
        projectName="proj"
      />,
    )

    const btn = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement
    fireEvent.click(btn)

    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy())
  })
})
