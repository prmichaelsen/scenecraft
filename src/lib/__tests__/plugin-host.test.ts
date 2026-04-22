import { describe, it, expect, beforeEach } from 'vitest'
import type { PluginModule } from '../plugin-host'
import { PluginHost } from '../plugin-host'

// The PluginHost singleton is process-global, so each test must start from a
// clean slate to avoid cross-pollution.
beforeEach(() => {
  PluginHost._resetForTests()
})

describe('PluginHost.register', () => {
  it('calls plugin.activate(host) and records the module name', () => {
    let activatedWith: unknown = null
    const plugin: PluginModule = {
      activate: (host) => {
        activatedWith = host
      },
    }

    PluginHost.register(plugin, 'test-plugin')

    expect(activatedWith).toBe(PluginHost)
    expect(PluginHost.registeredCount).toBe(1)
  })
})

describe('PluginHost.registerOperation / getOperation', () => {
  it('round-trips a registered operation', () => {
    PluginHost.registerOperation({
      id: 'test.op',
      label: 'Test Op',
      entityTypes: ['audio_clip'],
    })

    const got = PluginHost.getOperation('test.op')
    expect(got).toBeDefined()
    expect(got?.label).toBe('Test Op')
    expect(got?.entityTypes).toEqual(['audio_clip'])
  })

  it('returns undefined for unknown ids', () => {
    expect(PluginHost.getOperation('nope')).toBeUndefined()
  })

  it('throws on duplicate operation id', () => {
    PluginHost.registerOperation({
      id: 'dup.op',
      label: 'Dup',
      entityTypes: ['audio_clip'],
    })
    expect(() =>
      PluginHost.registerOperation({
        id: 'dup.op',
        label: 'Dup 2',
        entityTypes: ['audio_clip'],
      }),
    ).toThrow(/duplicate operation id/)
  })
})

describe('PluginHost.listOperations', () => {
  it('returns all when no filter', () => {
    PluginHost.registerOperation({ id: 'a', label: 'A', entityTypes: ['audio_clip'] })
    PluginHost.registerOperation({ id: 'b', label: 'B', entityTypes: ['video_clip'] })

    const ids = PluginHost.listOperations().map((o) => o.id).sort()
    expect(ids).toEqual(['a', 'b'])
  })

  it('filters by entity type', () => {
    PluginHost.registerOperation({ id: 'a', label: 'A', entityTypes: ['audio_clip'] })
    PluginHost.registerOperation({ id: 'b', label: 'B', entityTypes: ['video_clip'] })
    PluginHost.registerOperation({
      id: 'c',
      label: 'C',
      entityTypes: ['audio_clip', 'video_clip'],
    })

    const audio = PluginHost.listOperations('audio_clip').map((o) => o.id).sort()
    expect(audio).toEqual(['a', 'c'])

    const video = PluginHost.listOperations('video_clip').map((o) => o.id).sort()
    expect(video).toEqual(['b', 'c'])

    expect(PluginHost.listOperations('pool_segment')).toEqual([])
  })
})

describe('PluginHost.getContextMenuItems', () => {
  it('flattens items across multiple menu descriptors for the same entity type', () => {
    PluginHost.registerContextMenu({
      entityType: 'audio_clip',
      items: [{ operation: 'a.run', label: 'Run A' }],
    })
    PluginHost.registerContextMenu({
      entityType: 'audio_clip',
      items: [
        { operation: 'b.run', label: 'Run B' },
        { operation: 'c.run', label: 'Run C', icon: 'sparkles' },
      ],
    })
    PluginHost.registerContextMenu({
      entityType: 'video_clip',
      items: [{ operation: 'x.run', label: 'Run X' }],
    })

    const items = PluginHost.getContextMenuItems('audio_clip')
    expect(items.map((i) => i.operation)).toEqual(['a.run', 'b.run', 'c.run'])
    expect(items.find((i) => i.operation === 'c.run')?.icon).toBe('sparkles')

    const videoItems = PluginHost.getContextMenuItems('video_clip')
    expect(videoItems).toEqual([{ operation: 'x.run', label: 'Run X' }])

    // Entity type with no contributions → empty.
    expect(PluginHost.getContextMenuItems('pool_segment')).toEqual([])
  })
})
