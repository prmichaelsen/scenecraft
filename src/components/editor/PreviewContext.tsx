import { createContext, useContext, useState, useRef, useCallback, type ReactNode, type MutableRefObject } from 'react'
import type { PreviewViewportHandle } from './PreviewViewport'

export type HoverVideoState = {
  url: string
  scrubProgress: number | null // null = auto-play, 0-1 = scrub position
} | null

type PreviewContextValue = {
  hoverPreviewUrl: string | null
  setHoverPreviewUrl: (url: string | null) => void
  hoverVideo: HoverVideoState
  setHoverVideo: (state: HoverVideoState) => void
  previewRef: MutableRefObject<PreviewViewportHandle | null>
}

const PreviewContext = createContext<PreviewContextValue | null>(null)

export function usePreview() {
  const ctx = useContext(PreviewContext)
  if (!ctx) throw new Error('usePreview must be used within PreviewProvider')
  return ctx
}

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [hoverPreviewUrl, setHoverPreviewUrlRaw] = useState<string | null>(null)
  const [hoverVideo, setHoverVideoRaw] = useState<HoverVideoState>(null)
  const hoverClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverVideoClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewRef = useRef<PreviewViewportHandle | null>(null)

  const setHoverPreviewUrl = useCallback((url: string | null) => {
    if (hoverClearTimer.current) { clearTimeout(hoverClearTimer.current); hoverClearTimer.current = null }
    if (url) {
      setHoverPreviewUrlRaw(url)
    } else {
      hoverClearTimer.current = setTimeout(() => setHoverPreviewUrlRaw(null), 100)
    }
  }, [])

  const setHoverVideo = useCallback((state: HoverVideoState) => {
    if (hoverVideoClearTimer.current) { clearTimeout(hoverVideoClearTimer.current); hoverVideoClearTimer.current = null }
    if (state) {
      setHoverVideoRaw(state)
    } else {
      hoverVideoClearTimer.current = setTimeout(() => setHoverVideoRaw(null), 100)
    }
  }, [])

  return (
    <PreviewContext.Provider value={{
      hoverPreviewUrl,
      setHoverPreviewUrl,
      hoverVideo,
      setHoverVideo,
      previewRef,
    }}>
      {children}
    </PreviewContext.Provider>
  )
}

export { PreviewContext }
