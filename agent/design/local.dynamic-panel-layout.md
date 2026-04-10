# Dynamic Panel Layout System

**Concept**: Replace the mutually-exclusive side panel system with a VS Code-style dockview layout supporting resizable splits, draggable tabs, and saveable workspace views  
**Created**: 2026-04-10  
**Status**: Design Specification  

---

## Overview

The current editor uses a single mutually-exclusive side panel controlled by 12+ boolean state flags in Timeline.tsx. Only one panel renders at a time, panels can't coexist, and layout isn't customizable. This design replaces that with a dockview-powered layout where panels are independent, resizable, draggable, and arrangeable into workspace views.

---

## Problem Statement

- Users can only see one panel at a time (e.g., can't view Bin and Properties simultaneously)
- No way to customize the layout for different workflows
- 12+ boolean state flags and a growing ternary chain in Timeline.tsx is unmaintainable
- Color grading controls are buried inside TransitionPanel, not independently accessible
- No place for a chat panel (upcoming feature)

---

## Solution

Use **dockview-react** to create a 4-column layout with independent resizable panel groups. Each panel becomes a dockview panel component that can be moved, split, and arranged freely. Users save and toggle between workspace presets.

### Default Layout

```
                                                          [◫] [☰]
+--------+----------------------------------+-----------------+---------------+
|        |                                  | [KF] [TR] [CLR] |               |
| Left   |                                  |-----------------|               |
| Side   |         Video Preview            | Keyframe Props  |  Right Side   |
| bar    |                                  |  or TR Props    |  bar          |
|        |                                  |  or ColorGrade  |               |
|(empty/ |                                  |                 | (Sections,    |
| future)|                                  |  (context-      |  toggled via  |
|        |                                  |   sensitive)    |  ☰ menu)     |
|--------+----------------------------------+-----------------+---------------|
|        |  T1  ████████████████████████    | [Bin] [Logs]    | Chat          |
|        |  T2    ██████████  ████████      |                 |               |
|        |  T3      ██████████████         | items list      | > user msg    |
|        |          Timeline               |                 | [Send]        |
+--------+----------------------------------+-----------------+---------------+
  left      center                           properties col    right sidebar
```

### 4 Columns

1. **Left sidebar** — collapsible placeholder, toggled via [◫] button. Empty for now.
2. **Center** — top: video preview, bottom: timeline tracks. This is the main workspace.
3. **Properties column** — top: KF/TR/ColorGrade tabbed panel, bottom: Bin/Logs tabbed panel.
4. **Right sidebar** — toggled via [☰] hamburger menu. Loads Sections or future views.

### 2 Rows (per column, independent)

Each column manages its own vertical split independently. Bottom row heights are independent — dragging the timeline/bin divider doesn't affect the properties/chat divider.

---

## Implementation

### Library: dockview-react

**Install**: `npm install dockview-react`  
**Size**: ~40KB, zero dependencies  
**License**: MIT  

#### Core API

```typescript
import { DockviewReact, DockviewReadyEvent, IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'

// Panel components receive props from dockview
function MyPanel({ api, params }: IDockviewPanelProps<{ projectName: string }>) {
  return <div>Panel content</div>
}

// Register components and handle onReady
<DockviewReact
  components={{
    preview: PreviewPanel,
    timeline: TimelinePanel,
    keyframeProps: KeyframePropPanel,
    transitionProps: TransitionPropPanel,
    colorGrading: ColorGradingPanel,
    bin: BinPanel,
    logs: LogPanel,
    chat: ChatPanel,
    sections: SectionsPanel,
    checkpoints: CheckpointsPanel,
    versions: VersionsPanel,
    settings: SettingsPanel,
  }}
  onReady={(event: DockviewReadyEvent) => {
    const api = event.api

    // Try restore saved layout
    const saved = localStorage.getItem('beatlab-workspace-default')
    if (saved) {
      try {
        api.fromJSON(JSON.parse(saved))
        return
      } catch { /* fall through to default */ }
    }

    // Build default layout
    buildDefaultLayout(api)
  }}
/>
```

#### Default Layout Builder

```typescript
function buildDefaultLayout(api: DockviewApi) {
  // Center top — preview
  const preview = api.addPanel({
    id: 'preview',
    component: 'preview',
    title: 'Preview',
  })

  // Center bottom — timeline (below preview)
  const timeline = api.addPanel({
    id: 'timeline',
    component: 'timeline',
    title: 'Timeline',
    position: { referencePanel: 'preview', direction: 'below' },
  })

  // Properties top-right — keyframe props
  const kfProps = api.addPanel({
    id: 'keyframeProps',
    component: 'keyframeProps',
    title: 'Keyframe',
    position: { referencePanel: 'preview', direction: 'right' },
  })

  // Properties tab — transition props (same group as kf)
  api.addPanel({
    id: 'transitionProps',
    component: 'transitionProps',
    title: 'Transition',
    position: { referencePanel: 'keyframeProps', direction: 'within' },
  })

  // Properties tab — color grading (same group)
  api.addPanel({
    id: 'colorGrading',
    component: 'colorGrading',
    title: 'Color',
    position: { referencePanel: 'keyframeProps', direction: 'within' },
  })

  // Bottom of properties column — bin
  const bin = api.addPanel({
    id: 'bin',
    component: 'bin',
    title: 'Bin',
    position: { referencePanel: 'keyframeProps', direction: 'below' },
  })

  // Logs tab in same group as bin
  api.addPanel({
    id: 'logs',
    component: 'logs',
    title: 'Logs',
    position: { referencePanel: 'bin', direction: 'within' },
  })

  // Right sidebar — sections (to the right of properties)
  const sections = api.addPanel({
    id: 'sections',
    component: 'sections',
    title: 'Sections',
    position: { referencePanel: 'keyframeProps', direction: 'right' },
  })

  // Chat — bottom of right sidebar
  api.addPanel({
    id: 'chat',
    component: 'chat',
    title: 'Chat',
    position: { referencePanel: 'sections', direction: 'below' },
  })
}
```

#### Layout Serialization (Workspace Views)

```typescript
// Save current layout as a named workspace
function saveWorkspace(api: DockviewApi, name: string) {
  const layout = api.toJSON()
  const workspaces = JSON.parse(localStorage.getItem('beatlab-workspaces') || '{}')
  workspaces[name] = layout
  localStorage.setItem('beatlab-workspaces', JSON.stringify(workspaces))
}

// Restore a workspace
function loadWorkspace(api: DockviewApi, name: string) {
  const workspaces = JSON.parse(localStorage.getItem('beatlab-workspaces') || '{}')
  if (workspaces[name]) {
    api.fromJSON(workspaces[name])
  }
}

// Auto-save on layout change
api.onDidLayoutChange(() => {
  saveWorkspace(api, '_autosave')
})
```

### Panel Component Migration

Each existing panel becomes a dockview panel component. The key change: panels no longer manage their own width/resize handles — dockview handles all layout. Panels receive props via `params`.

| Current Panel | New Component | Location (default) |
|---|---|---|
| KeyframePanel | `keyframeProps` | Properties top (tab) |
| TransitionPanel | `transitionProps` | Properties top (tab) |
| Color grading (from TR) | `colorGrading` | Properties top (tab) |
| BinPanel | `bin` | Properties bottom (tab) |
| LogPanel | `logs` | Properties bottom (tab) |
| CheckpointsPanel | `checkpoints` | Properties bottom (tab) |
| VersionHistoryPanel | `versions` | Properties bottom (tab) |
| SettingsPanel | `settings` | Properties bottom (tab) |
| NarrativeSectionPanel | `sections` | Right sidebar top |
| Chat (new) | `chat` | Right sidebar bottom |
| Preview + BeatEffectPreview | `preview` | Center top |
| Timeline tracks + controls | `timeline` | Center bottom |

### What Changes in Timeline.tsx

- **Remove**: All `show*` boolean state flags, `closeAllPanels()`, the 13-deep ternary chain, per-panel resize handles
- **Keep**: Timeline track rendering, playhead, controls bar, keyboard shortcuts, preview canvas — these move into their respective panel components
- **New**: `EditorLayout.tsx` — top-level component that sets up DockviewReact with components map and onReady handler
- **New**: `useEditorLayout` hook — exposes `api` ref for programmatic panel control (e.g., open properties when keyframe clicked)

### Context-Sensitive Properties Tab

When a keyframe is selected, the properties panel group activates the KF tab. When a transition is selected, activates TR tab. This uses dockview's `api.getPanel('keyframeProps').api.setActive()`:

```typescript
// In timeline panel, on keyframe click:
const kfPanel = editorApi.getPanel('keyframeProps')
if (kfPanel) kfPanel.api.setActive()

// On transition click:
const trPanel = editorApi.getPanel('transitionProps')
if (trPanel) trPanel.api.setActive()
```

### Sidebar Toggle Buttons

- **[◫] Left sidebar toggle** — calls `api.getGroup(leftGroupId)` and toggles visibility
- **[☰] Right sidebar hamburger** — opens a dropdown menu listing available right sidebar views (Sections, future views). Selecting one either shows/adds that panel in the right sidebar group

---

## Benefits

- **Multi-panel viewing**: Users see Bin + Properties + Chat simultaneously
- **Customizable layouts**: Different workflows get different arrangements
- **Workspace presets**: Save and restore layouts instantly
- **Maintainability**: Eliminates 12+ boolean flags and the ternary chain
- **Extensibility**: Adding a new panel is just registering a component and calling addPanel
- **Color grading independence**: Accessible as its own tab without selecting a transition first

---

## Trade-offs

- **Bundle size**: +40KB for dockview-react (acceptable for the functionality gained)
- **Styling**: Dockview has its own tab/group chrome that needs CSS customization to match the current dark theme
- **Migration scope**: Large refactor — every panel component needs props interface changes, Timeline.tsx gets split up
- **Learning curve**: Dockview API is well-documented but is a new paradigm for this codebase

---

## Dependencies

- `dockview-react` (npm, MIT license, zero transitive dependencies)
- Existing: React 19, Tailwind CSS 4

---

## Testing Strategy

- Verify default layout renders all panels in correct positions
- Verify panel drag-and-drop between groups
- Verify workspace save/restore to localStorage
- Verify context-sensitive tab activation (click KF → KF tab activates)
- Verify sidebar toggle buttons show/hide sidebars
- Verify all existing panel functionality works within dockview wrappers

---

## Migration Path

1. Install dockview-react, create `EditorLayout.tsx` with component registration
2. Extract Preview and Timeline into standalone panel components
3. Wrap existing panel components (KeyframePanel, BinPanel, etc.) as dockview panels
4. Extract color grading from TransitionPanel into ColorGradingPanel
5. Build default layout in `onReady` handler
6. Add workspace save/restore (localStorage)
7. Add sidebar toggle buttons
8. Remove old boolean state flags, closeAllPanels, ternary chain from Timeline.tsx
9. Style dockview chrome to match dark theme

---

## Key Design Decisions

### Layout Structure

| Decision | Choice | Rationale |
|---|---|---|
| Column count | 4 (left sidebar, center, properties, right sidebar) | User mockup — separates concerns while allowing independent resize |
| Row splits | Independent per column | User specified "bottom independent" — each column's h-divider moves alone |
| Properties tabs | KF / TR / Color Grading | Color grading extracted as own tab per user request |
| Bottom defaults | Bin/Logs (properties col), Chat (right sidebar) | User specified "bottom right corner will be chat, corner to the left will be bin" |
| Right sidebar content | Sections, toggled via ☰ menu | User specified "accessible via top right toggle switch" |

### Panel Behavior

| Decision | Choice | Rationale |
|---|---|---|
| Panels draggable between regions | Yes | User: "the user could move chat entirely if they desired" |
| Arbitrary splitting | Yes | User: "panels can be split arbitrarily" |
| Collapsible sections | Yes | User: "top portion can be collapsed such that chat would take entire space" |
| Workspace views | Saveable presets, togglable | User: "they can save workspace views and toggle between them" |
| Library | dockview-react | Handles splits, tabs, drag-to-move, serialize/deserialize — all requirements met out of the box |

---

## Future Considerations

- Left sidebar content (file explorer, search, etc.)
- Floating/popout panels (dockview supports this natively)
- Per-project workspace views (currently per-browser via localStorage)
- Chat panel implementation (separate design doc)
- Keyboard shortcuts for panel focus/toggle

---

**Status**: Design Specification  
**Recommendation**: Implement in phases — layout shell first, then migrate panels one by one  
**Related Documents**: [clarification-3-dynamic-panel-layout.md](../clarifications/clarification-3-dynamic-panel-layout.md)  
