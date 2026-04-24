const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

// --- File URL helper (used client-side in img/audio/video src) ---

export function scenecraftFileUrl(project: string, path: string): string {
  return `${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/files/${path}`
}

export function scenecraftThumbUrl(project: string, path: string): string {
  return `${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/thumb/${path}`
}

export function scenecraftThumbnailUrl(project: string, path: string): string {
  return `${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/thumbnail/${path}`
}

// --- Server-side API functions ---

export async function fetchProjects() {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects`)
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

export async function postCreateProject(name: string, opts?: { fps?: number; resolution?: [number, number]; motionPrompt?: string }) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...opts }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `Failed to create project: ${res.status}`)
  }
  return res.json() as Promise<{ success: boolean; name: string }>
}

export async function fetchKeyframes(project: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/keyframes`)
  if (!res.ok) throw new Error(`Failed to fetch keyframes: ${res.status}`)
  return res.json()
}

export async function fetchBeats(project: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/beats`)
  if (!res.ok) throw new Error(`Failed to fetch beats: ${res.status}`)
  return res.json()
}

export async function postUpdateTimestamp(project: string, keyframeId: string, newTimestamp: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-timestamp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, newTimestamp }),
  })
  return res.json()
}

export async function postAddKeyframe(project: string, timestamp: string, section: string, prompt: string, trackId?: string) {
  console.log(`[scenecraft-client] add-keyframe: ${project} at ${timestamp} track=${trackId}`)
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/add-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, section, prompt, source: 'assets/stills/default.png', ...(trackId ? { trackId } : {}) }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`[scenecraft-client] add-keyframe failed: ${res.status} ${text}`)
    throw new Error(`Failed to add keyframe: ${res.status} ${text}`)
  }
  const result = await res.json()
  console.log('[scenecraft-client] add-keyframe result:', result)
  return result
}

export async function postDuplicateKeyframe(project: string, keyframeId: string, timestamp: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/duplicate-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, timestamp }),
  })
  if (!res.ok) throw new Error(`Failed to duplicate keyframe: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ success: boolean; keyframe: { id: string; timestamp: string } }>
}

export async function postBatchDeleteKeyframes(project: string, keyframeIds: string[]) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/batch-delete-keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeIds }),
  })
  if (!res.ok) throw new Error(`Failed to batch delete keyframes: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ success: boolean; deleted: string[] }>
}

export async function postDeleteKeyframe(project: string, keyframeId: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/delete-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId }),
  })
  if (!res.ok) throw new Error(`Failed to delete keyframe: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postRestoreKeyframe(project: string, keyframeId: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/restore-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId }),
  })
  return res.json()
}

export async function postUpdatePrompt(project: string, keyframeId: string, prompt: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-prompt`, {
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
  const res = await fetch(`${SCENECRAFT_API_URL}/api/browse${params}`)
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
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/audio-intelligence`)
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
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/ls${params}`)
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
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/bin`)
  if (!res.ok) throw new Error(`Failed to fetch bin: ${res.status}`)
  return res.json() as Promise<{ bin: BinEntry[]; transitionBin: TransitionBinEntry[] }>
}

export type PoolEntry = {
  // Legacy shape (keyframes still scan filesystem) OR pool_segments row (segments)
  name?: string             // filename on disk (legacy)
  path: string              // "pool/segments/<name>.mp4"
  size?: number             // byte size (legacy)
  tags?: string[]

  // New fields from pool_segments table (segments only)
  id?: string               // pool_segment_id (UUID)
  kind?: 'generated' | 'imported'   // provenance — NOT media type. See mediaType below.
  mediaType?: 'audio' | 'video' | 'image' | 'other'  // derived server-side from extension
  label?: string            // user-editable display name
  originalFilename?: string // preserved for imports; null for generated
  originalFilepath?: string // preserved for imports
  createdBy?: string
  createdAt?: string
  durationSeconds?: number | null
  width?: number | null
  height?: number | null
  byteSize?: number | null
  generationParams?: Record<string, unknown> | null
}

export type PoolImportResponse = {
  success: boolean
  poolSegmentId: string
  poolPath: string
  originalFilename: string
  originalFilepath: string
  durationSeconds: number | null
}

