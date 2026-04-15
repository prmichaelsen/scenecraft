import { useRef, useCallback, useEffect, forwardRef, useImperativeHandle, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import type { EditorData } from '@/routes/project/$name/editor'
import { PanelLayout, type LayoutNode, type PanelRegistry } from '@/components/panel-layout'
import { CurrentTimeProvider } from './CurrentTimeContext'
import { PreviewProvider } from './PreviewContext'
import { EditorStateProvider, useEditorState } from './EditorStateContext'
import { EditorDataProvider, useEditorData } from './EditorDataContext'
import { usePreview } from './PreviewContext'
import { Timeline } from './Timeline'
import { PreviewPanel } from './PreviewPanel'
import { LogPanel } from './LogPanel'
import { CheckpointsPanel } from './CheckpointsPanel'
import { SettingsPanel } from './SettingsPanel'
import { NarrativeSectionPanel } from './NarrativeSectionPanel'
import { BinPanel } from './BinPanel'
import { ExtensionsPanel } from './ExtensionsPanel'
import { KeyframePanel } from './KeyframePanel'
import { TransitionPanel } from './TransitionPanel'
import { saveWorkspaceView, fetchWorkspaceView } from '@/lib/workspace-client'

// --- Panel wrapper ---

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="h-full w-full overflow-hidden [&>*]:!w-full [&>*]:!shrink [&>*]:!h-full">{children}</div>
}

// --- Panel components (no dockview dependency) ---

function TimelinePanelComponent() {
  const data = useEditorData()
  return <Panel><Timeline data={data} v2 /></Panel>
}

function PreviewPanelComponent() {
  return <Panel><PreviewPanel /></Panel>
}

function LogPanelComponent() {
  return <Panel><LogPanel onClose={() => {}} /></Panel>
}

function CheckpointsPanelComponent() {
  const data = useEditorData()
  const router = useRouter()
  return <Panel><CheckpointsPanel projectName={data.projectName} onClose={() => {}} onRestore={() => router.invalidate()} /></Panel>
}

function SettingsPanelComponent() {
  const data = useEditorData()
  const router = useRouter()
  return <Panel><SettingsPanel data={data} projectName={data.projectName} onClose={() => {}} onSave={() => router.invalidate()} /></Panel>
}

function SectionsPanelComponent() {
  const data = useEditorData()
  return (
    <Panel>
      <NarrativeSectionPanel
        sections={data.narrativeSections}
        projectName={data.projectName}
        onClose={() => {}}
        onSeek={() => {}}
        onSectionsChange={() => {}}
        currentTime={0}
      />
    </Panel>
  )
}

function BinPanelComponent() {
  const data = useEditorData()
  const router = useRouter()
  return (
    <Panel>
      <BinPanel
        projectName={data.projectName}
        onClose={() => {}}
        onRestore={() => router.invalidate()}
        poolSelection={null}
        onPoolSelect={() => {}}
        onInsertPoolItem={() => {}}
        activeKeyframes={data.keyframes.map((kf) => ({ id: kf.id, timestamp: kf.timestamp, section: kf.section, prompt: kf.prompt, hasSelectedImage: true }))}
        activeTransitions={data.transitions.map((tr) => ({ id: tr.id, from: tr.from, to: tr.to, durationSeconds: tr.durationSeconds, hasSelectedVideo: true }))}
      />
    </Panel>
  )
}

function PropertiesPanelComponent() {
  const data = useEditorData()
  const { selectedKeyframe, selectedTransition, onKeyframeDelete, onKeyframeDataChange, onTransitionDelete, onTransitionDataChange } = useEditorState()
  const { setHoverPreviewUrl } = usePreview()
  const router = useRouter()

  if (selectedKeyframe) {
    return (
      <Panel>
        <KeyframePanel
          key={selectedKeyframe.id}
          keyframe={selectedKeyframe}
          projectName={data.projectName}
          onClose={() => {}}
          onDelete={() => onKeyframeDelete?.()}
          onDuplicate={() => {}}
          onMoveLeft={() => {}}
          onMoveRight={() => {}}
          onUnlink={() => {}}
          onDataChange={() => { onKeyframeDataChange?.(); router.invalidate() }}
          audioDescriptions={data.audioDescriptions}
          audioEvents={data.audioEvents}
          initialPromptRoster={data.promptRoster}
          onHoverPreview={setHoverPreviewUrl}
        />
      </Panel>
    )
  }

  if (selectedTransition) {
    return (
      <Panel>
        <TransitionPanel
          key={selectedTransition.id}
          transition={selectedTransition}
          projectName={data.projectName}
          motionPrompt={data.meta.motionPrompt}
          audioDescriptions={data.audioDescriptions}
          initialPromptRoster={data.promptRoster}
          keyframes={[]}
          currentTime={0}
          onClose={() => {}}
          onDelete={() => onTransitionDelete?.()}
          onDuplicateToNext={() => {}}
          onDuplicateToPrev={() => {}}
          onDataChange={() => { onTransitionDataChange?.(); router.invalidate() }}
          onHoverPreview={setHoverPreviewUrl}
        />
      </Panel>
    )
  }

  return (
    <div className="h-full flex items-center justify-center text-gray-600 text-sm bg-[#111827]">
      Select a keyframe or transition
    </div>
  )
}

