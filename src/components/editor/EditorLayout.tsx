import { createContext, useContext, useRef, useCallback, useImperativeHandle, forwardRef, useState, useEffect } from 'react'
import {
  DockviewReact, DockviewDefaultTab,
  type DockviewReadyEvent, type DockviewApi,
  type IDockviewPanelProps, type IDockviewPanelHeaderProps, type IDockviewHeaderActionsProps,
} from 'dockview-react'
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
import { saveWorkspaceView, fetchWorkspaceView, fetchWorkspaceViews } from '@/lib/workspace-client'

// --- Editor Layout Context ---

type EditorLayoutContextValue = {
  api: DockviewApi | null
}

const EditorLayoutContext = createContext<EditorLayoutContextValue>({ api: null })

export function useEditorLayout() {
  return useContext(EditorLayoutContext)
}

// --- Panel Components ---

// Dockview panels need h-full w-full to fill their slot. The old panel components
// use shrink-0 + fixed width from the side-panel layout, so we wrap them in a
// constrained container that overrides those styles.

function DockPanel({ children }: { children: React.ReactNode }) {
  return <div className="h-full w-full overflow-hidden [&>*]:!w-full [&>*]:!shrink [&>*]:!h-full">{children}</div>
}

function TimelinePanel({ params }: IDockviewPanelProps<{ data: EditorData }>) {
  return <DockPanel><Timeline data={params.data} v2 /></DockPanel>
}

function LogDockPanel() {
  return <DockPanel><LogPanel onClose={() => {}} /></DockPanel>
}

function CheckpointsDockPanel({ params }: IDockviewPanelProps<{ projectName: string }>) {
  const router = useRouter()
  return <DockPanel><CheckpointsPanel projectName={params.projectName} onClose={() => {}} onRestore={() => router.invalidate()} /></DockPanel>
}

function SettingsDockPanel({ params }: IDockviewPanelProps<{ data: EditorData }>) {
  const router = useRouter()
  return <DockPanel><SettingsPanel data={params.data} projectName={params.data.projectName} onClose={() => {}} onSave={() => router.invalidate()} /></DockPanel>
}

function SectionsDockPanel({ params }: IDockviewPanelProps<{ data: EditorData }>) {
  return (
    <DockPanel>
      <NarrativeSectionPanel
        sections={params.data.narrativeSections}
        projectName={params.data.projectName}
        onClose={() => {}}
        onSeek={() => {}}
        onSectionsChange={() => {}}
        currentTime={0}
      />
    </DockPanel>
  )
}

function BinDockPanel({ params }: IDockviewPanelProps<{ data: EditorData }>) {
  const router = useRouter()
  return (
    <DockPanel>
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
    </DockPanel>
  )
}

function PlaceholderPanel({ params }: IDockviewPanelProps<{ label: string }>) {
  return (
    <div className="h-full flex items-center justify-center text-gray-600 text-sm bg-gray-900">
      {params.label}
    </div>
  )
}

// --- Custom Tab (smaller close button with confirm) ---

const MANAGED_PANELS = new Set(['leftSidebar', 'timeline', 'sections', 'chat'])

function CustomTab(props: IDockviewPanelHeaderProps) {
  const isManaged = MANAGED_PANELS.has(props.api.id)
  return (
    <DockviewDefaultTab
      {...props}
      hideClose={isManaged}
      closeActionOverride={isManaged ? undefined : () => {
        if (confirm(`Remove "${props.api.title}" panel?`)) {
          props.api.close()
        }
      }}
    />
  )
}

// --- Right Header Actions (ellipsis menu to add panels) ---

const ADDABLE_PANELS = [
  { id: 'bin', component: 'bin', title: 'Bin' },
  { id: 'logs', component: 'logs', title: 'Logs' },
  { id: 'checkpoints', component: 'checkpoints', title: 'Checkpoints' },
  { id: 'settings', component: 'settings', title: 'Settings' },
  { id: 'properties', component: 'placeholder', title: 'Properties' },
] as const