export async function postPoolImport(project: string, sourcePath: string, label?: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/pool/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourcePath, label }),
  })
  if (!res.ok) throw new Error(`Failed to import: ${res.status} ${await res.text()}`)
  return res.json() as Promise<PoolImportResponse>
}

/**
 * Upload a browser File (drag-drop or file picker) into the pool.
 * Creates a pool_segments row with kind='imported'.
 */
export async function postPoolUpload(
  project: string,
  file: File,
  opts?: { label?: string; originalFilepath?: string },
) {
  const fd = new FormData()
  fd.append('file', file, file.name)
  if (opts?.label) fd.append('label', opts.label)
  // The browser can't reveal the full absolute path for privacy reasons, but we
  // keep this plumbing in place so the caller can pass through any client-known
  // source path (e.g., from file-system-access-API handles).
  if (opts?.originalFilepath) fd.append('originalFilepath', opts.originalFilepath)
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/pool/upload`, {
    method: 'POST',
    body: fd,
  })
  if (!res.ok) throw new Error(`Failed to upload: ${res.status} ${await res.text()}`)
  return res.json() as Promise<PoolImportResponse>
}

export async function postPoolRename(project: string, poolSegmentId: string, label: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/pool/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poolSegmentId, label }),
  })
  if (!res.ok) throw new Error(`Failed to rename: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postPoolTag(project: string, poolSegmentId: string, tag: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/pool/tag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poolSegmentId, tag }),
  })
  if (!res.ok) throw new Error(`Failed to tag: ${res.status}`)
  return res.json()
}

export async function postPoolUntag(project: string, poolSegmentId: string, tag: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/pool/untag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poolSegmentId, tag }),
  })
  if (!res.ok) throw new Error(`Failed to untag: ${res.status}`)
  return res.json()
}

export async function fetchPoolTags(project: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/pool/tags`)
  if (!res.ok) return { tags: [] }
  return res.json() as Promise<{ tags: Array<{ tag: string; count: number }> }>
}

export async function postPoolGc(project: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/pool/gc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) throw new Error(`Failed to run GC: ${res.status}`)
  return res.json() as Promise<{ success: boolean; deleted: number; freedBytes: number }>
}

export async function fetchPoolGcPreview(project: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/pool/gc-preview`)
  if (!res.ok) return { wouldDelete: 0, segments: [] }
  return res.json() as Promise<{ wouldDelete: number; segments: Array<{ id: string; poolPath: string; label: string; byteSize: number; createdAt: string }> }>
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'difference' | 'add' | 'soft-light' | 'chroma-key'

export type ChromaKeyConfig = { color: [number, number, number]; threshold: number; feather: number }

export type Track = {
  id: string
  name: string
  zOrder: number
  blendMode: BlendMode
  baseOpacity: number
  muted: boolean
  /** Solo'd tracks play; non-solo tracks are effectively muted when any solo is active. */
  solo: boolean
  opacityKeyframes: { id: string; time: number; opacity: number }[]
  chromaKey?: ChromaKeyConfig
  hidden?: boolean
}

export async function fetchTracks(project: string): Promise<Track[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/tracks`)
  if (!res.ok) return [{ id: 'track_1', name: 'Track 1', zOrder: 0, blendMode: 'normal', baseOpacity: 1.0, muted: false, solo: false, opacityKeyframes: [] }]
  const data = await res.json() as { tracks: Track[] }
  return data.tracks.map((t) => ({ ...t, opacityKeyframes: t.opacityKeyframes || [] }))
}

export async function postAddTrack(project: string, name?: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/tracks/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return res.json() as Promise<{ success: boolean; id: string }>
}

export async function postUpdateTrack(project: string, id: string, updates: Partial<Pick<Track, 'name' | 'blendMode' | 'baseOpacity' | 'muted' | 'solo' | 'hidden'>>) {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/tracks/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...updates }),
  })
}

export async function postDeleteTrack(project: string, id: string) {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/tracks/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}

export async function postReorderTracks(project: string, trackIds: string[]) {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/tracks/reorder`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackIds }),
  })
}

export type UnselectedCandidate = { keyframeId: string; variant: number; path: string }
export type VideoCandidate = { transitionId: string; slot: string; variant: number; path: string; size: number }

