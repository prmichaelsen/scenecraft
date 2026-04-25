import { useEffect, useRef, useState } from 'react'
import { createAudioMixer, type AudioMixer } from '@/lib/audio-mixer'
import { setActiveAudioMixer } from '@/lib/audio-mixer-ref'
import type { AudioTrack } from '@/lib/audio-client'
import { fetchMasterBusEffects } from '@/lib/scenecraft-client'
import type { TrackEffect } from '@/lib/audio-graph'

/**
 * Event name dispatched on `window` when the backend notifies us that
 * master-bus effects were mutated (via the `master_bus_effects_changed`
 * WS message). Listeners refetch the list and call `reevaluateMasterChain`.
 * Using a window event instead of context avoids plumbing the mixer
 * instance through multiple dock panels.
 */
export const MASTER_BUS_EFFECTS_CHANGED_EVENT = 'scenecraft:master-bus-effects-changed'

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
      // Register as the active mixer so sibling dock panels (light_show etc.)
      // can tap the master-bus analysers via audio-mixer-ref without
      // prop-drilling through dockview layers.
      setActiveAudioMixer(m)
    } catch (e) {
      console.error('[useAudioMixer] createAudioMixer failed:', e)
    }
    return () => {
      setActiveAudioMixer(null)
      mixerRef.current?.dispose()
      mixerRef.current = null
      setMixer(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName])

  // Initial master-bus load + WS-driven invalidation.
  // Runs once on mount (per projectName) to seed the master chain with
  // whatever the DB says, and then subscribes to the window-level event
  // that ChatPanel dispatches when the backend sends
  // `master_bus_effects_changed`. Without this effect the mixer starts
  // with an empty chain even when the DB has master effects configured.
  useEffect(() => {
    if (typeof window === 'undefined') return

    const rebuild = () => {
      fetchMasterBusEffects(projectName)
        .then((effects) => {
          if (!mixerRef.current) return
          mixerRef.current.reevaluateMasterChain(effects as unknown as readonly TrackEffect[])
        })
        .catch((err) => {
          console.warn('[useAudioMixer] fetchMasterBusEffects failed:', err)
        })
    }

    rebuild()
    const listener = () => rebuild()
    window.addEventListener(MASTER_BUS_EFFECTS_CHANGED_EVENT, listener)
    return () => window.removeEventListener(MASTER_BUS_EFFECTS_CHANGED_EVENT, listener)
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
