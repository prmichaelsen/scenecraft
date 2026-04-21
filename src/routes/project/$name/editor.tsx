import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { EditorPanelLayout, type EditorPanelLayoutHandle } from '@/components/editor/EditorPanelLayout'
import { useRef, useEffect } from 'react'
import { StatusBar } from '@/components/editor/StatusBar'
import { JobStateProvider } from '@/contexts/JobStateContext'
import {
  fetchKeyframes,
  fetchBeats,
  fetchBin,
  postUpdateTimestamp,
  postAddKeyframe,
  postDuplicateKeyframe,
  postDeleteKeyframe,
  postRestoreKeyframe,
  postUpdatePrompt,
  postDeleteTransition,
  postRestoreTransition,
  postGenerateKeyframeCandidates,
  postGenerateTransitionAction,
  postGenerateTransitionCandidates,
  postUpdateTransitionAction,
  postUpdateMeta,
  postImport,
  postSelectTransitions,
  postSelectKeyframes,
  postUpdateTransitionRemap,
  fetchEffects,
  fetchAudioIntelligence,
  type AudioEvent,
  type AudioRule,
  postUpdateEffects,
  type UserEffect,
  type BeatSuppression,
  type AudioDescription,
  fetchDescriptions,
  fetchPromptRoster,
} from '@/lib/scenecraft-client'
import {
  fetchNarrative,
  fetchTimelines,
  type NarrativeSection,
  type TimelineInfo,
} from '@/lib/timeline-client'
import { fetchSettings } from '@/lib/settings-client'
import { fetchWorkspaceView } from '@/lib/workspace-client'

export type { NarrativeSection, TimelineInfo } from '@/lib/timeline-client'

export type KeyframeContext = {
  mood: string
  energy: string
  instruments: string[]
  motifs: string[]
  events: string[]
  visual_direction: string
  details: string
}

export type Keyframe = {
  id: string
  timestamp: string
  section: string
  prompt: string
  selected: number | string | null
  hasSelectedImage: boolean
  context: KeyframeContext | null
  candidates: string[]
  trackId: string
  label: string
  labelColor: string
  blendMode: string
  opacity: number | null
  refinementPrompt: string
}

export type Beat = {
  time: number
  intensity: number
}

export type Section = {
  start_time: number
  end_time: number
  type: string
  label: string
}

export type CandidateDetail = {
  id: string             // pool_segment_id — stable identifier; use this for selection
  poolPath: string       // "pool/segments/cand_<uuid>.mp4"
  kind: 'generated' | 'imported'
  label: string          // user-editable display name (falls back to originalFilename)
  createdBy: string
  durationSeconds: number | null
  addedAt: string        // drives v1/v2/v3 display order (ordered ASC by added_at)
  generationParams?: GenerationParams | null  // present for kind='generated'; preserved for "reuse settings"
}

export type GenerationParams = {
  provider?: string
  model?: string
  prompt?: string
  negative_prompt?: string
  seed?: number | null
  ingredients?: {
    from_keyframe_id?: string
    to_keyframe_id?: string
    motion_prompt?: string
    action?: string
    ingredient_paths?: string[]
  }
  params?: {
    duration_target?: number
    generate_audio?: boolean
    no_end_frame?: boolean
    use_next_tr_frame?: boolean
  }
}

export type Transition = {
  id: string
  from: string
  to: string
  durationSeconds: number
  action: string
  useGlobalPrompt: boolean
  includeSectionDesc: boolean
  candidates: string[]  // ["path/v1.mp4", "path/v2.mp4", ...] — kept for render compatibility
  candidateDetails: CandidateDetail[]  // authoritative list with stable pool_segment_id
  hasSelectedVideo: boolean
  selected: number | string | null  // pool_segment_id (preferred) or legacy variant rank
  // Clip-trim model (see design/local.clip-trim-and-snap.md)
  trimIn: number  // in-point into the source video (seconds)
  trimOut: number | null  // out-point; null means "use full source_video_duration"
  sourceVideoDuration: number | null  // probed duration of the selected video
  remap: { method: string; target_duration: number; curve_points?: [number, number, number?][] }
  trackId: string
  label: string
  labelColor: string
  tags: string[]
  blendMode: string
  opacity: number | null
  opacityCurve: [number, number][] | null
  redCurve: [number, number][] | null
  greenCurve: [number, number][] | null
  blueCurve: [number, number][] | null
  blackCurve: [number, number][] | null
  hueShiftCurve: [number, number][] | null
  saturationCurve: [number, number][] | null
  invertCurve: [number, number][] | null
  brightnessCurve: [number, number][] | null
  contrastCurve: [number, number][] | null
  exposureCurve: [number, number][] | null
  chromaKey: { color: [number, number, number]; threshold: number; feather: number } | null
  isAdjustment: boolean
  maskCenterX: number | null
  maskCenterY: number | null
  maskRadius: number | null
  maskFeather: number | null
  transformX: number | null
  transformY: number | null
  transformXCurve: [number, number, number?][] | null
  transformYCurve: [number, number, number?][] | null
  transformZCurve: [number, number, number?][] | null
  anchorX: number | null
  anchorY: number | null
  hidden: boolean
  effects: TransitionEffect[]
  ingredients: string[]
  negativePrompt: string
  seed: number | null
}

