import { createContext, useContext, useState, useRef, type ReactNode, type MutableRefObject } from 'react'

type CurrentTimeContextValue = {
  currentTime: number
  setCurrentTime: (t: number) => void
  isPlaying: boolean
  setIsPlaying: (p: boolean) => void
  seekRef: MutableRefObject<((time: number) => void) | null>
  playPauseRef: MutableRefObject<(() => void) | null>
  audioElRef: MutableRefObject<HTMLAudioElement | null>
}

const CurrentTimeContext = createContext<CurrentTimeContextValue | null>(null)

export function useCurrentTime() {
  const ctx = useContext(CurrentTimeContext)
  if (!ctx) throw new Error('useCurrentTime must be used within CurrentTimeProvider')
  return ctx
}

export function CurrentTimeProvider({ children }: { children: ReactNode }) {
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const seekRef = useRef<((time: number) => void) | null>(null)
  const playPauseRef = useRef<(() => void) | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)

  return (
    <CurrentTimeContext.Provider value={{
      currentTime,
      setCurrentTime,
      isPlaying,
      setIsPlaying,
      seekRef,
      playPauseRef,
      audioElRef,
    }}>
      {children}
    </CurrentTimeContext.Provider>
  )
}
