/**
 * isolate_vocals plugin — entry point.
 *
 * Registered by the editor shell at startup. Registers a single operation
 * and two context-menu contributions (audio_clip + transition). The
 * operation's primary UX surface is the `AudioIsolationsPanel` (not a
 * dialog) — a context-menu click `reveals` the panel and kicks off the
 * inline Run form inside it.
 *
 * Naming conventions:
 *   • Operation id (internal): `isolate_vocals.run`
 *   • Chat tool name (Claude API): `isolate_vocals__run` (see backend chat.py)
 *   • REST route: `/plugins/isolate_vocals/run`
 */

import type { ComponentType } from 'react'

import type { PluginContext, PluginModule } from '@/lib/plugin-host'

import { AudioIsolationsPanel } from './AudioIsolationsPanel'
import { IsolateVocalsRunForm } from './IsolateVocalsRunForm'
import {
  callIsolateVocals,
  fetchIsolations,
  subscribeIsolationJob,
} from './isolate-vocals-client'

export const activate: PluginModule['activate'] = (host, context) => {
  // Panel contribution — the editor iterates ``PluginHost.listPanels()`` at
  // mount time and adds our panel to its dockview registry. Disposal on
  // plugin deactivate removes the panel from the list automatically.
  host.registerPanel(
    {
      id: 'audio_isolations',
      title: 'Audio Isolations',
      Component: AudioIsolationsPanel as ComponentType<unknown>,
    },
    context,
  )

  host.registerOperation(
    {
      id: 'isolate_vocals.run',
      label: 'Isolate vocals',
      entityTypes: ['audio_clip', 'transition'],
      // Kept for the operation↔panel linkage (context-menu `reveals` hint).
      panel: AudioIsolationsPanel as ComponentType<unknown>,
    },
    context,
  )

  host.registerContextMenu(
    {
      entityType: 'audio_clip',
      items: [
        {
          operation: 'isolate_vocals.run',
          label: 'Isolate vocals…',
          icon: 'wave',
          reveals: 'panel:audio_isolations',
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
          operation: 'isolate_vocals.run',
          label: 'Isolate vocals from audio track…',
          icon: 'wave',
          reveals: 'panel:audio_isolations',
        },
      ],
    },
    context,
  )
}


/**
 * Optional module-level deactivate hook. Runs after all subscriptions are
 * disposed; left here as a seam for future resource-heavy plugin state.
 */
export const deactivate: PluginModule['deactivate'] = (_context: PluginContext) => {
  // Nothing to clean up outside context.subscriptions for now.
}

export {
  AudioIsolationsPanel,
  IsolateVocalsRunForm,
  callIsolateVocals,
  fetchIsolations,
  subscribeIsolationJob,
}