export type TransitionEffect = {
  id: string
  type: string
  params: Record<string, number>
  enabled: boolean
}

export type EditorData = {
  meta: {
    title: string
    fps: number
    resolution: [number, number]
    motionPrompt: string
    defaultTransitionPrompt: string
  }
  keyframes: Keyframe[]
  transitions: Transition[]
  audioFile: string | null
  projectName: string
  beats: Beat[]
  sections: Section[]
  audioEvents: AudioEvent[]
  audioRules: AudioRule[]
  narrativeSections: NarrativeSection[]
  timelineInfo: TimelineInfo | null
  userEffects: UserEffect[]
  beatSuppressions: BeatSuppression[]
  previewQuality: number
  audioDescriptions: AudioDescription[]
  tracks: import('@/lib/scenecraft-client').Track[]
  audioOnsets: Record<string, Record<string, { time: number; strength: number }[]>>
  promptRoster: import('@/lib/scenecraft-client').PromptRosterEntry[]
  savedLayout: import('@/components/panel-layout').LayoutNode | null
  audioTracks: import('@/lib/audio-client').AudioTrack[]
}

const getEditorData = createServerFn({ method: 'GET' })
  .inputValidator((input: { name: string }) => input)
  .handler(async ({ data }): Promise<EditorData> => {
    // Split: heavy AI data is cached client-side, only light data refetched on invalidate
    const { fetchAudioTracks } = await import('@/lib/audio-client')
    const [kfData, beatsData, effectsData, narrativeData, timelineData, settingsData, descriptionsData, promptRosterData, savedLayout, audioTracksData] = await Promise.all([
      fetchKeyframes(data.name).catch((e) => { console.error('[editor] fetchKeyframes failed:', e); return { meta: null, keyframes: [], transitions: [], audioFile: null } }),
      fetchBeats(data.name).catch((e) => { console.error('[editor] fetchBeats failed:', e); return { beats: [], sections: [] } }),
      fetchEffects(data.name).catch((e) => { console.error('[editor] fetchEffects failed:', e); return { effects: [], suppressions: [] } }),
      fetchNarrative(data.name).catch((e) => { console.error('[editor] fetchNarrative failed:', e); return { sections: [] } }),
      fetchTimelines(data.name).catch(() => null),
      fetchSettings(data.name).catch(() => ({ preview_quality: 50 })),
      fetchDescriptions(data.name).catch(() => [] as AudioDescription[]),
      fetchPromptRoster(data.name).catch(() => [] as import('@/lib/scenecraft-client').PromptRosterEntry[]),
      fetchWorkspaceView(data.name, '_autosave_v3').then((v) => (v && typeof v === 'object' ? v as import('@/components/panel-layout').LayoutNode : null)).catch(() => null),
      fetchAudioTracks(data.name).catch((e) => { console.error('[editor] fetchAudioTracks failed:', e); return [] as import('@/lib/audio-client').AudioTrack[] }),
    ])
    // AI data placeholder — loaded separately on client to avoid refetching 5MB on every invalidate
    const aiData = { activeFile: null as string | null, events: [] as AudioEvent[], sections: [] as { start_time: number; end_time: number; type: string; label: string; description: string }[], rules: [] as import('@/lib/scenecraft-client').AudioRule[], ruleCount: 0, onsets: {} as Record<string, Record<string, { time: number; strength: number }[]>> }

    return {
      meta: {
        title: kfData.meta?.title || data.name,
        fps: kfData.meta?.fps || 24,
        resolution: kfData.meta?.resolution || [1920, 1080],
        motionPrompt: kfData.meta?.motionPrompt || '',
        defaultTransitionPrompt: kfData.meta?.defaultTransitionPrompt || 'Smooth cinematic transition',
      },
      keyframes: (kfData.keyframes || []).map((kf: Record<string, unknown>) => ({
        id: kf.id as string,
        timestamp: kf.timestamp as string,
        section: kf.section as string,
        prompt: (kf.prompt as string) || '',
        selected: kf.selected as number | string | null,
        hasSelectedImage: kf.hasSelectedImage as boolean,
        context: kf.context as KeyframeContext | null,
        candidates: Array.isArray(kf.candidates)
          ? (kf.candidates as Array<string | Record<string, unknown>>).map((c) =>
              typeof c === 'string' ? c : (c.path as string) || ''
            ).filter(Boolean)
          : [],
        trackId: (kf.trackId as string) || 'track_1',
        label: (kf.label as string) || '',
        labelColor: (kf.labelColor as string) || '',
        blendMode: (kf.blendMode as string) || '',
        opacity: kf.opacity != null ? kf.opacity as number : null,
        refinementPrompt: (kf.refinementPrompt as string) || '',
      })),
      transitions: (kfData.transitions || []).map((tr: Record<string, unknown>) => {
        // Candidate detail list (pool model) is the source of truth — backend orders by added_at.
        const rawDetails = tr.candidateDetails
        let candidateDetails: CandidateDetail[] = []
        if (rawDetails && typeof rawDetails === 'object') {
          const detailMap = rawDetails as Record<string, Array<Record<string, unknown>>>
          const slot0 = detailMap['slot_0'] || Object.values(detailMap)[0] || []
          candidateDetails = slot0.map((d) => ({
            id: (d.id as string) || '',
            poolPath: (d.poolPath as string) || '',
            kind: ((d.kind as string) === 'imported' ? 'imported' : 'generated') as 'generated' | 'imported',
            label: (d.label as string) || '',
            createdBy: (d.createdBy as string) || '',
            durationSeconds: (d.durationSeconds as number) ?? null,
            addedAt: (d.addedAt as string) || '',
            generationParams: (d.generationParams as GenerationParams) ?? null,
          })).filter((d) => d.id)
        }

        // Keep candidates[] as pool paths in the same order as candidateDetails — the render
        // layer uses this for <video src> URLs. Fall back to the raw candidates dict for
        // projects pre-migration that haven't been re-generated yet.
        const rawCandidates = tr.candidates
        let candidates: string[] = candidateDetails.map((d) => d.poolPath)
        if (candidates.length === 0) {
          if (Array.isArray(rawCandidates)) {
            candidates = rawCandidates as string[]
          } else if (rawCandidates && typeof rawCandidates === 'object') {
            const slotMap = rawCandidates as Record<string, string[]>
            candidates = slotMap['slot_0'] || Object.values(slotMap)[0] || []
            candidates.sort((a, b) => {
              const na = parseInt(a.match(/v(\d+)\./)?.[1] || '0', 10)
              const nb = parseInt(b.match(/v(\d+)\./)?.[1] || '0', 10)
              return na - nb
            })
          }
        }

        const rawSelected = tr.selected
        let selected: number | string | null = null
        if (Array.isArray(rawSelected)) {
          selected = (rawSelected as (number | string | null)[])[0] ?? null
        } else {
          selected = rawSelected as number | string | null
        }
        const rawHasSelected = tr.hasSelectedVideos
        const hasSelectedVideo = Array.isArray(rawHasSelected) ? (rawHasSelected as boolean[])[0] ?? false : !!rawHasSelected

        return {
          id: tr.id as string,
          from: tr.from as string,
          to: tr.to as string,
          durationSeconds: tr.durationSeconds as number,
          action: (tr.action as string) || '',
          useGlobalPrompt: tr.useGlobalPrompt !== false,
          includeSectionDesc: tr.includeSectionDesc !== false,
          candidateDetails,
          candidates,
          hasSelectedVideo,
          selected,
          trimIn: (tr.trimIn as number) ?? 0,
          trimOut: tr.trimOut != null ? (tr.trimOut as number) : null,
          sourceVideoDuration: tr.sourceVideoDuration != null ? (tr.sourceVideoDuration as number) : null,
          remap: (tr.remap as Transition['remap']) || { method: 'linear', target_duration: 0 },
          trackId: (tr.trackId as string) || 'track_1',
          label: (tr.label as string) || '',
          labelColor: (tr.labelColor as string) || '',
          tags: Array.isArray(tr.tags) ? tr.tags as string[] : [],
          blendMode: (tr.blendMode as string) || '',
          opacity: tr.opacity != null ? tr.opacity as number : null,
          opacityCurve: Array.isArray(tr.opacityCurve) ? tr.opacityCurve as [number, number][] : null,
          redCurve: Array.isArray(tr.redCurve) ? tr.redCurve as [number, number][] : null,
          greenCurve: Array.isArray(tr.greenCurve) ? tr.greenCurve as [number, number][] : null,
          blueCurve: Array.isArray(tr.blueCurve) ? tr.blueCurve as [number, number][] : null,
          blackCurve: Array.isArray(tr.blackCurve) ? tr.blackCurve as [number, number][] : null,
          hueShiftCurve: Array.isArray(tr.hueShiftCurve) ? tr.hueShiftCurve as [number, number][] : null,
          saturationCurve: Array.isArray(tr.saturationCurve) ? tr.saturationCurve as [number, number][] : null,
          invertCurve: Array.isArray(tr.invertCurve) ? tr.invertCurve as [number, number][] : null,
          brightnessCurve: Array.isArray(tr.brightnessCurve) ? tr.brightnessCurve as [number, number][] : null,
          contrastCurve: Array.isArray(tr.contrastCurve) ? tr.contrastCurve as [number, number][] : null,
          exposureCurve: Array.isArray(tr.exposureCurve) ? tr.exposureCurve as [number, number][] : null,
          chromaKey: tr.chromaKey && typeof tr.chromaKey === 'object' ? tr.chromaKey as { color: [number, number, number]; threshold: number; feather: number } : null,
          isAdjustment: !!tr.isAdjustment,
          maskCenterX: tr.maskCenterX != null ? tr.maskCenterX as number : null,
          maskCenterY: tr.maskCenterY != null ? tr.maskCenterY as number : null,
          maskRadius: tr.maskRadius != null ? tr.maskRadius as number : null,
          maskFeather: tr.maskFeather != null ? tr.maskFeather as number : null,
          transformX: tr.transformX != null ? tr.transformX as number : null,
          transformY: tr.transformY != null ? tr.transformY as number : null,
          transformXCurve: tr.transformXCurve ?? null,
          transformYCurve: tr.transformYCurve ?? null,
          transformZCurve: tr.transformZCurve ?? null,
          anchorX: tr.anchorX != null ? tr.anchorX as number : null,
          anchorY: tr.anchorY != null ? tr.anchorY as number : null,
          hidden: !!tr.hidden,
          effects: Array.isArray(tr.effects) ? tr.effects as TransitionEffect[] : [],
          ingredients: Array.isArray(tr.ingredients) ? tr.ingredients as string[] : [],
          negativePrompt: (tr.negativePrompt as string) || '',
          seed: tr.seed != null ? tr.seed as number : null,
        }
      }),
      audioFile: kfData.audioFile || null,
      projectName: data.name,
      beats: Array.isArray(beatsData.beats) ? beatsData.beats : [],
      sections: Array.isArray(beatsData.sections) ? beatsData.sections : [],
      audioEvents: aiData.events || [],
      audioRules: aiData.rules || [],
      narrativeSections: narrativeData.sections || [],
      timelineInfo: timelineData,
      userEffects: effectsData.effects || [],
      beatSuppressions: effectsData.suppressions || [],
      previewQuality: settingsData.preview_quality || 50,
      audioDescriptions: descriptionsData,
      audioOnsets: aiData.onsets || {},
      tracks: (Array.isArray(kfData.tracks) && kfData.tracks.length > 0 ? kfData.tracks : [{ id: 'track_1', name: 'Track 1', zOrder: 0, blendMode: 'normal', baseOpacity: 1.0, enabled: true }]).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        name: t.name as string,
        zOrder: (t.zOrder as number) ?? 0,
        blendMode: (t.blendMode as string) || 'normal',
        baseOpacity: (t.baseOpacity as number) ?? 1.0,
        enabled: t.enabled !== false,
        opacityKeyframes: (t.opacityKeyframes as { id: string; time: number; opacity: number }[]) || [],
        chromaKey: t.chromaKey as import('@/lib/scenecraft-client').ChromaKeyConfig | undefined,
        hidden: !!t.hidden,
      })),
      promptRoster: promptRosterData,
      savedLayout,
      audioTracks: audioTracksData,
    }
  })

