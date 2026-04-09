const BEATLAB_API_URL = import.meta.env.VITE_BEATLAB_API_URL || 'http://localhost:8888'

// --- File URL helper (used client-side in img/audio/video src) ---

export function beatlabFileUrl(project: string, path: string): string {
  return `${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/files/${path}`
}

export function beatlabThumbUrl(project: string, path: string): string {
  return `${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/thumb/${path}`
}

export function beatlabThumbnailUrl(project: string, path: string): string {
  return `${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/thumbnail/${path}`
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

export async function postAddKeyframe(project: string, timestamp: string, section: string, prompt: string, trackId?: string) {
  console.log(`[beatlab-client] add-keyframe: ${project} at ${timestamp} track=${trackId}`)
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/add-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, section, prompt, source: 'assets/stills/default.png', ...(trackId ? { trackId } : {}) }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`[beatlab-client] add-keyframe failed: ${res.status} ${text}`)
    throw new Error(`Failed to add keyframe: ${res.status} ${text}`)
  }
  const result = await res.json()
  console.log('[beatlab-client] add-keyframe result:', result)
  return result
}

export async function postDuplicateKeyframe(project: string, keyframeId: string, timestamp: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/duplicate-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, timestamp }),
  })
  if (!res.ok) throw new Error(`Failed to duplicate keyframe: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ success: boolean; keyframe: { id: string; timestamp: string } }>
}

export async function postBatchDeleteKeyframes(project: string, keyframeIds: string[]) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/batch-delete-keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeIds }),
  })
  if (!res.ok) throw new Error(`Failed to batch delete keyframes: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ success: boolean; deleted: string[] }>
}

export async function postDeleteKeyframe(project: string, keyframeId: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/delete-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId }),
  })
  if (!res.ok) throw new Error(`Failed to delete keyframe: ${res.status} ${await res.text()}`)
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

export type AudioEvent = {
  time: number
  duration: number
  effect: string
  intensity: number
  sustain: number
  stem_source: string
  rationale?: string
  isLayered?: boolean
}

export type AudioSection = {
  start_time: number
  end_time: number
  description: string
}

export type AudioRule = {
  stem: string
  band: string
  min_strength: number
  max_strength: number
  effect: string
  intensity_scale: number
  duration: number
  sustain_from_rms: boolean
  layer_with: string[]
  layer_threshold: number
  rationale: string
  _start?: number
  _end?: number
  _group_name?: string
  _group_start?: number
  _group_end?: number
}

export async function fetchAudioIntelligence(project: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/audio-intelligence`)
  if (!res.ok) throw new Error(`Failed to fetch audio intelligence: ${res.status}`)
  return res.json() as Promise<{
    activeFile: string | null
    availableFiles?: string[]
    events: AudioEvent[]
    sections: AudioSection[]
    rules: AudioRule[]
    ruleCount: number
    onsets?: Record<string, Record<string, { time: number; strength: number }[]>>
  }>
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
}

export async function fetchBin(project: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/bin`)
  if (!res.ok) throw new Error(`Failed to fetch bin: ${res.status}`)
  return res.json() as Promise<{ bin: BinEntry[]; transitionBin: TransitionBinEntry[] }>
}

export type PoolEntry = {
  name: string
  path: string
  size: number
  tags?: string[]
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'difference' | 'add' | 'soft-light' | 'chroma-key'

export type ChromaKeyConfig = { color: [number, number, number]; threshold: number; feather: number }

export type Track = {
  id: string
  name: string
  zOrder: number
  blendMode: BlendMode
  baseOpacity: number
  enabled: boolean
  opacityKeyframes: { id: string; time: number; opacity: number }[]
  chromaKey?: ChromaKeyConfig
  hidden?: boolean
}

export async function fetchTracks(project: string): Promise<Track[]> {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/tracks`)
  if (!res.ok) return [{ id: 'track_1', name: 'Track 1', zOrder: 0, blendMode: 'normal', baseOpacity: 1.0, enabled: true, opacityKeyframes: [] }]
  const data = await res.json() as { tracks: Track[] }
  return data.tracks.map((t) => ({ ...t, opacityKeyframes: t.opacityKeyframes || [] }))
}

export async function postAddTrack(project: string, name?: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/tracks/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return res.json() as Promise<{ success: boolean; id: string }>
}

export async function postUpdateTrack(project: string, id: string, updates: Partial<Pick<Track, 'name' | 'blendMode' | 'baseOpacity' | 'enabled'>>) {
  await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/tracks/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...updates }),
  })
}

export async function postDeleteTrack(project: string, id: string) {
  await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/tracks/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}

export async function postReorderTracks(project: string, trackIds: string[]) {
  await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/tracks/reorder`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackIds }),
  })
}