export async function fetchVideoCandidates(project: string): Promise<VideoCandidate[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/video-candidates`)
  if (!res.ok) return []
  const data = await res.json() as { candidates: VideoCandidate[] }
  return data.candidates
}

export async function fetchUnselectedCandidates(project: string): Promise<UnselectedCandidate[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/unselected-candidates`)
  if (!res.ok) return []
  const data = await res.json() as { candidates: UnselectedCandidate[] }
  return data.candidates
}

export async function postGenerateKeyframeVariations(project: string, keyframeId: string, count?: number) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/generate-keyframe-variations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, count: count || 4 }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ jobId: string; keyframeId: string }>
}

export async function postEscalateKeyframe(project: string, keyframeId: string, count?: number) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/escalate-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, count: count || 2 }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ jobId: string; keyframeId: string }>
}

export async function postUpdateKeyframeLabel(project: string, keyframeId: string, label: string, labelColor: string) {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-keyframe-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, label, labelColor }),
  })
}

export async function postUpdateTransitionLabel(project: string, transitionId: string, label: string, labelColor: string, tags?: string[]) {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-transition-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, label, labelColor, ...(tags ? { tags } : {}) }),
  })
}

export async function postUpdateKeyframeStyle(project: string, keyframeId: string, style: { blendMode?: string; opacity?: number | null }) {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-keyframe-style`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, ...style }),
  })
}

export async function postUpdateTransitionStyle(project: string, transitionId: string, style: { blendMode?: string; opacity?: number | null; opacityCurve?: [number, number][] | null; redCurve?: [number, number][] | null; greenCurve?: [number, number][] | null; blueCurve?: [number, number][] | null; blackCurve?: [number, number][] | null; hueShiftCurve?: [number, number][] | null; saturationCurve?: [number, number][] | null; invertCurve?: [number, number][] | null; isAdjustment?: boolean; chromaKey?: { color: [number, number, number]; threshold: number; feather: number } | null; maskCenterX?: number | null; maskCenterY?: number | null; maskRadius?: number | null; maskFeather?: number | null; transformX?: number | null; transformY?: number | null; anchorX?: number | null; anchorY?: number | null; hidden?: boolean }) {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-transition-style`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, ...style }),
  })
}

export async function postCopyTransitionStyle(project: string, sourceId: string, targetId: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/copy-transition-style`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, targetId }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
}

export async function postDuplicateTransitionVideo(project: string, sourceId: string, targetId: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/duplicate-transition-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, targetId }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
}

export async function postPasteGroup(project: string, keyframeIds: string[], targetTime: string, targetTrackId: string, audioClipIds: string[] = []) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/paste-group`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeIds, audioClipIds, targetTime, targetTrackId }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
}

export async function postUndo(project: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  return res.json() as Promise<{ success: boolean; description?: string; message?: string }>
}

export async function postRedo(project: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/redo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  return res.json() as Promise<{ success: boolean; description?: string; message?: string }>
}

export type UndoHistoryEntry = { id: number; description: string; timestamp: string; undone: boolean }

export async function fetchUndoHistory(project: string, limit: number = 50): Promise<UndoHistoryEntry[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/undo-history?limit=${limit}`)
  if (!res.ok) return []
  const data = await res.json() as { history: UndoHistoryEntry[] }
  return data.history || []
}

export async function postUnlinkKeyframe(project: string, keyframeId: string, side: 'both' | 'left' | 'right' = 'both') {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/unlink-keyframe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, side }),
  })
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
}

export async function postAssignKeyframeImage(project: string, keyframeId: string, sourcePath: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/assign-keyframe-image`, {
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
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/reapply-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Failed to reapply rules: ${res.status}`)
  return res.json()
}

export async function postUpdateRules(project: string, rules: AudioRule[]) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  })
  if (!res.ok) throw new Error(`Failed to update rules: ${res.status}`)
  return res.json()
}

export type MarkerType = 'note' | 'todo' | 'section'

export async function fetchMarkers(project: string): Promise<{ id: string; time: number; label: string; type: MarkerType }[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/markers`)
  if (!res.ok) return []
  const data = await res.json() as { markers: { id: string; time: number; label: string; type: MarkerType }[] }
  return data.markers
}

