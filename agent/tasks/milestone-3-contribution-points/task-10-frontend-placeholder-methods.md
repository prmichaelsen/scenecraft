# Task 10: Frontend Placeholder Methods

**Milestone**: M3 - Contribution Points  
**Design Reference**: [Contribution Points](../../design/local.contribution-points.md)  
**Estimated Time**: 3-4 hours  
**Dependencies**: Task 9 (backend placeholders — need GET /api/plugins endpoint)  
**Status**: Not Started  

---

## Objective

Create a `plugin-api.ts` module with placeholder types and functions for the frontend extension surface, and wire them into the editor UI so plugin effects, blend modes, panels, and commands have clear insertion points.

---

## Context

The editor UI has hardcoded dropdown options for effects, blend modes, and generator backends. This task defines the frontend plugin API types and placeholder functions so the UI can be extended by plugins without modifying core components.

---

## Steps

### 1. Create `src/lib/plugin-api.ts`

```typescript
export type PluginEffectParam = {
  name: string; type: 'number' | 'string' | 'boolean'; default: number | string | boolean
  min?: number; max?: number
}

export type PluginEffectDefinition = {
  id: string; label: string; category: string; params: PluginEffectParam[]
}

export type PluginBlendMode = {
  id: string; label: string
}

export type PluginGenerator = {
  id: string; label: string; type: 'image' | 'video'
}

export type PluginPanel = {
  id: string; label: string; icon: string; position: 'left' | 'right'
}

export type PluginCommand = {
  id: string; label: string; keybinding?: string
}

export type PluginManifest = {
  name: string; version: string; description: string
  beatlab: { minVersion: string }
  activationEvents: string[]
  contributes: {
    effects?: PluginEffectDefinition[]
    blendModes?: PluginBlendMode[]
    generators?: PluginGenerator[]
    panels?: PluginPanel[]
    commands?: PluginCommand[]
  }
}

// Placeholder functions — return defaults until plugin runtime is built
export function getPluginEffects(): PluginEffectDefinition[] { return [] }
export function getPluginBlendModes(): PluginBlendMode[] { return [] }
export function getPluginGenerators(): PluginGenerator[] { return [] }
export function getPluginPanels(): PluginPanel[] { return [] }
export function getPluginCommands(): PluginCommand[] { return [] }

export function applyPluginEffect(effectId: string, uniforms: Record<string, number>): Record<string, number> {
  return uniforms  // no-op
}

export function executePluginCommand(commandId: string, context: unknown): void {
  console.warn(`Plugin command '${commandId}' not available`)
}
```

### 2. Wire into Effects dropdown

**`src/components/editor/TransitionPanel.tsx`**:
- Import `getPluginEffects` from plugin-api
- In the effects type dropdown, append plugin effects after built-in types
- Plugin effects render with a "plugin" badge or different color

### 3. Wire into Blend Mode dropdown

Where blend mode is selectable:
- Import `getPluginBlendModes` from plugin-api
- Append plugin blend modes after built-in modes

### 4. Wire into Settings panel

Add a "Plugins" section to the settings panel:
- Fetch discovered plugins from `GET /api/plugins`
- Display plugin name, version, description
- Show "No plugins installed" when empty

### 5. Fetch plugin metadata from backend

- On editor load, fetch `GET /api/plugins` 
- Store in editor data context so all components can access plugin definitions
- Pass to dropdowns that need to show plugin options

---

## Verification

- [ ] `plugin-api.ts` module exists with all types and placeholder functions
- [ ] Effects dropdown includes placeholder for plugin effects (empty for now)
- [ ] Blend mode dropdown includes placeholder for plugin blend modes (empty for now)
- [ ] Settings panel shows "Plugins" section with "No plugins installed"
- [ ] All existing functionality unchanged
- [ ] TypeScript compiles without errors

---

## Notes

- No plugin code is loaded or executed on the frontend — these are type definitions and no-op functions
- The `GET /api/plugins` endpoint is created in Task 9
- Plugin panels (React components) are Phase 3 — this task only defines the types

---

**Next Task**: [task-11-package-yaml-schema](task-11-package-yaml-schema.md)  
**Related Design Docs**: [local.contribution-points](../../design/local.contribution-points.md)  
