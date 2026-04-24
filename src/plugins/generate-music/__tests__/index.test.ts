/**
 * Smoke tests for the generate-music plugin's activation wiring.
 *
 * Verifies `activate(host)` registers:
 *   - The MusicGenerationsPanel under id `music_generations`
 *   - The operation `generate_music.run` for audio_clip + transition
 *   - Two context-menu contributions pointing at the same operation
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { PluginHost } from '@/lib/plugin-host'
import * as generateMusic from '../index'

beforeEach(() => {
  PluginHost._resetForTests()
})

describe('generate-music plugin — activate()', () => {
  it('registers the MusicGenerationsPanel', () => {
    PluginHost.register(generateMusic, 'generate_music')

    const panel = PluginHost.getPanel('music_generations')
    expect(panel).toBeDefined()
    expect(panel?.title).toBe('Music Generations')
  })

  it('registers one operation for audio_clip + transition', () => {
    PluginHost.register(generateMusic, 'generate_music')

    const op = PluginHost.getOperation('generate_music.run')
    expect(op).toBeDefined()
    expect(op?.label).toBe('Generate music')
    expect(op?.entityTypes).toEqual(['audio_clip', 'transition'])
    expect(op?.panel).toBeDefined()
    expect(op?.dialog).toBeUndefined()
  })

  it('contributes context menu items that reveal the panel', () => {
    PluginHost.register(generateMusic, 'generate_music')

    const clipItems = PluginHost.getContextMenuItems('audio_clip')
    expect(clipItems).toHaveLength(1)
    expect(clipItems[0].operation).toBe('generate_music.run')
    expect(clipItems[0].reveals).toBe('panel:music_generations')

    const transitionItems = PluginHost.getContextMenuItems('transition')
    expect(transitionItems).toHaveLength(1)
    expect(transitionItems[0].operation).toBe('generate_music.run')
    expect(transitionItems[0].reveals).toBe('panel:music_generations')
  })

  it('listOperations filters by entity type', () => {
    PluginHost.register(generateMusic, 'generate_music')

    expect(PluginHost.listOperations('audio_clip')).toHaveLength(1)
    expect(PluginHost.listOperations('transition')).toHaveLength(1)
    expect(PluginHost.listOperations('keyframe')).toHaveLength(0)
  })
})
