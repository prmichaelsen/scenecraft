import type { LayoutNode, SplitNode, GroupNode, PanelRegistry } from './types'

/**
 * Validate a candidate LayoutNode tree loaded from storage.
 *
 * Returns `null` when the tree is malformed in a way that would crash the
 * renderer (`children[0]` on undefined, missing `tabs`, unknown `type`, etc.).
 * Also drops tab IDs that no longer exist in the current panel registry so
 * saved layouts survive panel additions/removals gracefully.
 *
 * The caller should fall back to the default layout whenever this returns null.
 */
export function validateLayout(node: unknown, panels: PanelRegistry): LayoutNode | null {
  if (!node || typeof node !== 'object') return null
  const n = node as Record<string, unknown>

  if (n.type === 'group') {
    if (typeof n.id !== 'string' || !Array.isArray(n.tabs)) return null
    const tabs = n.tabs.filter((t): t is string => typeof t === 'string' && !!panels[t])
    if (tabs.length === 0) return null
    const activeTab = typeof n.activeTab === 'string' && tabs.includes(n.activeTab) ? n.activeTab : tabs[0]
    const result: GroupNode = {
      type: 'group',
      id: n.id,
      tabs,
      activeTab,
    }
    if (typeof n.collapsed === 'boolean') result.collapsed = n.collapsed
    if (typeof n.preCollapseSize === 'number') result.preCollapseSize = n.preCollapseSize
    return result
  }

  if (n.type === 'split') {
    if (!Array.isArray(n.children) || n.children.length !== 2) return null
    if (n.direction !== 'horizontal' && n.direction !== 'vertical') return null
    const ratio = typeof n.ratio === 'number' && n.ratio > 0 && n.ratio < 1 ? n.ratio : 0.5
    const left = validateLayout(n.children[0], panels)
    const right = validateLayout(n.children[1], panels)
    if (!left && !right) return null
    if (!left) return right
    if (!right) return left
    const result: SplitNode = {
      type: 'split',
      direction: n.direction,
      ratio,
      children: [left, right],
    }
    if (typeof n.collapsed === 'boolean') result.collapsed = n.collapsed
    if (typeof n.preCollapseSize === 'number') result.preCollapseSize = n.preCollapseSize
    if (n.savedRatios && typeof n.savedRatios === 'object') {
      const savedRatios: Record<string, number> = {}
      for (const [k, v] of Object.entries(n.savedRatios)) {
        if (typeof v === 'number') savedRatios[k] = v
      }
      result.savedRatios = savedRatios
    }
    return result
  }

  return null
}
