# Spec: Panel Layout & Plugin Panel Host

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Retroactive (describes the shipped system)

---

## Purpose

Define the observable behavior of scenecraft's **first-party panel-layout system** (`src/components/panel-layout/*`) and the **editor-level plugin panel host** (`src/components/editor/EditorPanelLayout.tsx` + `PluginHost.registerPanel`). The panel-layout module is an in-house replacement for dockview — it owns its own tree data model, drag-resize, tab drag/drop, split-on-drop, collapse (group + column), group lock, and per-panel error isolation. The editor layer composes that module with a panel registry that merges built-in panels with plugin-contributed panels, persists layouts via the workspace API, and auto-activates the Properties tab on selection.

This is a **retroactive black-box spec**: it documents what the shipped code does today so future refactors have a stable contract to diff against, and so behavior the source did not resolve is surfaced as `undefined` rather than silently guessed.

---

## Source

- Mode: `--from-draft` (retroactive; derived from source files and `agent/reports/audit-2-architectural-deep-dive.md §1D unit 1–2`)
- Source files:
  - `src/components/panel-layout/PanelLayout.tsx`
  - `src/components/panel-layout/PanelGroup.tsx`
  - `src/components/panel-layout/SplitContainer.tsx`
  - `src/components/panel-layout/ResizeSash.tsx`
  - `src/components/panel-layout/types.ts`
  - `src/components/panel-layout/validate.ts`
  - `src/components/panel-layout/index.ts`
  - `src/components/editor/EditorPanelLayout.tsx`
  - `src/lib/plugin-host.ts` (registerPanel, getPanel, listPanels)
- Package dep note: `dockview-react` is present in `package.json` but is **not used**; panels are rendered by the in-house module. Removing that dep is an out-of-scope cleanup.

---

## Scope

### In scope
- `LayoutNode` data model: `SplitNode` (horizontal | vertical, ratio, two children, optional `collapsed` / `savedRatios`) and `GroupNode` (id, tabs, activeTab, optional `collapsed` / `locked`).
- Rendering pipeline: `PanelLayout` → recursive `renderNode` → `SplitContainer` (flex row/column with `ResizeSash` between children) → `PanelGroup` (tab bar + active-panel body) → editor-supplied `Panel` wrapper → content component.
- Drag-resize: `ResizeSash` pointer drag converting pixel delta to ratio delta, clamped `[MIN_RATIO=0.05, MAX_RATIO=0.95]`, minimum pane size `MIN_PX=100`.
- Tab interactions: click-to-activate, close (×), add via ⋮ menu, close group (closes all tabs → prune), drag-reorder within group, drag between groups.
- Split-on-drop: drag a tab to the 25%-edge drop zone of another group → create a new split (horizontal for left/right, vertical for top/bottom).
- Collapse model: **group collapse** (single group becomes a 34 px strip with vertical or horizontal tab labels + expand button) and **column collapse** (an entire split node becomes a 34 px strip). On collapse, ratios of same-axis ancestor splits are adjusted so the collapsed node is sized to `COLLAPSED_PX=34`, freed pixels flow to the first same-axis ancestor where the collapsing subtree is on the "away" side; old ratios are cached in `savedRatios` keyed by the collapse path and restored verbatim on expand.
- Group lock (`locked: true`): prevents `activatePanel` imperative API from stealing the user's active tab; UI shows Pin/PinOff toggle.
- Tree pruning: empty groups are dropped; splits with one null child collapse to the remaining child. Runs after tab close, tab move, and split-drop source removal.
- Persistence: `EditorPanelLayout` consumes `data.savedLayout` (served by backend workspace-view API under key `_autosave_v3`), validates via `validateLayout`, falls back to `defaultLayout` on invalid. Layout changes are debounced 500 ms then saved via `saveWorkspaceView(projectName, '_autosave_v3', layout)`. A `beforeunload` flush + unmount flush persist any pending layout.
- `validateLayout` guarantees: returns `null` for malformed trees; drops tab ids missing from the current registry; collapses groups emptied by drops; picks a valid `activeTab` when the saved one is gone; clamps ratios into `(0,1)` (falls back to `0.5` if out-of-range or non-number).
- Per-panel error boundary (`PluginPanelErrorBoundary`): catches render/lifecycle errors from a plugin panel, renders an inline "Panel X crashed" tile with the error message + Retry button; Retry remounts children by bumping a nonce key. Sibling panels and the outer layout remain alive.
- Plugin panel component cache (`PLUGIN_PANEL_COMPONENT_CACHE`): `makePluginPanelComponent(panelId)` returns the SAME function reference across calls for a given `panelId`; combined with `useMemo(buildPanelRegistry, [])`, this prevents the parent re-render → unmount/remount cycle that used to drop long-lived panel state (DMX WebSerial connections, 3D scene camera, etc.).
- `EditorPanelLayoutHandle.resetLayout()`: swaps the layout to a fresh `defaultLayout` (new object identity) and immediately persists; the wrapping `<PanelLayout>` is keyed on `JSON.stringify(initialLayout)` so it remounts with the default tree.
- `PanelLayoutHandle.activatePanel(panelId)`: finds the owning group, refuses when that group is `locked`, otherwise: expands any collapsed ancestor splits (restoring their `savedRatios`), expands the group if collapsed, sets `activeTab = panelId`. No-op when the target tab is already active and nothing is collapsed.
- `PanelLayoutHandle.setGroupLocked(groupId, locked)`: toggles the `locked` flag on the named group.
- Plugin panel registration: `PluginHost.registerPanel({id, title, Component}, ctx?)` adds to the internal Map; duplicate id throws; returns a Disposable that, when fired, removes the panel from the registry. Auto-pushes into `ctx.subscriptions` when provided so deactivation LIFO-disposes it.
- `PluginHost.getPanel(id)` / `listPanels()` feed the editor's registry builder.
- `AutoActivatePropertiesEffect`: whenever any of `{selectedKeyframe, selectedTransition, trackPropertiesId, selectedAudioClipId, selectedAudioTrackId}` becomes truthy, calls `panelLayoutRef.current.activatePanel('properties')`. Respects group lock.

