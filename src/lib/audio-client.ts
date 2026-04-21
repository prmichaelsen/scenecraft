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
