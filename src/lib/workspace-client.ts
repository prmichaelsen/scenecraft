const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8888'

export async function fetchWorkspaceViews(project: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/workspace-views`)
  if (!res.ok) return {}
  const { views } = await res.json()
  return views || {}
}

export async function fetchWorkspaceView(project: string, name: string): Promise<unknown | null> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/workspace-views/${encodeURIComponent(name)}`)
  if (!res.ok) return null
  const { layout } = await res.json()
  return layout
}

export async function saveWorkspaceView(project: string, name: string, layout: unknown): Promise<void> {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/workspace-views/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout }),
  })
}

export async function deleteWorkspaceView(project: string, name: string): Promise<void> {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/workspace-views/${encodeURIComponent(name)}/delete`, {
    method: 'POST',
  })
}
