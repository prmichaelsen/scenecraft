/**
 * generate_foley plugin — entry point.
 *
 * Registers the FoleyGenerationsPanel as a panel contribution.
 * No context menus or operations in MVP — the panel is the only surface.
 *
 * FoleyGenerationsPanel is created in task-147; this file imports it
 * anticipating that work. The import will error at dev-time until
 * task-147 lands — that's expected and harmless (the editor catches
 * plugin activation errors gracefully).
 */

import type { ComponentType } from 'react'

import type { PluginContext, PluginModule } from '@/lib/plugin-host'

// Task-147 creates this component. Stub import for now.
let FoleyGenerationsPanel: ComponentType<unknown>
try {
  // Dynamic require so the module is optional at bundle time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = await import('./FoleyGenerationsPanel')
  FoleyGenerationsPanel = mod.FoleyGenerationsPanel ?? mod.default
} catch {
  // Panel not built yet (task-147). Register a placeholder.
  FoleyGenerationsPanel = (() => null) as unknown as ComponentType<unknown>
}

export const activate: PluginModule['activate'] = (host, context) => {
  host.registerPanel(
    {
      id: 'foley_generations',
      title: 'Foley',
      Component: FoleyGenerationsPanel,
    },
    context,
  )
}

export const deactivate: PluginModule['deactivate'] = (
  _context: PluginContext,
) => {
  // Nothing to clean up outside context.subscriptions.
}

export {
  runFoleyGeneration,
  fetchFoleyGenerations,
  retryFoleyGeneration,
  subscribeFoleyJob,
} from './generate-foley-client'

export type {
  FoleyMode,
  GenerateFoleyRequest,
  GenerateFoleyResponse,
  GenerationListItem,
  GenerationTrack,
} from './types'
