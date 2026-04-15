import { useState } from 'react'
import { ArrowRightFromLine } from 'lucide-react'
import type { GroupNode, PanelId, PanelRegistry } from './types'

type PanelGroupProps = {
  group: GroupNode
  panels: PanelRegistry
  allPanelIds: PanelId[]
  collapseDirection?: 'left' | 'right' | 'up' | 'down'
  onTabActivate: (groupId: string, tabId: PanelId) => void
  onTabClose: (groupId: string, tabId: PanelId) => void
  onTabAdd: (groupId: string, tabId: PanelId) => void
  onCollapse: (groupId: string) => void
  onExpand: (groupId: string) => void
  // Tab drag-and-drop
  onTabDragStart?: (groupId: string, tabId: PanelId) => void
  onTabDrop?: (groupId: string, index: number) => void
}

const COLLAPSE_ROTATION: Record<string, string> = {
  right: '',
  left: 'rotate-180',
  down: 'rotate-90',
  up: '-rotate-90',
}

export function PanelGroup({
  group, panels, allPanelIds, collapseDirection,
  onTabActivate, onTabClose, onTabAdd, onCollapse, onExpand,
  onTabDragStart, onTabDrop,
}: PanelGroupProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  // Collapsed state
  if (group.collapsed) {
    const isVerticalCollapse = collapseDirection === 'up' || collapseDirection === 'down'
    return (
      <div
        className="bg-[#111827] flex overflow-hidden"
        style={isVerticalCollapse
          ? { height: 28, flexDirection: 'row', width: '100%' }
          : { width: 34, flexDirection: 'column', height: '100%' }
        }
      >
        <button
          onClick={() => onExpand(group.id)}
          className="flex items-center justify-center shrink-0 w-7 h-7 text-gray-500 hover:text-gray-200 hover:bg-white/10 rounded"
          title="Expand"
        >
          <ArrowRightFromLine size={14} className={COLLAPSE_ROTATION[collapseDirection || 'right']} />
        </button>
        <div className={`flex gap-0 overflow-hidden ${isVerticalCollapse ? 'flex-row' : 'flex-col'}`}>
          {group.tabs.map((tabId) => {
            const def = panels[tabId]
            if (!def) return null
            return (
              <button
                key={tabId}
                onClick={() => { onExpand(group.id); onTabActivate(group.id, tabId) }}
                className={`text-[11px] text-gray-400 hover:text-gray-200 hover:bg-white/5 px-2 py-1 truncate ${
                  isVerticalCollapse ? '' : 'writing-mode-vertical border-b border-gray-800'
                }`}
                style={isVerticalCollapse ? {} : { writingMode: 'vertical-lr', textOrientation: 'mixed', padding: '8px 6px' }}
              >
                {def.title}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // Active panel component
  const ActiveComponent = panels[group.activeTab]?.component

  return (
    <div className="flex flex-col h-full w-full bg-[#111827]">
      {/* Tab bar */}
      <div className="flex items-center shrink-0 bg-[#111827] border-b border-gray-800 h-[35px]">
        <div
          className="flex-1 flex overflow-x-auto"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
          onDrop={(e) => {
            e.preventDefault()
            onTabDrop?.(group.id, group.tabs.length)
          }}
        >
          {group.tabs.map((tabId, i) => {
            const def = panels[tabId]
            if (!def) return null
            const isActive = tabId === group.activeTab
            return (
              <div
                key={tabId}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', tabId)
                  e.dataTransfer.setData('application/x-panel-tab', JSON.stringify({ groupId: group.id, tabId }))
                  onTabDragStart?.(group.id, tabId)
                }}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move' }}
                onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onTabDrop?.(group.id, i) }}
                onClick={() => onTabActivate(group.id, tabId)}
                className={`flex items-center gap-1.5 px-3 h-full text-[13px] cursor-pointer select-none shrink-0 ${
                  isActive
                    ? 'text-gray-200 bg-gray-800/50 border-b-2 border-blue-500'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/30'
                }`}
              >
                <span>{def.title}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onTabClose(group.id, tabId) }}
                  className="w-4 h-4 flex items-center justify-center text-[10px] rounded opacity-40 hover:opacity-100 hover:bg-white/10"
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>

        {/* Right actions: collapse + add menu */}
        <div className="flex items-center gap-0 px-1 shrink-0">
          {collapseDirection && (
            <button
              onClick={() => onCollapse(group.id)}
              className="flex items-center justify-center w-6 h-6 text-gray-500 hover:text-gray-200 hover:bg-white/10 rounded"
              title="Collapse"
            >
              <ArrowRightFromLine size={12} className={COLLAPSE_ROTATION[collapseDirection]} />
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex items-center justify-center w-6 h-6 text-gray-500 hover:text-gray-200 hover:bg-white/10 rounded text-base"
              title="Add panel"
            >
              &#x22EE;
            </button>
            {menuOpen && (
              <div className="absolute top-full right-0 mt-1 bg-gray-800 border border-gray-700 rounded shadow-xl z-50 min-w-[140px] py-1">
                {allPanelIds.map((id) => {
                  const exists = group.tabs.includes(id)
                  const def = panels[id]
                  if (!def) return null
                  return (
                    <button
                      key={id}
                      disabled={exists}
                      className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-blue-600/40 disabled:text-gray-600 disabled:hover:bg-transparent"
                      onClick={() => { onTabAdd(group.id, id); setMenuOpen(false) }}
                    >
                      {def.title}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden">
        {ActiveComponent ? <ActiveComponent /> : (
          <div className="h-full flex items-center justify-center text-gray-600 text-sm">No panel</div>
        )}
      </div>
    </div>
  )
}
