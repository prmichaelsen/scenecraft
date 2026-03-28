const BEATLAB_API_URL = import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'

export type NarrativeSection = {
  id: string
  label: string
  start: string
  end?: string
  mood: string
  energy: string
  instruments: string[]
  motifs: string[]
  events: string[]
  visual_direction: string
  notes: string
}

export type TimelineInfo = {
  active: string
  timelines: string[]
}

export async function fetchNarrative(project: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/narrative`)
  if (!res.ok) throw new Error(`Failed to fetch narrative: ${res.status}`)
  return res.json() as Promise<{ sections: NarrativeSection[] }>
}

export async function postUpdateNarrative(project: string, sections: NarrativeSection[]) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/narrative`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sections }),
  })
  return res.json()
}

export async function fetchTimelines(project: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/timelines`)
  if (!res.ok) throw new Error(`Failed to fetch timelines: ${res.status}`)
  return res.json() as Promise<TimelineInfo>
}

export async function postSwitchTimeline(project: string, name: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/timeline/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return res.json() as Promise<{ success: boolean; active: string }>
}

export async function postCreateTimeline(project: string, name: string, copyFrom?: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/timeline/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, copyFrom }),
  })
  return res.json() as Promise<{ success: boolean }>
}

export async function postImportTimeline(project: string, sourcePath: string, timelineName?: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/timeline/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourcePath, timelineName }),
  })
  return res.json() as Promise<{ success: boolean; keyframes?: number; transitions?: number }>
}
