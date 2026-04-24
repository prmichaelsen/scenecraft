/**
 * REST + WS helpers for the generate-music plugin — thin wrappers over
 * `/api/projects/:name/plugins/generate-music/...` endpoints (task-130)
 * and the shared `/ws/jobs` stream (M11 task-101 seam).
 *
 * Mirrors the isolate_vocals client pattern: plain `fetch` + the
 * `getSubscribeJob` helper from `@/lib/plugin-api`.
 */

import { getSubscribeJob } from '@/lib/plugin-api'
import { useScenecraftSocket } from '@/hooks/useScenecraftSocket'
import { useEffect, useRef } from 'react'

import type {
  CreditsResponse,
  Generation,
  RunPayload,
  RunResponse,
} from './types'

const API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

function pluginUrl(projectName: string, suffix: string): string {
  return `${API_URL}/api/projects/${encodeURIComponent(projectName)}/plugins/generate-music${suffix}`
}

// ── REST ─────────────────────────────────────────────────────────────────

/**
 * Kick off a generation. Returns `{generation_id, task_ids, job_id}` on
 * success or throws with the backend's error message.
 */
export async function runGeneration(
  projectName: string,
  payload: RunPayload,
): Promise<RunResponse> {
  const res = await fetch(pluginUrl(projectName, '/run'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const json = await res.json()
  if (json && json.error) throw new Error(json.error)
  return { generation_id: json.generation_id, task_ids: json.task_ids, job_id: json.job_id }
}

/**
 * List generations for the project. Optional entity filter narrows to a
 * single (entity_type, entity_id) pair; spec requires both to be present
 * for the filter to apply.
 */
export async function listGenerations(
  projectName: string,
  filter?: { entityType?: string; entityId?: string },
): Promise<Generation[]> {
  const url = new URL(pluginUrl(projectName, '/generations'))
  if (filter?.entityType) url.searchParams.set('entityType', filter.entityType)
  if (filter?.entityId) url.searchParams.set('entityId', filter.entityId)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`generations fetch failed: ${res.status}`)
  const json = await res.json()
  return (json.generations || []) as Generation[]
}

/**
 * Retry a failed generation — creates a new row with `reused_from` set.
 * Backend enforces "failed only"; a non-failed id surfaces as a thrown
 * error here with the backend's message.
 */
export async function retryGeneration(
  projectName: string,
  generationId: string,
): Promise<RunResponse> {
  const res = await fetch(
    pluginUrl(projectName, `/generations/${encodeURIComponent(generationId)}/retry`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  )
  const json = await res.json()
  if (json && json.error) throw new Error(json.error)
  return { generation_id: json.generation_id, task_ids: json.task_ids, job_id: json.job_id }
}

/**
 * Fetch the Musicful credit balance. `?refresh=1` busts the backend's
 * short-TTL cache — the panel uses that after a run completes.
 */
export async function getCredits(
  projectName: string,
  opts?: { refresh?: boolean },
): Promise<CreditsResponse> {
  const url = new URL(pluginUrl(projectName, '/credits'))
  if (opts?.refresh) url.searchParams.set('refresh', '1')
  const res = await fetch(url.toString())
  return (await res.json()) as CreditsResponse
}

// ── WS ───────────────────────────────────────────────────────────────────

export type MusicJobEvent =
  | { type: 'job_started'; jobId: string; generationId: string }
  | { type: 'job_progress'; jobId: string; generationId: string; completed: number; total: number }
  | { type: 'job_completed'; jobId: string; generationId: string; result: unknown }
  | { type: 'job_failed'; jobId: string; generationId: string; error: string }

/**
 * React hook: subscribe to generate_music job events for the whole
 * project. The WS protocol attaches `jobType` only to `job_started`;
 * progress/completed/failed events carry just `jobId`. To filter
 * cleanly we track ids started with jobType='generate_music' in a ref
 * and only surface later events whose jobId is in that set.
 *
 * `projectName` isn't forwarded to the socket (it's a process-global
 * connection) — accepted here for future-proofing if WS ever becomes
 * per-project.
 */
export function useMusicGenerationEvents(
  _projectName: string,
  onEvent: (event: MusicJobEvent) => void,
): void {
  const { subscribeAll } = useScenecraftSocket()
  // Latest-callback ref so the effect doesn't resubscribe on every
  // parent render when onEvent is an inline arrow.
  const cbRef = useRef(onEvent)
  useEffect(() => { cbRef.current = onEvent }, [onEvent])

  useEffect(() => {
    const ourJobIds = new Map<string, string>() // jobId -> generationId
    return subscribeAll((raw) => {
      const msg = raw as unknown as {
        type?: string
        jobType?: string
        jobId?: string
        meta?: { generationId?: string }
        completed?: number
        total?: number
        result?: unknown
        error?: string
      }
      if (!msg.jobId) return

      if (msg.type === 'job_started' && msg.jobType === 'generate_music') {
        const generationId = msg.meta?.generationId
        if (!generationId) return
        ourJobIds.set(msg.jobId, generationId)
        cbRef.current({ type: 'job_started', jobId: msg.jobId, generationId })
        return
      }

      const generationId = ourJobIds.get(msg.jobId)
      if (!generationId) return

      if (msg.type === 'job_progress') {
        cbRef.current({
          type: 'job_progress',
          jobId: msg.jobId,
          generationId,
          completed: msg.completed ?? 0,
          total: msg.total ?? 0,
        })
      } else if (msg.type === 'job_completed') {
        cbRef.current({ type: 'job_completed', jobId: msg.jobId, generationId, result: msg.result })
        ourJobIds.delete(msg.jobId)
      } else if (msg.type === 'job_failed') {
        cbRef.current({ type: 'job_failed', jobId: msg.jobId, generationId, error: msg.error || 'unknown' })
        ourJobIds.delete(msg.jobId)
      }
    })
  }, [subscribeAll])
}

/**
 * Single-job subscribe — same as useMusicGenerationEvents but scoped to
 * one jobId. Useful for per-run progress bars inside a generation card.
 */
export function subscribeMusicJob(
  jobId: string,
  cbs: {
    onProgress?: (completed: number, total: number) => void
    onCompleted?: (result: unknown) => void
    onFailed?: (error: string) => void
  },
): () => void {
  const subscribe = getSubscribeJob()
  return subscribe(jobId, {
    onProgress: (p) => cbs.onProgress?.(p.completed, p.total),
    onCompleted: (result) => cbs.onCompleted?.(result),
    onFailed: (error) => cbs.onFailed?.(error),
  })
}
