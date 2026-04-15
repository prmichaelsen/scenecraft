# Custom Panel Layout Library

**Concept**: Replace dockview-react with a custom, generic split-tree panel layout system with tabs, drag-and-drop, collapse, and workspace persistence  
**Created**: 2026-04-15  
**Status**: Design Specification  

---

## Overview

The editor currently uses dockview-react for its panel layout. After extensive work with dockview, it has proven to have too many sharp edges: hardcoded 100px minimum widths, double sashes from separator borders overlapping resize handles, no built-in collapse support, phantom sashes from hidden groups, `toJSON()` that returns objects not strings, and nested split tree quirks that produce unpredictable layout behavior.

This design replaces dockview with a custom `<PanelLayout>` component built from scratch using CSS flexbox and plain DOM drag handles. The library is generic and reusable — it has no knowledge of scenecraft-specific panels.

---

## Problem Statement

- dockview hardcodes `minimumWidth: 100px` on groups, requiring workarounds for collapse
- Double sashes: dockview renders both a resize sash AND a `::before` separator border at each split boundary
- Hidden groups (`setVisible(false)`) still create phantom sashes
- No built-in collapse/expand — we had to build it manually with `setHeaderPosition('left')` + `setConstraints()` + `setSize()` hacks
- `toJSON()` returns an opaque `SerializedDockview` object, not a string — misleading API
- Nested split trees from `addPanel({ direction: 'left' })` create unpredictable sash stacking
- The library is 150KB+ for functionality we only partially use

---

## Solution

A custom panel layout system built on a **binary split tree** data model:

```
LayoutNode = SplitNode | GroupNode

SplitNode {
  direction: 'horizontal' | 'vertical'
  ratio: number           // 0-1, proportion of first child
  children: [LayoutNode, LayoutNode]
}

GroupNode {
  id: string
  tabs: PanelId[]
  activeTab: PanelId
  collapsed: boolean
  preCollapseSize: number  // px, restored on expand
}
```

Every panel is equal. There are no special "sidebar" or "center" designations. Users split, stack, and tab panels however they want. The default editor layout is just a preset arrangement of this tree.

### Architecture

```
<PanelLayout>                    // Generic, reusable
├── components/
│   ├── PanelLayout.tsx          // Root: renders split tree recursively
│   ├── SplitContainer.tsx       // Renders two children with a resize sash
│   ├── PanelGroup.tsx           // Tab bar + active panel content
│   ├── TabBar.tsx               // Draggable tabs, close button, add menu
│   ├── ResizeSash.tsx           // Single div, no pseudo-elements
│   └── CollapsedGroup.tsx       // Vertical tab labels + expand button
├── context/
│   └── PanelLayoutContext.tsx   // Layout tree state, API methods
├── types.ts                     // LayoutNode, SplitNode, GroupNode, PanelDef
└── hooks/
    └── usePanelLayout.ts        // Public API hook
```

### Component Registry

The layout takes a component registry — a map of panel IDs to React components:

```tsx
const panels: PanelRegistry = {
  timeline: { component: TimelinePanel, title: 'Timeline' },
  preview:  { component: PreviewPanel,  title: 'Preview' },
  bin:      { component: BinPanel,      title: 'Bin' },
  logs:     { component: LogPanel,      title: 'Logs' },
  // ...
}

<PanelLayout
  panels={panels}
  defaultLayout={defaultTree}
  onLayoutChange={handleAutosave}
/>
```

---

## Implementation

### Data Model

```typescript
type PanelId = string

type SplitNode = {
  type: 'split'
  direction: 'horizontal' | 'vertical'
  ratio: number // 0-1
  children: [LayoutNode, LayoutNode]
}

type GroupNode = {
  type: 'group'
  id: string
  tabs: PanelId[]
  activeTab: PanelId
  collapsed?: boolean
  preCollapseSize?: number
}

type LayoutNode = SplitNode | GroupNode

type PanelDef = {
  component: React.ComponentType
  title: string
  icon?: React.ComponentType  // optional tab icon
}

type PanelRegistry = Record<PanelId, PanelDef>
```

### Rendering

`PanelLayout` renders the tree recursively:
- **SplitNode** → `<SplitContainer>` with two children and a `<ResizeSash>` between them
- **GroupNode** → `<PanelGroup>` with a `<TabBar>` and the active panel's component
- **GroupNode (collapsed)** → `<CollapsedGroup>` with vertical tab labels

```tsx
function renderNode(node: LayoutNode): ReactNode {
  if (node.type === 'split') {
    return (
      <SplitContainer direction={node.direction} ratio={node.ratio}>
        {renderNode(node.children[0])}
        {renderNode(node.children[1])}
      </SplitContainer>
    )
  }
  if (node.collapsed) {
    return <CollapsedGroup group={node} />
  }
  return <PanelGroup group={node} />
}
```

