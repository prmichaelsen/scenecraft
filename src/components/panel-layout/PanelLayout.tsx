import { useState, useCallback, useMemo, useRef } from 'react'
import { ArrowRightFromLine } from 'lucide-react'
import type { LayoutNode, SplitNode, PanelId, PanelRegistry } from './types'
import { SplitContainer } from './SplitContainer'
import { PanelGroup } from './PanelGroup'

type PanelLayoutProps = {
  panels: PanelRegistry
  defaultLayout: LayoutNode
  onLayoutChange?: (layout: LayoutNode) => void
}

type CollapseDir = 'left' | 'right' | 'up' | 'down'

const COLLAPSED_PX = 34
const SASH_PX = 4

// --- Tree utilities ---

function updateNode(root: LayoutNode, path: number[], fn: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (path.length === 0) return fn(root)
  if (root.type !== 'split') return root
  const [head, ...rest] = path
  const newChildren = [...root.children] as [LayoutNode, LayoutNode]
  newChildren[head] = updateNode(newChildren[head], rest, fn)
  return { ...root, children: newChildren }
}

function getNode(root: LayoutNode, path: number[]): LayoutNode {
  let node = root
  for (const idx of path) {
    if (node.type !== 'split') return node
    node = node.children[idx]
  }
  return node
}

function findGroupPath(node: LayoutNode, groupId: string, path: number[] = []): number[] | null {
  if (node.type === 'group') return node.id === groupId ? path : null
  if (node.collapsed) return null
  const left = findGroupPath(node.children[0], groupId, [...path, 0])
  if (left) return left
  return findGroupPath(node.children[1], groupId, [...path, 1])
}

// --- Collapse direction ---

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
    return isInLeftmostColumn(root, path) ? 'left' : 'right'
  } else {
    const childIndex = path[path.length - 1]
    return childIndex === 0 ? 'up' : 'down'
  }
}

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

// --- Pixel size computation ---

// Compute the pixel size of a node at a given path, given the root container size
function computeNodePx(root: LayoutNode, targetPath: number[], containerPx: number, axis: 'horizontal' | 'vertical'): number {
  let availablePx = containerPx
  let node: LayoutNode = root

  for (let i = 0; i < targetPath.length; i++) {
    if (node.type !== 'split') return availablePx
    // Only account for sash and ratio on same-axis splits
    if (node.direction === axis) {
      const usable = availablePx - SASH_PX
      if (targetPath[i] === 0) {
        availablePx = node.ratio * usable
      } else {
        availablePx = (1 - node.ratio) * usable
      }
    }
    // For cross-axis splits, the child gets full available size on the target axis
    node = node.children[targetPath[i]]
  }
  return availablePx
}

// --- Ratio adjustment for collapse ---

