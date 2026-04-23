import { describe, it, expect, beforeEach } from 'vitest'
import type { PluginModule } from '../plugin-host'
import { PluginHost } from '../plugin-host'

// The PluginHost singleton is process-global, so each test must start from a
// clean slate to avoid cross-pollution.
beforeEach(() => {
  PluginHost._resetForTests()
})

describe('PluginHost.register', () => {
  it('calls plugin.activate(host, context) and records the module name', () => {
    let activatedWith: unknown = null
    let passedContext: { name: string; subscriptions: unknown[] } | null = null
    const plugin: PluginModule = {
      activate: (host, context) => {
        activatedWith = host
        passedContext = context ?? null
      },
    }

    PluginHost.register(plugin, 'test-plugin')

    expect(activatedWith).toBe(PluginHost)
    expect(passedContext?.name).toBe('test-plugin')
    expect(Array.isArray(passedContext?.subscriptions)).toBe(true)
    expect(PluginHost.registeredCount).toBe(1)
  })

  it('is idempotent — registering twice under the same name is a no-op', () => {
    let activations = 0
    const plugin: PluginModule = {
      activate: () => {
        activations += 1
      },
    }
    PluginHost.register(plugin, 'dup')
    PluginHost.register(plugin, 'dup')
    expect(activations).toBe(1)
    expect(PluginHost.registeredCount).toBe(1)
  })
})

describe('PluginHost.deactivate', () => {
  it('disposes subscriptions in LIFO order', async () => {
    const order: string[] = []
    const plugin: PluginModule = {
      activate: (_host, context) => {
        context!.subscriptions.push({ dispose: () => void order.push('first') })
        context!.subscriptions.push({ dispose: () => void order.push('second') })
        context!.subscriptions.push({ dispose: () => void order.push('third') })
      },
    }
    PluginHost.register(plugin, 'lifo')
    await PluginHost.deactivate('lifo')
    expect(order).toEqual(['third', 'second', 'first'])
  })

  it('calls the plugin deactivate() hook AFTER subscriptions dispose', async () => {
    const order: string[] = []
    const plugin: PluginModule = {
      activate: (_host, context) => {
        context!.subscriptions.push({
          dispose: () => void order.push('subscription'),
        })
      },
      deactivate: () => {
        order.push('module-deactivate')
      },
    }
    PluginHost.register(plugin, 'with-deactivate')
    await PluginHost.deactivate('with-deactivate')
    expect(order).toEqual(['subscription', 'module-deactivate'])
  })

  it('is safe to call on an unknown name', async () => {
    await expect(PluginHost.deactivate('never-registered')).resolves.toBeUndefined()
  })

  it('re-registering after deactivate works without duplicate-id throw', async () => {
    const plugin: PluginModule = {
      activate: (host, context) => {
        host.registerOperation(
          { id: 'reactivate.op', label: 'R', entityTypes: ['audio_clip'] },
          context,
        )
      },
    }
    PluginHost.register(plugin, 'reactivate')
    expect(PluginHost.getOperation('reactivate.op')).toBeDefined()

    await PluginHost.deactivate('reactivate')
    expect(PluginHost.getOperation('reactivate.op')).toBeUndefined()

    // Re-register cleanly.
    PluginHost.register(plugin, 'reactivate')
    expect(PluginHost.getOperation('reactivate.op')).toBeDefined()
  })
})

describe('PluginHost.registerOperation disposable', () => {
  it('returns a Disposable that removes the operation', async () => {
    const d = PluginHost.registerOperation({
      id: 'disposable.op',
      label: 'D',
      entityTypes: ['audio_clip'],
    })
    expect(PluginHost.getOperation('disposable.op')).toBeDefined()
    await d.dispose()
    expect(PluginHost.getOperation('disposable.op')).toBeUndefined()
  })

  it('auto-pushes to context.subscriptions when context is provided', () => {
    const ctx = { name: 'ctx-test', subscriptions: [] as { dispose(): void }[] }
    PluginHost.registerOperation(
      { id: 'ctx.op', label: 'C', entityTypes: ['audio_clip'] },
      ctx,
    )
    expect(ctx.subscriptions).toHaveLength(1)
  })
})

describe('PluginHost.registerPanel', () => {
  it('round-trips panel registration and dispose', async () => {
    const Component = () => null as React.ReactNode
    const d = PluginHost.registerPanel({
      id: 'audio_isolations',
      title: 'Audio Isolations',
      Component: Component as unknown as React.ComponentType<unknown>,
    })
    expect(PluginHost.getPanel('audio_isolations')?.title).toBe('Audio Isolations')
    expect(PluginHost.listPanels().map((p) => p.id)).toEqual(['audio_isolations'])

    await d.dispose()
    expect(PluginHost.getPanel('audio_isolations')).toBeUndefined()
    expect(PluginHost.listPanels()).toEqual([])
  })

  it('throws on duplicate panel id', () => {
    const Component = () => null as React.ReactNode
    PluginHost.registerPanel({
      id: 'dup_panel',
      title: 'Dup',
      Component: Component as unknown as React.ComponentType<unknown>,
    })
    expect(() =>
      PluginHost.registerPanel({
        id: 'dup_panel',
        title: 'Dup 2',
        Component: Component as unknown as React.ComponentType<unknown>,
      }),
    ).toThrow(/duplicate panel id/)
  })

  it('disappears from listPanels() when the plugin deactivates', async () => {
    const Component = () => null as React.ReactNode
    const plugin: PluginModule = {
      activate: (host, context) => {
        host.registerPanel(
          {
            id: 'plugin_panel',
            title: 'Plugin Panel',
            Component: Component as unknown as React.ComponentType<unknown>,
          },
          context,
        )
      },
    }
    PluginHost.register(plugin, 'panel_plugin')
    expect(PluginHost.listPanels().map((p) => p.id)).toEqual(['plugin_panel'])

    await PluginHost.deactivate('panel_plugin')
    expect(PluginHost.listPanels()).toEqual([])
  })
})

describe('PluginHost.registerContextMenu disposable', () => {
  it('dispose removes just that contribution, leaves sibling entries intact', async () => {
    const d1 = PluginHost.registerContextMenu({
      entityType: 'audio_clip',
      items: [{ operation: 'a.run', label: 'A' }],
    })
    PluginHost.registerContextMenu({
      entityType: 'audio_clip',
      items: [{ operation: 'b.run', label: 'B' }],
    })

    expect(PluginHost.getContextMenuItems('audio_clip').map((i) => i.operation)).toEqual([
      'a.run',
      'b.run',
    ])

    await d1.dispose()
    expect(PluginHost.getContextMenuItems('audio_clip').map((i) => i.operation)).toEqual([
      'b.run',
    ])
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
