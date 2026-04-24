/**
 * generate-music plugin — entry point.
 *
 * Registered by the editor shell at startup alongside isolate_vocals and
 * the rest. Single operation (`generate-music.run`) that the chat surface
 * and context-menu both dispatch; the primary UI is the
 * MusicGenerationsPanel which the operation "reveals" on activation.
 *
 * Naming:
 *   • Operation id (internal): `generate_music.run`
 *   • Chat tool name: `generate_music` (see backend chat.py)
 *   • REST routes: `/plugins/generate-music/...` (task-130)
 *
 * Note the plugin-id hyphenation mismatch: the backend uses
 * `generate_music` (Python module naming), the frontend folder and
 * plugin.yaml use `generate-music` (URL + npm convention). REST routes
 * use the hyphenated form; chat-tool / operation ids use underscored.
 */

import type { ComponentType } from 'react'

import type { PluginContext, PluginModule } from '@/lib/plugin-host'

import { MusicGenerationsPanel } from './MusicGenerationsPanel'
import {
  runGeneration,
  listGenerations,
  retryGeneration,
  getCredits,
  useMusicGenerationEvents,
  subscribeMusicJob,
} from './generate-music-client'

export const activate: PluginModule['activate'] = (host, context) => {
  host.registerPanel(
    {
      id: 'music_generations',
      title: 'Music Generations',
      Component: MusicGenerationsPanel as ComponentType<unknown>,
    },
    context,
  )

  host.registerOperation(
    {
      id: 'generate_music.run',
      label: 'Generate music',
      entityTypes: ['audio_clip', 'transition'],
      panel: MusicGenerationsPanel as ComponentType<unknown>,
    },
    context,
  )

  host.registerContextMenu(
    {
      entityType: 'audio_clip',
      items: [
        {
          operation: 'generate_music.run',
          label: 'Generate music for this clip…',
          icon: 'music',
          reveals: 'panel:music_generations',
        },
      ],
    },
    context,
  )

  host.registerContextMenu(
    {
      entityType: 'transition',
      items: [
        {
          operation: 'generate_music.run',
          label: 'Generate music for this transition…',
          icon: 'music',
          reveals: 'panel:music_generations',
        },
      ],
    },
    context,
  )
}

export const deactivate: PluginModule['deactivate'] = (_context: PluginContext) => {
  // Nothing beyond context.subscriptions to tear down.
}

export {
  MusicGenerationsPanel,
  runGeneration,
  listGenerations,
  retryGeneration,
  getCredits,
  useMusicGenerationEvents,
  subscribeMusicJob,
}