export type UnselectedCandidate = { keyframeId: string; variant: number; path: string }

export async function fetchUnselectedCandidates(project: string): Promise<UnselectedCandidate[]> {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/unselected-candidates`)
  if (!res.ok) return []
  const data = await res.json() as { candidates: UnselectedCandidate[] }
  return data.candidates
}

export async function postGenerateKeyframeVariations(project: string, keyframeId: string, count?: number) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/generate-keyframe-variations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, count: count || 4 }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ jobId: string; keyframeId: string }>
}

export async function postEscalateKeyframe(project: string, keyframeId: string, count?: number) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/escalate-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, count: count || 2 }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ jobId: string; keyframeId: string }>
}

export async function postUpdateKeyframeLabel(project: string, keyframeId: string, label: string, labelColor: string) {
  await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-keyframe-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, label, labelColor }),
  })
}

export async function postUpdateTransitionLabel(project: string, transitionId: string, label: string, labelColor: string, tags?: string[]) {
  await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-transition-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, label, labelColor, ...(tags ? { tags } : {}) }),
  })
}

export async function postUpdateKeyframeStyle(project: string, keyframeId: string, style: { blendMode?: string; opacity?: number | null }) {
  await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-keyframe-style`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, ...style }),
  })
}

export async function postUpdateTransitionStyle(project: string, transitionId: string, style: { blendMode?: string; opacity?: number | null; opacityCurve?: [number, number][] | null; redCurve?: [number, number][] | null; greenCurve?: [number, number][] | null; blueCurve?: [number, number][] | null; blackCurve?: [number, number][] | null; hueShiftCurve?: [number, number][] | null; saturationCurve?: [number, number][] | null; invertCurve?: [number, number][] | null; isAdjustment?: boolean; chromaKey?: { color: [number, number, number]; threshold: number; feather: number } | null; maskCenterX?: number | null; maskCenterY?: number | null; maskRadius?: number | null; maskFeather?: number | null; transformX?: number | null; transformY?: number | null; hidden?: boolean }) {
  await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-transition-style`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, ...style }),
  })
}

export async function postCopyTransitionStyle(project: string, sourceId: string, targetId: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/copy-transition-style`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, targetId }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
}

export async function postDuplicateTransitionVideo(project: string, sourceId: string, targetId: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/duplicate-transition-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, targetId }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
}

export async function postPasteGroup(project: string, keyframeIds: string[], targetTime: string, targetTrackId: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/paste-group`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeIds, targetTime, targetTrackId }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
}

export async function postUndo(project: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  return res.json() as Promise<{ success: boolean; description?: string; message?: string }>
}

export async function postUnlinkKeyframe(project: string, keyframeId: string, side: 'both' | 'left' | 'right' = 'both') {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/unlink-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, side }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
}

export async function postAssignKeyframeImage(project: string, keyframeId: string, sourcePath: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/assign-keyframe-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, sourcePath }),
  })
  if (!res.ok) throw new Error(`Failed to assign keyframe image: ${res.status}`)
  return res.json()
}

export async function postReapplyRules(project: string, rules?: AudioRule[], sectionStart?: number, sectionEnd?: number): Promise<{ success: boolean; eventCount: number }> {
  const body: Record<string, unknown> = {}
  if (rules) body.rules = rules
  if (sectionStart != null && sectionEnd != null) { body.sectionStart = sectionStart; body.sectionEnd = sectionEnd }
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/reapply-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Failed to reapply rules: ${res.status}`)
  return res.json()
}

export async function postUpdateRules(project: string, rules: AudioRule[]) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  })
  if (!res.ok) throw new Error(`Failed to update rules: ${res.status}`)
  return res.json()
}

export async function fetchMarkers(project: string): Promise<{ id: string; time: number; label: string }[]> {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/markers`)
  if (!res.ok) return []
  const data = await res.json() as { markers: { id: string; time: number; label: string }[] }
  return data.markers
}

export async function postAddMarker(project: string, id: string, time: number, label: string = '') {
  await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/markers/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, time, label }),
  })
}

export async function postUpdateMarker(project: string, id: string, label: string) {
  await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/markers/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, label }),
  })
}

export async function postRemoveMarker(project: string, id: string) {
  await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/markers/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}

export async function fetchStagingCandidates(project: string, stagingId: string): Promise<string[]> {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/staging/${encodeURIComponent(stagingId)}`)
  if (!res.ok) return []
  const data = await res.json() as { candidates: string[] }
  return data.candidates
}