// Light refetch — only keyframes + transitions + tracks (500KB vs 5.5MB full refetch)
export const getTimelineData = createServerFn({ method: 'GET' })
  .inputValidator((input: { name: string }) => input)
  .handler(async ({ data }) => {
    const kfData = await fetchKeyframes(data.name).catch(() => ({ meta: null, keyframes: [], transitions: [], audioFile: null, tracks: [] }))
    return {
      keyframes: (kfData.keyframes || []).map((kf: Record<string, unknown>) => ({
        id: kf.id as string,
        timestamp: kf.timestamp as string,
        section: kf.section as string,
        prompt: (kf.prompt as string) || '',
        selected: kf.selected as number | string | null,
        hasSelectedImage: kf.hasSelectedImage as boolean,
        context: kf.context as KeyframeContext | null,
        candidates: Array.isArray(kf.candidates)
          ? (kf.candidates as Array<string | Record<string, unknown>>).map((c) =>
              typeof c === 'string' ? c : (c.path as string) || ''
            ).filter(Boolean)
          : [],
        trackId: (kf.trackId as string) || 'track_1',
        label: (kf.label as string) || '',
        labelColor: (kf.labelColor as string) || '',
        blendMode: (kf.blendMode as string) || '',
        opacity: kf.opacity != null ? kf.opacity as number : null,
        refinementPrompt: (kf.refinementPrompt as string) || '',
      })),
      transitions: (kfData.transitions || []).map((tr: Record<string, unknown>) => {
        const rawDetails = tr.candidateDetails
        let candidateDetails: CandidateDetail[] = []
        if (rawDetails && typeof rawDetails === 'object') {
          const detailMap = rawDetails as Record<string, Array<Record<string, unknown>>>
          const slot0 = detailMap['slot_0'] || Object.values(detailMap)[0] || []
          candidateDetails = slot0.map((d) => ({
            id: (d.id as string) || '',
            poolPath: (d.poolPath as string) || '',
            kind: ((d.kind as string) === 'imported' ? 'imported' : 'generated') as 'generated' | 'imported',
            label: (d.label as string) || '',
            createdBy: (d.createdBy as string) || '',
            durationSeconds: (d.durationSeconds as number) ?? null,
            addedAt: (d.addedAt as string) || '',
            generationParams: (d.generationParams as GenerationParams) ?? null,
          })).filter((d) => d.id)
        }
        let candidates = candidateDetails.map((d) => d.poolPath)
        if (candidates.length === 0) {
          candidates = Array.isArray(tr.candidates) ? tr.candidates as string[]
            : typeof tr.candidates === 'object' && tr.candidates !== null
              ? Object.values(tr.candidates as Record<string, string[]>).flat()
              : []
        }
        let selected: number | string | null = null
        const rawSelected = tr.selected
        if (Array.isArray(rawSelected)) {
          selected = (rawSelected as (number | string | null)[])[0] ?? null
        } else {
          selected = rawSelected as number | string | null
        }
        const rawHasSelected = tr.hasSelectedVideos
        const hasSelectedVideo = Array.isArray(rawHasSelected) ? (rawHasSelected as boolean[])[0] ?? false : !!rawHasSelected
        return {
          id: tr.id as string,
          from: tr.from as string,
          candidateDetails,
          to: tr.to as string,
          durationSeconds: tr.durationSeconds as number,
          action: (tr.action as string) || '',
          useGlobalPrompt: tr.useGlobalPrompt !== false,
          includeSectionDesc: tr.includeSectionDesc !== false,
          candidates,
          hasSelectedVideo,
          selected,
          remap: (tr.remap as Transition['remap']) || { method: 'linear', target_duration: 0 },
          trackId: (tr.trackId as string) || 'track_1',
          label: (tr.label as string) || '',
          labelColor: (tr.labelColor as string) || '',
          tags: Array.isArray(tr.tags) ? tr.tags as string[] : [],
          blendMode: (tr.blendMode as string) || '',
          opacity: tr.opacity != null ? tr.opacity as number : null,
          opacityCurve: Array.isArray(tr.opacityCurve) ? tr.opacityCurve as [number, number][] : null,
          redCurve: Array.isArray(tr.redCurve) ? tr.redCurve as [number, number][] : null,
          greenCurve: Array.isArray(tr.greenCurve) ? tr.greenCurve as [number, number][] : null,
          blueCurve: Array.isArray(tr.blueCurve) ? tr.blueCurve as [number, number][] : null,
          blackCurve: Array.isArray(tr.blackCurve) ? tr.blackCurve as [number, number][] : null,
          hueShiftCurve: Array.isArray(tr.hueShiftCurve) ? tr.hueShiftCurve as [number, number][] : null,
          saturationCurve: Array.isArray(tr.saturationCurve) ? tr.saturationCurve as [number, number][] : null,
          invertCurve: Array.isArray(tr.invertCurve) ? tr.invertCurve as [number, number][] : null,
          brightnessCurve: Array.isArray(tr.brightnessCurve) ? tr.brightnessCurve as [number, number][] : null,
          contrastCurve: Array.isArray(tr.contrastCurve) ? tr.contrastCurve as [number, number][] : null,
          exposureCurve: Array.isArray(tr.exposureCurve) ? tr.exposureCurve as [number, number][] : null,
          chromaKey: tr.chromaKey && typeof tr.chromaKey === 'object' ? tr.chromaKey as { color: [number, number, number]; threshold: number; feather: number } : null,
          isAdjustment: !!tr.isAdjustment,
          maskCenterX: tr.maskCenterX != null ? tr.maskCenterX as number : null,
          maskCenterY: tr.maskCenterY != null ? tr.maskCenterY as number : null,
          maskRadius: tr.maskRadius != null ? tr.maskRadius as number : null,
          maskFeather: tr.maskFeather != null ? tr.maskFeather as number : null,
          transformX: tr.transformX != null ? tr.transformX as number : null,
          transformY: tr.transformY != null ? tr.transformY as number : null,
          transformXCurve: tr.transformXCurve ?? null,
          transformYCurve: tr.transformYCurve ?? null,
          transformZCurve: tr.transformZCurve ?? null,
          anchorX: tr.anchorX != null ? tr.anchorX as number : null,
          anchorY: tr.anchorY != null ? tr.anchorY as number : null,
          hidden: !!tr.hidden,
          effects: Array.isArray(tr.effects) ? tr.effects as TransitionEffect[] : [],
          ingredients: Array.isArray(tr.ingredients) ? tr.ingredients as string[] : [],
          negativePrompt: (tr.negativePrompt as string) || '',
          seed: tr.seed != null ? tr.seed as number : null,
        }
      }),
    }
  })

