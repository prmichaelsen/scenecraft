import { createContext, useContext, useState, useRef, type ReactNode, type MutableRefObject } from 'react'

// ── CurrentTimeContext — high-frequency playhead signal ─────────────────
//
// `currentTime` ticks ~20Hz during playback (driven by audio.timeupdate).
// Split out from the lower-frequency playback controls so consumers of
// isPlaying / refs don't re-render on every tick.

type CurrentTimeContextValue = {
  currentTime: number
  setCurrentTime: (t: number) => void
}

const CurrentTimeContext = createContext<CurrentTimeContextValue | null>(null)

export function useCurrentTime() {
  const ctx = useContext(CurrentTimeContext)
  if (!ctx) throw new Error('useCurrentTime must be used within CurrentTimeProvider')
  return ctx
}

// ── PlaybackStateContext — isPlaying toggle + action refs ───────────────
//
// `isPlaying` changes ~per user gesture. Refs are stable across renders.
// Consumers of this context do NOT re-render on currentTime ticks.

type PlaybackStateContextValue = {
  isPlaying: boolean
  setIsPlaying: (p: boolean) => void
  seekRef: MutableRefObject<((time: number) => void) | null>
  playPauseRef: MutableRefObject<(() => void) | null>
  audioElRef: MutableRefObject<HTMLAudioElement | null>
}

const PlaybackStateContext = createContext<PlaybackStateContextValue | null>(null)

export function usePlaybackState() {
  const ctx = useContext(PlaybackStateContext)
  if (!ctx) throw new Error('usePlaybackState must be used within CurrentTimeProvider')
  return ctx
}

export function CurrentTimeProvider({ children }: { children: ReactNode }) {
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const seekRef = useRef<((time: number) => void) | null>(null)
  const playPauseRef = useRef<(() => void) | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)

  return (
    <PlaybackStateContext.Provider value={{
      isPlaying,
      setIsPlaying,
      seekRef,
      playPauseRef,
      audioElRef,
    }}>
      <CurrentTimeContext.Provider value={{ currentTime, setCurrentTime }}>
        {children}
      </CurrentTimeContext.Provider>
    </PlaybackStateContext.Provider>
  )
}
