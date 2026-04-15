import { createContext, useContext, type ReactNode } from 'react'
import type { EditorData } from '@/routes/project/$name/editor'

const EditorDataContext = createContext<EditorData | null>(null)

export function useEditorData(): EditorData {
  const ctx = useContext(EditorDataContext)
  if (!ctx) throw new Error('useEditorData must be used within EditorDataProvider')
  return ctx
}

export function EditorDataProvider({ data, children }: { data: EditorData; children: ReactNode }) {
  return <EditorDataContext.Provider value={data}>{children}</EditorDataContext.Provider>
}