export const getAudioIntelligenceData = createServerFn({ method: 'GET' })
  .inputValidator((input: { name: string }) => input)
  .handler(async ({ data }) => {
    const aiData = await fetchAudioIntelligence(data.name).catch(() => ({ activeFile: null, events: [], sections: [], rules: [], ruleCount: 0 }))
    return {
      audioEvents: aiData.events || [],
      audioRules: aiData.rules || [],
      audioOnsets: (aiData as Record<string, unknown>).onsets as Record<string, Record<string, { time: number; strength: number }[]>> || {},
    }
  })

export function secondsToTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  const whole = Math.floor(s)
  const frac = s - whole
  if (frac < 0.005) {
    return `${m}:${whole.toString().padStart(2, '0')}`
  }
  return `${m}:${whole.toString().padStart(2, '0')}.${Math.round(frac * 100).toString().padStart(2, '0')}`
}

export const updateKeyframeTimestamp = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string; newTimestamp: string }) => input)
  .handler(async ({ data }) => {
    return postUpdateTimestamp(data.projectName, data.keyframeId, data.newTimestamp)
  })

export const addKeyframe = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; timestamp: string; section: string; prompt: string; trackId?: string }) => input)
  .handler(async ({ data }) => {
    console.log('[serverFn] addKeyframe:', data.projectName, data.timestamp, data.trackId)
    try {
      const result = await postAddKeyframe(data.projectName, data.timestamp, data.section, data.prompt, data.trackId)
      console.log('[serverFn] addKeyframe result:', JSON.stringify(result).slice(0, 200))
      return result
    } catch (e) {
      console.error('[serverFn] addKeyframe FAILED:', e)
      throw e
    }
  })

