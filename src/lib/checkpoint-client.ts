const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

export type Checkpoint = {
  filename: string
  name: string
  created: string
  size_bytes: number
}

export async function fetchCheckpoints(project: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/checkpoints`)
  if (!res.ok) throw new Error(`Failed to fetch checkpoints: ${res.status}`)
  return res.json() as Promise<{ checkpoints: Checkpoint[]; active: string }>
}

export async function createCheckpoint(project: string, name?: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/checkpoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || undefined }),
  })
  if (!res.ok) throw new Error(`Failed to create checkpoint: ${res.status}`)
  return res.json() as Promise<{ success: boolean; filename: string }>
}

export async function restoreCheckpoint(project: string, filename: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/checkpoint/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  })
  if (!res.ok) throw new Error(`Failed to restore checkpoint: ${res.status}`)
  return res.json() as Promise<{ success: boolean; message?: string }>
}

export async function deleteCheckpoint(project: string, filename: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/checkpoint/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  })
  if (!res.ok) throw new Error(`Failed to delete checkpoint: ${res.status}`)
  return res.json() as Promise<{ success: boolean }>
}