export async function fetchPool(project: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/pool`)
  if (!res.ok) throw new Error(`Failed to fetch pool: ${res.status}`)
  return res.json() as Promise<{ keyframes: PoolEntry[]; segments: PoolEntry[] }>
}

export async function postUpdatePoolTags(project: string, poolPath: string, tags: string[]) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-pool-tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poolPath, tags }),
  })
  if (!res.ok) throw new Error(`Failed to update pool tags: ${res.status}`)
  return res.json()
}

export async function postGenerateKeyframeCandidates(project: string, keyframeId: string, count?: number, refinementPrompt?: string, freeform?: boolean) {
  console.log('[beatlab-client] generating keyframe candidates:', project, keyframeId, count, refinementPrompt ? `refine: ${refinementPrompt.slice(0, 50)}` : '', freeform ? 'freeform' : '')
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/generate-keyframe-candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, count, ...(refinementPrompt ? { refinementPrompt } : {}), ...(freeform ? { freeform: true } : {}) }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error('[beatlab-client] generate-keyframe-candidates failed:', res.status, text)
    throw new Error(`Failed to generate keyframe candidates: ${res.status} ${text}`)
  }
  return res.json() as Promise<{ jobId: string; keyframeId: string; candidates?: string[] }>
}

export async function postGenerateTransitionAction(project: string, transitionId: string, sectionContext?: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/generate-transition-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, ...(sectionContext && { sectionContext }) }),
  })
  return res.json() as Promise<{ success: boolean; action: string; slotActions?: string[] }>
}

export async function postEnhanceTransitionAction(project: string, transitionId: string, action: string, sectionContext?: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/enhance-transition-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, action, ...(sectionContext && { sectionContext }) }),
  })
  return res.json() as Promise<{ success: boolean; action: string }>
}

export async function postUpdateTransitionRemap(project: string, transitionId: string, targetDuration: number, method?: string, curvePoints?: [number, number, number?][]) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-transition-remap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, targetDuration, method, ...(curvePoints && { curvePoints }) }),
  })
  return res.json()
}

export async function postUpdateTransitionAction(project: string, transitionId: string, action: string, useGlobalPrompt: boolean, slotActions?: string[], includeSectionDesc?: boolean) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/update-transition-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, action, useGlobalPrompt, ...(slotActions && { slotActions }), ...(includeSectionDesc !== undefined && { includeSectionDesc }) }),
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

export async function postGenerateTransitionCandidates(project: string, transitionId: string, count?: number, slotIndex?: number, duration?: number) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/generate-transition-candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, count, ...(slotIndex != null && { slotIndex }), ...(duration != null && { duration }) }),
  })
  return res.json() as Promise<{ jobId: string; transitionId: string; candidates?: Record<string, string[]> }>
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

export type EffectType = 'pulse' | 'zoom' | 'shake' | 'glow' | 'flash' | 'echo'

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
  effectTypes?: EffectType[]       // primary effects to suppress (undefined = all)
  layerEffectTypes?: EffectType[]  // layered effects to suppress (undefined/empty = none)
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

export async function fetchWatchedFolders(project: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/watched-folders`)
  if (!res.ok) throw new Error(`Failed to fetch watched folders: ${res.status}`)
  return res.json() as Promise<{ watchedFolders: string[] }>
}

export async function postWatchFolder(project: string, folderPath: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/watch-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath }),
  })
  return res.json() as Promise<{ success: boolean; watching: string; existingFiles: number }>
}

export async function postUnwatchFolder(project: string, folderPath: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/unwatch-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath }),
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
  if (!res.ok) throw new Error(`Failed to select transitions: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postSetBaseImage(project: string, keyframeId: string, stillName: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/set-base-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, stillName }),
  })
  if (!res.ok) throw new Error(`Failed to set base image: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ success: boolean; keyframeId: string; still: string }>
}

export async function postAssignPoolVideo(project: string, transitionId: string, poolPath: string) {
  console.log(`[beatlab-client] assigning pool video: ${transitionId} <- ${poolPath}`)
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/assign-pool-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, poolPath }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`[beatlab-client] assign-pool-video failed: ${res.status} ${text}`)
    throw new Error(`Failed to assign pool video: ${res.status} ${text}`)
  }
  return res.json()
}

export async function postSplitTransition(project: string, transitionId: string, splitTime: number) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/split-transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, splitTime }),
  })
  if (!res.ok) throw new Error(`Failed to split transition: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ success: boolean; keyframeId: string; transition1: string; transition2: string }>
}

export type BenchItem = {
  id: string
  type: 'keyframe' | 'transition'
  sourcePath: string
  label: string
  addedAt: string
  usageCount: number
  usages: { entityId: string; timestamp: string }[]
}

export async function fetchBench(project: string): Promise<BenchItem[]> {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/bench`)
  if (!res.ok) return []
  const data = await res.json()
  return data.items || []
}

