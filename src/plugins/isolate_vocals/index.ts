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

import type { PluginModule } from '@/lib/plugin-host'

import { AudioIsolationsPanel } from './AudioIsolationsPanel'
import { IsolateVocalsRunForm } from './IsolateVocalsRunForm'
import {
  callIsolateVocals,
  fetchIsolations,
  subscribeIsolationJob,
} from './isolate-vocals-client'

export const activate: PluginModule['activate'] = (host) => {
  host.registerOperation({
    id: 'isolate_vocals.run',
    label: 'Isolate vocals',
    entityTypes: ['audio_clip', 'transition'],
    // Plugin-host descriptor types panels as ComponentType<unknown> — plugins
    // are free to narrow their own prop types internally.
    panel: AudioIsolationsPanel as ComponentType<unknown>,
  })

  host.registerContextMenu({
    entityType: 'audio_clip',
    items: [
      {
        operation: 'isolate_vocals.run',
        label: 'Isolate vocals…',
        icon: 'wave',
        reveals: 'panel:audio_isolations',
      },
    ],
  })

  host.registerContextMenu({
    entityType: 'transition',
    items: [
      {
        operation: 'isolate_vocals.run',
        label: 'Isolate vocals from audio track…',
        icon: 'wave',
        reveals: 'panel:audio_isolations',
      },
    ],
  })
}

export {
  AudioIsolationsPanel,
  IsolateVocalsRunForm,
  callIsolateVocals,
  fetchIsolations,
  subscribeIsolationJob,
}
