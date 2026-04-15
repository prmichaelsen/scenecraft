import { createContext, useContext, useState, useRef, useCallback, type ReactNode, type MutableRefObject } from 'react'
import type { TrackLayer } from './BeatEffectPreview'

export type BeatEffectPreviewHandle = {
  getCanvas: () => HTMLCanvasElement | null
}

type CrossfadeData = { frameA: ImageBitmap | null; frameB: ImageBitmap | null; blendFactor: number }

type PreviewContextValue = {
  crossfadeData: CrossfadeData
  trackLayers: TrackLayer[]
  isTransitionLoading: boolean
  hoverPreviewUrl: string | null
  setHoverPreviewUrl: (url: string | null) => void
  previewRef: MutableRefObject<BeatEffectPreviewHandle | null>
  // Called by Timeline to push computed preview data up
  updatePreview: (data: { crossfadeData: CrossfadeData; trackLayers: TrackLayer[]; isTransitionLoading: boolean }) => void
}

const PreviewContext = createContext<PreviewContextValue | null>(null)

export function usePreview() {
  const ctx = useContext(PreviewContext)
  if (!ctx) throw new Error('usePreview must be used within PreviewProvider')
  return ctx
}

const EMPTY_CROSSFADE: CrossfadeData = { frameA: null, frameB: null, blendFactor: 0 }
const EMPTY_LAYERS: TrackLayer[] = []

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [crossfadeData, setCrossfadeData] = useState<CrossfadeData>(EMPTY_CROSSFADE)
  const [trackLayers, setTrackLayers] = useState<TrackLayer[]>(EMPTY_LAYERS)
  const [isTransitionLoading, setIsTransitionLoading] = useState(false)
  const [hoverPreviewUrl, setHoverPreviewUrlRaw] = useState<string | null>(null)
  const hoverClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewRef = useRef<BeatEffectPreviewHandle | null>(null)

  const setHoverPreviewUrl = useCallback((url: string | null) => {
    if (hoverClearTimer.current) { clearTimeout(hoverClearTimer.current); hoverClearTimer.current = null }
    if (url) {
      setHoverPreviewUrlRaw(url)
    } else {
      hoverClearTimer.current = setTimeout(() => setHoverPreviewUrlRaw(null), 100)
    }
  }, [])

  const updatePreview = useCallback((data: { crossfadeData: CrossfadeData; trackLayers: TrackLayer[]; isTransitionLoading: boolean }) => {
    setCrossfadeData(data.crossfadeData)
    setTrackLayers(data.trackLayers)
    setIsTransitionLoading(data.isTransitionLoading)
  }, [])

  return (
    <PreviewContext.Provider value={{
      crossfadeData,
      trackLayers,
      isTransitionLoading,
      hoverPreviewUrl,
      setHoverPreviewUrl,
      previewRef,
      updatePreview,
    }}>
      {children}
    </PreviewContext.Provider>
  )
}

export { PreviewContext }
