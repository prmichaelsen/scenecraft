/**
 * Tests for the isolate_vocals plugin's activation wiring.
 *
 * Verifies that `activate(host)` correctly registers:
 *   - One operation (id `isolate_vocals.run`, with `panel` set)
 *   - Two context-menu contributions (audio_clip + transition)
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { PluginHost } from '@/lib/plugin-host'
import * as isolateVocals from '../index'

beforeEach(() => {
  PluginHost._resetForTests()
})

describe('isolate_vocals plugin — activate()', () => {
  it('registers one operation with a panel (no dialog)', () => {
    PluginHost.register(isolateVocals, 'isolate_vocals')

    const op = PluginHost.getOperation('isolate_vocals.run')
    expect(op).toBeDefined()
    expect(op?.label).toBe('Isolate vocals')
    expect(op?.entityTypes).toEqual(['audio_clip', 'transition'])
    expect(op?.panel).toBeDefined()
    expect(op?.dialog).toBeUndefined()
  })

  it('contributes context menu items for audio_clip and transition', () => {
    PluginHost.register(isolateVocals, 'isolate_vocals')

    const clipItems = PluginHost.getContextMenuItems('audio_clip')
    expect(clipItems).toHaveLength(1)
    expect(clipItems[0].operation).toBe('isolate_vocals.run')
    expect(clipItems[0].label).toBe('Isolate vocals…')
    expect(clipItems[0].reveals).toBe('panel:audio_isolations')

    const transitionItems = PluginHost.getContextMenuItems('transition')
    expect(transitionItems).toHaveLength(1)
    expect(transitionItems[0].operation).toBe('isolate_vocals.run')
    expect(transitionItems[0].label).toBe('Isolate vocals from audio track…')
    expect(transitionItems[0].reveals).toBe('panel:audio_isolations')
  })

  it('listOperations filters by entity type', () => {
    PluginHost.register(isolateVocals, 'isolate_vocals')

    expect(PluginHost.listOperations('audio_clip')).toHaveLength(1)
    expect(PluginHost.listOperations('transition')).toHaveLength(1)
    expect(PluginHost.listOperations('keyframe')).toHaveLength(0)
  })
})
