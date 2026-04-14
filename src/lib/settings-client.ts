const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

export type ProjectSettings = {
  preview_quality: number  // percentage of original resolution (5-100)
  audio_intelligence_file: string | null
  render_preview_fps: number
  available_audio_intelligence_files: string[]
}

export async function fetchSettings(project: string): Promise<ProjectSettings> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/settings`)
  if (!res.ok) throw new Error(`Failed to fetch settings: ${res.status}`)
  return res.json()
}

export async function postUpdateSettings(project: string, fields: Partial<Omit<ProjectSettings, 'available_audio_intelligence_files'>>) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  return res.json()
}
