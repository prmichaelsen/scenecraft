import { createContext, useContext, useRef, useCallback } from 'react'
import { DockviewReact, type DockviewReadyEvent, type DockviewApi, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import '@/styles/dockview-theme.css'
import type { EditorData } from '@/routes/project/$name/editor'
import { Timeline } from './Timeline'
import { LogPanel } from './LogPanel'
import { CheckpointsPanel } from './CheckpointsPanel'
import { VersionHistoryPanel } from './VersionHistoryPanel'
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
  return <Timeline data={params.data} />
}

function LogDockPanel() {
  return <LogPanel onClose={() => {}} />
}

function CheckpointsDockPanel({ params }: IDockviewPanelProps<{ projectName: string }>) {
  const router = useRouter()
  return <CheckpointsPanel projectName={params.projectName} onClose={() => {}} onRestore={() => router.invalidate()} />
}

function VersionsDockPanel({ params }: IDockviewPanelProps<{ projectName: string }>) {
  const router = useRouter()
  return <VersionHistoryPanel projectName={params.projectName} onClose={() => {}} onRestore={() => router.invalidate()} />
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
  versions: VersionsDockPanel,
  settings: SettingsDockPanel,
  sections: SectionsDockPanel,
  bin: BinDockPanel,
  placeholder: PlaceholderPanel,
} satisfies Record<string, React.FunctionComponent<IDockviewPanelProps<any>>>

// --- Default Layout Builder ---

function buildDefaultLayout(api: DockviewApi, data: EditorData) {
  // Center — the existing Timeline (preview + tracks + KF/TR panels still inside)
  api.addPanel({
    id: 'timeline',
    component: 'timeline',
    title: 'Timeline',
    params: { data },
  })

  // Properties column — Settings (placeholder for KF/TR/ColorGrade in future)
  api.addPanel({
    id: 'settings',
    component: 'settings',
    title: 'Settings',
    params: { data },
    position: { referencePanel: 'timeline', direction: 'right' },
    initialWidth: 360,
  })

  // Bottom of properties column — Bin
  api.addPanel({
    id: 'bin',
    component: 'bin',
    title: 'Bin',
    params: { data },
    position: { referencePanel: 'settings', direction: 'below' },
  })

  // Tabs alongside Bin
  api.addPanel({
    id: 'logs',
    component: 'logs',
    title: 'Logs',
    position: { referencePanel: 'bin', direction: 'within' },
  })

  api.addPanel({
    id: 'checkpoints',
    component: 'checkpoints',
    title: 'Checkpoints',
    params: { projectName: data.projectName },
    position: { referencePanel: 'bin', direction: 'within' },
  })

  api.addPanel({
    id: 'versions',
    component: 'versions',
    title: 'Versions',
    params: { projectName: data.projectName },
    position: { referencePanel: 'bin', direction: 'within' },
  })

  // Right sidebar — Sections
  api.addPanel({
    id: 'sections',
    component: 'sections',
    title: 'Sections',
    params: { data },
    position: { referencePanel: 'settings', direction: 'right' },
    initialWidth: 280,
  })

  // Bottom of right sidebar — Chat placeholder
  api.addPanel({
    id: 'chat',
    component: 'placeholder',
    title: 'Chat',
    params: { label: 'Chat (coming soon)' },
    position: { referencePanel: 'sections', direction: 'below' },
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