export async function postAddMarker(project: string, id: string, time: number, label: string = '', type: MarkerType = 'note') {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/markers/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, time, label, type }),
  })
}

export async function postUpdateMarker(project: string, id: string, updates: { label?: string; type?: MarkerType }) {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/markers/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...updates }),
  })
}

export async function postRemoveMarker(project: string, id: string) {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/markers/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}

// Prompt Roster

export type PromptRosterEntry = { id: string; name: string; template: string; category: string }

export async function fetchPromptRoster(project: string): Promise<PromptRosterEntry[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/prompt-roster`)
  if (!res.ok) return []
  const data = await res.json() as { prompts: PromptRosterEntry[] }
  return data.prompts
}

export async function postAddPromptRoster(project: string, name: string, template: string, category: string = 'general') {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/prompt-roster/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, template, category }),
  })
  return res.json() as Promise<{ success: boolean; id: string }>
}

export async function postUpdatePromptRoster(project: string, id: string, updates: { name?: string; template?: string; category?: string }) {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/prompt-roster/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...updates }),
  })
}

export async function postRemovePromptRoster(project: string, id: string) {
  await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/prompt-roster/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}

export async function fetchStagingCandidates(project: string, stagingId: string): Promise<string[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/staging/${encodeURIComponent(stagingId)}`)
  if (!res.ok) return []
  const data = await res.json() as { candidates: string[] }
  return data.candidates
}

export async function fetchPool(project: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/pool`)
  if (!res.ok) throw new Error(`Failed to fetch pool: ${res.status}`)
  return res.json() as Promise<{ keyframes: PoolEntry[]; segments: PoolEntry[] }>
}

export async function postUpdatePoolTags(project: string, poolPath: string, tags: string[]) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-pool-tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poolPath, tags }),
  })
  if (!res.ok) throw new Error(`Failed to update pool tags: ${res.status}`)
  return res.json()
}

export async function postGenerateKeyframeCandidates(project: string, keyframeId: string, count?: number, refinementPrompt?: string, freeform?: boolean) {
  console.log('[scenecraft-client] generating keyframe candidates:', project, keyframeId, count, refinementPrompt ? `refine: ${refinementPrompt.slice(0, 50)}` : '', freeform ? 'freeform' : '')
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/generate-keyframe-candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, count, ...(refinementPrompt ? { refinementPrompt } : {}), ...(freeform ? { freeform: true } : {}) }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error('[scenecraft-client] generate-keyframe-candidates failed:', res.status, text)
    throw new Error(`Failed to generate keyframe candidates: ${res.status} ${text}`)
  }
  return res.json() as Promise<{ jobId: string; keyframeId: string; candidates?: string[] }>
}

export async function postGenerateTransitionAction(project: string, transitionId: string, sectionContext?: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/generate-transition-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, ...(sectionContext && { sectionContext }) }),
  })
  return res.json() as Promise<{ success: boolean; action: string; slotActions?: string[] }>
}

export async function postEnhanceTransitionAction(project: string, transitionId: string, action: string, sectionContext?: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/enhance-transition-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, action, ...(sectionContext && { sectionContext }) }),
  })
  return res.json() as Promise<{ success: boolean; action: string }>
}

export async function postUpdateTransitionRemap(project: string, transitionId: string, targetDuration: number, method?: string, curvePoints?: [number, number, number?][]) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-transition-remap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, targetDuration, method, ...(curvePoints && { curvePoints }) }),
  })
  return res.json()
}

export async function postUpdateTransitionAction(project: string, transitionId: string, action: string, useGlobalPrompt: boolean, slotActions?: string[], includeSectionDesc?: boolean, negativePrompt?: string, seed?: number | null, ingredients?: string[]) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-transition-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, action, useGlobalPrompt, ...(slotActions && { slotActions }), ...(includeSectionDesc !== undefined && { includeSectionDesc }), ...(negativePrompt !== undefined && { negativePrompt }), ...(seed !== undefined && { seed }), ...(ingredients !== undefined && { ingredients }) }),
  })
  return res.json()
}

export async function fetchMeta(project: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/keyframes`)
  if (!res.ok) return {}
  const data = await res.json()
  return (data.meta || {}) as Record<string, unknown>
}

