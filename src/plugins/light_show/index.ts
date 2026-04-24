/**
 * light_show plugin — entry point (MVP).
 *
 * Registers a single panel that renders a hardcoded DMX rig in 3D with
 * hardcoded scene variations selectable via dropdown. Validates the
 * three.js + r3f pipeline end-to-end without backend coupling.
 *
 * Follow-up work (deferred to M17 proper): data-driven fixtures and scenes
 * stored in SQL, GDTF-backed profiles, timeline integration via track-type
 * contribution point, chat/MCP tools for rig + scene authoring.
 */

import type { ComponentType } from 'react'
import type { PluginModule } from '@/lib/plugin-host'

import { LightShow3DPanel } from './LightShow3DPanel'

export const activate: PluginModule['activate'] = (host, context) => {
  host.registerPanel(
    {
      id: 'light_show',
      title: 'Light Show',
      Component: LightShow3DPanel as ComponentType<unknown>,
    },
    context,
  )
}
