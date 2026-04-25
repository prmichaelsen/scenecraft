/**
 * REST + WS helpers for the generate-foley plugin.
 *
 * Shapes mirror the backend (task-145 routes):
 *   POST /api/projects/:name/plugins/generate-foley/run
 *   GET  /api/projects/:name/plugins/generate-foley/generations?entityType=&entityId=
 *   POST /api/projects/:name/plugins/generate-foley/generations/:id/retry
 *   WS: /ws/jobs (subscribe with job_id)
 */

import { getSubscribeJob, type JobSubscribeCallbacks } from '@/lib/plugin-api'

import type {
  GenerateFoleyRequest,
  GenerateFoleyResponse,
  GenerationListItem,
} from './types'

const API_URL =
  import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

// --- REST ─────────────────────────────────────────────────────────────────

export async function runFoleyGeneration(
  projectName: string,
  request: GenerateFoleyRequest,
): Promise<GenerateFoleyResponse> {
  const url = `${API_URL}/api/projects/${encodeURIComponent(projectName)}/plugins/generate-foley/run`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  return res.json()
}

export async function fetchFoleyGenerations(
  projectName: string,
  filter?: {
    entityType?: string
    entityId?: string
    limit?: number
  },
): Promise<{ generations: GenerationListItem[] }> {
  const params = new URLSearchParams()
  if (filter?.entityType) params.set('entityType', filter.entityType)
  if (filter?.entityId) params.set('entityId', filter.entityId)
  if (filter?.limit) params.set('limit', String(filter.limit))
  const qs = params.toString()
  const url = `${API_URL}/api/projects/${encodeURIComponent(projectName)}/plugins/generate-foley/generations${qs ? `?${qs}` : ''}`
  const res = await fetch(url)
  return res.json()
}

export async function retryFoleyGeneration(
  projectName: string,
  generationId: string,
): Promise<GenerateFoleyResponse> {
  const url = `${API_URL}/api/projects/${encodeURIComponent(projectName)}/plugins/generate-foley/generations/${encodeURIComponent(generationId)}/retry`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  return res.json()
}

// --- WS ──────────────────────────────────────────────────────────────────

export function subscribeFoleyJob(
  jobId: string,
  callbacks: JobSubscribeCallbacks,
): () => void {
  const subscribe = getSubscribeJob()
  return subscribe(jobId, callbacks)
}