export async function postUpdateMeta(project: string, fields: Record<string, string>) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  return res.json()
}

export async function postGenerateTransitionCandidates(project: string, transitionId: string, count?: number, slotIndex?: number, duration?: number, useNextTransitionFrame?: boolean, noEndFrame?: boolean, generateAudio?: boolean, ingredients?: string[], negativePrompt?: string, seed?: number | null) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/generate-transition-candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, count, ...(slotIndex != null && { slotIndex }), ...(duration != null && { duration }), ...(useNextTransitionFrame && { useNextTransitionFrame: true }), ...(noEndFrame && { noEndFrame: true }), ...(generateAudio && { generateAudio: true }), ...(ingredients && ingredients.length > 0 && { ingredients }), ...(negativePrompt && { negativePrompt }), ...(seed != null && { seed }) }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || `Generate failed: ${res.status}`)
  }
  return res.json() as Promise<{ jobId: string; transitionId: string; candidates?: Record<string, string[]> }>
}

export async function postDeleteTransition(project: string, transitionId: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/delete-transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId }),
  })
  return res.json()
}

export async function postRestoreTransition(project: string, transitionId: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/restore-transition`, {
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
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/effects`)
  if (!res.ok) throw new Error(`Failed to fetch effects: ${res.status}`)
  return res.json() as Promise<{ effects: UserEffect[]; suppressions: BeatSuppression[] }>
}

export async function postUpdateEffects(project: string, effects: UserEffect[], suppressions: BeatSuppression[]) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/effects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ effects, suppressions }),
  })
  return res.json()
}

export async function fetchWatchedFolders(project: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/watched-folders`)
  if (!res.ok) throw new Error(`Failed to fetch watched folders: ${res.status}`)
  return res.json() as Promise<{ watchedFolders: string[] }>
}

export async function postWatchFolder(project: string, folderPath: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/watch-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath }),
  })
  return res.json() as Promise<{ success: boolean; watching: string; existingFiles: number }>
}

export async function postUnwatchFolder(project: string, folderPath: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/unwatch-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath }),
  })
  return res.json()
}

export async function postImport(project: string, sourcePath: string, timestamp?: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/import`, {
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

/**
 * Atomic trim + boundary move for a transition clip. Used by the clip-boundary
 * drag handles in TransitionTrack. Any combination of trimIn/trimOut/
 * fromKfTimestamp/toKfTimestamp can be provided; omitted fields are untouched.
 *
 * Backend applies all updates in one transaction and cascades to adjacent trs'
 * duration_seconds so the timeline stays consistent.
 */
export async function postUpdateTransitionTrim(
  project: string,
  opts: {
    transitionId: string
    trimIn?: number
    trimOut?: number
    fromKfTimestamp?: string
    toKfTimestamp?: string
  },
) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/update-transition-trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  if (!res.ok) throw new Error(`Failed to update transition trim: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{
    success: boolean
    transitionId: string
    trimIn: number | null
    trimOut: number | null
  }>
}

/**
 * Design-correct clip-edge trim for `<]` / `[>` zones. Backend decides whether
 * to insert a gap (shrink) or advance the neighbor's trim (extend) so that no
 * transition's time_remap_factor changes as a side effect.
 */
export async function postClipTrimEdge(
  project: string,
  opts: {
    transitionId: string
    edge: 'right' | 'left'
    newBoundaryTimestamp: string
    newTrim: number
    mode?: 'trim' | 'ripple'  // default 'trim'
  },
) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/clip-trim-edge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  if (!res.ok) throw new Error(`Failed clip-trim-edge: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ success: boolean; transitionId: string; mode: string }>
}

/**
 * selections map values:
 *   - string (UUID): pool_segment_id — preferred; stable under merges and candidate insertion
 *   - number: legacy 1-based variant rank — backend resolves against candidate list
 *   - null: deselect
 * Keys: "tr_NNN_slot_N" or "tr_NNN" (shorthand for slot 0)
 */
export async function postSelectTransitions(
  project: string,
  selections: Record<string, string | number | null>,
) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/select-transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selections }),
  })
  if (!res.ok) throw new Error(`Failed to select transitions: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postSetBaseImage(project: string, keyframeId: string, stillName: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/set-base-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, stillName }),
  })
  if (!res.ok) throw new Error(`Failed to set base image: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ success: boolean; keyframeId: string; still: string }>
}

