const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

// ── Types ────────────────────────────────────────────────────────

export type CurvePoint = [number, number]   // [x, db] — x is normalised (clip) or seconds (track)

export type AudioTrack = {
  id: string
  name: string
  display_order: number
  enabled: boolean
  hidden: boolean
  muted: boolean
  volume_curve: CurvePoint[]
  /** Populated by GET /api/projects/:name/audio-tracks — clips already live on their track. */
  clips?: AudioClip[]
}

export type AudioClip = {
  id: string
  track_id: string
  source_path: string
  start_time: number
  end_time: number
  source_offset: number
  volume_curve: CurvePoint[]
  muted: boolean
  remap?: { method: string; target_duration: number }
  /**
   * Linear playback-rate factor derived from the linked transition's
   * remap (if any). 1.0 for unlinked clips. `source_span / kf_span` when
   * a transition link exists, so audio tracks the video's linear time
   * remap. Computed server-side at query time; not stored.
   */
  playback_rate?: number
  /**
   * Source-file offset to start reading from, including the linked
   * transition's `trim_in` (so the right slice of the source plays).
   * Computed server-side; equals `source_offset` for unlinked clips.
   */
  effective_source_offset?: number
}

export type AudioClipLink = {
  audio_clip_id: string
  transition_id: string
  offset: number
}

// ── API calls ────────────────────────────────────────────────────

export async function fetchAudioTracks(project: string): Promise<AudioTrack[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/audio-tracks`)
  if (!res.ok) return []
  const data = await res.json() as { audioTracks?: AudioTrack[]; tracks?: AudioTrack[]; audio_tracks?: AudioTrack[] }
  return data.audioTracks || data.tracks || data.audio_tracks || []
}

export async function fetchAudioClips(project: string, trackId?: string): Promise<AudioClip[]> {
  const params = trackId ? `?track_id=${encodeURIComponent(trackId)}` : ''
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/audio-clips${params}`)
  if (!res.ok) return []
  const data = await res.json() as { audioClips?: AudioClip[]; clips?: AudioClip[]; audio_clips?: AudioClip[] }
  return data.audioClips || data.clips || data.audio_clips || []
}

export type AudioClipUpdate = Partial<{
  trackId: string
  sourcePath: string
  startTime: number
  endTime: number
  sourceOffset: number
  volumeCurve: CurvePoint[]
  muted: boolean
  remap: { method: string; target_duration: number }
}>

export async function postUpdateAudioClip(project: string, clipId: string, update: AudioClipUpdate): Promise<void> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/audio-clips/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: clipId, ...update }),
  })
  if (!res.ok) throw new Error(`audio-clips/update failed: ${res.status}`)
}

export type AudioTrackUpdate = Partial<{
  name: string
  displayOrder: number
  enabled: boolean
  hidden: boolean
  muted: boolean
  volumeCurve: CurvePoint[]
}>

export async function postUpdateAudioTrack(project: string, trackId: string, update: AudioTrackUpdate): Promise<void> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/audio-tracks/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: trackId, ...update }),
  })
  if (!res.ok) throw new Error(`audio-tracks/update failed: ${res.status}`)
}
