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
  onExpandAndActivate?: (groupId: string, tabId: PanelId) => void
  // Column-level collapse (collapses the entire parent vertical split)
  onCollapseColumn?: () => void
  showCollapseColumn?: boolean
  columnCollapseDirection?: 'left' | 'right'
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

// Expand icon points opposite to collapse direction
const EXPAND_ROTATION: Record<string, string> = {
  right: 'rotate-180',
  left: '',
  down: '-rotate-90',
  up: 'rotate-90',
}

export function PanelGroup({
  group, panels, allPanelIds, collapseDirection,
  onTabActivate, onTabClose, onTabAdd, onCollapse, onExpand,
  onExpandAndActivate,
  onCollapseColumn, showCollapseColumn, columnCollapseDirection,
  onTabDragStart, onTabDrop,
}: PanelGroupProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  // Collapsed state
  if (group.collapsed) {
    const isVerticalCollapse = collapseDirection === 'up' || collapseDirection === 'down'

    const expandButton = (
      <button
        onClick={() => onExpand(group.id)}
        className="flex items-center justify-center shrink-0 w-7 h-7 text-gray-500 hover:text-gray-200 hover:bg-white/10 rounded"
        title="Expand"
      >
        <ArrowRightFromLine size={14} className={EXPAND_ROTATION[collapseDirection || 'right']} />
      </button>
    )

    const tabLabels = group.tabs.map((tabId) => {
      const def = panels[tabId]
      if (!def) return null
      return (
        <button
          key={tabId}
          onClick={() => onExpandAndActivate ? onExpandAndActivate(group.id, tabId) : (onExpand(group.id), onTabActivate(group.id, tabId))}
          className="text-[11px] text-gray-400 hover:text-gray-200 hover:bg-white/5 truncate"
          style={isVerticalCollapse
            ? { padding: '2px 8px' }
            : { writingMode: 'vertical-lr', textOrientation: 'mixed', padding: '8px 6px', borderBottom: '1px solid #1f2937' }
          }
        >
          {def.title}
        </button>
      )
    })

    const columnCollapseButton = showCollapseColumn && onCollapseColumn ? (
      <button
        onClick={onCollapseColumn}
        className="flex items-center justify-center shrink-0 w-7 h-7 text-gray-500 hover:text-gray-200 hover:bg-white/10 rounded"
        title="Collapse column"
      >
        <ArrowRightFromLine size={12} className={COLLAPSE_ROTATION[columnCollapseDirection || 'right']} />
      </button>
    ) : null

    if (isVerticalCollapse) {
      // Horizontal bar — tabs on left, buttons floated to right
      return (
        <div
          className="bg-[#111827] flex items-center overflow-hidden border-b border-gray-800"
          style={{ height: 28, width: '100%' }}
        >
          <div className="flex flex-row gap-0 overflow-hidden flex-1">{tabLabels}</div>
          {columnCollapseButton}
          {expandButton}
        </div>
      )
    }

    // Vertical bar — buttons at top, tabs below
    return (
      <div
        className="bg-[#111827] flex flex-col overflow-hidden"
        style={{ width: 34, height: '100%' }}
      >
        {columnCollapseButton}
        {expandButton}
        <div className="flex flex-col gap-0 overflow-hidden flex-1">{tabLabels}</div>
      </div>
    )
  }

  // Active panel component
  const ActiveComponent = panels[group.activeTab]?.component

  return (
    <div className="flex flex-col h-full w-full bg-[#111827]">
      {/* Tab bar */}
      <div className="flex shrink-0 bg-[#111827] border-b border-gray-800 h-[35px]">
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
                    ? 'text-gray-200 bg-gray-800/50'
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

        {/* Right actions: inner collapse + column collapse + add menu */}
        <div className="flex items-center gap-0 px-1 shrink-0 self-center">
          {/* Inner collapse — collapses this group within its split */}
          {collapseDirection && (
            <button
              onClick={() => onCollapse(group.id)}
              className="flex items-center justify-center w-6 h-6 text-gray-500 hover:text-gray-200 hover:bg-white/10 rounded"
              title="Collapse"
            >
              <ArrowRightFromLine size={12} className={COLLAPSE_ROTATION[collapseDirection]} />
            </button>
          )}
          {/* Column collapse — collapses entire parent column width-wise */}
          {showCollapseColumn && onCollapseColumn && (
            <button
              onClick={onCollapseColumn}
              className="flex items-center justify-center w-6 h-6 text-gray-500 hover:text-gray-200 hover:bg-white/10 rounded"
              title="Collapse column"
            >
              <ArrowRightFromLine size={12} className={COLLAPSE_ROTATION[columnCollapseDirection || 'right']} />
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
