export type PanelId = string

export type SplitNode = {
  type: 'split'
  direction: 'horizontal' | 'vertical'
  ratio: number // 0-1
  children: [LayoutNode, LayoutNode]
}

export type GroupNode = {
  type: 'group'
  id: string
  tabs: PanelId[]
  activeTab: PanelId
  collapsed?: boolean
  preCollapseSize?: number
}

export type LayoutNode = SplitNode | GroupNode

export type PanelDef = {
  component: React.ComponentType
  title: string
  icon?: React.ComponentType
}

export type PanelRegistry = Record<PanelId, PanelDef>
