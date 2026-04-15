import { createContext, useContext, type MutableRefObject } from 'react'
import type { TrackLayer } from './BeatEffectPreview'

export type BeatEffectPreviewHandle = {
  getCanvas: () => HTMLCanvasElement | null
}

type PreviewContextValue = {
  crossfadeData: { frameA: ImageBitmap | null; frameB: ImageBitmap | null; blendFactor: number }
  trackLayers: TrackLayer[]
  isTransitionLoading: boolean
  hoverPreviewUrl: string | null
  setHoverPreviewUrl: (url: string | null) => void
  previewRef: MutableRefObject<BeatEffectPreviewHandle | null>
}

const PreviewContext = createContext<PreviewContextValue | null>(null)

export function usePreview() {
  const ctx = useContext(PreviewContext)
  if (!ctx) throw new Error('usePreview must be used within PreviewProvider')
  return ctx
}

export { PreviewContext }
