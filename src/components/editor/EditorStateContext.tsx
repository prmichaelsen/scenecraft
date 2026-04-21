import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { Keyframe, Transition } from '@/routes/project/$name/editor'

export type KeyframeWithTime = Keyframe & { timeSeconds: number }

type EditorStateContextValue = {
  selectedKeyframe: KeyframeWithTime | null
  selectedTransition: Transition | null
  // When set, the Properties panel shows TrackSettingsPanel for this track.
  // Mutex with selectedKeyframe/selectedTransition.
  trackPropertiesId: string | null
  // M9: audio clip/track selection. Mutex with the others.
  selectedAudioClipId: string | null
  selectedAudioTrackId: string | null
  setSelectedKeyframe: (kf: KeyframeWithTime | null) => void
  setSelectedTransition: (tr: Transition | null) => void
  setTrackPropertiesId: (id: string | null) => void
  setSelectedAudioClipId: (id: string | null) => void
  setSelectedAudioTrackId: (id: string | null) => void
  // Callbacks for panel actions — set by Timeline, consumed by property panels
  onKeyframeDelete: (() => void) | null
  onKeyframeDataChange: (() => void) | null
  onTransitionDelete: (() => void) | null
  onTransitionDataChange: (() => void) | null
  registerCallbacks: (cbs: {
    onKeyframeDelete?: () => void
    onKeyframeDataChange?: () => void
    onTransitionDelete?: () => void
    onTransitionDataChange?: () => void
  }) => void
}

const EditorStateContext = createContext<EditorStateContextValue>({
  selectedKeyframe: null,
  selectedTransition: null,
  trackPropertiesId: null,
  selectedAudioClipId: null,
  selectedAudioTrackId: null,
  setSelectedKeyframe: () => {},
  setSelectedTransition: () => {},
  setTrackPropertiesId: () => {},
  setSelectedAudioClipId: () => {},
  setSelectedAudioTrackId: () => {},
  onKeyframeDelete: null,
  onKeyframeDataChange: null,
  onTransitionDelete: null,
  onTransitionDataChange: null,
  registerCallbacks: () => {},
})

export function useEditorState() {
  return useContext(EditorStateContext)
}

export function EditorStateProvider({ children }: { children: ReactNode }) {
  const [selectedKeyframe, setSelectedKeyframeRaw] = useState<KeyframeWithTime | null>(null)
  const [selectedTransition, setSelectedTransitionRaw] = useState<Transition | null>(null)
  const [trackPropertiesId, setTrackPropertiesIdRaw] = useState<string | null>(null)
  const [selectedAudioClipId, setSelectedAudioClipIdRaw] = useState<string | null>(null)
  const [selectedAudioTrackId, setSelectedAudioTrackIdRaw] = useState<string | null>(null)
  const [callbacks, setCallbacks] = useState<{
    onKeyframeDelete?: () => void
    onKeyframeDataChange?: () => void
    onTransitionDelete?: () => void
    onTransitionDataChange?: () => void
  }>({})

  const clearAudioSelection = () => {
    setSelectedAudioClipIdRaw(null)
    setSelectedAudioTrackIdRaw(null)
  }

  // Enforce mutex: setting one selection clears the others.
  const setSelectedKeyframe = useCallback((kf: KeyframeWithTime | null) => {
    setSelectedKeyframeRaw(kf)
    if (kf) {
      setSelectedTransitionRaw(null)
      setTrackPropertiesIdRaw(null)
      clearAudioSelection()
    }
  }, [])
  const setSelectedTransition = useCallback((tr: Transition | null) => {
    setSelectedTransitionRaw(tr)
    if (tr) {
      setSelectedKeyframeRaw(null)
      setTrackPropertiesIdRaw(null)
      clearAudioSelection()
    }
  }, [])
  const setTrackPropertiesId = useCallback((id: string | null) => {
    setTrackPropertiesIdRaw(id)
    if (id) {
      setSelectedKeyframeRaw(null)
      setSelectedTransitionRaw(null)
      clearAudioSelection()
    }
  }, [])
  const setSelectedAudioClipId = useCallback((id: string | null) => {
    setSelectedAudioClipIdRaw(id)
    if (id) {
      setSelectedKeyframeRaw(null)
      setSelectedTransitionRaw(null)
      setTrackPropertiesIdRaw(null)
      setSelectedAudioTrackIdRaw(null)
    }
  }, [])
  const setSelectedAudioTrackId = useCallback((id: string | null) => {
    setSelectedAudioTrackIdRaw(id)
    if (id) {
      setSelectedKeyframeRaw(null)
      setSelectedTransitionRaw(null)
      setTrackPropertiesIdRaw(null)
      setSelectedAudioClipIdRaw(null)
    }
  }, [])

  const registerCallbacks = useCallback((cbs: typeof callbacks) => {
    setCallbacks(cbs)
  }, [])

  return (
    <EditorStateContext.Provider value={{
      selectedKeyframe,
      selectedTransition,
      trackPropertiesId,
      selectedAudioClipId,
      selectedAudioTrackId,
      setSelectedKeyframe,
      setSelectedTransition,
      setTrackPropertiesId,
      setSelectedAudioClipId,
      setSelectedAudioTrackId,
      onKeyframeDelete: callbacks.onKeyframeDelete || null,
      onKeyframeDataChange: callbacks.onKeyframeDataChange || null,
      onTransitionDelete: callbacks.onTransitionDelete || null,
      onTransitionDataChange: callbacks.onTransitionDataChange || null,
      registerCallbacks,
    }}>
      {children}
    </EditorStateContext.Provider>
  )
}
