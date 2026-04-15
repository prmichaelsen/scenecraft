import { useState, useCallback, useMemo } from 'react'
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
  const left = findGroupPath(node.children[0], groupId, [...path, 0])
  if (left) return left
  return findGroupPath(node.children[1], groupId, [...path, 1])
}

// Get collapse direction for a node at a given path
function getCollapseDir(root: LayoutNode, path: number[]): CollapseDir | undefined {
  if (path.length === 0) return undefined
  // Walk to parent
  let parent: LayoutNode = root
  for (let i = 0; i < path.length - 1; i++) {
    if (parent.type !== 'split') return undefined
    parent = parent.children[path[i]]
  }
  if (parent.type !== 'split') return undefined
  const childIndex = path[path.length - 1]
  if (parent.direction === 'horizontal') {
    return childIndex === 0 ? 'left' : 'right'
  } else {
    return childIndex === 0 ? 'up' : 'down'
  }
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
      if (newTabs.length === 0) return node // Don't remove last tab
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
        />
      )
    }

    const firstCollapsed = node.children[0].type === 'group' && node.children[0].collapsed
    const secondCollapsed = node.children[1].type === 'group' && node.children[1].collapsed

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