// Compute the ratio changes needed when collapsing a node.
// Returns array of { path, newRatio, oldRatio } for each ancestor split that needs adjustment.
function computeCollapseRatioChanges(
  root: LayoutNode,
  collapsePath: number[],
  collapseDir: CollapseDir,
  containerPx: number,
): Array<{ path: number[], newRatio: number, oldRatio: number }> {
  const axis = (collapseDir === 'left' || collapseDir === 'right') ? 'horizontal' : 'vertical'
  const collapsingRight = collapseDir === 'right' || collapseDir === 'down'

  // Compute the current pixel size of the node being collapsed
  const currentPx = computeNodePx(root, collapsePath, containerPx, axis)
  const freedPx = currentPx - COLLAPSED_PX
  if (freedPx <= 0) return []

  const changes: Array<{ path: number[], newRatio: number, oldRatio: number }> = []

  // Walk up from the collapsing node through same-axis ancestor splits.
  // At the immediate parent: adjust ratio so collapsed child gets COLLAPSED_PX.
  // Then propagate freed space upward to the beneficiary.

  // Collect all same-axis ancestor splits from the collapse point to root
  const ancestors: Array<{ path: number[], childIdx: number, split: SplitNode }> = []
  for (let depth = collapsePath.length; depth > 0; depth--) {
    const ancestorPath = collapsePath.slice(0, depth - 1)
    const ancestor = getNode(root, ancestorPath)
    if (ancestor.type !== 'split') continue
    if (ancestor.direction !== axis) continue
    ancestors.push({
      path: ancestorPath,
      childIdx: collapsePath[depth - 1],
      split: ancestor,
    })
  }

  if (ancestors.length === 0) return []

  // Immediate parent: adjust ratio so collapsed child gets COLLAPSED_PX
  const immParent = ancestors[0]
  const immParentPx = computeNodePx(root, immParent.path, containerPx, axis)
  const immUsable = immParentPx - SASH_PX
  let newImmRatio: number
  if (immParent.childIdx === 0) {
    // Collapsed node is first child
    newImmRatio = COLLAPSED_PX / immUsable
  } else {
    // Collapsed node is second child
    newImmRatio = (immUsable - COLLAPSED_PX) / immUsable
  }
  changes.push({ path: immParent.path, newRatio: newImmRatio, oldRatio: immParent.split.ratio })

  // Now propagate: the parent split itself needs to shrink.
  // Find the beneficiary: for right-collapse, walk up until we find an ancestor
  // where the collapsing subtree is on the RIGHT (childIdx=1). The left sibling gets the space.
  // For left-collapse, find where collapsing subtree is on the LEFT (childIdx=0).
  for (let i = 1; i < ancestors.length; i++) {
    const anc = ancestors[i]
    // For right-collapse: if we're child[0], the freed space can't go left (there's nothing further left at this level)
    // We need to keep walking up. If we're child[1], the left sibling (child[0]) gets the space.
    if (collapsingRight && anc.childIdx === 1) {
      // Beneficiary is child[0] at this level — it grows by freedPx
      const ancPx = computeNodePx(root, anc.path, containerPx, axis)
      const ancUsable = ancPx - SASH_PX
      const child0CurrentPx = anc.split.ratio * ancUsable
      const newChild0Px = child0CurrentPx + freedPx
      const newRatio = newChild0Px / ancUsable
      changes.push({ path: anc.path, newRatio, oldRatio: anc.split.ratio })
      break
    }
    if (!collapsingRight && anc.childIdx === 0) {
      // Beneficiary is child[1] — child[0] shrinks, child[1] grows
      const ancPx = computeNodePx(root, anc.path, containerPx, axis)
      const ancUsable = ancPx - SASH_PX
      const child0CurrentPx = anc.split.ratio * ancUsable
      const newChild0Px = child0CurrentPx - freedPx
      const newRatio = newChild0Px / ancUsable
      changes.push({ path: anc.path, newRatio, oldRatio: anc.split.ratio })
      break
    }
    // If we didn't find a beneficiary at this level, the freed space stays within this subtree
    // (the sibling at the immediate parent already absorbed it via the ratio change)
  }

  return changes
}

// --- Collect tabs ---

function collectAllTabs(node: LayoutNode): { groupId: string; tabs: PanelId[] }[] {
  if (node.type === 'group') return [{ groupId: node.id, tabs: node.tabs }]
  return [...collectAllTabs(node.children[0]), ...collectAllTabs(node.children[1])]
}

// --- Icons ---

const EXPAND_ROTATION: Record<string, string> = {
  right: 'rotate-180',
  left: '',
  down: '-rotate-90',
  up: 'rotate-90',
}


// --- Component ---

