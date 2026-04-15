import { useState, useCallback, useMemo } from 'react'
import { ArrowRightFromLine } from 'lucide-react'
import type { LayoutNode, PanelId, PanelRegistry } from './types'
import { SplitContainer } from './SplitContainer'
import { PanelGroup } from './PanelGroup'

type PanelLayoutProps = {
  panels: PanelRegistry
  defaultLayout: LayoutNode
  onLayoutChange?: (layout: LayoutNode) => void
}

type CollapseDir = 'left' | 'right' | 'up' | 'down'

// Immutable tree update: apply fn to the node at the given path
function updateNode(root: LayoutNode, path: number[], fn: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (path.length === 0) return fn(root)
  if (root.type !== 'split') return root
  const [head, ...rest] = path
  const newChildren = [...root.children] as [LayoutNode, LayoutNode]
  newChildren[head] = updateNode(newChildren[head], rest, fn)
  return { ...root, children: newChildren }
}

// Find path to a group by id
function findGroupPath(node: LayoutNode, groupId: string, path: number[] = []): number[] | null {
  if (node.type === 'group') return node.id === groupId ? path : null
  if (node.collapsed) return null // Don't search inside collapsed splits
  const left = findGroupPath(node.children[0], groupId, [...path, 0])
  if (left) return left
  return findGroupPath(node.children[1], groupId, [...path, 1])
}

// Get collapse direction for a node at a given path
// Check if a node is in the leftmost column of the tree
// (every horizontal split ancestor chose child 0)
function isInLeftmostColumn(root: LayoutNode, path: number[]): boolean {
  let node: LayoutNode = root
  for (let i = 0; i < path.length; i++) {
    if (node.type !== 'split') break
    if (node.direction === 'horizontal' && path[i] !== 0) return false
    node = node.children[path[i]]
  }
  return true
}

function getCollapseDir(root: LayoutNode, path: number[]): CollapseDir | undefined {
  if (path.length === 0) return undefined
  let parent: LayoutNode = root
  for (let i = 0; i < path.length - 1; i++) {
    if (parent.type !== 'split') return undefined
    parent = parent.children[path[i]]
  }
  if (parent.type !== 'split') return undefined
  if (parent.direction === 'horizontal') {
    // Leftmost column collapses left, everything else collapses right
    return isInLeftmostColumn(root, path) ? 'left' : 'right'
  } else {
    const childIndex = path[path.length - 1]
    return childIndex === 0 ? 'up' : 'down'
  }
}

// Get the parent split direction for a path
function getParentDirection(root: LayoutNode, path: number[]): 'horizontal' | 'vertical' | undefined {
  if (path.length === 0) return undefined
  let node: LayoutNode = root
  for (let i = 0; i < path.length - 1; i++) {
    if (node.type !== 'split') return undefined
    node = node.children[path[i]]
  }
  if (node.type !== 'split') return undefined
  return node.direction
}

// Collect all tab labels from all groups in a subtree
function collectAllTabs(node: LayoutNode): { groupId: string; tabs: PanelId[] }[] {
  if (node.type === 'group') return [{ groupId: node.id, tabs: node.tabs }]
  return [...collectAllTabs(node.children[0]), ...collectAllTabs(node.children[1])]
}

const COLLAPSE_ROTATION: Record<string, string> = {
  right: '',
  left: 'rotate-180',
  down: 'rotate-90',
  up: '-rotate-90',
}

