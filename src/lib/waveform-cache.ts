/**
 * Fetches float16 peak arrays from the backend and caches them in-memory.
 *
 * Endpoint: GET /api/projects/:name/audio-clips/:id/peaks?resolution=N
 * Returns: raw bytes, little-endian float16 (2 bytes per peak), length =
 * ceil(duration * resolution).
 *
 * Concurrent requests for the same key de-dupe to a single in-flight fetch.
 * The cache is unbounded (peak arrays are tiny — ~6 KB per 8-second clip at
 * 400 peaks/sec); fine for editor-session lifetimes.
 */

const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

type CacheKey = `${string}:${string}:${number}`

const cache = new Map<CacheKey, Float32Array>()
const inflight = new Map<CacheKey, Promise<Float32Array>>()

export async function fetchPeaks(
  project: string,
  clipId: string,
  resolution: number = 400,
): Promise<Float32Array> {
  const key: CacheKey = `${project}:${clipId}:${resolution}`
  const cached = cache.get(key)
  if (cached) return cached
  const existing = inflight.get(key)
  if (existing) return existing

  const url = `${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/audio-clips/${encodeURIComponent(clipId)}/peaks?resolution=${resolution}`
  const promise = fetch(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`peaks fetch ${res.status}`)
      const buf = await res.arrayBuffer()
      // float16 → float32 (browsers lack native Float16Array in most runtimes)
      const i16 = new Uint16Array(buf)
      const f32 = new Float32Array(i16.length)
      for (let i = 0; i < i16.length; i++) {
        f32[i] = float16ToFloat32(i16[i])
      }
      cache.set(key, f32)
      return f32
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, promise)
  return promise
}

/** Invalidate a clip's cached peaks (e.g. after source swap). */
export function invalidatePeaks(project: string, clipId: string) {
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(`${project}:${clipId}:`)) cache.delete(k)
  }
}

/**
 * Decode a single IEEE 754 half-float (uint16) to float32.
 * Based on the canonical bit-twiddling conversion.
 */
function float16ToFloat32(h: number): number {
  const s = (h & 0x8000) >> 15
  const e = (h & 0x7c00) >> 10
  const f = h & 0x03ff
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024)
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity)
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024)
}
