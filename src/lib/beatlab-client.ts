const BEATLAB_API_URL = import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'

// --- File URL helper (used client-side in img/audio/video src) ---

export function beatlabFileUrl(project: string, path: string): string {
  return `${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/files/${path}`
}

// --- Server-side API functions ---

export async function fetchProjects() {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects`)
  if (!res.ok) throw new Error(`Failed to fetch projects: ${res.status}`)
  return res.json() as Promise<Array<{
    name: string
    hasAudio: boolean
    hasVideo: boolean
    hasYaml: boolean
    hasBeats: boolean
    fileCount: number
    modified: number
  }>>
}

export async function fetchKeyframes(project: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/keyframes`)
  if (!res.ok) throw new Error(`Failed to fetch keyframes: ${res.status}`)
  return res.json()
}

export async function fetchBeats(project: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/beats`)
  if (!res.ok) throw new Error(`Failed to fetch beats: ${res.status}`)
  return res.json()
}

export async function postUpdateTimestamp(project: string, keyframeId: string, newTimestamp: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-timestamp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, newTimestamp }),
  })
  return res.json()
}

export async function postAddKeyframe(project: string, timestamp: string, section: string, prompt: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/add-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, section, prompt, source: 'assets/stills/default.png' }),
  })
  return res.json()
}

export async function postDeleteKeyframe(project: string, keyframeId: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/delete-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId }),
  })
  return res.json()
}

export async function postRestoreKeyframe(project: string, keyframeId: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/restore-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId }),
  })
  return res.json()
}

export async function postUpdatePrompt(project: string, keyframeId: string, prompt: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, prompt }),
  })
  return res.json()
}

export type FileEntry = {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

export type BrowseEntry = {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  type?: 'image' | 'video' | 'other'
}

export async function fetchBrowse(subpath: string = '') {
  const params = subpath ? `?path=${encodeURIComponent(subpath)}` : ''
  const res = await fetch(`${BEATLAB_API_URL}/api/browse${params}`)
  if (!res.ok) throw new Error(`Failed to browse: ${res.status}`)
  return res.json() as Promise<{ path: string; entries: BrowseEntry[] }>
}

export async function fetchDirectoryListing(project: string, subpath: string = '') {
  const params = subpath ? `?path=${encodeURIComponent(subpath)}` : ''
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/ls${params}`)
  if (!res.ok) throw new Error(`Failed to list directory: ${res.status}`)
  return res.json() as Promise<FileEntry[]>
}

export type BinEntry = {
  id: string
  deleted_at: string
  timestamp: string
  section: string
  prompt: string
  hasSelectedImage: boolean
}

export type TransitionBinEntry = {
  id: string
  deleted_at: string
  from: string
  to: string
  durationSeconds: number
  slots: number
}

export async function fetchBin(project: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/bin`)
  if (!res.ok) throw new Error(`Failed to fetch bin: ${res.status}`)
  return res.json() as Promise<{ bin: BinEntry[]; transitionBin: TransitionBinEntry[] }>
}

export async function postGenerateKeyframeCandidates(project: string, keyframeId: string, count?: number) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/generate-keyframe-candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, count }),
  })
  return res.json() as Promise<{ success: boolean; keyframeId: string; candidates: string[] }>
}

export async function postGenerateTransitionAction(project: string, transitionId: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/generate-transition-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId }),
  })
  return res.json() as Promise<{ success: boolean; action: string }>
}

export async function postUpdateTransitionAction(project: string, transitionId: string, action: string, useGlobalPrompt: boolean) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-transition-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, action, useGlobalPrompt }),
  })
  return res.json()
}

export async function postUpdateMeta(project: string, fields: Record<string, string>) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  return res.json()
}

export async function postGenerateTransitionCandidates(project: string, transitionId: string, count?: number) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/generate-transition-candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, count }),
  })
  return res.json() as Promise<{ success: boolean; transitionId: string; candidates: Record<string, string[]> }>
}

export async function postDeleteTransition(project: string, transitionId: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/delete-transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId }),
  })
  return res.json()
}

export async function postRestoreTransition(project: string, transitionId: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/restore-transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId }),
  })
  return res.json()
}

export type EffectType = 'pulse' | 'zoom' | 'shake' | 'glow' | 'flash'

export type UserEffect = {
  id: string
  time: number
  type: EffectType
  intensity: number  // 0-1
  duration: number   // seconds
}

export type BeatSuppression = {
  id: string
  from: number  // start time in seconds
  to: number    // end time in seconds
}

export async function fetchEffects(project: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/effects`)
  if (!res.ok) throw new Error(`Failed to fetch effects: ${res.status}`)
  return res.json() as Promise<{ effects: UserEffect[]; suppressions: BeatSuppression[] }>
}

export async function postUpdateEffects(project: string, effects: UserEffect[], suppressions: BeatSuppression[]) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/effects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ effects, suppressions }),
  })
  return res.json()
}

export async function postImport(project: string, sourcePath: string, timestamp?: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourcePath, timestamp }),
  })
  return res.json() as Promise<{
    success: boolean
    imported: { keyframes: string[]; transitions: string[] }
    summary: string
  }>
}

export async function postSelectTransitions(project: string, selections: Record<string, number>) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/select-transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selections }),
  })
  return res.json()
}

export async function postSelectKeyframes(project: string, selections: Record<string, number>) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/select-keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selections }),
  })
  return res.json()
}