### Out of scope
- Individual panel content (Timeline, ChatPanel, PreviewPanel, PropertiesPanel body logic, etc.).
- `EditorStateContext`, `CurrentTimeContext`, `PreviewContext`, `ContextMenuProvider` — separate specs.
- Workspace view backend REST contract (`saveWorkspaceView` HTTP shape). Only the client-side invocation and key name are in scope.
- Operation / context-menu / MCP tool contributions of `PluginHost` — covered by `plugin-host-and-manifest` spec.
- Hot-module-replacement behavior for plugin additions after editor mount (editor currently captures registry once at mount; runtime add is acknowledged as a known trade-off, not a requirement).
- Touch / pointer / keyboard drag (mouse events only in `ResizeSash`; drag-and-drop uses HTML5 DnD which is mouse-driven in practice).
- Server-driven layout push / multi-client sync.

---

## Interfaces / Data Shapes

### LayoutNode

```ts
type PanelId = string

type SplitNode = {
  type: 'split'
  direction: 'horizontal' | 'vertical'
  ratio: number              // (0, 1)
  children: [LayoutNode, LayoutNode]
  collapsed?: boolean        // entire subtree collapsed
  preCollapseSize?: number   // (unused in current code; reserved)
  savedRatios?: Record<string, number>  // key = collapsePath.join(','), value = ancestor ratio before collapse
}

type GroupNode = {
  type: 'group'
  id: string
  tabs: PanelId[]
  activeTab: PanelId
  collapsed?: boolean
  preCollapseSize?: number   // reserved
  locked?: boolean           // when true, activatePanel() skips this group
}

type LayoutNode = SplitNode | GroupNode

type PanelDef = {
  component: React.ComponentType
  title: string
  icon?: React.ComponentType
}

type PanelRegistry = Record<PanelId, PanelDef>
```

### Imperative handles

```ts
type PanelLayoutHandle = {
  activatePanel(panelId: PanelId): void
  setGroupLocked(groupId: string, locked: boolean): void
}

type EditorPanelLayoutHandle = {
  resetLayout(): void
}
```

### Plugin panel contribution

```ts
type PanelContribution = {
  id: string
  title: string
  Component: React.ComponentType<unknown>
  singleton?: boolean  // default false; see R49
}

PluginHost.registerPanel(panel: PanelContribution, ctx?: PluginContext): Disposable
PluginHost.getPanel(id: string): PanelContribution | undefined
PluginHost.listPanels(): PanelContribution[]
```

### Constants

- `COLLAPSED_PX = 34`
- `SASH_PX = 4`
- `MIN_RATIO = 0.05`
- `MAX_RATIO = 0.95`
- `MIN_PX = 100`
- Split drop edge zone: `25%` from each side of the content area.
- Autosave debounce: `500 ms`.
- Autosave key: `_autosave_v3:<windowId>` (per-window, per INV-5 / R54).

### Drag data

- `dataTransfer` MIME: `application/x-panel-tab` — payload `JSON.stringify({ groupId, tabId })`.
- Also sets `text/plain` to `tabId` as a fallback for browsers showing a drag preview.

---

## Requirements

### Data model
- **R1** A layout tree is a strict binary tree: every `SplitNode` has exactly two `children`; every leaf is a `GroupNode`.
- **R2** A `GroupNode` with zero tabs is invalid and MUST be pruned from the tree.
- **R3** `SplitNode.ratio` is stored in `(0, 1)`; drag clamps to `[MIN_RATIO, MAX_RATIO]`.
- **R4** `GroupNode.activeTab` MUST be a member of `tabs` whenever `tabs.length > 0`.

### Rendering
- **R5** `PanelLayout` renders a recursive tree: a `GroupNode` renders as `PanelGroup`; an uncollapsed `SplitNode` renders as `SplitContainer` with its two children; a collapsed `SplitNode` renders as a 34 px strip showing all contained tab labels vertically.
- **R6** `SplitContainer` uses flex: the first child takes `ratio * 100%`, the second child takes the remaining flex:1, separated by a 1 px `ResizeSash`. When either child is collapsed, the collapsed child is `flex: 0 0 34px` and the sash is hidden.
- **R7** `PanelGroup` mounts exactly one active panel body at a time: `panels[activeTab].component`. Inactive tabs are not mounted.

### Resize
- **R8** Dragging `ResizeSash` updates the parent split's `ratio` live on every `mousemove`; the new ratio is `clamp(oldRatio + deltaPx / containerPx, MIN_RATIO, MAX_RATIO)`.
- **R9** Resize uses the current `containerRef` size; if `containerPx === 0` the drag is a no-op.
- **R10** Releasing the mouse restores `document.body` cursor and `user-select`.

### Tabs
- **R11** Clicking a tab sets that group's `activeTab`.
- **R12** Clicking × on a tab removes it from `tabs`; if it was active, the next `tabs[0]` becomes active; if the group empties, it is pruned.
- **R13** Dropping a tab on another tab or the tab bar reorders within the group or moves between groups; source group is pruned if emptied.
- **R14** Dropping a tab on the 25% left/right/top/bottom edge of another group's body creates a new split (left/right → horizontal, top/bottom → vertical, ratio 0.5), placing the dragged tab on the named side.
- **R15** Dropping a tab on the center zone of another group's body appends it as a tab in that group (same as tab-bar drop).
- **R16** A group cannot split into itself when it holds only one tab (the operation is refused — the would-be-remaining group is empty).
- **R17** The "Add Panel" ⋮ menu lists every panel id in the registry; already-present ids are disabled.
- **R18** "Close Group" in the ⋮ menu closes every tab in the group, causing pruning.

### Collapse
- **R19** Collapsing a group sets `group.collapsed = true` and, if the group has a same-axis ancestor split, adjusts that ancestor's ratio so the group is sized to exactly `COLLAPSED_PX`; freed pixels are given to the first same-axis ancestor where the collapsing subtree is on the "away" side (right-collapse → first ancestor with collapsing subtree on child index 1 → child index 0 grows; left-collapse mirrored; up/down mirrored on the vertical axis).
- **R20** Each ratio change caused by a collapse is stored in the affected ancestor's `savedRatios` keyed by `collapsePath.join(',')`; on expand, the saved ratios at that key are restored and the entry deleted.
- **R21** Column collapse (whole split) uses the same ratio math applied to the split's path; the column renders as a 34 px strip listing every tab across every descendant group.
- **R22** Collapse direction is derived from position in the tree: horizontal-split children → left/right (leftmost column collapses left, else right); vertical-split children → up/down (child 0 → up, child 1 → down).
- **R23** Clicking a tab label in a column-collapse strip expands the column (restoring saved ratios) AND activates that tab in its owning group.