export function PanelLayout({ panels, defaultLayout, onLayoutChange }: PanelLayoutProps) {
  const [layout, setLayout] = useState<LayoutNode>(defaultLayout)

  const allPanelIds = useMemo(() => Object.keys(panels), [panels])

  const update = useCallback((newLayout: LayoutNode) => {
    setLayout(newLayout)
    onLayoutChange?.(newLayout)
  }, [onLayoutChange])

  const handleTabActivate = useCallback((groupId: string, tabId: PanelId) => {
    const path = findGroupPath(layout, groupId)
    if (!path) return
    update(updateNode(layout, path, (node) => {
      if (node.type !== 'group') return node
      return { ...node, activeTab: tabId }
    }))
  }, [layout, update])

  const handleTabClose = useCallback((groupId: string, tabId: PanelId) => {
    const path = findGroupPath(layout, groupId)
    if (!path) return
    update(updateNode(layout, path, (node) => {
      if (node.type !== 'group') return node
      const newTabs = node.tabs.filter((t) => t !== tabId)
      if (newTabs.length === 0) return node
      return {
        ...node,
        tabs: newTabs,
        activeTab: node.activeTab === tabId ? newTabs[0] : node.activeTab,
      }
    }))
  }, [layout, update])

  const handleTabAdd = useCallback((groupId: string, tabId: PanelId) => {
    const path = findGroupPath(layout, groupId)
    if (!path) return
    update(updateNode(layout, path, (node) => {
      if (node.type !== 'group') return node
      if (node.tabs.includes(tabId)) return node
      return { ...node, tabs: [...node.tabs, tabId], activeTab: tabId }
    }))
  }, [layout, update])

  const handleCollapse = useCallback((groupId: string) => {
    const path = findGroupPath(layout, groupId)
    if (!path) return
    update(updateNode(layout, path, (node) => {
      if (node.type !== 'group') return node
      return { ...node, collapsed: true }
    }))
  }, [layout, update])

  const handleExpand = useCallback((groupId: string) => {
    const path = findGroupPath(layout, groupId)
    if (!path) return
    update(updateNode(layout, path, (node) => {
      if (node.type !== 'group') return node
      return { ...node, collapsed: false }
    }))
  }, [layout, update])

  // Column collapse: collapse an entire split node (used for vertical columns inside horizontal splits)
  const handleCollapseColumn = useCallback((splitPath: number[]) => {
    update(updateNode(layout, splitPath, (node) => {
      if (node.type !== 'split') return node
      return { ...node, collapsed: true }
    }))
  }, [layout, update])

  const handleExpandColumn = useCallback((splitPath: number[]) => {
    update(updateNode(layout, splitPath, (node) => {
      if (node.type !== 'split') return node
      return { ...node, collapsed: false }
    }))
  }, [layout, update])

  const handleRatioChange = useCallback((path: number[], newRatio: number) => {
    if (path.length === 0 && layout.type === 'split') {
      update({ ...layout, ratio: newRatio })
      return
    }
    update(updateNode(layout, path, (node) => {
      if (node.type !== 'split') return node
      return { ...node, ratio: newRatio }
    }))
  }, [layout, update])

  function renderNode(node: LayoutNode, path: number[] = []): React.ReactNode {
    if (node.type === 'group') {
      const collapseDir = getCollapseDir(layout, path)

      // Determine if this group should show the "collapse column" button.
      // Condition: this group is inside a vertical split, which is inside a horizontal split,
      // and this group is the topmost (first) child in the vertical split.
      let showCollapseColumn = false
      let columnCollapseDirection: 'left' | 'right' | undefined
      let columnSplitPath: number[] | undefined

      if (path.length >= 2) {
        const parentDir = getParentDirection(layout, path)
        if (parentDir === 'vertical') {
          const verticalSplitPath = path.slice(0, -1)
          const grandparentDir = getParentDirection(layout, verticalSplitPath)
          if (grandparentDir === 'horizontal' && path[path.length - 1] === 0) {
            showCollapseColumn = true
            columnCollapseDirection = isInLeftmostColumn(layout, verticalSplitPath) ? 'left' : 'right'
            columnSplitPath = verticalSplitPath
          }
        }
      }

      return (
        <PanelGroup
          key={node.id}
          group={node}
          panels={panels}
          allPanelIds={allPanelIds}
          collapseDirection={collapseDir}
          onTabActivate={handleTabActivate}
          onTabClose={handleTabClose}
          onTabAdd={handleTabAdd}
          onCollapse={handleCollapse}
          onExpand={handleExpand}
          showCollapseColumn={showCollapseColumn}
          columnCollapseDirection={columnCollapseDirection}
          onCollapseColumn={columnSplitPath ? () => handleCollapseColumn(columnSplitPath) : undefined}
        />
      )
    }

    // Collapsed split node — render as a single collapsed bar with all tabs from the subtree
    if (node.collapsed) {
      const allTabs = collectAllTabs(node)
      const flatTabs = allTabs.flatMap((g) => g.tabs)
      const collapseDir = getCollapseDir(layout, path)

      return (
        <div
          key={path.join('-') || 'root'}
          className="bg-[#111827] flex flex-col overflow-hidden"
          style={{ width: 34, height: '100%' }}
        >
          <button
            onClick={() => handleExpandColumn(path)}
            className="flex items-center justify-center shrink-0 w-7 h-7 text-gray-500 hover:text-gray-200 hover:bg-white/10 rounded m-0.5"
            title="Expand column"
          >
            <ArrowRightFromLine size={14} className={COLLAPSE_ROTATION[collapseDir || 'right']} />
          </button>
          <div className="flex flex-col gap-0 overflow-hidden flex-1">
            {flatTabs.map((tabId) => {
              const def = panels[tabId]
              if (!def) return null
              return (
                <button
                  key={tabId}
                  onClick={() => handleExpandColumn(path)}
                  className="text-[11px] text-gray-400 hover:text-gray-200 hover:bg-white/5 truncate"
                  style={{ writingMode: 'vertical-lr', textOrientation: 'mixed', padding: '8px 6px', borderBottom: '1px solid #1f2937' }}
                >
                  {def.title}
                </button>
              )
            })}
          </div>
        </div>
      )
    }

    const firstCollapsed = !!node.children[0].collapsed
    const secondCollapsed = !!node.children[1].collapsed

    return (
      <SplitContainer
        key={path.join('-') || 'root'}
        direction={node.direction}
        ratio={node.ratio}
        onRatioChange={(r) => handleRatioChange(path, r)}
        firstCollapsed={firstCollapsed}
        secondCollapsed={secondCollapsed}
      >
        {[renderNode(node.children[0], [...path, 0]), renderNode(node.children[1], [...path, 1])]}
      </SplitContainer>
    )
  }

  return (
    <div className="h-full w-full overflow-hidden">
      {renderNode(layout)}
    </div>
  )
}