function ExtensionsPanelComponent() {
  return <Panel><ExtensionsPanel onClose={() => {}} /></Panel>
}

function ChatPlaceholder() {
  return <div className="h-full flex items-center justify-center text-gray-600 text-sm bg-[#111827]">Chat (coming soon)</div>
}

// --- Panel registry ---

const panels: PanelRegistry = {
  preview:     { component: PreviewPanelComponent, title: 'Preview' },
  timeline:    { component: TimelinePanelComponent, title: 'Timeline' },
  properties:  { component: PropertiesPanelComponent, title: 'Properties' },
  bin:         { component: BinPanelComponent, title: 'Bin' },
  logs:        { component: LogPanelComponent, title: 'Logs' },
  checkpoints: { component: CheckpointsPanelComponent, title: 'Checkpoints' },
  settings:    { component: SettingsPanelComponent, title: 'Settings' },
  extensions:  { component: ExtensionsPanelComponent, title: 'Extensions' },
  sections:    { component: SectionsPanelComponent, title: 'Sections' },
  chat:        { component: ChatPlaceholder, title: 'Chat' },
}

// --- Default layout ---

const defaultLayout: LayoutNode = {
  type: 'split',
  direction: 'horizontal',
  ratio: 0.5,
  children: [
    {
      type: 'split',
      direction: 'vertical',
      ratio: 0.45,
      children: [
        { type: 'group', id: 'preview-group', tabs: ['preview'], activeTab: 'preview' },
        { type: 'group', id: 'timeline-group', tabs: ['timeline'], activeTab: 'timeline' },
      ],
    },
    {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.6,
      children: [
        {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          children: [
            { type: 'group', id: 'properties-group', tabs: ['properties'], activeTab: 'properties' },
            { type: 'group', id: 'utilities-group', tabs: ['bin', 'logs', 'checkpoints', 'settings', 'extensions'], activeTab: 'bin' },
          ],
        },
        {
          type: 'split',
          direction: 'vertical',
          ratio: 0.6,
          children: [
            { type: 'group', id: 'sidebar-group', tabs: ['sections'], activeTab: 'sections' },
            { type: 'group', id: 'chat-group', tabs: ['chat'], activeTab: 'chat' },
          ],
        },
      ],
    },
  ],
}

// --- EditorPanelLayout ---

export type EditorPanelLayoutHandle = {
  resetLayout: () => void
}

type EditorPanelLayoutProps = {
  data: EditorData
}

export const EditorPanelLayout = forwardRef<EditorPanelLayoutHandle, EditorPanelLayoutProps>(function EditorPanelLayout({ data }, ref) {
  const layoutRef = useRef<LayoutNode>(defaultLayout)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedRef = useRef(false)
  const [initialLayout, setInitialLayout] = useState<LayoutNode>(defaultLayout)

  // Load saved layout on mount
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    fetchWorkspaceView(data.projectName, '_autosave_v3').then((saved) => {
      if (saved && typeof saved === 'object') {
        setInitialLayout(saved as LayoutNode)
      }
    }).catch(() => {})
  }, [data.projectName])

  useImperativeHandle(ref, () => ({
    resetLayout() {
      setInitialLayout({ ...defaultLayout })
      saveWorkspaceView(data.projectName, '_autosave_v3', defaultLayout).catch(() => {})
    },
  }), [data.projectName])

  const handleLayoutChange = useCallback((layout: LayoutNode) => {
    layoutRef.current = layout
    // Debounced auto-save
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveWorkspaceView(data.projectName, '_autosave_v3', layout).catch(() => {})
    }, 2000)
  }, [data.projectName])

  return (
    <EditorDataProvider data={data}>
    <CurrentTimeProvider>
    <PreviewProvider>
    <EditorStateProvider>
      <PanelLayout
        key={JSON.stringify(initialLayout).slice(0, 50)}
        panels={panels}
        defaultLayout={initialLayout}
        onLayoutChange={handleLayoutChange}
      />
    </EditorStateProvider>
    </PreviewProvider>
    </CurrentTimeProvider>
    </EditorDataProvider>
  )
})