export async function postAssignPoolVideo(project: string, transitionId: string, poolPath: string) {
  console.log(`[scenecraft-client] assigning pool video: ${transitionId} <- ${poolPath}`)
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/assign-pool-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, poolPath }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`[scenecraft-client] assign-pool-video failed: ${res.status} ${text}`)
    throw new Error(`Failed to assign pool video: ${res.status} ${text}`)
  }
  return res.json()
}

export async function postSplitTransition(project: string, transitionId: string, splitTime: number) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/split-transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, splitTime }),
  })
  if (!res.ok) throw new Error(`Failed to split transition: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ success: boolean; keyframeId: string; transition1: string; transition2: string }>
}

export async function postMoveTransitions(
  project: string,
  opts: {
    mode?: 'move' | 'copy'
    trackDelta: number
    timeDeltaSeconds: number
    transitionIds: string[]
    autoCreateTracks?: boolean
  },
): Promise<{
  success: boolean
  movedTransitionIds: string[]
  createdTrackIds: string[]
  consumedTransitionIds: string[]
  splitTransitionIds: string[]
}> {
  const body = {
    mode: opts.mode ?? 'move',
    trackDelta: opts.trackDelta,
    timeDeltaSeconds: opts.timeDeltaSeconds,
    transitionIds: opts.transitionIds,
    autoCreateTracks: opts.autoCreateTracks ?? true,
  }
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/move-transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Failed to move transitions: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{
    success: boolean
    movedTransitionIds: string[]
    createdTrackIds: string[]
    consumedTransitionIds: string[]
    splitTransitionIds: string[]
  }>
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
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/bench`)
  if (!res.ok) return []
  const data = await res.json()
  return data.items || []
}

export async function postAddToBench(project: string, type: 'keyframe' | 'transition', entityId?: string, sourcePath?: string, label?: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/bench/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, entityId, sourcePath, label }),
  })
  if (!res.ok) throw new Error(`Failed to add to bench: ${res.status}`)
  return res.json() as Promise<{ success: boolean; benchId: string }>
}

export async function postRemoveFromBench(project: string, benchId: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/bench/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ benchId }),
  })
  if (!res.ok) throw new Error(`Failed to remove from bench: ${res.status}`)
  return res.json()
}

// ── Transition effects ──

export async function postAddTransitionEffect(project: string, transitionId: string, type: string, params: Record<string, number> = {}) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/transition-effects/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, type, params }),
  })
  if (!res.ok) throw new Error(`Failed to add effect: ${res.status}`)
  return res.json() as Promise<{ success: boolean; id: string }>
}

export async function postUpdateTransitionEffect(project: string, id: string, updates: { params?: Record<string, number>; enabled?: boolean }) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/transition-effects/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...updates }),
  })
  if (!res.ok) throw new Error(`Failed to update effect: ${res.status}`)
  return res.json()
}

export async function postDeleteTransitionEffect(project: string, id: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/transition-effects/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) throw new Error(`Failed to delete effect: ${res.status}`)
  return res.json()
}

export async function postInsertPoolItem(project: string, type: 'keyframe' | 'segment', poolPath: string, atTime: number) {
  console.log(`[scenecraft-client] inserting pool item: ${type} ${poolPath} at ${atTime}s`)
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/insert-pool-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, poolPath, atTime }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`[scenecraft-client] insert-pool-item failed: ${res.status} ${text}`)
    throw new Error(`Failed to insert pool item: ${res.status} ${text}`)
  }
  const result = await res.json()
  console.log('[scenecraft-client] insert-pool-item result:', result)
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
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/descriptions`)
  if (!res.ok) return []
  const data = await res.json()
  return data.sections || []
}

export async function postSelectKeyframes(project: string, selections: Record<string, number>) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/select-keyframes`, {
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
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/enhance-keyframe-prompt`, {
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
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/suggest-keyframe-prompts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Failed to suggest prompts: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postPromoteStagedCandidate(project: string, keyframeId: string, stagingId: string, variant: number) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/promote-staged-candidate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, stagingId, variant }),
  })
  if (!res.ok) throw new Error(`Failed to promote staged candidate: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postGenerateStagedCandidate(project: string, prompt: string, stillName: string, stagingId: string, count: number = 1) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/generate-staged-candidate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, stillName, stagingId, count }),
  })
  if (!res.ok) throw new Error(`Failed to generate staged candidate: ${res.status} ${await res.text()}`)
  return res.json() as Promise<{ jobId: string; stagingId: string }>
}

