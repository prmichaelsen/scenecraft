import { useRef, useEffect, useState, type MutableRefObject } from 'react'
import WaveSurfer from 'wavesurfer.js'

type AudioTrackProps = {
  audioUrl: string
  pxPerSec: number
  onTimeUpdate: (time: number) => void
  onDurationChange: (duration: number) => void
  onPlayingChange: (playing: boolean) => void
  seekRef: MutableRefObject<((time: number) => void) | null>
  playPauseRef: MutableRefObject<(() => void) | null>
  audioElRef?: MutableRefObject<HTMLAudioElement | null>
}

// IndexedDB cache for waveform peaks
const DB_NAME = 'beatlab-waveform-cache'
const STORE_NAME = 'peaks'

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function getCachedPeaks(url: string): Promise<{ peaks: Float32Array[]; duration: number } | null> {
  try {
    const db = await openCacheDb()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(url)
      req.onsuccess = () => {
        const val = req.result
        if (val?.peaks && val?.duration) {
          resolve({ peaks: val.peaks.map((p: ArrayBuffer) => new Float32Array(p)), duration: val.duration })
        } else {
          resolve(null)
        }
      }
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function cachePeaks(url: string, peaks: Float32Array[], duration: number): Promise<void> {
  try {
    const db = await openCacheDb()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    // Store as plain ArrayBuffers (structured-cloneable)
    tx.objectStore(STORE_NAME).put(
      { peaks: peaks.map((p) => p.buffer.slice(0)), duration },
      url
    )
  } catch {
    // Cache failures are non-fatal
  }
}

export function AudioTrack({
  audioUrl,
  pxPerSec,
  onTimeUpdate,
  onDurationChange,
  onPlayingChange,
  seekRef,
  playPauseRef,
  audioElRef,
}: AudioTrackProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    if (!containerRef.current) return
    let destroyed = false

    setLoading(true)
    setProgress(0)

    async function init() {
      const cached = await getCachedPeaks(audioUrl)

      if (destroyed || !containerRef.current) return

      // Create audio element for early playback — browser can play before waveform decodes
      const audio = new Audio(audioUrl)
      audio.crossOrigin = 'anonymous'
      audio.preload = 'auto'
      if (audioElRef) audioElRef.current = audio

      // Enable playback as soon as audio is buffered (before waveform is ready)
      audio.addEventListener('canplay', () => {
        if (destroyed) return
        playPauseRef.current = () => {
          if (audio.paused) { audio.play().catch(() => {}); onPlayingChange(true) }
          else { audio.pause(); onPlayingChange(false) }
        }
        seekRef.current = (time: number) => {
          audio.currentTime = time
          onTimeUpdate(time)
        }
      }, { once: true })

      audio.addEventListener('durationchange', () => {
        if (audio.duration && isFinite(audio.duration)) {
          onDurationChange(audio.duration)
        }
      })

      audio.addEventListener('timeupdate', () => {
        onTimeUpdate(audio.currentTime)
      })

      const ws = WaveSurfer.create({
        container: containerRef.current!,
        media: audio,
        waveColor: '#4a5568',
        progressColor: '#3b82f6',
        cursorColor: 'transparent',
        height: 'auto',
        fillParent: false,
        minPxPerSec: pxPerSec,
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
        normalize: true,
        interact: false,
        // If we have cached peaks, use them for instant rendering
        ...(cached ? { peaks: cached.peaks, duration: cached.duration } : {}),
      })

      ws.on('loading', (pct) => setProgress(pct))
      ws.on('ready', () => {
        if (destroyed) return
        setLoading(false)

        // Once waveform is decoded, upgrade seek/play to use WaveSurfer for waveform sync
        seekRef.current = (time: number) => {
          ws.setTime(time)
          onTimeUpdate(time)
        }
        playPauseRef.current = () => ws.playPause()

        const dur = ws.getDuration()
        onDurationChange(dur)

        // Cache peaks for next time (only if we didn't load from cache)
        if (!cached) {
          const peaks = ws.exportPeaks()
          cachePeaks(audioUrl, peaks as Float32Array[], dur)
        }
      })
      ws.on('timeupdate', (time) => onTimeUpdate(time))
      ws.on('play', () => onPlayingChange(true))
      ws.on('pause', () => onPlayingChange(false))

      wsRef.current = ws
    }

    init()

    return () => {
      destroyed = true
      wsRef.current?.destroy()
      wsRef.current = null
      seekRef.current = null
      playPauseRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl])

  useEffect(() => {
    if (wsRef.current) {
      wsRef.current.setOptions({ minPxPerSec: pxPerSec })
    }
  }, [pxPerSec])

  return (
    <div ref={containerRef} className="h-full relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950/80 z-10">
          <div className="text-xs text-gray-500">
            Loading waveform... {progress}%
          </div>
        </div>
      )}
    </div>
  )
}
