/**
 * MusicGenerationsPanel — task-132 scaffolding.
 *
 * This file lands in task-131 as the minimum shape task-131 needs
 * (`host.registerPanel` requires a component reference at activate
 * time). Task-132 fleshes out the form, run list, Reuse/Retry, credits
 * header, context filter, and drag payload.
 */

import { useEffect, useState } from 'react'

import { getCredits, listGenerations, useMusicGenerationEvents } from './generate-music-client'
import type { CreditsResponse, Generation } from './types'

type Props = {
  projectName?: string
}

// The editor shell passes projectName via the panel registry's props
// plumbing; the scaffold defaults to a no-op render when it's missing.
export function MusicGenerationsPanel({ projectName }: Props) {
  const [generations, setGenerations] = useState<Generation[]>([])
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refetch() {
    if (!projectName) return
    setLoading(true)
    setError(null)
    try {
      const [gens, cr] = await Promise.all([
        listGenerations(projectName),
        getCredits(projectName),
      ])
      setGenerations(gens)
      setCredits(cr)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName])

  useMusicGenerationEvents(projectName || '', () => {
    void refetch()
  })

  if (!projectName) {
    return <div className="p-3 text-xs text-gray-500">No project loaded.</div>
  }

  return (
    <div className="h-full flex flex-col text-xs">
      <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between">
        <span className="font-semibold">Music Generations</span>
        <span className="text-gray-400">
          {credits?.credits != null ? `${credits.credits} credits` : credits?.error || '—'}
        </span>
      </div>
      {error && <div className="px-3 py-2 text-red-400">{error}</div>}
      <div className="flex-1 overflow-auto p-3">
        {loading && generations.length === 0 && <div className="text-gray-500">Loading…</div>}
        {!loading && generations.length === 0 && (
          <div className="text-gray-500">No music generations yet. (Task-132 will wire the run form.)</div>
        )}
        {generations.map((gen) => (
          <div key={gen.id} className="mb-2 p-2 border border-gray-700 rounded">
            <div className="text-gray-400">{gen.created_at} · {gen.action} · {gen.status}</div>
            <div className="text-white">{gen.style || '(no style)'}</div>
            {gen.tracks.length > 0 && (
              <div className="mt-1 text-gray-500">{gen.tracks.length} track(s)</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