### Group lock
- **R24** `setGroupLocked(groupId, true)` adds `locked: true` to the group; `false` removes it.
- **R25** `activatePanel(panelId)` is a no-op when the owning group is `locked`.
- **R26** The Pin icon in the tab bar toggles lock; the icon fills amber when locked.

### Persistence
- **R27** On mount, `EditorPanelLayout` reads `data.savedLayout` once and passes it through `validateLayout(saved, buildPanelRegistry())`. If the result is non-null, it becomes the initial layout; otherwise the tree falls back to `defaultLayout` AND a fresh `defaultLayout` is persisted back to `_autosave_v3`.
- **R28** Any `onLayoutChange` from `PanelLayout` is debounced 500 ms, then persisted via `saveWorkspaceView(projectName, '_autosave_v3', layout)`.
- **R29** On `beforeunload` and on unmount, any pending debounced save flushes immediately.
- **R30** `validateLayout` MUST return `null` for objects with unknown `type`, non-array `children` of the wrong length, non-string `tabs`, or empty groups.
- **R31** `validateLayout` MUST filter out tab ids missing from the passed `PanelRegistry`, and if that leaves the group empty return `null` (causing the parent split to collapse to its other child).
- **R32** `validateLayout` MUST coerce out-of-range or non-number ratios to `0.5`.

### Plugin panel host
- **R33** `PluginHost.registerPanel({id, title, Component})` inserts the contribution into an in-memory Map keyed by `id`.
- **R34** Registering a second panel with an existing `id` MUST throw.
- **R35** The returned Disposable MUST remove the panel from the registry when fired; if another panel has since taken the same id, the removal MUST NOT delete that newer entry.
- **R36** When a `PluginContext` is provided, the Disposable is auto-pushed to `ctx.subscriptions` for LIFO disposal on plugin deactivate.
- **R37** `listPanels()` returns every currently-registered panel contribution.
- **R38** `getPanel(id)` returns the current contribution or `undefined`.
- **R39** `buildPanelRegistry()` (editor) merges the static built-in map with every entry from `PluginHost.listPanels()`; built-in ids take precedence (plugin cannot shadow a built-in).
- **R40** `makePluginPanelComponent(panelId)` MUST return the same function reference across calls for a given `panelId` (cache).
- **R41** `EditorPanelLayout` MUST compute `panelRegistry = useMemo(buildPanelRegistry, [])` so the registry object identity is stable for the editor's lifetime.
- **R42** The plugin panel component, at render time, calls `PluginHost.getPanel(panelId)`; if the panel is missing (deactivated), it renders an inline "Plugin panel `id` not registered." message without crashing.

### Per-panel error isolation
- **R43** A plugin panel that throws during render is caught by `PluginPanelErrorBoundary`; it renders an inline "Panel `id` crashed" tile containing the error message and a Retry button.
- **R44** Retry bumps an internal nonce that keys the wrapped children, forcing a full remount of the panel subtree.
- **R45** Errors thrown by one plugin panel MUST NOT unmount or crash sibling panels or the layout shell.

### Auto-activation
- **R46** When any selection state (`selectedKeyframe`, `selectedTransition`, `trackPropertiesId`, `selectedAudioClipId`, `selectedAudioTrackId`) becomes truthy, `AutoActivatePropertiesEffect` calls `panelLayoutRef.current?.activatePanel('properties')`.
- **R47** If the `properties` owning group is `locked`, the auto-activate call is a no-op (R25).

### Reset
- **R48** `EditorPanelLayoutHandle.resetLayout()` sets the initial layout to a fresh `defaultLayout` object, forces the inner `<PanelLayout>` to remount (via the `JSON.stringify(initialLayout)` key), and immediately persists `defaultLayout` to `_autosave_v3`.

### Singleton panels (INV-6)
- **R49** The plugin panel manifest gains a `singleton: boolean` field (defaults to `false`). `PanelContribution` shape is extended:
  ```ts
  type PanelContribution = {
    id: string
    title: string
    Component: React.ComponentType<unknown>
    singleton?: boolean  // default false
  }
  ```
- **R50** Core built-in panels marked `singleton: true`: `Timeline`, `Preview` (program monitor), `ChatPanel`, `DMXConnect`. Default (multi-instance): `Properties`, `Bin`, `Source Monitor`, `Log`.
- **R51** When a `singleton: true` panel is added from the ⋮ "Add Panel" menu or dropped in a new location, PanelLayout **moves** the existing instance (removes it from its current group, inserts it at the target) rather than spawning a second instance. Cross-window moves are brokered via the unified WS (INV-4).
- **R52** The ⋮ "Add Panel" menu disables the entry for any singleton panel that already exists in the current window.
- **R53** Registering a non-manifested panel defaults `singleton` to `false`; existing plugins that do not declare the field behave identically to today.

### Multi-window workspaces (INV-5)
- **R54** Panel layouts are persisted **per window**. The autosave key becomes `_autosave_v3:<windowId>` where `<windowId>` is a stable per-window identifier (e.g., `sessionStorage`-backed uuid). A window opened fresh seeds with `defaultLayout` persisted under its own key.
- **R55** Multiple browser windows / tabs of the same project are coexisting peers. All DB-backed state stays synchronized across windows via the unified WS (INV-4); edits in window A reflect in window B without manual refresh.
- **R56** **Exclusive browser resources** are owned by exactly one window at a time:
  - WebSerial / DMX handle
  - WebAudio playback graph / active `HTMLAudioElement`
  - Chat WS session (singleton `ChatPanel`)
