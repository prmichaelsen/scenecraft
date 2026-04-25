export type FoleyMode = 't2fx' | 'v2fx'

export interface GenerateFoleyRequest {
  prompt?: string
  duration_seconds?: number
  source_candidate_id?: string
  source_in_seconds?: number
  source_out_seconds?: number
  negative_prompt?: string
  cfg_strength?: number
  seed?: number
  entity_type?: 'transition'
  entity_id?: string
  count?: number
}

export interface GenerateFoleyResponse {
  generation_id: string
  job_id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  mode: FoleyMode
  error?: string
}

export interface GenerationTrack {
  variant_index: number
  pool_segment_id: string
  replicate_prediction_id: string
  duration_seconds: number | null
  pool_path?: string
  pool_duration?: number | null
}

export interface GenerationListItem {
  id: string
  created_at: string
  created_by: string
  mode: FoleyMode
  prompt: string | null
  duration_seconds: number | null
  source_candidate_id: string | null
  source_in_seconds: number | null
  source_out_seconds: number | null
  model: string
  negative_prompt: string | null
  cfg_strength: number | null
  seed: number | null
  entity_type: 'transition' | null
  entity_id: string | null
  variant_count: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  error: string | null
  started_at: string | null
  completed_at: string | null
  tracks: GenerationTrack[]
}