function GroupActions({ containerApi, group }: IDockviewHeaderActionsProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative flex items-center pr-1">
      <button
        onClick={() => setOpen(!open)}
        className="text-gray-500 hover:text-gray-300 text-xs px-1 leading-none"
        title="Add panel"
      >
        &#x22EE;
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 bg-gray-800 border border-gray-700 rounded shadow-xl z-50 min-w-[140px] py-1">
          {ADDABLE_PANELS.map((p) => {
            const exists = containerApi.getPanel(p.id)
            return (
              <button
                key={p.id}
                disabled={!!exists}
                className="w-full text-left px-3 py-1 text-xs text-gray-300 hover:bg-gray-700 disabled:text-gray-600 disabled:hover:bg-transparent"
                onClick={() => {
                  containerApi.addPanel({
                    id: p.id,
                    component: p.component,
                    title: p.title,
                    position: { referenceGroup: group },
                  })
                  setOpen(false)
                }}
              >
                {p.title}
              </button>
            )
          })}
        </div>
      )}
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

  // Col 3: Single tab group (full height — no vertical split, max space for timeline)
  // Bin default, Properties/Logs/Checkpoints/Settings as inactive tabs
  api.addPanel({
    id: 'bin',
    component: 'bin',
    title: 'Bin',
    params: { data },
    position: { referenceGroup: propsGroup },
    initialWidth: 320,
  })

  api.addPanel({
    id: 'properties',
    component: 'placeholder',
    title: 'Properties',
    params: { label: 'Select a keyframe or transition' },
    inactive: true,
    position: { referencePanel: 'bin', direction: 'within' },
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
  getApi: () => DockviewApi | null
}

type EditorLayoutProps = {
  data: EditorData
}

export const EditorLayout = forwardRef<EditorLayoutHandle, EditorLayoutProps>(function EditorLayout({ data }, ref) {
  const apiRef = useRef<DockviewApi | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useImperativeHandle(ref, () => ({
    resetLayout() {
      const api = apiRef.current
      if (!api) return
      api.clear()
      buildDefaultLayout(api, dataRef.current)
      saveWorkspaceView(dataRef.current.projectName, '_autosave', api.toJSON()).catch(() => {})
    },
    getApi() { return apiRef.current },
  }), [])

  // Auto-save layout on changes (debounced 2s)
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    const disposable = api.onDidLayoutChange(() => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        saveWorkspaceView(dataRef.current.projectName, '_autosave', api.toJSON()).catch(() => {})
      }, 2000)
    })
    return () => { disposable.dispose(); if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [])

  const onReady = useCallback(async (event: DockviewReadyEvent) => {
    apiRef.current = event.api

    // Try restoring saved layout from DB
    try {
      const saved = await fetchWorkspaceView(dataRef.current.projectName, '_autosave')
      if (saved && typeof saved === 'object') {
        event.api.fromJSON(saved as Parameters<typeof event.api.fromJSON>[0])
        return
      }
    } catch { /* fall through to default */ }

    buildDefaultLayout(event.api, dataRef.current)
  }, [])

  return (
    <EditorLayoutContext.Provider value={{ api: apiRef.current }}>
      <DockviewReact
        components={components}
        defaultTabComponent={CustomTab}
        rightHeaderActionsComponent={GroupActions}
        onReady={onReady}
        className="h-full"
      />
    </EditorLayoutContext.Provider>
  )
})

// --- Workspace Menu ---

export function WorkspaceMenu({ projectName, onReset, api }: { projectName: string; onReset: () => void; api: DockviewApi | null }) {
  const [open, setOpen] = useState(false)
  const [savedViews, setSavedViews] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    fetchWorkspaceViews(projectName).then((views) => {
      setSavedViews(Object.keys(views).filter((k) => k !== '_autosave'))
    }).catch(() => {})
  }, [open, projectName])

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
          {savedViews.map((name) => (
            <button
              key={name}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700"
              onClick={async () => {
                if (!api) return
                const layout = await fetchWorkspaceView(projectName, name)
                if (layout) api.fromJSON(layout as Parameters<typeof api.fromJSON>[0])
                setOpen(false)
              }}
            >
              {name}
            </button>
          ))}
          <div className="border-t border-gray-700 my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700 hover:text-gray-200"
            onClick={() => {
              if (!api) return
              const name = prompt('Workspace view name:')
              if (!name?.trim()) return
              saveWorkspaceView(projectName, name.trim(), api.toJSON()).catch(() => {})
              setOpen(false)
            }}
          >
            Save Workspace View
          </button>
        </div>
      )}
    </div>
  )
}
