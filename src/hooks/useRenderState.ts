/**
 * Tracks the preview render state per timeline bucket for the
 * `<RenderStateBar>`. Initial snapshot comes from
 * `GET /api/projects/:name/render-state`; live updates come from polling
 * (2s interval) until task-37 (unified WS) lands and we can switch to
 * `render-state.update` message subscriptions.
 */
import { useEffect, useState } from 'react'

export type BucketState = 'unrendered' | 'rendering' | 'cached' | 'stale'

export type RenderBucket = {
  t_start: number
  t_end: number
  state: BucketState
}

export type RenderStateSnapshot = {
  bucket_seconds: number
  duration_seconds: number
  buckets: RenderBucket[]
}

const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

const POLL_INTERVAL_MS = 2000
/**
 * How often the polling fallback refreshes the snapshot. 2s matches
 * FRAGMENT_SECONDS on the backend — anything faster produces a worst-
 * case N buckets × 2Hz update load with no perceived benefit (buckets
 * can't transition states faster than they render).
 */

export function useRenderState(projectName: string): {
  snapshot: RenderStateSnapshot | null
  error: string | null
} {
  const [snapshot, setSnapshot] = useState<RenderStateSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const fetchSnapshot = async () => {
      try {
        const res = await fetch(
          `${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(projectName)}/render-state`,
          { credentials: 'include' },
        )
        if (cancelled) return
        if (!res.ok) {
          setError(`render-state ${res.status}`)
          return
        }
        const data = (await res.json()) as RenderStateSnapshot
        if (cancelled) return
        setSnapshot(data)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError((err as Error)?.message ?? String(err))
      }
    }

    fetchSnapshot()
    const id = setInterval(fetchSnapshot, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [projectName])

  return { snapshot, error }
}
