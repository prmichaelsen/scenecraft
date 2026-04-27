/**
 * Static plugin registry (frontend) with VSCode-style dispose pattern.
 *
 * Plugins register contributions during ``activate(host, context)`` and
 * push ``Disposable`` objects into ``context.subscriptions``. When a plugin
 * is deactivated (Vite HMR, dynamic unload, tests), each disposable fires
 * in LIFO order so resources (event listeners, WebSockets, subscriptions,
 * intervals) clean up cleanly.
 *
 * Mirrors the backend ``PluginHost`` surface in scenecraft-engine. For MVP
 * this is a process-singleton populated at editor startup; when a dynamic
 * loader lands, ``register`` + ``deactivate`` remain the seams.
 */

import type { ComponentType } from 'react'


// ── Disposable contract ─────────────────────────────────────────────────

export interface Disposable {
  dispose(): void | Promise<void>
}


/**
 * Adapt a teardown callable to a Disposable. Example::
 *
 *     const timer = setInterval(tick, 1000)
 *     context.subscriptions.push(makeDisposable(() => clearInterval(timer)))
 */
export function makeDisposable(fn: () => void | Promise<void>): Disposable {
  let disposed = false
  return {
    dispose: async () => {
      if (disposed) return
      disposed = true
      try {
        await fn()
      } catch (e) {
        console.error('[plugin-host] disposable raised:', e)
      }
    },
  }
}


export type PluginContext = {
  /** Plugin module name; also used as the deactivation key. */
  readonly name: string
  /**
   * Register Disposables here. On deactivation each one fires in LIFO
   * order, matching VSCode's model.
   */
  readonly subscriptions: Disposable[]
}

// Internal registry entry — carries the plugin module reference alongside
// its context so `deactivate(name)` can invoke the module's optional
// `deactivate(context)` hook without the caller re-supplying the module.
type RegistryEntry = {
  context: PluginContext
  plugin: PluginModule
}


// ── Descriptors ─────────────────────────────────────────────────────────

export type OperationDescriptor = {
  /**
   * Stable operation id. Convention: `{plugin_name}.{member}` where
   * `plugin_name` is snake_case matching the Python backend module. Example:
   * `isolate_vocals.run`. Must be unique process-wide. (Dots are fine for
   * internal ids; chat-tool names that cross the Claude API boundary use
   * `{plugin_name}__{member}` because Claude's tool-name regex forbids dots.)
   */
  id: string
  /** Human-readable label used in menus / buttons. */
  label: string
  /** Entity kinds this operation can be invoked on (e.g. `["audio_clip"]`). */
  entityTypes: string[]
  /**
   * Optional dialog component the caller should render before dispatching the
   * operation (confirm / parameter picker). Complementary with `panel`: a
   * plugin that ships a dedicated panel typically doesn't need a dialog.
   */
  dialog?: ComponentType<unknown>
  /**
   * Optional panel component the plugin contributes. Registered with the
   * editor's dockview layout so context-menu `reveals` hints and chat-tool
   * invocations can focus the plugin's primary UX surface.
   */
  panel?: ComponentType<unknown>
}

/**
 * Panel contribution — plugins register a panel that the editor's dockview
 * layout mounts as one of its tabs. The editor provides an optional wrapper
 * with editor-context-aware props; the plugin's ``Component`` receives those
 * props and renders whatever UX it owns.
 *
 * Separate from ``OperationDescriptor.panel`` (which ties a panel reveal to
 * an operation). A plugin can register a panel without registering an
 * operation, e.g. for a log viewer or a read-only inspector.
 */
export type PanelContribution = {
  /**
   * Panel id. Convention: snake_case, matches the plugin layout of
   * ``panel:{id}`` in context-menu ``reveals`` hints (e.g. ``audio_isolations``).
   */
  id: string
  /** Human-readable tab title. */
  title: string
  /** Panel body. Props are editor-supplied at mount time. */
  Component: ComponentType<unknown>
}

/**
 * A plugin-contributed track lane on the main editor Timeline.
 *
 * The frontend Timeline iterates registered track types (after rendering
 * the built-in video / audio / transition rows) and renders each one's
 * ``Renderer`` underneath. Plugins use this to surface their own data
 * on the timeline — e.g., light_show's scene placements rendered as
 * colored bars.
 *
 * MVP scope (lighter than the full task-137 spec): we DO NOT refactor
 * the existing video/audio rendering paths through this registry. Those
 * stay hardcoded. Plugin track types render in a separate dispatch loop
 * after them. Once all built-in types have an extracted contribution,
 * we can collapse the loops into one — that's a follow-up.
 *
 * No backend track-row entry is required. A plugin's track type is a
 * pure UI contribution; the data backing the lane comes from whatever
 * REST/WS surface the plugin already exposes (placements, etc.).
 */
