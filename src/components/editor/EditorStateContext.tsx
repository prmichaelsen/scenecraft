import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { Keyframe, Transition } from '@/routes/project/$name/editor'

export type KeyframeWithTime = Keyframe & { timeSeconds: number }

type EditorStateContextValue = {
  selectedKeyframe: KeyframeWithTime | null
  selectedTransition: Transition | null
  setSelectedKeyframe: (kf: KeyframeWithTime | null) => void
  setSelectedTransition: (tr: Transition | null) => void
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
  setSelectedKeyframe: () => {},
  setSelectedTransition: () => {},
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
  const [selectedKeyframe, setSelectedKeyframe] = useState<KeyframeWithTime | null>(null)
  const [selectedTransition, setSelectedTransition] = useState<Transition | null>(null)
  const [callbacks, setCallbacks] = useState<{
    onKeyframeDelete?: () => void
    onKeyframeDataChange?: () => void
    onTransitionDelete?: () => void
    onTransitionDataChange?: () => void
  }>({})

  const registerCallbacks = useCallback((cbs: typeof callbacks) => {
    setCallbacks(cbs)
  }, [])

  return (
    <EditorStateContext.Provider value={{
      selectedKeyframe,
      selectedTransition,
      setSelectedKeyframe,
      setSelectedTransition,
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