export const duplicateKeyframe = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string; timestamp: string }) => input)
  .handler(async ({ data }) => {
    return postDuplicateKeyframe(data.projectName, data.keyframeId, data.timestamp)
  })

export const batchDeleteKeyframes = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeIds: string[] }) => input)
  .handler(async ({ data }) => {
    const { postBatchDeleteKeyframes } = await import('@/lib/scenecraft-client')
    return postBatchDeleteKeyframes(data.projectName, data.keyframeIds)
  })

export const deleteKeyframe = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string }) => input)
  .handler(async ({ data }) => {
    console.log('[deleteKeyframe] projectName:', data.projectName, 'keyframeId:', data.keyframeId)
    try {
      const result = await postDeleteKeyframe(data.projectName, data.keyframeId)
      console.log('[deleteKeyframe] result:', JSON.stringify(result))
      return result
    } catch (e) {
      console.error('[deleteKeyframe] ERROR:', e)
      throw e
    }
  })

export const restoreKeyframe = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string }) => input)
  .handler(async ({ data }) => {
    return postRestoreKeyframe(data.projectName, data.keyframeId)
  })

export const updateKeyframePrompt = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string; prompt: string }) => input)
  .handler(async ({ data }) => {
    return postUpdatePrompt(data.projectName, data.keyframeId, data.prompt)
  })

