/**
 * generate_foley plugin — entry point.
 *
 * Registers the FoleyGenerationsPanel as a panel contribution.
 * No context menus or operations in MVP — the panel is the only surface.
 */

import type { ComponentType } from 'react'

import type { PluginContext, PluginModule } from '@/lib/plugin-host'

import { FoleyGenerationsPanel } from './FoleyGenerationsPanel'

export const activate: PluginModule['activate'] = (host, context) => {
  host.registerPanel(
    {
      id: 'foley_generations',
      title: 'Foley',
      Component: FoleyGenerationsPanel as ComponentType<unknown>,
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