export async function fetchSectionSettings(project: string, sectionLabel: string): Promise<{ still: string | null; suggestions: KeyframePromptSuggestion[] | null }> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/section-settings?section=${encodeURIComponent(sectionLabel)}`)
  if (!res.ok) return { still: null, suggestions: null }
  return res.json()
}

export async function postSectionSettings(project: string, sectionLabel: string, settings: { still?: string; suggestions?: KeyframePromptSuggestion[] }) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/section-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sectionLabel, ...settings }),
  })
  if (!res.ok) throw new Error(`Failed to save section settings: ${res.status}`)
  return res.json()
}

// ── Ingredients ──

export type Ingredient = {
  id: string
  path: string
  label: string
  addedAt: string
  sourceType: 'keyframe' | 'pool' | 'upload'
  sourceRef?: string
}

export async function fetchIngredients(project: string): Promise<Ingredient[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/ingredients`)
  if (!res.ok) return []
  const data = await res.json() as { ingredients: Ingredient[] }
  return data.ingredients
}

export async function postPromoteToIngredient(project: string, sourceType: 'keyframe' | 'pool', sourcePath: string, label?: string): Promise<{ success: boolean; ingredient: Ingredient }> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/ingredients/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceType, sourcePath, ...(label && { label }) }),
  })
  if (!res.ok) throw new Error(`Failed to promote to ingredient: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postRemoveIngredient(project: string, ingredientId: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/ingredients/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredientId }),
  })
  if (!res.ok) throw new Error(`Failed to remove ingredient: ${res.status}`)
  return res.json()
}

export async function postUpdateIngredientLabel(project: string, ingredientId: string, label: string) {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/ingredients/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredientId, label }),
  })
  if (!res.ok) throw new Error(`Failed to update ingredient: ${res.status}`)
  return res.json()
}

// ── Video extension ──

export async function postExtendVideo(project: string, transitionId: string, videoPath: string): Promise<{ jobId: string; transitionId: string }> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/extend-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transitionId, videoPath }),
  })
  if (!res.ok) throw new Error(`Failed to extend video: ${res.status} ${await res.text()}`)
  return res.json()
}

// ── M13 effect-curves ──

/**
 * Update a single effect_curve row (task-52 endpoint — individual update).
 * For multi-curve paste (task-56) prefer `postEffectCurveBatchUpdate` so
 * the whole paste collapses into a single undo unit (spec R47).
 */
export async function postUpdateEffectCurve(
  project: string,
  curveId: string,
  patch: { points?: Array<[number, number]>; interpolation?: 'bezier' | 'linear' | 'step'; visible?: boolean },
): Promise<{ id: string; points: Array<[number, number]>; interpolation: string; visible: boolean }> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/effect-curves/${encodeURIComponent(curveId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Failed to update effect curve: ${res.status} ${await res.text()}`)
  return res.json()
}

/**
 * Batch-update multiple effect_curve rows atomically inside a single
 * undo group (spec R47).
 *
 * Backing endpoint: `POST /effect-curves/batch`. Implementation in
 * `scenecraft-engine/src/scenecraft/api_server.py` wraps the updates in
 * one `undo_begin(...)` call so the whole paste shows up as ONE entry in
 * the undo history — undoing it reverts every pasted keyframe at once
 * (spec test `simultaneous-copy-paste-across-10-tracks`).
 */
export async function postEffectCurveBatchUpdate(
  project: string,
  updates: Array<{
    curve_id: string
    points?: Array<[number, number]>
    interpolation?: 'bezier' | 'linear' | 'step'
    visible?: boolean
  }>,
  opts?: { description?: string },
): Promise<{ success: boolean; updated: string[] }> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/effect-curves/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: opts?.description ?? `Paste automation (${updates.length} curves)`,
      updates,
    }),
  })
  if (!res.ok) throw new Error(`Failed to batch-update effect curves: ${res.status} ${await res.text()}`)
  return res.json()
}

