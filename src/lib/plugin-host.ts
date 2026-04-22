/**
 * Static plugin registry (frontend).
 *
 * Mirrors the backend `PluginHost` surface: plugins register operations and
 * context-menu contributions during `activate(host)`. For MVP this is a
 * process-singleton populated at editor startup; when a dynamic loader lands
 * later, the same `PluginHost` shape will remain the integration point.
 */

import type { ComponentType } from 'react'

export type OperationDescriptor = {
  /** Stable operation id (e.g. "isolate-vocals.run"). Must be unique process-wide. */
  id: string
  /** Human-readable label used in menus / buttons. */
  label: string
  /** Entity kinds this operation can be invoked on (e.g. `["audio_clip"]`). */
  entityTypes: string[]
  /**
   * Optional dialog component the caller should render before dispatching the
   * operation (e.g. confirm / parameter picker). The caller passes whatever
   * props are appropriate for the entity; the operation itself is responsible
   * for any backend side-effects once the dialog resolves.
   */
  dialog?: ComponentType<unknown>
}

export type ContextMenuDescriptor = {
  /** Entity kind this context menu contributes to. */
  entityType: string
  /** Menu items; each references a previously registered operation id. */
  items: Array<{ operation: string; label: string; icon?: string }>
}

export type PluginModule = {
  activate: (host: PluginHostImpl) => void
}

class PluginHostImpl {
  private operations = new Map<string, OperationDescriptor>()
  private contextMenus: ContextMenuDescriptor[] = []
  private registered: string[] = []

  /** Activate a plugin module — calls `plugin.activate(this)`. */
  register(plugin: PluginModule, name = '<unknown>'): void {
    plugin.activate(this)
    this.registered.push(name)
  }

  registerOperation(op: OperationDescriptor): void {
    if (this.operations.has(op.id)) {
      throw new Error(`duplicate operation id: ${op.id}`)
    }
    this.operations.set(op.id, op)
  }

  registerContextMenu(menu: ContextMenuDescriptor): void {
    this.contextMenus.push(menu)
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
    return this.contextMenus
      .filter((m) => m.entityType === entityType)
      .flatMap((m) => m.items)
  }

  /** Count of registered plugin modules — used for startup diagnostics. */
  get registeredCount(): number {
    return this.registered.length
  }

  /** Count of registered operations — used for startup diagnostics. */
  get operationCount(): number {
    return this.operations.size
  }

  /** Test-only: clear all registry state. */
  _resetForTests(): void {
    this.operations.clear()
    this.contextMenus = []
    this.registered = []
  }
}

export type { PluginHostImpl }

export const PluginHost = new PluginHostImpl()
