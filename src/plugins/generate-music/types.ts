/**
 * Types mirroring the `generate_music` backend plugin's REST contract.
 * Shapes line up 1:1 with what task-130's `routes.py` returns so the
 * client wrappers stay dumb and the panel just destructures.
 */

export type GenerationAction = 'auto' | 'custom'
export type GenerationStatus = 'pending' | 'running' | 'completed' | 'failed'
export type GenerationGender = 'male' | 'female' | '' | null

export type GenerationTrack = {
  generation_id: string
  pool_segment_id: string
  musicful_task_id: string
  song_title: string | null
  // Filled from the pool_segments JOIN in get_music_generations_for_entity.
  // Used by the drag payload so AudioLane's drop handler can create an
  // audio_clip pointing at the right file.
  pool_path: string
  duration_seconds: number | null
  cover_url: string | null
}

export type Generation = {
  id: string
  action: GenerationAction
  model: string
  style: string | null
  lyrics: string | null
  title: string | null
  instrumental: 0 | 1
  gender: GenerationGender
  task_ids: string[]
  status: GenerationStatus
  error: string | null
  entity_type: 'audio_clip' | 'transition' | null
  entity_id: string | null
  reused_from: string | null
  created_at: string
  tracks: GenerationTrack[]
}

/**
 * Body POSTed to `/run`. Matches the shape `routes._handle_run` expects.
 * Fields the caller omits are simply not serialized — the backend then
 * applies its own defaults / treats as "no value" (see spec R13).
 */
export type RunPayload = {
  action: GenerationAction
  style: string
  lyrics?: string
  title?: string
  instrumental?: 0 | 1
  gender?: GenerationGender
  model?: string
  entity_type?: 'audio_clip' | 'transition' | null
  entity_id?: string | null
}

export type RunResponse = {
  generation_id: string
  task_ids: string[]
  job_id: string
}

export type CreditsResponse = {
  credits: number | null
  last_checked_at?: string
  error?: string
}