export const setBaseImage = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string; stillName: string }) => input)
  .handler(async ({ data }) => {
    const { postSetBaseImage } = await import('@/lib/scenecraft-client')
    return postSetBaseImage(data.projectName, data.keyframeId, data.stillName)
  })

export const selectKeyframes = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; selections: Record<string, number> }) => input)
  .handler(async ({ data }) => {
    return postSelectKeyframes(data.projectName, data.selections)
  })

export const suggestKeyframePrompts = createServerFn({ method: 'POST' })
  .inputValidator((input: {
    projectName: string
    sectionLabel: string
    sectionContent: string
    events: Array<{ time: number; effect: string; intensity: number; stem_source: string }>
    baseStillName: string
  }) => input)
  .handler(async ({ data }) => {
    const { postSuggestKeyframePrompts } = await import('@/lib/scenecraft-client')
    return postSuggestKeyframePrompts(data.projectName, {
      sectionLabel: data.sectionLabel,
      sectionContent: data.sectionContent,
      events: data.events,
      baseStillName: data.baseStillName,
    })
  })

export const enhanceKeyframePrompt = createServerFn({ method: 'POST' })
  .inputValidator((input: {
    projectName: string
    prompt: string
    sectionContent: string
    event: { time: number; effect: string; intensity: number; stem_source: string; rationale?: string }
  }) => input)
  .handler(async ({ data }) => {
    const { postEnhanceKeyframePrompt } = await import('@/lib/scenecraft-client')
    return postEnhanceKeyframePrompt(data.projectName, {
      prompt: data.prompt,
      sectionContent: data.sectionContent,
      event: data.event,
    })
  })

