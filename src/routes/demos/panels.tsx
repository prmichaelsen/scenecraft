import { createFileRoute, Link } from '@tanstack/react-router'
import { PanelLayout, type LayoutNode, type PanelRegistry } from '@/components/panel-layout'

export const Route = createFileRoute('/demos/panels')({
  component: PanelsDemo,
})

// Dummy panel components for testing
function DummyPanel({ label, color }: { label: string; color: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center" style={{ backgroundColor: color }}>
      <span className="text-white text-sm font-medium">{label}</span>
    </div>
  )
}

function PreviewPanel() { return <DummyPanel label="Preview" color="#1a1a2e" /> }
function TimelinePanel() { return <DummyPanel label="Timeline" color="#16213e" /> }
function PropertiesPanel() { return <DummyPanel label="Properties" color="#0f3460" /> }
function EffectsPanel() { return <DummyPanel label="Effects" color="#1a1a4e" /> }
function BinPanel() { return <DummyPanel label="Bin" color="#1e3a2e" /> }
function LogsPanel() { return <DummyPanel label="Logs" color="#2a1a1a" /> }
function CheckpointsPanel() { return <DummyPanel label="Checkpoints" color="#1a2a1a" /> }
function SettingsPanel() { return <DummyPanel label="Settings" color="#2a2a1a" /> }
function SectionsPanel() { return <DummyPanel label="Sections" color="#1a1a3e" /> }
function ChatPanel() { return <DummyPanel label="Chat" color="#2e1a2e" /> }

const panels: PanelRegistry = {
  preview:     { component: PreviewPanel, title: 'Preview' },
  timeline:    { component: TimelinePanel, title: 'Timeline' },
  properties:  { component: PropertiesPanel, title: 'Properties' },
  effects:     { component: EffectsPanel, title: 'Effects' },
  bin:         { component: BinPanel, title: 'Bin' },
  logs:        { component: LogsPanel, title: 'Logs' },
  checkpoints: { component: CheckpointsPanel, title: 'Checkpoints' },
  settings:    { component: SettingsPanel, title: 'Settings' },
  sections:    { component: SectionsPanel, title: 'Sections' },
  chat:        { component: ChatPanel, title: 'Chat' },
}

const defaultLayout: LayoutNode = {
  type: 'split',
  direction: 'horizontal',
  ratio: 0.5,
  children: [
    // Left: Preview + Timeline stacked
    {
      type: 'split',
      direction: 'vertical',
      ratio: 0.45,
      children: [
        { type: 'group', id: 'preview-group', tabs: ['preview'], activeTab: 'preview' },
        { type: 'group', id: 'timeline-group', tabs: ['timeline'], activeTab: 'timeline' },
      ],
    },
    // Right: Props column + Sidebar column
    {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.6,
      children: [
        // Props column: Properties/Effects on top, Bin/Logs/Checkpoints on bottom
        {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          children: [
            { type: 'group', id: 'properties-group', tabs: ['properties', 'effects'], activeTab: 'properties' },
            { type: 'group', id: 'utilities-group', tabs: ['bin', 'logs', 'checkpoints', 'settings'], activeTab: 'bin' },
          ],
        },
        // Sidebar: Sections on top, Chat on bottom
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

function PanelsDemo() {
  return (
    <div className="h-screen flex flex-col">
      <div className="flex items-center gap-4 px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
        <Link to="/demos" className="text-xs text-gray-500 hover:text-gray-300">&larr; Demos</Link>
        <h1 className="text-sm font-medium text-gray-300">Panel Layout Demo</h1>
      </div>
      <div className="flex-1">
        <PanelLayout
          panels={panels}
          defaultLayout={defaultLayout}
          onLayoutChange={(layout) => console.log('Layout changed:', JSON.stringify(layout, null, 2))}
        />
      </div>
    </div>
  )
}