### SplitContainer

Uses CSS flexbox. The sash is a single `<div>`:

```tsx
function SplitContainer({ direction, ratio, children, onRatioChange }) {
  const isHorizontal = direction === 'horizontal'
  return (
    <div style={{ display: 'flex', flexDirection: isHorizontal ? 'row' : 'column' }}>
      <div style={{ flex: `0 0 ${ratio * 100}%`, minWidth: 100, minHeight: 100 }}>
        {children[0]}
      </div>
      <ResizeSash
        direction={direction}
        onDrag={(delta) => onRatioChange(clamp(ratio + delta, 0.05, 0.95))}
      />
      <div style={{ flex: 1, minWidth: 100, minHeight: 100 }}>
        {children[1]}
      </div>
    </div>
  )
}
```

### ResizeSash

One element. One cursor. No pseudo-elements.

```tsx
function ResizeSash({ direction, onDrag }) {
  return (
    <div
      className="shrink-0 hover:bg-blue-500/50 active:bg-blue-500 bg-transparent transition-colors"
      style={{
        width: direction === 'horizontal' ? 4 : '100%',
        height: direction === 'vertical' ? 4 : '100%',
        cursor: direction === 'horizontal' ? 'col-resize' : 'row-resize',
      }}
      onMouseDown={startDrag}
    />
  )
}
```

### Tab Drag and Drop

Tabs are draggable between groups. When dragging:
1. The tab element gets `draggable="true"` with a MIME type carrying the panel ID
2. Drop targets appear on group edges (split indicators) and tab bars (insert position)
3. On drop: remove tab from source group → insert into target group (or create new split)

### Collapse / Expand

- Each `GroupNode` has `collapsed: boolean` and `preCollapseSize: number`
- Collapse direction is **contextual** — determined by the parent split's direction:
  - **Parent is horizontal split** → group collapses **width** (shrinks to 34px wide, vertical tab labels)
  - **Parent is vertical split** → group collapses **height** (shrinks to 28px tall, horizontal tab labels)
- Collapse button placement:
  - **Horizontal collapse** → button at **top-right corner** of the group header
  - **Vertical collapse** → button at **right end** of the group header
- Icon: `ArrowRightFromLine` from lucide-react, rotated to match collapse direction:
  - Right child of horizontal split → arrow points right
  - Left child of horizontal split → arrow rotated 180°
  - Bottom child of vertical split → arrow rotated 90° (points down)
  - Top child of vertical split → arrow rotated 270° (points up)
- Nested splits can each be independently collapsed — e.g., collapse a vertical split within an already-narrow horizontal column
- Collapsing overrides the parent split's `minWidth`/`minHeight` for this child

### Tab Rendering

Inactive tabs are **unmounted**. Only the active tab in each group renders its component. Panels that need persistent state across tab switches should use React context (e.g., `CurrentTimeContext`, `PreviewContext`) or localStorage.

### Context-Sensitive Activation

The layout API exposes `activatePanel(id: PanelId)` which:
1. Searches all groups in the tree for the panel ID
2. Sets it as the active tab in its group
3. If the group is collapsed, expands it first

Timeline calls `activatePanel('properties')` when a keyframe/transition is selected.

### Public API

```typescript
type PanelLayoutApi = {
  // Layout manipulation
  activatePanel(id: PanelId): void
  addPanel(id: PanelId, targetGroupId?: string): void
  removePanel(id: PanelId): void
  splitGroup(groupId: string, direction: 'horizontal' | 'vertical', newPanelId: PanelId): void

  // Collapse
  collapseGroup(groupId: string): void
  expandGroup(groupId: string): void

  // Serialization
  serialize(): LayoutNode
  deserialize(layout: LayoutNode): void
}
```

### Workspace Persistence

Same backend API as before — the layout tree serializes to JSON and is stored via:
- `POST /api/projects/:name/workspace-views/:viewName` — save
- `GET /api/projects/:name/workspace-views/:viewName` — load

Auto-save on layout changes (debounced 2s) to `_autosave`. Named workspace views for save/load/delete.

The serialization format is scope-agnostic. Future config hierarchy (user > project > org) is handled by the config layer, not this library.

### Default Editor Layout

```typescript
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
            { type: 'group', id: 'utilities-group', tabs: ['bin', 'logs', 'checkpoints', 'settings', 'extensions'], activeTab: 'bin' },
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
```

---

## Benefits

- **Zero third-party dependencies** — no dockview, no library quirks
- **Single sash per boundary** — one `<div>`, one cursor, no double borders
- **Built-in collapse** — first-class feature, not a hack
- **Predictable layout tree** — binary split tree with explicit ratios, no hidden internal state
- **Generic and reusable** — no scenecraft knowledge in the library, could be extracted as a package
- **~500 lines** — vs 150KB+ dockview bundle
- **Full control** — every pixel, every cursor, every behavior is ours

