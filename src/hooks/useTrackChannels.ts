import { useEffect, useState } from 'react'
import type { AudioMixer } from '@/lib/audio-mixer'

// Poll at ~2 Hz. Buffer decodes finish milliseconds-to-seconds after a
// clip is added; a half-second lag before the bar count settles is fine
// and avoids wiring event plumbing through the mixer for a display concern.
const POLL_MS = 500

/**
 * Read a track's channel count from the mixer, re-polling periodically so
 * the value settles after async buffer decodes finish. Returns 2 while
 * the mixer is null so the meter renders stereo by default.
 */
export function useTrackChannels(mixer: AudioMixer | null, trackId: string): 1 | 2 {
  const [channels, setChannels] = useState<1 | 2>(2)
  useEffect(() => {
    if (!mixer) {
      setChannels(2)
      return
    }
    const read = () => {
      const next = mixer.getTrackChannelCount(trackId)
      setChannels((prev) => (prev === next ? prev : next))
    }
    read()
    const id = window.setInterval(read, POLL_MS)
    return () => window.clearInterval(id)
  }, [mixer, trackId])
  return channels
}
