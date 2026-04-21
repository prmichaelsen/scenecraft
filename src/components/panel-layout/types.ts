export type PanelId = string

export type SplitNode = {
  type: 'split'
  direction: 'horizontal' | 'vertical'
  ratio: number // 0-1
  children: [LayoutNode, LayoutNode]
  collapsed?: boolean       // When true, this entire subtree is collapsed (used for column collapse)
  preCollapseSize?: number  // Preserved width/height before collapse
  savedRatios?: Record<string, number>  // key = collapsePath.join(','), value = ratio before that collapse
}

export type GroupNode = {
  type: 'group'
  id: string
  tabs: PanelId[]
  activeTab: PanelId
  collapsed?: boolean
  preCollapseSize?: number
  // When true, external `activatePanel(...)` calls skip this group so the user's
  // current tab/active selection isn't stolen by auto-activation.
  locked?: boolean
}

export type LayoutNode = SplitNode | GroupNode

export type PanelDef = {
  component: React.ComponentType
  title: string
  icon?: React.ComponentType
}

export type PanelRegistry = Record<PanelId, PanelDef>