- **R57** Take-over modals transfer ownership: clicking the action in a non-owning window prompts "Take over DMX / playback / chat control from window X?" On confirm, the owning window releases its handle gracefully and the requesting window acquires it.
- **R58** Closing the owning window transparently releases exclusive resources; the next interaction in any remaining window claims them (no explicit hand-off required).
- **R59** The detailed coordination mechanism (BroadcastChannel, shared worker, `navigator.locks`, playhead sync precision) is tracked in a follow-up design doc `agent/design/local.multi-window-workspaces.md` — not blocking for spec close.

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | Editor mounts with valid saved layout | Renders saved tree; no reset | `loads-valid-saved-layout` |
| 2 | Editor mounts with no saved layout | Renders default layout | `falls-back-to-default-when-no-saved` |
| 3 | User drags sash | Split ratio updates live, clamped to [0.05, 0.95] | `drag-sash-updates-ratio`, `drag-sash-clamps-at-bounds` |
| 4 | User clicks a different tab | That tab becomes active; its body mounts | `tab-click-activates` |
| 5 | User clicks × on a tab | Tab removed; neighbor becomes active | `tab-close-removes-and-reactivates` |
| 6 | User closes the last tab in a group | Group is pruned; parent split collapses to sibling | `closing-last-tab-prunes-group` |
| 7 | User drags a tab onto another group's tab bar | Tab moves to target group, active there; source group pruned if empty | `drag-tab-between-groups` |
| 8 | User drags a tab onto the left 25% of another group's body | New horizontal split created, dragged tab on the left | `split-drop-left-creates-split` |
| 9 | User drags a tab onto the center of another group's body | Tab added to that group, same as tab-bar drop | `split-drop-center-equals-tab-drop` |
| 10 | User clicks collapse on a group | Group becomes 34 px strip; parent ratio adjusts | `collapse-group-shrinks-to-strip` |
| 11 | User clicks expand on a collapsed group | Group restored; ancestor ratios restored from savedRatios | `expand-restores-saved-ratios` |
| 12 | User collapses a column (whole vertical split) | Entire subtree becomes a 34 px strip listing all tabs | `collapse-column-shrinks-subtree` |
| 13 | User clicks a tab label in a collapsed column | Column expands AND that tab activates in its group | `collapsed-column-tab-click-expands-and-activates` |
| 14 | Plugin registers a panel with a new id | listPanels / getPanel returns it; buildPanelRegistry merges it | `register-panel-appears-in-registry` |
| 15 | Plugin registers a panel with a duplicate id | registerPanel throws | `duplicate-panel-id-throws` |
| 16 | Plugin Disposable fires | Panel removed from registry | `disposable-removes-panel` |
| 17 | Selection becomes non-null | Properties tab auto-activates | `selection-activates-properties` |
| 18 | Properties group is locked, selection changes | Active tab is NOT stolen | `lock-blocks-auto-activate` |
| 19 | User calls EditorPanelLayoutHandle.resetLayout() | Layout swaps to default; persisted; inner layout remounts | `reset-layout-restores-default` |
| 20 | onLayoutChange fires | Save is debounced 500ms before persisting | `layout-change-debounces-save` |
| 21 | beforeunload during pending save | Pending save flushes synchronously before unload | `beforeunload-flushes-pending-save` |
| 22 | Saved layout references tab ids not in registry | Those tabs are dropped; group survives if any remain | `validate-drops-unknown-tabs` |
| 23 | Saved layout's group has no surviving tabs | That group pruned; parent split collapses to sibling | `validate-prunes-emptied-group` |
| 24 | Saved layout ratio is NaN or out of range | Coerced to 0.5 | `validate-coerces-bad-ratio` |
| 25 | Plugin panel throws during render | PluginPanelErrorBoundary shows inline fallback; siblings alive | `plugin-panel-render-error-shows-fallback` |
| 26 | User clicks Retry on crashed panel | Panel remounts; if it no longer throws, it renders normally | `retry-remounts-crashed-panel` |
| 27 | makePluginPanelComponent called twice for same id | Returns the same function reference | `plugin-panel-component-cache-stable` |
| 28 | Parent re-renders the editor | panelRegistry identity stable; plugin panels do not unmount/remount | `plugin-panels-survive-parent-rerender` |
| 29 | activatePanel called for an unknown panel id | No-op | `activate-unknown-panel-noop` |
| 30 | activatePanel called when owning group + ancestors collapsed | All collapsed ancestors expand (savedRatios restored); tab activates | `activate-expands-collapsed-ancestors` |
| 31 | Drag tab into a single-tab group and drop on its own edge | Split is refused (would leave empty source) | `self-split-refused-when-single-tab` |
| 32 | localStorage / server returns corrupted JSON for saved layout | Codified: `validateLayout` returns `null` for any malformed structure; fallback-to-default path fires and persists default back | `corrupted-saved-json-falls-back-to-default` |
| 33 | Saved layout references an unknown panel id that is ALSO the only tab in its group | Group pruned per R23; if entire tree prunes to null, layout falls back to default | `validate-prunes-to-default-when-empty` |
| 34 | Sash drag where total container size computes to zero | Codified: `totalSize===0` bail is the correct no-op (no code path produces a non-collapsed zero-width pane) | `sash-drag-zero-size-bails`, `no-zero-width-noncollapsed-pane` |
| 35 | User drops a tab into a new group while collapse/expand animation is in flight | Codified: transitions are CSS-instant today; scenario not reachable. Revisit if animated transitions added | `no-animated-transitions-in-layout` |
| 36 | Plugin deactivated while its panel is mounted | Next render shows "Plugin panel X not registered."; no crash | `deactivated-plugin-panel-shows-fallback` |
| 37 | Two plugins attempt to register the same panel id | Second `registerPanel` throws; first remains active | `second-registration-throws-first-wins` |
| 38 | Collapse on a root-only group (no ancestor split) | Group marks collapsed; no ratio math performed | `collapse-root-group-no-ratio-change` |
| 39 | Deep nesting (>3 levels) collapse | Ratios propagate up same-axis ancestors only, skipping cross-axis parents | `collapse-propagates-through-same-axis-only` |
| 40 | Tab drag onto itself (same group, same position) | No structural change | `self-drop-is-noop` |
| 41 | Plugin panel registry merge when plugin id collides with built-in | Built-in wins; plugin is NOT rendered under that id | `builtin-takes-precedence-over-plugin` |
| 42 | Second browser window of same project opens | Each window persists layout under its own `_autosave_v3:<windowId>` key; layouts do not share | `multi-window-layouts-per-window` |
| 43 | User adds a singleton panel (e.g. Chat) in window B while it exists in window A | Panel moves from A to B (A's layout removes it; B gains it); cross-window peer sync via unified WS | `singleton-panel-move-across-windows` |
| 44 | User adds a singleton panel via menu in the same window where it already exists | Menu entry disabled (already present, per R17); no duplicate spawn | `singleton-panel-menu-disabled-when-present` |
| 45 | Non-singleton panel (e.g. Properties) added a second time in same window | Duplicate instance is created (default `singleton: false` behavior) | `non-singleton-panel-duplicates-freely` |
| 46 | DMX-connect panel (singleton + exclusive resource) active in window A; user clicks "Connect" in window B | Take-over modal in window B; on confirm, A releases WebSerial handle; B acquires it | `exclusive-resource-take-over-dmx` |
| 47 | Closing the window that owns an exclusive resource | Release is transparent; next interaction in any remaining window claims the resource | `exclusive-resource-released-on-window-close` |

---

## Behavior (step by step)

### Mount
1. `EditorPanelLayout` reads `data.savedLayout` once via `useRef` gate.
2. `buildPanelRegistry()` is built from `panels` (static) ∪ `PluginHost.listPanels()` (plugin order preserved, built-in wins on id collision).
3. `validateLayout(saved, registry)` is called. On `null`, `defaultLayout` is used AND persisted back.
4. The validated (or default) tree is passed as `defaultLayout` to `<PanelLayout>`.
5. `PanelLayout` stores layout in local state; a ref shadows it for imperative reads.

### Tab click
1. Tab `<div>` `onClick` calls `onTabActivate(groupId, tabId)`.
2. `PanelLayout.handleTabActivate` finds the group's path via `findGroupPath`, updates the node's `activeTab`.
3. `update` calls `setLayout` + `onLayoutChange(newLayout)`.
4. `EditorPanelLayout.handleLayoutChange` starts a 500 ms debounce timer.

### Resize drag
1. `ResizeSash` `mousedown` captures start pos, attaches window `mousemove` / `mouseup`.
2. Each `mousemove` computes `deltaPx = currentPos - lastPos`, updates `lastPos`, calls `onDrag(deltaPx)`.
3. `SplitContainer.handleDrag` converts `deltaPx / containerPx` to `deltaRatio`, clamps, calls `onRatioChange(clamped)`.
4. `PanelLayout.handleRatioChange` updates the split at the given path.
5. `mouseup` detaches listeners, resets body cursor + user-select.

### Tab drop (reorder / move)
1. Tab `dragstart` sets `application/x-panel-tab` payload.
2. Target `dragover` computes `dragOverIndex`; target `drop` parses payload and calls `onTabDrop(targetGroupId, insertIndex, sourceGroupId, tabId)`.
3. `handleTabDrop` either reorders within-group (adjusting the insert index by removal offset) or removes from source (+ `pruneTree`) and inserts into target.
4. `update` persists.

### Split drop
1. Panel body `dragover` divides the rect into 25% edge zones and one center zone; stores `splitZone` state.
2. `drop` calls `onSplitDrop(targetGroupId, 'left'|'right'|'top'|'bottom', srcGroupId, tabId)` for edge zones, or `onTabDrop` for center.
3. `handleSplitDrop` removes tab from source (prune if empty), creates a new `GroupNode` with the dragged tab, wraps target + new group in a `SplitNode` (direction derived from edge), replaces target path with the split.
4. If source === target and target has only one tab, operation is refused.

### Collapse (group)
1. `onCollapse(groupId)` finds path; `getCollapseDir` computes `left|right|up|down` from position + parent direction.
2. If no ancestor same-axis split exists, sets `group.collapsed = true` and returns.
3. Else `computeCollapseRatioChanges` walks up, computes the new ratio that yields exactly 34 px for the collapsed child, and the ratio for the first ancestor where the collapsing side is "away".
4. Writes `collapsed: true` on the group AND writes new ratios onto each affected ancestor, storing the old ratio in `savedRatios` keyed by the collapse path.

### Expand (group or column)
1. `onExpand(groupId)` / `handleExpandColumn(splitPath)` unsets `collapsed`.
2. Walks up the ancestor chain; for any ancestor with `savedRatios[collapseKey]` defined, restores that value and deletes the key.

### activatePanel(panelId)
1. Reads current layout via ref (avoids stale closure).
2. `findPanelOwnerPath(panelId)` locates the owning group regardless of collapse state.
3. If the owning group is `locked`, returns immediately.
4. Walks the path expanding any collapsed ancestor splits (restoring savedRatios).
5. Expands the owning group if collapsed, sets `activeTab = panelId`.
6. Skips the state update if nothing changed (no stale re-save).

### AutoActivatePropertiesEffect
1. `useEffect` dependency array includes every selection primitive.
2. On change, if any is truthy, calls `activatePanel('properties')`.

### Debounced save
1. `handleLayoutChange(layout)` clears any existing 500 ms timer and starts a new one.
2. Timer callback persists via `saveWorkspaceView(projectName, '_autosave_v3', layout)`; errors are logged.
3. `beforeunload` handler AND unmount cleanup call a shared `flush()` that clears the timer and saves synchronously via the same API.

### Plugin panel lookup at render
1. `PluginPanelComponent` (cached by id) calls `PluginHost.getPanel(panelId)` each render.
2. Missing → inline "not registered" message.
3. Present → wraps `PluginPanelErrorBoundary` around `<panel.Component entity={...} projectName={...} onClose={...} />`.

### resetLayout
1. `setInitialLayout({ ...defaultLayout })` — new object identity.
2. `saveWorkspaceView(..., defaultLayout)` persists immediately.
3. `<PanelLayout key={JSON.stringify(initialLayout)}>` key changes → full remount of the inner layout.

---

## Acceptance Criteria

- [ ] All 41 Behavior Table rows pass their linked tests (except `undefined` rows, which remain Open Questions until resolved).
- [ ] `validateLayout` is pure (no mutation of input) and returns either a fully-sanitized tree or `null`.
- [ ] Dragging a sash does not mutate any node outside the parent split.
- [ ] Collapse/expand round-trip (collapse → expand) restores the tree to ratio-equivalent shape (savedRatios cleared).
- [ ] Plugin panel crash does not propagate beyond `PluginPanelErrorBoundary`.
- [ ] Plugin registry additions at activation time appear in the editor registry on next mount.
- [ ] `activatePanel` respects lock in 100% of cases (no race windows).
- [ ] Debounced save flushes on `beforeunload` and on editor unmount.
- [ ] `resetLayout` remounts the inner layout such that collapsed/locked state from the previous layout is gone.

---

## Tests

### Base Cases

#### Test: loads-valid-saved-layout (covers R27, R30)
**Given**: A valid `LayoutNode` tree in `data.savedLayout` referencing only known panel ids
**When**: `EditorPanelLayout` mounts
**Then**:
- **renders-saved**: The rendered tree matches the saved structure
- **no-reset-write**: `saveWorkspaceView` is NOT invoked during mount

#### Test: falls-back-to-default-when-no-saved (covers R27)
**Given**: `data.savedLayout` is `undefined`
**When**: Editor mounts
**Then**:
- **renders-default**: The default layout shape is rendered (preview/timeline column + properties/utilities + sidebar/chat)
- **no-reset-write**: `saveWorkspaceView` is NOT invoked during mount

#### Test: drag-sash-updates-ratio (covers R8, R9)
**Given**: A horizontal 50/50 split, container width 1000 px
**When**: User drags the sash 100 px right
**Then**:
- **new-ratio-0_6**: The split's ratio becomes ~0.6
- **visual-width-matches**: The left pane renders at ~60% width

#### Test: drag-sash-clamps-at-bounds (covers R8)
**Given**: Split ratio 0.05
**When**: User drags sash 500 px left
**Then**:
- **stays-at-min**: Ratio remains 0.05 (never < MIN_RATIO)

#### Test: tab-click-activates (covers R11, R7)
**Given**: A group with tabs `[a, b]`, active `a`
**When**: User clicks tab `b`
**Then**:
- **active-updates**: Group's `activeTab` becomes `b`
- **body-swaps**: Only panel `b`'s component is mounted

#### Test: tab-close-removes-and-reactivates (covers R12)
**Given**: A group with tabs `[a, b, c]`, active `b`
**When**: User clicks × on `b`
**Then**:
- **tabs-now-ac**: `tabs = [a, c]`
- **active-is-a**: `activeTab = a`

#### Test: closing-last-tab-prunes-group (covers R2, R12)
**Given**: A split whose right child is a group with tab `[x]`
**When**: User closes `x`
**Then**:
- **group-pruned**: The group is removed
- **split-collapses**: The parent split is replaced by its remaining child

#### Test: drag-tab-between-groups (covers R13)
**Given**: Groups G1 `[a, b]`, G2 `[c]`
**When**: User drags `a` to G2's tab bar, drops at index 1
**Then**:
- **g1-now-b**: G1 has `[b]`
- **g2-now-c-a**: G2 has `[c, a]`, active `a`

#### Test: split-drop-left-creates-split (covers R14)
**Given**: Group G1 `[a, b]`, group G2 `[x]`
**When**: User drags `a` to the left 25% of G2's body
**Then**:
- **new-split**: G2 is replaced by a horizontal split
- **new-group-on-left**: Left child is a new group with only `a`; right child is the updated G2 (`[x]`)

#### Test: split-drop-center-equals-tab-drop (covers R15)
**Given**: Groups G1 `[a]`, G2 `[x]`
**When**: User drops `a` on the center zone of G2's body
**Then**:
- **g2-absorbs**: G2 now has `[x, a]`
- **no-split-created**: No new split node exists

#### Test: collapse-group-shrinks-to-strip (covers R19, R22)
**Given**: A horizontal split 50/50, right group visible
**When**: User collapses the right group
**Then**:
- **right-34px**: Right group renders at 34 px wide
- **ratio-adjusted**: The split's ratio is set so the right pane is exactly 34 px
- **saved-ratio-recorded**: `savedRatios[collapseKey] = 0.5`

#### Test: expand-restores-saved-ratios (covers R20)
**Given**: The state from the previous test
**When**: User expands the collapsed group
**Then**:
- **ratio-is-0_5**: Split ratio returns to 0.5
- **saved-key-deleted**: `savedRatios[collapseKey]` is gone

#### Test: collapse-column-shrinks-subtree (covers R21)
**Given**: A horizontal split whose right child is a vertical split
**When**: User collapses the right column (whole vertical split)
**Then**:
- **right-34px**: The entire right subtree renders as a 34 px strip
- **strip-lists-all-tabs**: The strip contains labels for every tab in every descendant group

#### Test: collapsed-column-tab-click-expands-and-activates (covers R23)
**Given**: A column-collapsed right subtree, containing group with tabs `[x, y]`, active `x`
**When**: User clicks the `y` label in the strip
**Then**:
- **column-expanded**: The split's `collapsed` flag is false; ratios restored
- **y-active**: The owning group's `activeTab = y`

#### Test: register-panel-appears-in-registry (covers R33, R37, R38, R39)
**Given**: `PluginHost` has no panel `foo`
**When**: Plugin calls `registerPanel({id: 'foo', title: 'Foo', Component})`
**Then**:
- **listPanels-contains-foo**: `listPanels()` includes an entry with id `foo`
- **getPanel-returns-it**: `getPanel('foo')` returns the contribution
- **registry-merge-includes-foo**: `buildPanelRegistry()['foo']` is non-null

#### Test: duplicate-panel-id-throws (covers R34)
**Given**: Panel `foo` already registered
**When**: A second `registerPanel({id: 'foo', ...})` is called
**Then**:
- **throws**: Error thrown with "duplicate panel id: foo"
- **original-survives**: `getPanel('foo')` still returns the original contribution

#### Test: disposable-removes-panel (covers R35, R36)
**Given**: Panel `foo` registered with a `ctx`
**When**: The returned Disposable's `dispose()` fires (or ctx LIFO-disposes)
**Then**:
- **getPanel-undefined**: `getPanel('foo')` returns `undefined`
- **listPanels-excludes**: `listPanels()` does not contain `foo`

#### Test: selection-activates-properties (covers R46)
**Given**: Editor mounted with no selection; Properties owning group unlocked
**When**: `selectedKeyframe` becomes non-null
**Then**:
- **properties-active**: The `properties` group's `activeTab === 'properties'`

#### Test: lock-blocks-auto-activate (covers R24, R25, R47)
**Given**: Properties group is `locked: true`; a different tab is active in that group
**When**: `selectedKeyframe` becomes non-null
**Then**:
- **active-unchanged**: The group's `activeTab` is unchanged
- **no-save-triggered**: No debounced save is scheduled by the activate attempt

#### Test: reset-layout-restores-default (covers R48)
**Given**: Editor in an arbitrary modified layout
**When**: `resetLayout()` is called on `EditorPanelLayoutHandle`
**Then**:
- **renders-default**: Default shape is rendered
- **persisted**: `saveWorkspaceView` is called with `defaultLayout` and key `_autosave_v3`
- **remounted**: Inner `PanelLayout` remounts (any collapsed/locked/lock-state from prior layout is gone)

#### Test: layout-change-debounces-save (covers R28)
**Given**: No pending save
**When**: `onLayoutChange` fires three times within 500 ms
**Then**:
- **single-save**: `saveWorkspaceView` is called exactly once, 500 ms after the third change
- **payload-is-final**: The saved payload matches the third layout, not the first or second

#### Test: beforeunload-flushes-pending-save (covers R29)
**Given**: A save timer is pending
**When**: `window` dispatches `beforeunload`
**Then**:
- **save-called-now**: `saveWorkspaceView` is invoked synchronously during the handler
- **timer-cleared**: The pending timer is cleared (does not fire again later)

#### Test: validate-drops-unknown-tabs (covers R31)
**Given**: Saved group `{tabs: ['a', 'ghost'], activeTab: 'ghost'}`, registry has `a` but not `ghost`
**When**: `validateLayout` runs
**Then**:
- **tabs-now-a**: Result group's `tabs = ['a']`
- **active-is-a**: `activeTab = 'a'`

#### Test: validate-prunes-emptied-group (covers R2, R31)
**Given**: Saved split whose right child is a group with tabs `[ghost]` only; registry lacks `ghost`
**When**: `validateLayout` runs
**Then**:
- **split-replaced**: Result is the left child only (split itself is gone)

#### Test: validate-coerces-bad-ratio (covers R32)
**Given**: Saved split with `ratio: NaN` (or 1.5, or "0.7")
**When**: `validateLayout` runs
**Then**:
- **ratio-0_5**: Result split's `ratio = 0.5`

#### Test: plugin-panel-render-error-shows-fallback (covers R43, R45)
**Given**: A plugin panel whose `Component` throws on render
**When**: The panel becomes active
**Then**:
- **fallback-rendered**: An inline "Panel X crashed" tile with the error message is shown
- **siblings-alive**: Sibling panels remain mounted and interactive
- **outer-layout-alive**: The editor shell and layout do NOT remount

#### Test: retry-remounts-crashed-panel (covers R44)
**Given**: A crashed plugin panel whose `Component` no longer throws
**When**: User clicks "Retry"
**Then**:
- **fresh-mount**: The component mounts from scratch (new lifecycle)
- **renders-content**: Normal panel content is visible

#### Test: plugin-panel-component-cache-stable (covers R40)
**Given**: `makePluginPanelComponent('foo')` has been called once
**When**: `makePluginPanelComponent('foo')` is called again
**Then**:
- **same-reference**: The returned function `===` the first call's result

#### Test: plugin-panels-survive-parent-rerender (covers R40, R41)
**Given**: A plugin panel is mounted with some internal `useRef`/`useState`
**When**: The editor parent re-renders (forced)
**Then**:
- **no-unmount**: The plugin panel's `useEffect` cleanup is NOT called
- **state-retained**: Internal refs/state are preserved

### Edge Cases

#### Test: validate-prunes-to-default-when-empty (covers R27, R30)
**Given**: Saved layout whose every leaf group references only unknown tabs
**When**: `EditorPanelLayout` mounts
**Then**:
- **validator-returns-null**: `validateLayout` returns `null`
- **fallback-to-default**: Editor renders `defaultLayout`
- **default-persisted**: `saveWorkspaceView(..., defaultLayout)` is called

#### Test: collapse-root-group-no-ratio-change (covers R19)
**Given**: A layout that is a single `GroupNode` at the root (no split)
**When**: User collapses the group
**Then**:
- **collapsed-true**: Group's `collapsed = true`
- **no-ratio-math**: No `savedRatios` entries are written anywhere (none exist to write to)

#### Test: collapse-propagates-through-same-axis-only (covers R19, R22)
**Given**: A deep tree: horizontal split H with a vertical split V on the right, and V's bottom group is collapsed-right-equivalent
**When**: A nested group collapses "right"
**Then**:
- **cross-axis-skipped**: Vertical split ratios are untouched
- **horizontal-ancestor-beneficiary**: The first same-axis horizontal ancestor where the subtree is on child index 1 gets the freed pixels on child index 0

#### Test: self-split-refused-when-single-tab (covers R16)
**Given**: A group with a single tab `[only]`
**When**: User drags `only` to the left-edge drop zone of the same group
**Then**:
- **no-structural-change**: The layout tree is unchanged
- **still-one-group**: The group is not split

#### Test: self-drop-is-noop (covers R13)
**Given**: A group with `[a, b]`, active `a`
**When**: User drags `a` and drops it at its own index
**Then**:
- **unchanged**: `tabs = [a, b]`, `activeTab = a`

#### Test: activate-unknown-panel-noop (covers R33)
**Given**: Panel id `nope` is not in the current layout
**When**: `activatePanel('nope')` is called
**Then**:
- **no-layout-change**: Layout is unchanged; `onLayoutChange` not fired

#### Test: activate-expands-collapsed-ancestors (covers R20, R25)
**Given**: Owning group's ancestor split is column-collapsed
**When**: `activatePanel(panelId)` runs (group unlocked)
**Then**:
- **ancestor-expanded**: The ancestor split's `collapsed = false`
- **ratios-restored**: `savedRatios[collapseKey]` is consumed
- **tab-active**: Owning group's `activeTab = panelId`

#### Test: deactivated-plugin-panel-shows-fallback (covers R42)
**Given**: Plugin panel `foo` was mounted
**When**: Plugin `foo` is deactivated while the panel remains as an active tab
**Then**:
- **fallback-text**: Body renders "Plugin panel foo not registered."
- **no-crash**: No error boundary triggered; no stack trace logged

#### Test: second-registration-throws-first-wins (covers R34)
**Given**: Plugin A registered panel `foo`
**When**: Plugin B calls `registerPanel({id: 'foo', ...})`
**Then**:
- **b-throws**: Plugin B's call raises
- **a-still-active**: `getPanel('foo').Component === A.Component`

#### Test: builtin-takes-precedence-over-plugin (covers R39)
**Given**: Plugin registers a panel with id `chat` (same as built-in)
**When**: `buildPanelRegistry()` runs
**Then**:
- **builtin-kept**: `registry.chat` is the built-in `ChatPanelComponent`
- **plugin-shadowed**: Plugin's Component is NOT reachable via the registry

#### Test: corrupted-saved-json-falls-back-to-default (covers R27, R30, OQ-1)
**Given**: `data.savedLayout` is a non-object (string, number, null after failed JSON.parse upstream, or an object with `type: 'bogus'`)
**When**: `EditorPanelLayout` mounts
**Then**:
- **validator-returns-null**: `validateLayout` returns `null`
- **fallback-to-default**: Editor renders `defaultLayout`
- **default-persisted**: `saveWorkspaceView(..., defaultLayout)` called

#### Test: sash-drag-zero-size-bails (covers R9, OQ-2)
**Given**: A split container whose `containerRef` measures 0 px (e.g., hidden display)
**When**: `ResizeSash` fires `mousemove`
**Then**:
- **no-ratio-change**: The split's ratio is unchanged
- **no-exception**: No divide-by-zero / NaN ratios introduced

#### Test: no-zero-width-noncollapsed-pane (covers R9, OQ-2)
**Given**: The panel-layout source
**When**: inspected for code paths that could produce a 0-px non-collapsed pane
**Then**:
- **collapse-only-path**: only the collapse flow produces the 34-px-strip size; all other paths clamp via MIN_RATIO / MIN_PX

#### Test: no-animated-transitions-in-layout (covers OQ-3)
**Given**: Panel-layout CSS / styles
**When**: inspected
**Then**:
- **no-transition-css**: no `transition`/`animation` rules on ratio-driven sizing; collapse/expand are synchronous

#### Test: multi-window-layouts-per-window (covers R54)
**Given**: Two windows (`windowId=w1`, `w2`) of the same project
**When**: User mutates layout in `w1`
**Then**:
- **w1-key-updated**: `_autosave_v3:w1` payload matches the `w1` tree
- **w2-key-untouched**: `_autosave_v3:w2` is unchanged

#### Test: singleton-panel-move-across-windows (covers R49, R51, INV-6)
**Given**: ChatPanel (singleton) mounted in window A; user opens window B and adds ChatPanel via menu
**When**: The add action completes
**Then**:
- **a-removes-chat**: window A's layout no longer contains `chat`
- **b-gains-chat**: window B's layout now contains `chat`
- **no-duplicate**: no window has two ChatPanel instances

#### Test: singleton-panel-menu-disabled-when-present (covers R52)
**Given**: A singleton panel already present in the current window
**When**: User opens the ⋮ "Add Panel" menu
**Then**:
- **entry-disabled**: The entry for that panel id is disabled (not clickable)

#### Test: non-singleton-panel-duplicates-freely (covers R53)
**Given**: The `properties` panel (non-singleton) already present
**When**: User adds `properties` again via menu or drag
**Then**:
- **two-instances**: The layout now contains two `properties` tab entries

#### Test: exclusive-resource-take-over-dmx (covers R56, R57)
**Given**: Window A owns the DMX WebSerial handle. User clicks "Connect" in window B's DMX panel.
**When**: Take-over modal confirmed.
**Then**:
- **modal-shown**: A take-over modal appeared in window B
- **a-releases-handle**: Window A's WebSerial port is closed
- **b-acquires-handle**: Window B now owns the port; transmit works from B

#### Test: exclusive-resource-released-on-window-close (covers R58)
**Given**: Window A owns DMX; window B is open but not claiming.
**When**: Window A is closed.
**Then**:
- **handle-released**: The DMX serial port is freed (no orphaned lock)
- **b-can-claim**: Window B's next Connect click succeeds without a take-over modal

### Concurrency / single-threaded note

The panel-layout system runs entirely on the React render loop / main-thread JS. There are **no mutexes, no worker coordination, no pub/sub event queues**. The only async surface is the 500 ms debounced save (a single `setTimeout`) and the `Promise`-returning `saveWorkspaceView` call — neither affects tree state. The `activatePanel` imperative call reads layout via a ref (`layoutRef`) specifically to avoid a stale-closure race between React state updates and imperative reads; that is the only synchronization primitive in the module.

- **Negative assertion (no-concurrency-assumed)**: The implementation MUST NOT introduce workers, shared mutexes, or message queues without extending this spec; adding async coordination silently would violate the design contract.

---

## Non-Goals

- Drag-and-drop on touch devices.
- Keyboard-driven panel navigation or screen-reader ARIA roles beyond native button/tab defaults.
- Multi-monitor / pop-out windows.
- Cross-client layout sync (real-time collaboration).
- Runtime HMR-added plugins appearing in an already-mounted editor without reload.
- Ratio math when the root `LayoutNode` is itself collapsed (current code allows `SplitNode.collapsed` but the root-collapse UX is not a supported invocation path in the default layout).
- Mobile / small-viewport responsive behavior.
- Persisting plugin panel internal state across full editor reloads (component cache survives re-renders, not reloads).

---

## Open Questions

### Resolved

**OQ-1 (resolved)**: Corrupted saved JSON. **Decision**: codify current validate-or-reset path — malformed input makes `validateLayout` return `null`; default is persisted back. No spec-level requirement for logging / user notification. **Tests**: `corrupted-saved-json-falls-back-to-default`.

**OQ-2 (resolved)**: Sash drag with zero total container size. **Decision**: codify the current `totalSize===0` bail as correct; add a negative-assertion test that no code path produces a non-collapsed zero-width pane. **Tests**: `sash-drag-zero-size-bails`, `no-zero-width-noncollapsed-pane`.

**OQ-3 (resolved)**: Drop during animation. **Decision**: codify — transitions are CSS-instant today; scenario not reachable. Revisit if animated transitions added. **Tests**: `no-animated-transitions-in-layout`.

---

## Related Artifacts

- `agent/reports/audit-2-architectural-deep-dive.md` §1D (units 1–2) — the audit that originated this spec target.
- `src/components/panel-layout/` — implementation.
- `src/components/editor/EditorPanelLayout.tsx` — editor host.
- `src/lib/plugin-host.ts` — plugin contribution API.
- Future spec: `local.plugin-host-and-manifest` (cross-cutting plugin system; this spec assumes `registerPanel` exists).
- Future spec: `local.editor-state-selection-mutex` (owns the `selected*` primitives consumed by `AutoActivatePropertiesEffect`).
