const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

// ── Types ────────────────────────────────────────────────────────

export type CurvePoint = [number, number]   // [x, db] — x is normalised (clip) or seconds (track)

export type AudioTrack = {
  id: string
  name: string
  display_order: number
  hidden: boolean
  muted: boolean
  /** Solo'd tracks play; non-solo tracks are effectively muted when any solo is active. */
  solo: boolean
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
  /**
   * Transition id this clip is linked to via `audio_clip_links`, or null
   * for standalone clips. Computed server-side. Used by cross-type drag
   * so a linked clip isn't double-shifted when its transition is moved
   * (propagation in `update_keyframe` handles the linked-audio shift), and
   * by the timeline for cross-highlighting linked transition ↔ audio clip.
   */
  linked_transition_id?: string | null
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

export async function postDeleteAudioClip(project: string, clipId: string): Promise<void> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/audio-clips/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: clipId }),
  })
  if (!res.ok) throw new Error(`audio-clips/delete failed: ${res.status}`)
}

export type AudioTrackUpdate = Partial<{
  name: string
  displayOrder: number
  hidden: boolean
  muted: boolean
  solo: boolean
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

/**
 * Create a new audio track. `name` is optional — backend assigns
 * "Audio Track N+1" when omitted. Returns the new track's id; caller should
 * refreshTimeline() to pick it up.
 */
export async function postAddAudioTrack(
  project: string,
  opts: { name?: string } = {},
): Promise<{ id: string }> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/audio-tracks/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  if (!res.ok) throw new Error(`audio-tracks/add failed: ${res.status}`)
  const data = await res.json() as { id: string }
  return { id: data.id }
}

/**
 * Delete an audio track and every clip it owns. Destructive — caller is
 * responsible for confirming with the user before invoking.
 */
export async function postDeleteAudioTrack(project: string, trackId: string): Promise<void> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/audio-tracks/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: trackId }),
  })
  if (!res.ok) throw new Error(`audio-tracks/delete failed: ${res.status}`)
}

/**
 * Persist a new track ordering. `trackIds` is the complete, ordered list of
 * ids — the server rewrites `display_order` to match array position.
 */
export async function postReorderAudioTracks(project: string, trackIds: string[]): Promise<void> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/audio-tracks/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackIds }),
  })
  if (!res.ok) throw new Error(`audio-tracks/reorder failed: ${res.status}`)
}

/**
 * Auto-detect time offset between audio clips via waveform cross-correlation.
 * Returns signed seconds per non-anchor clip: positive = clip should shift
 * later; negative = clip should shift earlier, so its waveform aligns with
 * the anchor's waveform.
 *
 * Backend not yet implemented; caller should handle non-2xx as "auto-detect
 * unavailable" and fall back to manual offsets.
 */
export type AlignWaveformsResult = {
  anchorClipId: string
  offsets: Record<string, number>       // clipId -> signed-seconds shift
  confidence: Record<string, number>    // clipId -> 0..1 score
}

export async function postDetectAudioAlignment(
  project: string,
  opts: { anchorClipId: string; clipIds: string[] },
): Promise<AlignWaveformsResult> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/projects/${encodeURIComponent(project)}/audio-clips/align-detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  if (!res.ok) throw new Error(`audio-clips/align-detect failed: ${res.status}`)
  return res.json()
}
