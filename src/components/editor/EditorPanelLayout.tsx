import { useRef, useCallback, useEffect, forwardRef, useImperativeHandle, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import type { EditorData } from '@/routes/project/$name/editor'
import { PanelLayout, validateLayout, type LayoutNode, type PanelRegistry, type PanelLayoutHandle } from '@/components/panel-layout'
import { CurrentTimeProvider } from './CurrentTimeContext'
import { PreviewProvider } from './PreviewContext'
import { EditorStateProvider, useEditorState } from './EditorStateContext'
import { EditorDataProvider, useEditorData } from './EditorDataContext'
import { usePreview } from './PreviewContext'
import { Timeline, TrackSettingsPanel } from './Timeline'
import { postUpdateTrack } from '@/lib/scenecraft-client'
import { PreviewPanel } from './PreviewPanel'
import { LogPanel } from './LogPanel'
import { CheckpointsPanel } from './CheckpointsPanel'
import { SettingsPanel } from './SettingsPanel'
import { NarrativeSectionPanel } from './NarrativeSectionPanel'
import { BinPanel } from './BinPanel'
import { ExtensionsPanel } from './ExtensionsPanel'
import { KeyframePanel } from './KeyframePanel'
import { TransitionPanel } from './TransitionPanel'
import { ChatPanel } from './ChatPanel'
import { MCPPanel } from './MCPPanel'
import { AudioPropertiesPanel } from './AudioPropertiesPanel'
import { MacroPanel } from './MacroPanel'
import { saveWorkspaceView } from '@/lib/workspace-client'
import { ContextMenuProvider } from '@/contexts/ContextMenuContext'
import { PluginHost } from '@/lib/plugin-host'

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
  const { selectedKeyframe, selectedTransition, trackPropertiesId, selectedAudioClipId, selectedAudioTrackId, setTrackPropertiesId, onKeyframeDelete, onKeyframeDataChange, onTransitionDelete, onTransitionDataChange } = useEditorState()
  const { setHoverPreviewUrl, setHoverVideo } = usePreview()
  const router = useRouter()

  if (selectedAudioClipId || selectedAudioTrackId) {
    const projectDuration = estimateProjectDuration(data)
    return (
      <Panel>
        <AudioPropertiesPanel
          projectName={data.projectName}
          audioTracks={data.audioTracks ?? []}
          projectDurationSeconds={projectDuration}
          onChanged={() => router.invalidate()}
        />
      </Panel>
    )
  }

  if (trackPropertiesId) {
    const track = data.tracks.find((t) => t.id === trackPropertiesId) || data.tracks[0]
    if (!track) {
      return <div className="h-full flex items-center justify-center text-gray-600 text-sm bg-[#111827]">Track not found</div>
    }
    return (
      <Panel>
        <TrackSettingsPanel
          track={track}
          onClose={() => setTrackPropertiesId(null)}
          onUpdate={(updates) => {
            postUpdateTrack(data.projectName, track.id, updates as never).then(() => router.invalidate())
          }}
        />
      </Panel>
    )
  }

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
          onHoverVideo={setHoverVideo}
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

function ChatPanelComponent() {
  const data = useEditorData()
  const router = useRouter()
  return (
    <Panel>
      <ChatPanel
        projectName={data.projectName}
        onClose={() => {}}
        onMutation={() => router.invalidate()}
      />
    </Panel>
  )
}

function MCPPanelComponent() {
  return <Panel><MCPPanel onClose={() => {}} /></Panel>
}

function MacroPanelComponent() {
  return <Panel><MacroPanel /></Panel>
}

// Generic wrapper for any PluginHost-contributed panel. Looks the panel up
// by id at render time so when the plugin deactivates (HMR or dynamic
// unload), the panel body is replaced by a fallback without a stale
// component reference lingering in the registry. Editor-context props are
// injected here so plugin panels don't need to import editor internals.
function makePluginPanelComponent(panelId: string) {
  return function PluginPanelComponent() {
    const data = useEditorData()
    const { selectedAudioClipId } = useEditorState()
    const panel = PluginHost.getPanel(panelId)

    if (!panel) {
      return (
        <div className="h-full flex items-center justify-center text-xs text-gray-500 bg-[#111827]">
          Plugin panel <code>{panelId}</code> not registered.
        </div>
      )
    }

    const entity = selectedAudioClipId
      ? { type: 'audio_clip' as const, id: selectedAudioClipId }
      : null
    const PluginPanel = panel.Component as React.ComponentType<{
      entity: typeof entity
      projectName: string
      onClose?: () => void
    }>
    return (
      <Panel>
        <PluginPanel
          entity={entity}
          projectName={data.projectName}
          onClose={() => {}}
        />
      </Panel>
    )
  }
}

// Auto-focus the Properties tab when anything becomes selected (kf / tr / track / audio).
// Respects group locks — user can pin the Properties group to another tab.
function AutoActivatePropertiesEffect({ panelLayoutRef }: { panelLayoutRef: React.RefObject<PanelLayoutHandle | null> }) {
  const { selectedKeyframe, selectedTransition, trackPropertiesId, selectedAudioClipId, selectedAudioTrackId } = useEditorState()
  useEffect(() => {
    if (selectedKeyframe || selectedTransition || trackPropertiesId || selectedAudioClipId || selectedAudioTrackId) {
      panelLayoutRef.current?.activatePanel('properties')
    }
  }, [selectedKeyframe, selectedTransition, trackPropertiesId, selectedAudioClipId, selectedAudioTrackId, panelLayoutRef])
  return null
}

function estimateProjectDuration(data: EditorData): number {
  const parse = (ts: string): number => {
    const parts = ts.split(':')
    if (parts.length === 1) return parseFloat(parts[0]) || 0
    if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1])
    if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2])
    return 0
  }
  let max = 0
  for (const kf of data.keyframes) {
    const t = parse(kf.timestamp)
    if (t > max) max = t
  }
  return Math.max(max, 1)
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
  chat:        { component: ChatPanelComponent, title: 'Chat' },
  mcp:         { component: MCPPanelComponent, title: 'MCP' },
  'macro-panel': { component: MacroPanelComponent, title: 'Macro Panel' },
}

