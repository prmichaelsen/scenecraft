import { createContext, useContext, useRef, useCallback, useImperativeHandle, forwardRef, useState } from 'react'
import { DockviewReact, type DockviewReadyEvent, type DockviewApi, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import '@/styles/dockview-theme.css'
import type { EditorData } from '@/routes/project/$name/editor'
import { Timeline } from './Timeline'
import { LogPanel } from './LogPanel'
import { CheckpointsPanel } from './CheckpointsPanel'
import { SettingsPanel } from './SettingsPanel'
import { NarrativeSectionPanel } from './NarrativeSectionPanel'
import { BinPanel } from './BinPanel'
import { useRouter } from '@tanstack/react-router'

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
  return <Timeline data={params.data} v2 />
}

function LogDockPanel() {
  return <LogPanel onClose={() => {}} />
}

function CheckpointsDockPanel({ params }: IDockviewPanelProps<{ projectName: string }>) {
  const router = useRouter()
  return <CheckpointsPanel projectName={params.projectName} onClose={() => {}} onRestore={() => router.invalidate()} />
}

function SettingsDockPanel({ params }: IDockviewPanelProps<{ data: EditorData }>) {
  const router = useRouter()
  return <SettingsPanel data={params.data} projectName={params.data.projectName} onClose={() => {}} onSave={() => router.invalidate()} />
}

function SectionsDockPanel({ params }: IDockviewPanelProps<{ data: EditorData }>) {
  return (
    <NarrativeSectionPanel
      sections={params.data.narrativeSections}
      projectName={params.data.projectName}
      onClose={() => {}}
      onSeek={() => {}}
      onSectionsChange={() => {}}
      currentTime={0}
    />
  )
}

function BinDockPanel({ params }: IDockviewPanelProps<{ data: EditorData }>) {
  const router = useRouter()
  return (
    <BinPanel
      projectName={params.data.projectName}
      onClose={() => {}}
      onRestore={() => router.invalidate()}
      poolSelection={null}
      onPoolSelect={() => {}}
      onInsertPoolItem={() => {}}
      activeKeyframes={params.data.keyframes.map((kf) => ({ id: kf.id, timestamp: kf.timestamp, section: kf.section, prompt: kf.prompt, hasSelectedImage: true }))}
      activeTransitions={params.data.transitions.map((tr) => ({ id: tr.id, from: tr.from, to: tr.to, durationSeconds: tr.durationSeconds, hasSelectedVideo: true }))}
    />
  )
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
  logs: LogDockPanel,
  checkpoints: CheckpointsDockPanel,
  settings: SettingsDockPanel,
  sections: SectionsDockPanel,
  bin: BinDockPanel,
  placeholder: PlaceholderPanel,
} satisfies Record<string, React.FunctionComponent<IDockviewPanelProps<any>>>

// --- Default Layout Builder ---

function buildDefaultLayout(api: DockviewApi, data: EditorData) {
  // Layout:
  // [Left]  +------------------------------+-----------+-----------+
  // [hidden]|                              | Properties| Sections  |
  //         |     Timeline (flex)           |  (400px)  |  (240px)  |
  //         |                              |           |-----------|
  //         |                              |-----------| Chat      |
  //         |                              | Bin/Logs  |           |
  //         +------------------------------+-----------+-----------+
  //
  // Build right-to-left using addGroup to avoid insertion ordering issues.

  // Step 1: Create groups right-to-left

  // Col 4: Right sidebar (full height, 240px)
  const rightSidebarGroup = api.addGroup({ direction: 'right' })

  // Col 3: Properties column (400px) — to the left of right sidebar
  const propsGroup = api.addGroup({
    referenceGroup: rightSidebarGroup,
    direction: 'left',
  })

  // Step 2: Add panels to groups

  // Col 1: Left sidebar (starts hidden)
  const leftGroup = api.addGroup({ direction: 'left' })
  api.addPanel({
    id: 'leftSidebar',
    component: 'placeholder',
    title: 'Explorer',
    params: { label: '' },
    position: { referenceGroup: leftGroup },
  })
  leftGroup.api.setVisible(false)

  // Col 2: Timeline — goes into the remaining center space (left of props)
  api.addPanel({
    id: 'timeline',
    component: 'timeline',
    title: 'Timeline',
    params: { data },
    position: { referenceGroup: propsGroup, direction: 'left' },
  })

  // Col 3 top: Properties placeholder (KF/TR/ColorGrade tabs in future)
  api.addPanel({
    id: 'properties',
    component: 'placeholder',
    title: 'Properties',
    params: { label: 'Select a keyframe or transition' },
    position: { referenceGroup: propsGroup },
    initialWidth: 320,
  })

  // Col 3 bottom: Bin + Logs/Checkpoints/Versions/Settings as tabs
  api.addPanel({
    id: 'bin',
    component: 'bin',
    title: 'Bin',
    params: { data },
    position: { referencePanel: 'properties', direction: 'below' },
  })

  api.addPanel({
    id: 'logs',
    component: 'logs',
    title: 'Logs',
    inactive: true,
    position: { referencePanel: 'bin', direction: 'within' },
  })

  api.addPanel({
    id: 'checkpoints',
    component: 'checkpoints',
    title: 'Checkpoints',
    params: { projectName: data.projectName },
    inactive: true,
    position: { referencePanel: 'bin', direction: 'within' },
  })

  api.addPanel({
    id: 'settings',
    component: 'settings',
    title: 'Settings',
    params: { data },
    inactive: true,
    position: { referencePanel: 'bin', direction: 'within' },
  })

  // Col 4 top: Sections
  api.addPanel({
    id: 'sections',
    component: 'sections',
    title: 'Sections',
    params: { data },
    position: { referenceGroup: rightSidebarGroup },
    initialWidth: 240,
  })

  // Col 4 bottom: Chat (split inside right sidebar)
  api.addPanel({
    id: 'chat',
    component: 'placeholder',
    title: 'Chat',
    params: { label: 'Chat (coming soon)' },
    position: { referencePanel: 'sections', direction: 'below' },
  })
}

// --- EditorLayout Component ---

export type EditorLayoutHandle = {
  resetLayout: () => void
}

type EditorLayoutProps = {
  data: EditorData
}

export const EditorLayout = forwardRef<EditorLayoutHandle, EditorLayoutProps>(function EditorLayout({ data }, ref) {
  const apiRef = useRef<DockviewApi | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data

  useImperativeHandle(ref, () => ({
    resetLayout() {
      const api = apiRef.current
      if (!api) return
      api.clear()
      buildDefaultLayout(api, dataRef.current)
    },
  }), [])

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    buildDefaultLayout(event.api, dataRef.current)
  }, [])

  return (
    <EditorLayoutContext.Provider value={{ api: apiRef.current }}>
      <DockviewReact
        components={components}
        onReady={onReady}
        className="h-full"
      />
    </EditorLayoutContext.Provider>
  )
})

// --- Workspace Menu ---

export function WorkspaceMenu({ onReset }: { onReset: () => void }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded transition-colors"
      >
        Workspace
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 min-w-[180px] py-1">
          <div className="px-3 py-1.5 text-[10px] text-gray-500 uppercase tracking-wider">View</div>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-blue-400 hover:bg-gray-700"
            onClick={() => { onReset(); setOpen(false) }}
          >
            Default
          </button>
          <div className="border-t border-gray-700 my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700 hover:text-gray-200"
            onClick={() => { setOpen(false) }}
          >
            Save Workspace View
          </button>
        </div>
      )}
    </div>
  )
}