export type TrackRendererProps = {
  /** Pixels per second on the timeline ruler. */
  pxPerSec: number
  /** Horizontal scroll offset of the timeline viewport. */
  scrollLeft: number
  /** Visible viewport width in pixels. */
  viewportWidth: number
  /** Current playhead time in seconds. */
  currentTime: number
  /** Project name (for the renderer's own data fetches). */
  projectName: string
}

export type TrackTypeContribution = {
  /** Stable id. Convention: snake_case, matches the plugin name. */
  id: string
  /** Tab/lane label shown in the timeline gutter. */
  label: string
  /** Lane height in pixels. */
  defaultHeight?: number
  /** Lower number = higher in the timeline stack (renders earlier). */
  sortHint?: number
  /** Renderer for the lane body. */
  Renderer: ComponentType<TrackRendererProps>
}


export type ContextMenuDescriptor = {
  /** Entity kind this context menu contributes to. */
  entityType: string
  /** Menu items; each references a previously registered operation id. */
  items: Array<{
    operation: string
    label: string
    icon?: string
    /**
     * Optional panel focus hint (e.g. "panel:audio_isolations") — the editor
     * can use this to reveal the corresponding panel on menu-click before or
     * alongside dispatching the operation.
     */
    reveals?: string
  }>
}


export type PluginModule = {
  /**
   * Called once on registration. Plugins push Disposables into
   * ``context.subscriptions`` so the host can tear them down on deactivation.
   * Legacy signature ``activate(host)`` is still supported during migration.
   */
  activate:
    | ((host: PluginHostImpl) => void | Promise<void>)
    | ((host: PluginHostImpl, context: PluginContext) => void | Promise<void>)
  /**
   * Optional module-level deactivate hook. Runs AFTER all subscriptions
   * have been disposed. Use for anything that doesn't fit the Disposable
   * shape (one-shot flushes, finalizers).
   */
  deactivate?: (context: PluginContext) => void | Promise<void>
}


// ── PluginHost ─────────────────────────────────────────────────────────

class PluginHostImpl {
  private operations = new Map<string, OperationDescriptor>()
  private contextMenus = new Map<string, ContextMenuDescriptor[]>()
  private entries = new Map<string, RegistryEntry>()
  private panels = new Map<string, PanelContribution>()
  private trackTypes = new Map<string, TrackTypeContribution>()
  private trackTypeListeners = new Set<() => void>()