---

## Trade-offs

- **More code to maintain** — we own the layout system instead of delegating to a library
- **Drag-and-drop complexity** — building tab DnD with split-on-edge targets is non-trivial (mitigated by using native HTML drag API)
- **No floating panels** — dockview supports detaching panels into floating windows; we don't need this
- **No undo** — layout changes are not undoable (same as dockview, mitigated by named workspace views)

---

## Dependencies

- `lucide-react` — collapse/expand icons (already installed)
- `CurrentTimeContext`, `PreviewContext`, `EditorStateContext` — existing shared state contexts
- Backend workspace views API — existing, no changes needed

---

## Testing Strategy

- Render default layout, verify all panels appear
- Resize sash drag: verify ratio updates and minimum widths enforced
- Tab click: verify active tab switches and inactive tabs unmount
- Tab drag: verify panel moves between groups
- Collapse/expand: verify 34px collapsed state, vertical labels, expand restores size
- Serialize/deserialize: round-trip layout tree through JSON
- Auto-save: verify debounced save on layout change

---

## Migration Path

1. Build `<PanelLayout>` as new files alongside dockview (`src/components/panel-layout/`)
2. Create `EditorPanelLayout.tsx` that wires the generic library to scenecraft panels
3. Replace `EditorLayout.tsx` (dockview) with `EditorPanelLayout.tsx`
4. Remove `v2` prop from Timeline — it's always the panel layout now
5. Delete dockview files: `EditorLayout.tsx`, `dockview-theme.css`
6. `npm uninstall dockview-react dockview-core`

---

## Key Design Decisions

### Layout Model

| Decision | Choice | Rationale |
|---|---|---|
| Layout structure | Binary split tree, no sidebar/center distinction | User requested fully flexible layout — all panels are equal |
| Panel rearranging | All panels freely rearrangeable | No panel pinned to a position |
| Minimum group width | 100px (34px when collapsed) | Matches dockview behavior we already had |

### Tab System

| Decision | Choice | Rationale |
|---|---|---|
| Tab drag-and-drop | Full drag between groups | User confirmed |
| Tab closing | All panels closeable via X, reopen via ⋮ menu | Every panel is equal — no special cases |
| All panels addable | Every panel type listed in every group's add menu | User specified |
| Tab rendering | Unmount inactive tabs | Saves memory, state persists via contexts |
| Context-sensitive activation | `activatePanel('properties')` on keyframe/transition select | User confirmed |

### Collapse

| Decision | Choice | Rationale |
|---|---|---|
| Collapsed appearance | Contextual: vertical tab labels (horizontal collapse) or horizontal labels (vertical collapse) | Collapse direction matches parent split direction |
| Collapse button | Top-right corner of group header | Consistent, discoverable placement |
| Collapse icon | ArrowRightFromLine, rotated to match collapse direction (right/left/down/up) | Auto-detected from position in split tree |
| Collapsed size | 34px wide (horizontal) or 28px tall (vertical) | Tight but readable |
| Nesting | Each split level independently collapsible | Width and height collapses can coexist in nested splits |

### Persistence

| Decision | Choice | Rationale |
|---|---|---|
| Backend API | Keep existing workspace-views endpoints | Backend stores opaque JSON — format change is transparent |
| What to persist | Everything (widths, heights, tabs, active tab, collapsed state, pre-collapse size) | User confirmed all six |
| Named workspaces | Keep save/load/delete | User confirmed |
| Scope | Library is scope-agnostic; config hierarchy is future work | Per clarification-1 |

### Scope

| Decision | Choice | Rationale |
|---|---|---|
| Replaces | Both v1 and v2 layouts entirely | User said "replace" — no v1/v2 toggle |
| Component design | Generic reusable `<PanelLayout>` | Could be extracted as a package |
| dockview removal | Remove dependency entirely after migration | User confirmed |
| Priority | Urgent | User specified |

---

## Future Considerations

- Extract `<PanelLayout>` into its own npm package for reuse across projects
- Config hierarchy (user > project > org) for workspace views — separate design
- Floating/detachable panels (not currently needed)
- Keyboard shortcuts for panel navigation (Ctrl+1/2/3 to focus groups)
- Panel search/command palette integration

---

**Status**: Design Specification  
**Recommendation**: Proceed to implementation immediately (urgent priority)  
**Related Documents**: [local.dynamic-panel-layout.md](local.dynamic-panel-layout.md) (predecessor, to be superseded), [clarification-2](../clarifications/clarification-2-custom-panel-layout-library.md)  
