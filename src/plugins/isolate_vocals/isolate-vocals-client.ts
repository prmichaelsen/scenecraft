/**
 * REST + WS helpers for the isolate_vocals plugin.
 *
 * Plugins surface-safe: all network calls go through the plugin-api layer.
 * The shapes mirror the backend (scenecraft-engine task-102):
 *   - POST /api/projects/:name/plugins/isolate_vocals/run
 *   - GET  /api/projects/:name/audio-isolations?entityType=&entityId=
 *   - job subscribe via `getSubscribeJob` for progress + multi-stem result
 */

import { getSubscribeJob } from '@/lib/plugin-api'

const API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

// ── Types ────────────────────────────────────────────────────────────────

export type EntityType = 'audio_clip' | 'transition'
export type StemType = 'vocal' | 'background'

export type IsolateKickoff = {
  isolation_id: string
  job_id: string
}

export type IsolateStem = {
  stem_type: StemType
  pool_segment_id: string
  pool_path: string
}

export type IsolateResult = {
  isolation_id: string
  stems: IsolateStem[]
}

export type IsolationStem = IsolateStem & {
  duration_seconds: number
}

export type IsolationRun = {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  model: string
  range_mode: 'full' | 'subset'
  trim_in: number | null
  trim_out: number | null
  created_at: string
  error?: string | null
  stems: IsolationStem[]
}

export type IsolateRunBody = {
  entity_type: EntityType
  entity_id: string
  range_mode?: 'full' | 'subset'
  trim_in?: number
  trim_out?: number
}

// ── REST ─────────────────────────────────────────────────────────────────

/**
 * Kick off an isolation run. Returns `{isolation_id, job_id}` on success, or
 * throws with the backend's error message.
 */
export async function callIsolateVocals(
  projectName: string,
  body: IsolateRunBody,
): Promise<IsolateKickoff> {
  const res = await fetch(
    `${API_URL}/api/projects/${encodeURIComponent(projectName)}/plugins/isolate_vocals/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  const json = await res.json()
  if (json && json.error) throw new Error(json.error)
  return { isolation_id: json.isolation_id, job_id: json.job_id }
}

/**
 * List isolation runs for an entity (newest first), each with its stems.
 */
export async function fetchIsolations(
  projectName: string,
  entityType: EntityType,
  entityId: string,
): Promise<IsolationRun[]> {
  const url = new URL(
    `${API_URL}/api/projects/${encodeURIComponent(projectName)}/audio-isolations`,
  )
  url.searchParams.set('entityType', entityType)
  url.searchParams.set('entityId', entityId)
  const res = await fetch(url.toString())
  const json = await res.json()
  return json.isolations || []
}

// ── WS job subscription ───────────────────────────────────────────────────

export type SubscribeCallbacks = {
  onProgress?: (pct: number, detail: string) => void
  onCompleted?: (result: IsolateResult) => void
  onFailed?: (error: string) => void
}

/**
 * Subscribe to a single job's progress + terminal state. Returns an
 * unsubscribe function. Thin adapter over the shared `getSubscribeJob`
 * helper from plugin-api (which itself wraps `useScenecraftSocket`).
 */
export function subscribeIsolationJob(
  jobId: string,
  cbs: SubscribeCallbacks,
): () => void {
  const subscribe = getSubscribeJob()
  return subscribe(jobId, {
    onProgress: (p) =>
      cbs.onProgress?.(
        p.total > 0 ? p.completed / p.total : 0,
        p.detail || '',
      ),
    onCompleted: (result) => cbs.onCompleted?.(result as IsolateResult),
    onFailed: (err) => cbs.onFailed?.(err),
  })
}
