/**
 * Two-tier frame cache for transition video playback:
 * - In-memory: Map<key, ImageBitmap[]> for the render loop
 * - IndexedDB: persists decoded frames across page reloads
 */

const DB_NAME = 'beatlab-frame-cache'
const STORE_NAME = 'frames'
const DB_VERSION = 1
const PREVIEW_WIDTH = 256
const PREVIEW_HEIGHT = 144
const TARGET_FPS = 24

// ── IndexedDB helpers ─────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function getFromDb(key: string): Promise<Blob[] | null> {
  const db = await openDb()
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => resolve(null)
  })
}

async function putToDb(key: string, blobs: Blob[]): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(blobs, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── Video frame decoder ───────────────────────────────────────────

async function decodeVideoFrames(videoUrl: string): Promise<ImageBitmap[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.preload = 'auto'
    video.playsInline = true

    video.onloadedmetadata = async () => {
      const duration = video.duration
      if (!isFinite(duration) || duration <= 0) {
        resolve([])
        return
      }

      const frameCount = Math.ceil(duration * TARGET_FPS)
      const frames: ImageBitmap[] = []

      // Use an offscreen canvas to draw and capture frames
      const canvas = new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve([])
        return
      }

      for (let i = 0; i < frameCount; i++) {
        const time = i / TARGET_FPS
        video.currentTime = time

        await new Promise<void>((res) => {
          video.onseeked = () => res()
        })

        ctx.drawImage(video, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT)
        const bitmap = await createImageBitmap(canvas)
        frames.push(bitmap)
      }

      video.src = ''
      resolve(frames)
    }

    video.onerror = () => reject(new Error(`Failed to load video: ${videoUrl}`))
    video.src = videoUrl
  })
}

async function bitmapsToBlobs(bitmaps: ImageBitmap[]): Promise<Blob[]> {
  const canvas = new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT)
  const ctx = canvas.getContext('2d')!
  const blobs: Blob[] = []
  for (const bmp of bitmaps) {
    ctx.drawImage(bmp, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
    blobs.push(blob)
  }
  return blobs
}

async function blobsToBitmaps(blobs: Blob[]): Promise<ImageBitmap[]> {
  return Promise.all(blobs.map((b) => createImageBitmap(b)))
}

// ── Frame Cache ───────────────────────────────────────────────────

type CacheEntry = {
  frames: ImageBitmap[]
  fps: number
  duration: number
}

const memoryCache = new Map<string, CacheEntry>()
const loadingKeys = new Set<string>()

export function getFrames(key: string): CacheEntry | null {
  return memoryCache.get(key) ?? null
}

export function getFrameAtProgress(key: string, progress: number): ImageBitmap | null {
  const entry = memoryCache.get(key)
  if (!entry || entry.frames.length === 0) return null
  const idx = Math.min(Math.floor(progress * entry.frames.length), entry.frames.length - 1)
  return entry.frames[Math.max(0, idx)]
}

export function isLoaded(key: string): boolean {
  return memoryCache.has(key)
}

export function isLoading(key: string): boolean {
  return loadingKeys.has(key)
}

/**
 * Invalidate a cache entry — forces re-decode on next preload.
 */
export async function invalidateEntry(key: string) {
  const entry = memoryCache.get(key)
  if (entry) {
    entry.frames.forEach((f) => f.close())
    memoryCache.delete(key)
  }
  loadingKeys.delete(key)
  // Also remove from IndexedDB
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(key)
  } catch {}
}

/**
 * Preload a transition's video frames into the cache.
 * First checks IndexedDB, then decodes from the video URL if needed.
 */
export async function preloadTransition(key: string, videoUrl: string): Promise<void> {
  if (memoryCache.has(key) || loadingKeys.has(key)) return
  loadingKeys.add(key)

  try {
    // Try IndexedDB first
    const cached = await getFromDb(key)
    if (cached && cached.length > 0) {
      const bitmaps = await blobsToBitmaps(cached)
      memoryCache.set(key, {
        frames: bitmaps,
        fps: TARGET_FPS,
        duration: bitmaps.length / TARGET_FPS,
      })
      loadingKeys.delete(key)
      return
    }

    // Decode from video
    const frames = await decodeVideoFrames(videoUrl)
    if (frames.length > 0) {
      memoryCache.set(key, {
        frames,
        fps: TARGET_FPS,
        duration: frames.length / TARGET_FPS,
      })

      // Persist to IndexedDB in background
      bitmapsToBlobs(frames).then((blobs) => putToDb(key, blobs)).catch(() => {})
    }
  } catch {
    // Failed to decode — will try again next time
  } finally {
    loadingKeys.delete(key)
  }
}

/**
 * Preload a keyframe image into the cache (single frame).
 */
export async function preloadKeyframeImage(key: string, imageUrl: string): Promise<void> {
  if (memoryCache.has(key) || loadingKeys.has(key)) return
  loadingKeys.add(key)

  try {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject()
      img.src = imageUrl
    })
    const bitmap = await createImageBitmap(img, { resizeWidth: PREVIEW_WIDTH, resizeHeight: PREVIEW_HEIGHT })
    memoryCache.set(key, { frames: [bitmap], fps: 1, duration: Infinity })
  } catch {
    // Failed to load
  } finally {
    loadingKeys.delete(key)
  }
}

/**
 * Evict entries far from the current playhead to free memory.
 */
export function evictFarEntries(keepKeys: Set<string>) {
  for (const key of memoryCache.keys()) {
    if (!keepKeys.has(key)) {
      const entry = memoryCache.get(key)
      entry?.frames.forEach((f) => f.close())
      memoryCache.delete(key)
    }
  }
}
