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

// ── Pool peaks ────────────────────────────────────────────────────────────

/**
 * Fetch float16-encoded peak data for a raw pool_segment. Returns a
 * Float32Array of interleaved min/max values (length = 2 * resolution). Used
 * by AudioIsolationsPanel's stem mini-waveforms — stems are bare
 * pool_segments, not audio_clips, so the existing clip-keyed peaks route
 * can't serve them.
 */
export async function fetchPoolPeaks(
  projectName: string,
  poolSegmentId: string,
  resolution = 200,
): Promise<Float32Array> {
  const url = `${API_URL}/api/projects/${encodeURIComponent(projectName)}/pool/${encodeURIComponent(poolSegmentId)}/peaks?resolution=${resolution}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`peaks fetch failed: ${res.status}`)
  const buf = await res.arrayBuffer()
  return decodeFloat16ToFloat32(buf)
}

/**
 * Decode a float16 buffer (raw big-endian-interleaved min/max pairs, as
 * produced by scenecraft's ``compute_peaks``) into a plain Float32Array.
 * JavaScript has no native float16 decoder; decode manually.
 */
function decodeFloat16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer)
  const n = view.byteLength / 2
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = float16FromBits(view.getUint16(i * 2, false))
  }
  return out
}

function float16FromBits(h: number): number {
  const sign = (h & 0x8000) >> 15
  const exponent = (h & 0x7c00) >> 10
  const fraction = h & 0x03ff
  if (exponent === 0) {
    return (sign ? -1 : 1) * Math.pow(2, -14) * (fraction / 1024)
  }
  if (exponent === 0x1f) {
    return fraction ? NaN : (sign ? -1 : 1) * Infinity
  }
  return (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
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