export function PanelLayout({ panels, defaultLayout, onLayoutChange }: PanelLayoutProps) {
  const [layout, setLayout] = useState<LayoutNode>(defaultLayout)
  const rootRef = useRef<HTMLDivElement>(null)

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
      return { ...node, tabs: newTabs, activeTab: node.activeTab === tabId ? newTabs[0] : node.activeTab }
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

  // Inner group collapse (vertical within a column)
  const handleCollapse = useCallback((groupId: string) => {
    const path = findGroupPath(layout, groupId)
    if (!path) return
    const rootEl = rootRef.current
    if (!rootEl) return

    const collapseDir = getCollapseDir(layout, path)
    if (!collapseDir) {
      // Simple collapse without ratio adjustment
      update(updateNode(layout, path, (node) => ({ ...node, collapsed: true })))
      return
    }

    const axis = (collapseDir === 'left' || collapseDir === 'right') ? 'horizontal' : 'vertical'
    const containerPx = axis === 'horizontal' ? rootEl.clientWidth : rootEl.clientHeight
    const changes = computeCollapseRatioChanges(layout, path, collapseDir, containerPx)

    let newLayout = updateNode(layout, path, (node) => ({ ...node, collapsed: true }))
    const collapseKey = path.join(',')
    for (const { path: splitPath, newRatio, oldRatio } of changes) {
      newLayout = updateNode(newLayout, splitPath, (node) => {
        if (node.type !== 'split') return node
        return { ...node, ratio: newRatio, savedRatios: { ...node.savedRatios, [collapseKey]: oldRatio } }
      })
    }
    update(newLayout)
  }, [layout, update])

  const handleExpand = useCallback((groupId: string) => {
    const path = findGroupPath(layout, groupId)
    if (!path) return
    const collapseKey = path.join(',')
    // Restore saved ratios on all ancestors
    let newLayout = updateNode(layout, path, (node) => ({ ...node, collapsed: false }))
    // Walk up and restore any savedRatios keyed by this collapse
    for (let depth = path.length; depth > 0; depth--) {
      const ancestorPath = path.slice(0, depth - 1)
      const ancestor = getNode(newLayout, ancestorPath)
      if (ancestor.type === 'split' && ancestor.savedRatios?.[collapseKey] !== undefined) {
        const savedRatio = ancestor.savedRatios[collapseKey]
        newLayout = updateNode(newLayout, ancestorPath, (node) => {
          if (node.type !== 'split') return node
          const { [collapseKey]: _, ...restSaved } = node.savedRatios || {}
          return { ...node, ratio: savedRatio, savedRatios: Object.keys(restSaved).length > 0 ? restSaved : undefined }
        })
      }
    }
    update(newLayout)
  }, [layout, update])

  const handleExpandAndActivate = useCallback((groupId: string, tabId: PanelId) => {
    const path = findGroupPath(layout, groupId)
    if (!path) return
    const collapseKey = path.join(',')
    let newLayout = updateNode(layout, path, (node) => {
      if (node.type !== 'group') return node
      return { ...node, collapsed: false, activeTab: tabId }
    })
    for (let depth = path.length; depth > 0; depth--) {
      const ancestorPath = path.slice(0, depth - 1)
      const ancestor = getNode(newLayout, ancestorPath)
      if (ancestor.type === 'split' && ancestor.savedRatios?.[collapseKey] !== undefined) {
        const savedRatio = ancestor.savedRatios[collapseKey]
        newLayout = updateNode(newLayout, ancestorPath, (node) => {
          if (node.type !== 'split') return node
          const { [collapseKey]: _, ...restSaved } = node.savedRatios || {}
          return { ...node, ratio: savedRatio, savedRatios: Object.keys(restSaved).length > 0 ? restSaved : undefined }
        })
      }
    }
    update(newLayout)
  }, [layout, update])

  // Column collapse: collapse an entire split node with ratio adjustment
  const handleCollapseColumn = useCallback((splitPath: number[]) => {
    const rootEl = rootRef.current
    if (!rootEl) return

    const collapseDir = getCollapseDir(layout, splitPath)
    if (!collapseDir) {
      update(updateNode(layout, splitPath, (node) => ({ ...node, collapsed: true })))
      return
    }

    const axis = (collapseDir === 'left' || collapseDir === 'right') ? 'horizontal' : 'vertical'
    const containerPx = axis === 'horizontal' ? rootEl.clientWidth : rootEl.clientHeight
    const changes = computeCollapseRatioChanges(layout, splitPath, collapseDir, containerPx)

    let newLayout = updateNode(layout, splitPath, (node) => ({ ...node, collapsed: true }))
    const collapseKey = splitPath.join(',')
    for (const { path, newRatio, oldRatio } of changes) {
      newLayout = updateNode(newLayout, path, (node) => {
        if (node.type !== 'split') return node
        return { ...node, ratio: newRatio, savedRatios: { ...node.savedRatios, [collapseKey]: oldRatio } }
      })
    }
    update(newLayout)
  }, [layout, update])

  const handleExpandColumn = useCallback((splitPath: number[]) => {
    const collapseKey = splitPath.join(',')
    let newLayout = updateNode(layout, splitPath, (node) => ({ ...node, collapsed: false }))
    // Restore saved ratios on all ancestors
    for (let depth = splitPath.length; depth >= 0; depth--) {
      const ancestorPath = splitPath.slice(0, depth)
      const ancestor = getNode(newLayout, ancestorPath)
      if (ancestor.type === 'split' && ancestor.savedRatios?.[collapseKey] !== undefined) {
        const savedRatio = ancestor.savedRatios[collapseKey]
        newLayout = updateNode(newLayout, ancestorPath, (node) => {
          if (node.type !== 'split') return node
          const { [collapseKey]: _, ...restSaved } = node.savedRatios || {}
          return { ...node, ratio: savedRatio, savedRatios: Object.keys(restSaved).length > 0 ? restSaved : undefined }
        })
      }
    }
    update(newLayout)
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
          onExpandAndActivate={handleExpandAndActivate}
          showCollapseColumn={showCollapseColumn}
          columnCollapseDirection={columnCollapseDirection}
          onCollapseColumn={columnSplitPath ? () => handleCollapseColumn(columnSplitPath) : undefined}
        />
      )
    }

    // Collapsed split node — render as a single collapsed bar
    if (node.collapsed) {
      const allGroups = collectAllTabs(node)
      const flatTabs = allGroups.flatMap((g) => g.tabs)
      const collapseDir = getCollapseDir(layout, path)
      return (
        <div
          key={path.join('-') || 'root'}
          className="bg-[#111827] flex flex-col overflow-hidden"
          style={{ width: COLLAPSED_PX, height: '100%' }}
        >
          <button
            onClick={() => handleExpandColumn(path)}
            className="flex items-center justify-center shrink-0 w-7 h-7 text-gray-500 hover:text-gray-200 hover:bg-white/10 rounded m-0.5"
            title="Expand column"
          >
            <ArrowRightFromLine size={14} className={EXPAND_ROTATION[collapseDir || 'right']} />
          </button>
          <div className="flex flex-col gap-0 overflow-hidden flex-1">
            {flatTabs.map((tabId) => {
              const def = panels[tabId]
              if (!def) return null
              return (
                <button
                  key={tabId}
                  onClick={() => {
                    const ownerGroup = allGroups.find((g) => g.tabs.includes(tabId))
                    // Expand column + restore ratios + activate tab
                    const collapseKey = path.join(',')
                    let newLayout = updateNode(layout, path, (n) => ({ ...n, collapsed: false }))
                    // Restore saved ratios
                    for (let depth = path.length; depth >= 0; depth--) {
                      const ancestorPath = path.slice(0, depth)
                      const ancestor = getNode(newLayout, ancestorPath)
                      if (ancestor.type === 'split' && ancestor.savedRatios?.[collapseKey] !== undefined) {
                        const savedRatio = ancestor.savedRatios[collapseKey]
                        newLayout = updateNode(newLayout, ancestorPath, (n) => {
                          if (n.type !== 'split') return n
                          const { [collapseKey]: _, ...restSaved } = n.savedRatios || {}
                          return { ...n, ratio: savedRatio, savedRatios: Object.keys(restSaved).length > 0 ? restSaved : undefined }
                        })
                      }
                    }
                    // Activate tab
                    if (ownerGroup) {
                      const groupPath = findGroupPath(newLayout, ownerGroup.groupId)
                      if (groupPath) {
                        newLayout = updateNode(newLayout, groupPath, (n) => {
                          if (n.type !== 'group') return n
                          return { ...n, activeTab: tabId }
                        })
                      }
                    }
                    update(newLayout)
                  }}
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
    <div ref={rootRef} className="h-full w-full overflow-hidden">
      {renderNode(layout)}
    </div>
  )
}
