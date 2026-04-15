// Types for the plugin contribution points system

export type PluginEffectParam = {
  name: string
  type: 'number' | 'string' | 'boolean'
  default: number | string | boolean
  min?: number
  max?: number
}

export type PluginEffectDefinition = {
  id: string
  label: string
  category: string
  params: PluginEffectParam[]
}

export type PluginBlendMode = {
  id: string
  label: string
}

export type PluginGenerator = {
  id: string
  label: string
  type: 'image' | 'video'
}

export type PluginPanel = {
  id: string
  label: string
  icon: string
  position: 'left' | 'right'
}

export type PluginCommand = {
  id: string
  label: string
  keybinding?: string
}

export type PluginManifest = {
  name: string
  version: string
  description: string
  scenecraft: { minVersion: string }
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

// Fetch installed plugins from backend (placeholder — backend endpoint not yet implemented)
export async function fetchPlugins(): Promise<PluginManifest[]> {
  try {
    const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'
    const res = await fetch(`${SCENECRAFT_API_URL}/api/plugins`)
    if (!res.ok) return []
    return res.json()
  } catch {
    return []
  }
}