export const promoteStagedCandidate = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string; stagingId: string; variant: number }) => input)
  .handler(async ({ data }) => {
    const { postPromoteStagedCandidate } = await import('@/lib/scenecraft-client')
    return postPromoteStagedCandidate(data.projectName, data.keyframeId, data.stagingId, data.variant)
  })

export const generateStagedCandidate = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; prompt: string; stillName: string; stagingId: string; count?: number }) => input)
  .handler(async ({ data }) => {
    const { postGenerateStagedCandidate } = await import('@/lib/scenecraft-client')
    return postGenerateStagedCandidate(data.projectName, data.prompt, data.stillName, data.stagingId, data.count)
  })

export const generateKeyframeVariations = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string; count?: number }) => input)
  .handler(async ({ data }) => {
    const { postGenerateKeyframeVariations } = await import('@/lib/scenecraft-client')
    return postGenerateKeyframeVariations(data.projectName, data.keyframeId, data.count)
  })

export const escalateKeyframe = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string; count?: number }) => input)
  .handler(async ({ data }) => {
    const { postEscalateKeyframe } = await import('@/lib/scenecraft-client')
    return postEscalateKeyframe(data.projectName, data.keyframeId, data.count)
  })

export const generateKeyframeCandidates = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string; count?: number; refinementPrompt?: string; freeform?: boolean }) => input)
  .handler(async ({ data }) => {
    return postGenerateKeyframeCandidates(data.projectName, data.keyframeId, data.count, data.refinementPrompt, data.freeform)
  })

export const generateTransitionAction = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId: string; sectionContext?: string }) => input)
  .handler(async ({ data }) => {
    return postGenerateTransitionAction(data.projectName, data.transitionId, data.sectionContext)
  })

export const enhanceTransitionAction = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId: string; action: string; sectionContext?: string }) => input)
  .handler(async ({ data }) => {
    const { postEnhanceTransitionAction } = await import('@/lib/scenecraft-client')
    return postEnhanceTransitionAction(data.projectName, data.transitionId, data.action, data.sectionContext)
  })

export const updateTransitionAction = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId: string; action: string; useGlobalPrompt: boolean; includeSectionDesc?: boolean; slotActions?: string[]; negativePrompt?: string; seed?: number | null; ingredients?: string[] }) => input)
  .handler(async ({ data }) => {
    return postUpdateTransitionAction(data.projectName, data.transitionId, data.action, data.useGlobalPrompt, data.slotActions, data.includeSectionDesc, data.negativePrompt, data.seed, data.ingredients)
  })

export const updateMeta = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; fields: Record<string, string> }) => input)
  .handler(async ({ data }) => {
    return postUpdateMeta(data.projectName, data.fields)
  })

export const updateTransitionRemap = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId: string; targetDuration: number }) => input)
  .handler(async ({ data }) => {
    return postUpdateTransitionRemap(data.projectName, data.transitionId, data.targetDuration)
  })

export const selectTransitions = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; selections: Record<string, string | number | null> }) => input)
  .handler(async ({ data }) => {
    return postSelectTransitions(data.projectName, data.selections)
  })

export const generateTransitionCandidates = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId: string; count?: number; slotIndex?: number; duration?: number; useNextTransitionFrame?: boolean; noEndFrame?: boolean; generateAudio?: boolean; ingredients?: string[]; negativePrompt?: string; seed?: number | null }) => input)
  .handler(async ({ data }) => {
    console.log('[serverFn] generateTransitionCandidates:', data.projectName, data.transitionId, data.count, 'duration:', data.duration, 'useNextTrFrame:', data.useNextTransitionFrame, 'noEndFrame:', data.noEndFrame, 'generateAudio:', data.generateAudio, 'ingredients:', data.ingredients?.length || 0)
    try {
      const result = await postGenerateTransitionCandidates(data.projectName, data.transitionId, data.count, data.slotIndex, data.duration, data.useNextTransitionFrame, data.noEndFrame, data.generateAudio, data.ingredients, data.negativePrompt, data.seed)
      console.log('[serverFn] generateTransitionCandidates result:', JSON.stringify(result).slice(0, 200))
      return result
    } catch (e) {
      console.error('[serverFn] generateTransitionCandidates FAILED:', e)
      throw e
    }
  })

