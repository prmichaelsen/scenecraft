import { createContext, useContext, useRef, useCallback } from 'react'
import { DockviewReact, type DockviewReadyEvent, type DockviewApi, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import '@/styles/dockview-theme.css'
import type { EditorData } from '@/routes/project/$name/editor'
import { Timeline } from './Timeline'

// --- Editor Layout Context ---

type EditorLayoutContextValue = {
  api: DockviewApi | null
}

const EditorLayoutContext = createContext<EditorLayoutContextValue>({ api: null })

export function useEditorLayout() {
  return useContext(EditorLayoutContext)
}

// --- Panel Components ---

function TimelinePanel({ params }: IDockviewPanelProps<{ data: EditorData }>) {
  return <Timeline data={params.data} />
}

function PlaceholderPanel({ params }: IDockviewPanelProps<{ label: string }>) {
  return (
    <div className="h-full flex items-center justify-center text-gray-600 text-sm bg-gray-900">
      {params.label}
    </div>
  )
}

// --- Component Registration ---

const components = {
  timeline: TimelinePanel,
  placeholder: PlaceholderPanel,
} satisfies Record<string, React.FunctionComponent<IDockviewPanelProps<any>>>

// --- Default Layout Builder ---

function buildDefaultLayout(api: DockviewApi, data: EditorData) {
  // Center — the existing Timeline (preview + tracks + all panels for now)
  api.addPanel({
    id: 'timeline',
    component: 'timeline',
    title: 'Timeline',
    params: { data },
  })

  // Properties column — placeholder (will be KF/TR/ColorGrade tabs in Task 5)
  api.addPanel({
    id: 'properties',
    component: 'placeholder',
    title: 'Properties',
    params: { label: 'Properties — KF / TR / Color Grading (Task 5)' },
    position: { referencePanel: 'timeline', direction: 'right' },
    initialWidth: 360,
  })

  // Bottom of properties — placeholder (will be Bin/Logs/etc in Task 6)
  api.addPanel({
    id: 'utilities',
    component: 'placeholder',
    title: 'Bin',
    params: { label: 'Bin / Logs / Checkpoints (Task 6)' },
    position: { referencePanel: 'properties', direction: 'below' },
  })

  // Right sidebar — placeholder (will be Sections in Task 7)
  api.addPanel({
    id: 'rightSidebar',
    component: 'placeholder',
    title: 'Sections',
    params: { label: 'Sections (Task 7)' },
    position: { referencePanel: 'properties', direction: 'right' },
    initialWidth: 280,
  })

  // Bottom of right sidebar — placeholder (will be Chat in Task 7)
  api.addPanel({
    id: 'chat',
    component: 'placeholder',
    title: 'Chat',
    params: { label: 'Chat (Task 7)' },
    position: { referencePanel: 'rightSidebar', direction: 'below' },
  })
}

// --- EditorLayout Component ---

type EditorLayoutProps = {
  data: EditorData
}

export function EditorLayout({ data }: EditorLayoutProps) {
  const apiRef = useRef<DockviewApi | null>(null)

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    buildDefaultLayout(event.api, data)
  }, [data])

  return (
    <EditorLayoutContext.Provider value={{ api: apiRef.current }}>
      <DockviewReact
        components={components}
        onReady={onReady}
        className="h-full"
      />
    </EditorLayoutContext.Provider>
  )
}
