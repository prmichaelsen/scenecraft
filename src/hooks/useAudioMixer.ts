import { useEffect, useRef, useState } from 'react'
import { createAudioMixer, type AudioMixer } from '@/lib/audio-mixer'
import type { AudioTrack } from '@/lib/audio-client'

/**
 * React wrapper around the WebAudio streaming mixer.
 *
 * Lifecycle:
 *  - Mixer is created on mount (client-only; SSR returns null).
 *  - `isPlaying` prop drives `mixer.play()` / `mixer.pause()`.
 *  - `currentTime` prop drives `mixer.seek()` — Timeline's existing per-frame
 *    playhead updates are the mixer's scheduling tick.
 *  - `tracks` prop changes drive `mixer.rebuild()`.
 *  - Unmount calls `mixer.dispose()`.
 *
 * Returns the mixer ref so the parent can call `updateClip(id)` / `updateTrack(id)`
 * directly in response to property-panel edits for live audible feedback.
 */
export function useAudioMixer(
  projectName: string,
  tracks: AudioTrack[],
  isPlaying: boolean,
  currentTime: number,
): AudioMixer | null {
  const [mixer, setMixer] = useState<AudioMixer | null>(null)
  const mixerRef = useRef<AudioMixer | null>(null)

  // Mount: create once per (projectName) — project change means full rebuild
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const m = createAudioMixer(projectName, tracks)
      mixerRef.current = m
      setMixer(m)
    } catch (e) {
      console.error('[useAudioMixer] createAudioMixer failed:', e)
    }
    return () => {
      mixerRef.current?.dispose()
      mixerRef.current = null
      setMixer(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName])

  // Track list changed: rebuild graph
  useEffect(() => {
    mixerRef.current?.rebuild(tracks)
  }, [tracks])

  // Seek on every playhead change. Runs BEFORE the play/pause effect below
  // so that when a render batch flips both (e.g. user scrubs then presses
  // play in the same frame), `play()` sees the updated lastPlayhead instead
  // of a stale one — otherwise audio starts from the previous position.
  useEffect(() => {
    mixerRef.current?.seek(currentTime)
  }, [currentTime])

  // Play/pause
  useEffect(() => {
    if (!mixerRef.current) return
    if (isPlaying) mixerRef.current.play()
    else mixerRef.current.pause()
  }, [isPlaying])

  return mixer
}