// ── M13 track-effects ──

export type TrackEffectCurve = {
  id: string
  effect_id: string
  param_name: string
  points: Array<[number, number]>
  interpolation: 'bezier' | 'linear' | 'step'
  visible: boolean
}

export type TrackEffectRowJSON = {
  id: string
  track_id: string
  effect_type: string
  order_index: number
  enabled: boolean
  static_params: Record<string, unknown>
  curves: TrackEffectCurve[]
  created_at?: string
}

export async function fetchTrackEffects(project: string, trackId: string): Promise<TrackEffectRowJSON[]> {
  const u = `${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/track-effects?track_id=${encodeURIComponent(trackId)}`
  const res = await fetch(u)
  if (!res.ok) throw new Error(`Failed to fetch track-effects: ${res.status} ${await res.text()}`)
  const data = await res.json() as { effects?: TrackEffectRowJSON[] }
  return data.effects ?? []
}

export async function postCreateTrackEffect(
  project: string,
  body: { track_id: string; effect_type: string; static_params?: Record<string, unknown>; order_index?: number },
): Promise<TrackEffectRowJSON> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/track-effects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Failed to create track-effect: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postUpdateTrackEffect(
  project: string,
  effectId: string,
  patch: { enabled?: boolean; static_params?: Record<string, unknown>; order_index?: number },
): Promise<TrackEffectRowJSON> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/track-effects/${encodeURIComponent(effectId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Failed to update track-effect: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function deleteTrackEffect(project: string, effectId: string): Promise<void> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/track-effects/${encodeURIComponent(effectId)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`Failed to delete track-effect: ${res.status} ${await res.text()}`)
}

// ── Master-bus effects ───────────────────────────────────────────────────
//
// Master-bus effects are `track_effects` rows where `track_id IS NULL`, sat
// on the summed mix (masterGain → fx chain → destination). The backend's
// `list_master_bus_effects(project_dir)` tool powers the endpoint below;
// POST/PATCH/DELETE on the same row flow through the widened track-effects
// endpoints with a null track_id.
//
// Contract: throws on network / non-2xx response. Callers that want a
// soft-failure (e.g. mixer-init) should wrap in try/catch or `.catch(() => [])`.
// An empty 2xx body (`{ effects: [] }` or missing `effects`) returns `[]`.
//
//   GET /api/projects/:project/master-bus-effects
//       → { effects: TrackEffectRowJSON[] }  (track_id === null)
export async function fetchMasterBusEffects(projectName: string): Promise<TrackEffectRowJSON[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(projectName)}/master-bus-effects`)
  if (!res.ok) throw new Error(`failed to fetch master-bus effects: ${res.status}`)
  const data = await res.json() as { effects?: TrackEffectRowJSON[] }
  return data.effects ?? []
}

// ── M13 send-buses ──

export type SendBusJSON = {
  id: string
  bus_type: 'reverb' | 'delay' | 'echo'
  label: string
  order_index: number
  static_params: Record<string, unknown>
}

export async function fetchSendBuses(project: string): Promise<SendBusJSON[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/send-buses`)
  if (!res.ok) throw new Error(`Failed to fetch send-buses: ${res.status} ${await res.text()}`)
  const data = await res.json() as { buses?: SendBusJSON[] }
  return data.buses ?? []
}

export async function postCreateSendBus(
  project: string,
  body: { bus_type: 'reverb' | 'delay' | 'echo'; label?: string; static_params?: Record<string, unknown>; order_index?: number },
): Promise<SendBusJSON> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/send-buses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Failed to create send-bus: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function postUpdateSendBus(
  project: string,
  busId: string,
  patch: { label?: string; order_index?: number; static_params?: Record<string, unknown> },
): Promise<SendBusJSON> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/send-buses/${encodeURIComponent(busId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Failed to update send-bus: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function deleteSendBus(project: string, busId: string): Promise<void> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/send-buses/${encodeURIComponent(busId)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`Failed to delete send-bus: ${res.status} ${await res.text()}`)
}