  /**
   * Activate a plugin module. Creates a PluginContext and calls
   * `plugin.activate(this, context)`. If the plugin is already registered
   * under this name, the call is a no-op — the caller should deactivate
   * first if it wants to re-register.
   */
  register(plugin: PluginModule, name = '<unknown>'): PluginContext {
    const existing = this.entries.get(name)
    if (existing) return existing.context

    const context: PluginContext = { name, subscriptions: [] }
    // Pass context as the second arg. Plugins with legacy 1-arg activate()
    // just ignore it; the positional arg is silently accepted at runtime.
    const result = (plugin.activate as (h: unknown, c?: unknown) => unknown)(
      this,
      context,
    )
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      ;(result as Promise<unknown>).catch((e) =>
        console.error(`[plugin-host] activate(${name}) failed:`, e),
      )
    }
    this.entries.set(name, { context, plugin })
    return context
  }

  /**
   * Deactivate a plugin by name. Disposes all ``context.subscriptions`` in
   * LIFO order, then (if defined) calls the plugin module's ``deactivate``
   * hook with the same context. The plugin reference is stored at register
   * time so callers don't need to re-supply it. Safe on unknown names
   * (silent no-op).
   */
  async deactivate(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) return
    this.entries.delete(name)
    const { context, plugin } = entry

    while (context.subscriptions.length > 0) {
      const d = context.subscriptions.pop() as Disposable
      try {
        await d.dispose()
      } catch (e) {
        console.error(`[plugin-host] dispose failed for ${name}:`, e)
      }
    }

    if (plugin.deactivate) {
      try {
        await plugin.deactivate(context)
      } catch (e) {
        console.error(`[plugin-host] plugin deactivate() failed for ${name}:`, e)
      }
    }
  }

  /**
   * Register an operation. Returns a Disposable that removes the operation
   * from the registry when disposed. If ``context`` is provided, the
   * Disposable is auto-pushed into ``context.subscriptions``.
   */
  registerOperation(
    op: OperationDescriptor,
    context?: PluginContext,
  ): Disposable {
    if (this.operations.has(op.id)) {
      throw new Error(`duplicate operation id: ${op.id}`)
    }
    this.operations.set(op.id, op)

    const d = makeDisposable(() => {
      if (this.operations.get(op.id) === op) {
        this.operations.delete(op.id)
      }
    })
    if (context) context.subscriptions.push(d)
    return d
  }

  /**
   * Register a context-menu contribution. Returns a Disposable. Per-menu
   * bookkeeping by entityType so dispose only removes this plugin's entry.
   */
  registerContextMenu(
    menu: ContextMenuDescriptor,
    context?: PluginContext,
  ): Disposable {
    const list = this.contextMenus.get(menu.entityType) ?? []
    list.push(menu)
    this.contextMenus.set(menu.entityType, list)

    const d = makeDisposable(() => {
      const current = this.contextMenus.get(menu.entityType)
      if (!current) return
      const i = current.indexOf(menu)
      if (i >= 0) current.splice(i, 1)
      if (current.length === 0) this.contextMenus.delete(menu.entityType)
    })
    if (context) context.subscriptions.push(d)
    return d
  }

  /**
   * Register a panel contribution. Returns a Disposable that removes the
   * panel when disposed. Auto-pushes into ``context.subscriptions`` when
   * provided.
   */
  registerPanel(
    panel: PanelContribution,
    context?: PluginContext,
  ): Disposable {
    if (this.panels.has(panel.id)) {
      throw new Error(`duplicate panel id: ${panel.id}`)
    }
    this.panels.set(panel.id, panel)

    const d = makeDisposable(() => {
      if (this.panels.get(panel.id) === panel) {
        this.panels.delete(panel.id)
      }
    })
    if (context) context.subscriptions.push(d)
    return d
  }

  /**
   * Register a timeline track-type contribution. Returns a Disposable that
   * removes it from the registry when disposed. Notifies subscribers
   * (Timeline.tsx + tests) so the timeline re-renders to include / drop
   * the lane.
   */
  registerTrackType(
    track: TrackTypeContribution,
    context?: PluginContext,
  ): Disposable {
    if (this.trackTypes.has(track.id)) {
      throw new Error(`duplicate track type id: ${track.id}`)
    }
    this.trackTypes.set(track.id, track)
    for (const cb of this.trackTypeListeners) cb()

    const d = makeDisposable(() => {
      if (this.trackTypes.get(track.id) === track) {
        this.trackTypes.delete(track.id)
        for (const cb of this.trackTypeListeners) cb()
      }
    })
    if (context) context.subscriptions.push(d)
    return d
  }

  /** List all registered track types, sorted ascending by sortHint. */
  listTrackTypes(): TrackTypeContribution[] {
    return Array.from(this.trackTypes.values()).sort(
      (a, b) => (a.sortHint ?? 1000) - (b.sortHint ?? 1000),
    )
  }

  /** Look up one track type by id. */
  getTrackType(id: string): TrackTypeContribution | undefined {
    return this.trackTypes.get(id)
  }

  /**
   * Subscribe to registration / disposal of track types. Returns an
   * unsubscribe fn. Designed for ``useSyncExternalStore`` consumers
   * (Timeline.tsx); fires on every register/dispose so the consumer
   * re-renders.
   */
  subscribeTrackTypes(cb: () => void): () => void {
    this.trackTypeListeners.add(cb)
    return () => { this.trackTypeListeners.delete(cb) }
  }

  /** List all panel contributions currently registered. */
  listPanels(): PanelContribution[] {
    return Array.from(this.panels.values())
  }

  /** Look up a single panel contribution by id. */
  getPanel(id: string): PanelContribution | undefined {
    return this.panels.get(id)
  }

  getOperation(id: string): OperationDescriptor | undefined {
    return this.operations.get(id)
  }

  listOperations(entityType?: string): OperationDescriptor[] {
    const all = Array.from(this.operations.values())
    if (entityType === undefined) return all
    return all.filter((op) => op.entityTypes.includes(entityType))
  }

  /**
   * Flatten all context-menu items contributed for `entityType` across every
   * menu descriptor registered for that entity kind.
   */
  getContextMenuItems(entityType: string): ContextMenuDescriptor['items'] {
    const list = this.contextMenus.get(entityType)
    if (!list) return []
    return list.flatMap((m) => m.items)
  }

  /** Count of registered plugin modules — used for startup diagnostics. */
  get registeredCount(): number {
    return this.entries.size
  }

  /** Count of registered operations — used for startup diagnostics. */
  get operationCount(): number {
    return this.operations.size
  }

  /** Test-only: clear all registry state with best-effort disposal. */
  _resetForTests(): void {
    for (const name of Array.from(this.entries.keys())) {
      void this.deactivate(name)
    }
    this.operations.clear()
    this.contextMenus.clear()
    this.entries.clear()
    this.panels.clear()
    this.trackTypes.clear()
    this.trackTypeListeners.clear()
  }
}

export type { PluginHostImpl }

export const PluginHost = new PluginHostImpl()