export const fetchProjectIngredients = createServerFn({ method: 'GET' })
  .inputValidator((input: { projectName: string }) => input)
  .handler(async ({ data }) => {
    const { fetchIngredients } = await import('@/lib/scenecraft-client')
    return fetchIngredients(data.projectName)
  })

export const promoteToIngredient = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; sourceType: 'keyframe' | 'pool'; sourcePath: string; label?: string }) => input)
  .handler(async ({ data }) => {
    const { postPromoteToIngredient } = await import('@/lib/scenecraft-client')
    return postPromoteToIngredient(data.projectName, data.sourceType, data.sourcePath, data.label)
  })

export const removeIngredient = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; ingredientId: string }) => input)
  .handler(async ({ data }) => {
    const { postRemoveIngredient } = await import('@/lib/scenecraft-client')
    return postRemoveIngredient(data.projectName, data.ingredientId)
  })

export const extendVideo = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId: string; videoPath: string }) => input)
  .handler(async ({ data }) => {
    const { postExtendVideo } = await import('@/lib/scenecraft-client')
    return postExtendVideo(data.projectName, data.transitionId, data.videoPath)
  })

export const deleteTransition = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId: string }) => input)
  .handler(async ({ data }) => {
    return postDeleteTransition(data.projectName, data.transitionId)
  })

export const restoreTransition = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId: string }) => input)
  .handler(async ({ data }) => {
    return postRestoreTransition(data.projectName, data.transitionId)
  })

export const saveEffects = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; effects: UserEffect[]; suppressions: BeatSuppression[] }) => input)
  .handler(async ({ data }) => {
    // Guard: fetch current suppressions from DB before overwriting.
    // If the caller sends 0 suppressions but the DB has some, the caller's state
    // was likely stale (e.g. failed initial fetch). Preserve the DB suppressions.
    if (data.suppressions.length === 0) {
      const current = await fetchEffects(data.projectName).catch(() => ({ effects: [], suppressions: [] }))
      if (current.suppressions && current.suppressions.length > 0) {
        console.warn(`[saveEffects] caller sent 0 suppressions but DB has ${current.suppressions.length} — preserving DB suppressions`)
        return postUpdateEffects(data.projectName, data.effects, current.suppressions)
      }
    }
    return postUpdateEffects(data.projectName, data.effects, data.suppressions)
  })

export const importAssets = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; sourcePath: string; timestamp?: string }) => input)
  .handler(async ({ data }) => {
    return postImport(data.projectName, data.sourcePath, data.timestamp)
  })

export const getBin = createServerFn({ method: 'GET' })
  .inputValidator((input: { projectName: string }) => input)
  .handler(async ({ data }) => {
    return fetchBin(data.projectName)
  })

export const Route = createFileRoute('/project/$name/editor')({
  component: EditorPage,
  loader: ({ params }) => getEditorData({ data: { name: params.name } }),
  staleTime: Infinity, // Only re-fetch on router.invalidate() (after mutations)
})

function EditorPage() {
  const data = Route.useLoaderData()
  const { name } = Route.useParams()
  // Block browser zoom globally in the editor (Ctrl+scroll, pinch-to-zoom, Ctrl+/-)
  useEffect(() => {
    const onWheel = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '-' || e.key === '+')) e.preventDefault()
    }
    document.addEventListener('wheel', onWheel, { passive: false })
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('wheel', onWheel); document.removeEventListener('keydown', onKey) }
  }, [])
  const layoutRef = useRef<EditorPanelLayoutHandle>(null)

  return (
    <JobStateProvider>
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
        <Link
          to="/project/$name"
          params={{ name }}
          className="text-sm text-gray-500 hover:text-gray-300"
        >
          &larr; Back
        </Link>
        <h1 className="text-sm font-medium">{data.meta.title}</h1>
        <span className="text-xs text-gray-600">{data.meta.fps}fps</span>
        <span className="text-xs text-gray-600">{data.keyframes.length} keyframes</span>
        {data.timelineInfo && (
          <span className="text-xs text-purple-400 font-mono">{data.timelineInfo.active}</span>
        )}
        <button
          onClick={() => layoutRef.current?.resetLayout()}
          className="text-xs text-gray-500 hover:text-gray-300 bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded transition-colors"
        >
          Reset Layout
        </button>
      </div>

      <div className="flex-1 min-h-0">
        <EditorPanelLayout ref={layoutRef} data={data} />
      </div>

      {/* Status bar */}
      <StatusBar />
    </div>
    </JobStateProvider>
  )
}