export async function postAddToBench(project: string, type: 'keyframe' | 'transition', entityId?: string, sourcePath?: string, label?: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/bench/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, entityId, sourcePath, label }),
  })
  if (!res.ok) throw new Error(`Failed to add to bench: ${res.status}`)
  return res.json() as Promise<{ success: boolean; benchId: string }>
}

export async function postRemoveFromBench(project: string, benchId: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/bench/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ benchId }),
  })
  if (!res.ok) throw new Error(`Failed to remove from bench: ${res.status}`)
  return res.json()
}

// ── Transition effects ──

export async function postAddTransitionEffect(project: string, transitionId: string, type: string, params: Record<string, number> = {}) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/transition-effects/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, type, params }),
  })
  if (!res.ok) throw new Error(`Failed to add effect: ${res.status}`)
  return res.json() as Promise<{ success: boolean; id: string }>
}

export async function postUpdateTransitionEffect(project: string, id: string, updates: { params?: Record<string, number>; enabled?: boolean }) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/transition-effects/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...updates }),
  })
  if (!res.ok) throw new Error(`Failed to update effect: ${res.status}`)
  return res.json()
}

export async function postDeleteTransitionEffect(project: string, id: string) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/transition-effects/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) throw new Error(`Failed to delete effect: ${res.status}`)
  return res.json()
}

export async function postInsertPoolItem(project: string, type: 'keyframe' | 'segment', poolPath: string, atTime: number) {
  console.log(`[beatlab-client] inserting pool item: ${type} ${poolPath} at ${atTime}s`)
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/insert-pool-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, poolPath, atTime }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`[beatlab-client] insert-pool-item failed: ${res.status} ${text}`)
    throw new Error(`Failed to insert pool item: ${res.status} ${text}`)
  }
  const result = await res.json()
  console.log('[beatlab-client] insert-pool-item result:', result)
  return result
}

export type AudioDescription = {
  sectionIndex: number
  label: string
  startTime: number
  endTime: number
  content: string
}

export async function fetchDescriptions(project: string): Promise<AudioDescription[]> {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/descriptions`)
  if (!res.ok) return []
  const data = await res.json()
  return data.sections || []
}

export async function postSelectKeyframes(project: string, selections: Record<string, number>) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/select-keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selections }),
  })
  return res.json()
}

export type KeyframePromptSuggestion = {
  eventIndex: number
  prompt: string
}

export async function postEnhanceKeyframePrompt(
  project: string,
  payload: {
    prompt: string
    sectionContent: string
    event: { time: number; effect: string; intensity: number; stem_source: string; rationale?: string }
  }
): Promise<{ success: boolean; prompt: string }> {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/enhance-keyframe-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Failed to enhance prompt: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postSuggestKeyframePrompts(
  project: string,
  payload: {
    sectionLabel: string
    sectionContent: string
    events: Array<{ time: number; effect: string; intensity: number; stem_source: string }>
    baseStillName: string
  }
): Promise<{ suggestions: KeyframePromptSuggestion[] }> {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/suggest-keyframe-prompts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Failed to suggest prompts: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postPromoteStagedCandidate(project: string, keyframeId: string, stagingId: string, variant: number) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/promote-staged-candidate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, stagingId, variant }),
  })
  if (!res.ok) throw new Error(`Failed to promote staged candidate: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postGenerateStagedCandidate(project: string, prompt: string, stillName: string, stagingId: string, count: number = 1) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/generate-staged-candidate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, stillName, stagingId, count }),
  })
  if (!res.ok) throw new Error(`Failed to generate staged candidate: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ jobId: string; stagingId: string }>
}

export async function fetchSectionSettings(project: string, sectionLabel: string): Promise<{ still: string | null; suggestions: KeyframePromptSuggestion[] | null }> {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/section-settings?section=${encodeURIComponent(sectionLabel)}`)
  if (!res.ok) return { still: null, suggestions: null }
  return res.json()
}

export async function postSectionSettings(project: string, sectionLabel: string, settings: { still?: string; suggestions?: KeyframePromptSuggestion[] }) {
  const res = await fetch(`${BEATLAB_API_URL}/api/projects/${encodeURIComponent(project)}/section-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sectionLabel, ...settings }),
  })
  if (!res.ok) throw new Error(`Failed to save section settings: ${res.status}`)
  return res.json()
}