// Merge plugin-contributed panels on top of the built-in registry. Called
// once per render so HMR'd plugin changes flow through without a reload.
function buildPanelRegistry(): PanelRegistry {
  const merged: PanelRegistry = { ...panels }
  for (const p of PluginHost.listPanels()) {
    if (!merged[p.id]) {
      merged[p.id] = {
        component: makePluginPanelComponent(p.id),
        title: p.title,
      }
    }
  }
  return merged
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
            { type: 'group', id: 'properties-group', tabs: ['properties', 'macro-panel'], activeTab: 'properties' },
            { type: 'group', id: 'utilities-group', tabs: ['bin', 'logs', 'checkpoints', 'audio_isolations', 'settings', 'extensions'], activeTab: 'bin' },
          ],
        },
        {
          type: 'split',
          direction: 'vertical',
          ratio: 0.6,
          children: [
            { type: 'group', id: 'sidebar-group', tabs: ['sections'], activeTab: 'sections' },
            { type: 'group', id: 'chat-group', tabs: ['chat', 'mcp'], activeTab: 'chat' },
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
  // Resolve initial layout from the SSR-loaded savedLayout (falls back to default).
  // Saved layouts from older schemas or with tabs referring to removed panels
  // would crash the tree-traversal inside PanelLayout, so the saved tree is
  // sanitised by validateLayout.
  const resolvedInitial = useRef<LayoutNode | null>(null)
  if (resolvedInitial.current === null) {
    const saved = data.savedLayout as unknown
    const validated = saved ? validateLayout(saved, panels) : null
    if (saved && !validated) {
      console.warn('[EditorPanelLayout] saved _autosave_v3 failed validation, resetting to default')
      saveWorkspaceView(data.projectName, '_autosave_v3', defaultLayout).catch(() => {})
    }
    resolvedInitial.current = validated ?? defaultLayout
  }
  const layoutRef = useRef<LayoutNode>(resolvedInitial.current)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [initialLayout, setInitialLayout] = useState<LayoutNode>(resolvedInitial.current)
  const panelLayoutRef = useRef<PanelLayoutHandle>(null)

  useImperativeHandle(ref, () => ({
    resetLayout() {
      setInitialLayout({ ...defaultLayout })
      saveWorkspaceView(data.projectName, '_autosave_v3', defaultLayout).catch((e) => console.error('saveWorkspaceView failed', e))
    },
  }), [data.projectName])

  const handleLayoutChange = useCallback((layout: LayoutNode) => {
    layoutRef.current = layout
    // Debounced auto-save
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveWorkspaceView(data.projectName, '_autosave_v3', layout).catch((e) => console.error('saveWorkspaceView failed', e))
    }, 500)
  }, [data.projectName])

  // Flush pending save on navigation / tab close
  useEffect(() => {
    const flush = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        saveWorkspaceView(data.projectName, '_autosave_v3', layoutRef.current).catch((e) => console.error('saveWorkspaceView (flush) failed', e))
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      flush()
      window.removeEventListener('beforeunload', flush)
    }
  }, [data.projectName])

  return (
    <EditorDataProvider data={data}>
    <CurrentTimeProvider>
    <PreviewProvider>
    <EditorStateProvider>
    <ContextMenuProvider>
      <AutoActivatePropertiesEffect panelLayoutRef={panelLayoutRef} />
      <PanelLayout
        ref={panelLayoutRef}
        key={JSON.stringify(initialLayout)}
        panels={buildPanelRegistry()}
        defaultLayout={initialLayout}
        onLayoutChange={handleLayoutChange}
      />
    </ContextMenuProvider>
    </EditorStateProvider>
    </PreviewProvider>
    </CurrentTimeProvider>
    </EditorDataProvider>
  )
})
