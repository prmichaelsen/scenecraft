const BEATLAB_API_URL = import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'

export type Commit = {
  sha: string
  message: string
  date: string
}

export type VersionHistory = {
  commits: Commit[]
  branch: string
  branches: string[]
}

export type DiffFile = {
  path: string
  status: string
  binary?: boolean
}

export type DiffResult = {
  files: DiffFile[]
  hasChanges: boolean
}

export async function fetchVersionHistory(project: string, limit: number = 20) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/version/history?limit=${limit}`)
  if (!res.ok) throw new Error(`Failed to fetch version history: ${res.status}`)
  return res.json() as Promise<VersionHistory>
}

export async function fetchVersionDiff(project: string, from?: string, to?: string) {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const qs = params.toString()
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/version/diff${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`)
  return res.json() as Promise<DiffResult>
}

export async function postVersionCommit(project: string, message: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/version/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  return res.json() as Promise<{ success: boolean; sha?: string; message?: string; noChanges?: boolean }>
}

export async function postVersionCheckout(project: string, sha: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/version/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha }),
  })
  return res.json() as Promise<{ success: boolean; sha?: string; message?: string }>
}

export async function postVersionBranch(project: string, name: string, create: boolean = false) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/version/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, create }),
  })
  return res.json() as Promise<{ success: boolean; branch?: string }>
}

export async function postVersionDeleteBranch(project: string, name: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/version/delete-branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return res.json() as Promise<{ success: boolean }>
}
