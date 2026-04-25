# Task 168: Plugin `contributes.sourceMonitorProvider` Contribution Point

**Milestone**: [M20](../../milestones/milestone-20-source-monitor-panel.md)
**Spec**: `agent/specs/local.source-monitor-panel.md` — R29-R36, R53
**Design Reference**: [Source Monitor Panel](../../design/local.source-monitor-panel.md)
**Estimated Time**: 4 hours
**Dependencies**: task-163 (`useSourceMonitor` exists), task-167 (ContextMenuProvider entry-registration API exists)
**Status**: Not Started

---

## Objective

Add the optional `contributes.sourceMonitorProvider` plugin manifest entry. When a plugin declares it, the core app auto-wires a right-click menu entry on matching entity kinds via the same `ContextMenuProvider` used in task-167. Plugins that don't declare can still call `useSourceMonitor().setSource(...)` imperatively — the contribution point is purely additive (progressive enhancement). Decouples menu wiring from individual panel components; one consistent affordance for all sources.

---

## Files

Modify:
- `src/lib/plugin-host.ts` — extend `PluginManifest` type to include `contributes.sourceMonitorProvider`
- `src/lib/plugin-host.ts` — `register_declared` (or equivalent) reads the new field at activation and wires the menu entry

Create:
- `src/lib/__tests__/plugin-host-source-monitor-provider.test.ts`

---

## Steps

### 1. Schema extension

In `plugin.yaml` schema (and the corresponding TS type):

```yaml
contributes:
  sourceMonitorProvider:
    entityTypes: [pool_segment, audio_clip, transition]   # required: list of entity kinds
    label: "Preview track"                                  # optional; default "Preview in source monitor"
    resolver: "frontend:my_plugin.resolveSource"            # optional; if omitted, default resolver looks up
                                                            # pool_segment by id and emits {kind, path, label, poolSegmentId}
```

TS type:

```ts
type SourceMonitorProviderContribution = {
  entityTypes: string[]
  label?: string
  resolver?: string  // fully-qualified frontend hook reference; resolves entity → SourceMonitorSource
}
```

### 2. Default resolver

When a plugin declares `sourceMonitorProvider` without a custom `resolver`, use the default:

```ts
async function defaultResolver(entityKind: string, entity: any): Promise<SourceMonitorSource | null> {
  if (entityKind === 'pool_segment') {
    const kind = inferKind(entity.pool_path)  // same helper as task-165
    if (!kind) return null
    return {
      kind,
      path: entity.pool_path,
      label: entity.label || basename(entity.pool_path),
      poolSegmentId: entity.id,
    }
  }
  if (entityKind === 'transition') {
    // Reuse task-167's openTransitionSource resolver path
    return resolveTransitionSource(entity)
  }
  if (entityKind === 'audio_clip') {
    // Resolve via clip.selected → pool_segments
    return resolveAudioClipSource(entity)
  }
  return null
}
```

### 3. Wiring at plugin activation

Inside `PluginHost.register_declared` (or wherever the plugin's `activate` runs):

```ts
const contrib = manifest.contributes?.sourceMonitorProvider
if (contrib) {
  for (const entityKind of contrib.entityTypes) {
    const dispose = contextMenu.registerEntry(entityKind, {
      id: `${plugin.id}.preview-in-source-monitor`,
      label: contrib.label || 'Preview in source monitor',
      enabled: () => true,
      onSelect: async (entity) => {
        const resolver = contrib.resolver
          ? resolveModuleExport(contrib.resolver)
          : defaultResolver
        const source = await resolver(entityKind, entity)
        if (source) sourceMonitor.setSource(source)
      },
    })
    plugin.context.subscriptions.push(dispose)
  }
}
```

This means a plugin gets right-click "Preview in source monitor" on all its declared entity kinds for free — no per-plugin menu wiring needed.

### 4. Imperative path is unchanged

Plugins that DON'T declare the contribution point still call `useSourceMonitor().setSource(...)` from their own UI (R35). The contribution point is additive — never required.

### 5. Documentation

Add a docstring at the top of `plugin-host.ts` showing the manifest snippet and brief explanation:

```ts
/**
 * sourceMonitorProvider contribution
 * ----------------------------------
 * Plugins MAY declare a sourceMonitorProvider in plugin.yaml to get
 * auto-wired right-click "Preview in source monitor" menu entries
 * on the listed entity kinds. Example:
 *
 *   contributes:
 *     sourceMonitorProvider:
 *       entityTypes: [pool_segment]
 *       label: "Preview foley clip"
 *
 * Plugins without this declaration can still call
 * useSourceMonitor().setSource(...) imperatively from their own UI.
 * The declaration is purely additive — progressive enhancement.
 */
```

### 6. Tests

`plugin-host-source-monitor-provider.test.ts`:

- `plugin with contributes.sourceMonitorProvider gets registered menu entry`:
  - Create a fake plugin manifest with `contributes.sourceMonitorProvider: { entityTypes: ['pool_segment'], label: 'Preview foo' }`
  - Activate via `PluginHost.register_declared`
  - Assert the ContextMenuProvider has an entry for `'pool_segment'` with label `'Preview foo'`
  - Trigger the entry's `onSelect` with a fake pool_segment → assert `setSource` called with the resolved source
- `plugin without sourceMonitorProvider has no auto-wired entry`:
  - Activate a plugin without the field
  - Assert no menu entries were registered for that plugin
- `imperative setSource still works after activation` (R32, R36):
  - Plugin's own UI calls `useSourceMonitor().setSource(...)` → source loads, no errors

---

## Verification

- [ ] Plugin manifest can declare `contributes.sourceMonitorProvider` and pass schema validation
- [ ] Activating such a plugin registers a context menu entry for each `entityTypes` member
- [ ] Right-clicking the matching entity shows the menu entry; clicking it loads the source
- [ ] Plugins without the declaration are unaffected (imperative `setSource` still works)
- [ ] Disposing the plugin (HMR or deactivate) removes the menu entry
- [ ] All tests pass
- [ ] `npx tsc --noEmit` clean
- [ ] Doc comment in `plugin-host.ts` includes the example snippet
