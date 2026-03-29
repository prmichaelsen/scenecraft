import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { Timeline } from '@/components/editor/Timeline'
import {
  fetchKeyframes,
  fetchBeats,
  fetchBin,
  postUpdateTimestamp,
  postAddKeyframe,
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
  postGenerateSlotKeyframeCandidates,
  postSelectSlotKeyframes,
  fetchEffects,
  fetchAudioIntelligence,
  type AudioEvent,
  postUpdateEffects,
  type UserEffect,
  type BeatSuppression,
} from '@/lib/beatlab-client'
import {
  fetchNarrative,
  fetchTimelines,
  type NarrativeSection,
  type TimelineInfo,
} from '@/lib/timeline-client'

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

export type Transition = {
  id: string
  from: string
  to: string
  durationSeconds: number
  slots: number
  action: string
  useGlobalPrompt: boolean
  candidates: Record<string, string[]>  // slot_0: ["path/v1.mp4", ...], slot_1: [...]
  hasSelectedVideos: boolean[]
  selected: (number | string | null)[]  // per-slot: variant number (1-based), imported path, or null
  remap: { method: string; target_duration: number }
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
  narrativeSections: NarrativeSection[]
  timelineInfo: TimelineInfo | null
  userEffects: UserEffect[]
  beatSuppressions: BeatSuppression[]
}

const getEditorData = createServerFn({ method: 'GET' })
  .inputValidator((input: { name: string }) => input)
  .handler(async ({ data }): Promise<EditorData> => {
    const [kfData, beatsData, effectsData, narrativeData, timelineData, aiData] = await Promise.all([
      fetchKeyframes(data.name).catch(() => ({ meta: null, keyframes: [], transitions: [], audioFile: null })),
      fetchBeats(data.name).catch(() => ({ beats: [], sections: [] })),
      fetchEffects(data.name).catch(() => ({ effects: [], suppressions: [] })),
      fetchNarrative(data.name).catch(() => ({ sections: [] })),
      fetchTimelines(data.name).catch(() => null),
      fetchAudioIntelligence(data.name).catch(() => ({ activeFile: null, events: [], sections: [], ruleCount: 0 })),
    ])

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
      })),
      transitions: (kfData.transitions || []).map((tr: Record<string, unknown>) => ({
        id: tr.id as string,
        from: tr.from as string,
        to: tr.to as string,
        durationSeconds: tr.durationSeconds as number,
        slots: tr.slots as number,
        action: (tr.action as string) || '',
        useGlobalPrompt: tr.useGlobalPrompt !== false,
        candidates: (tr.candidates as Record<string, string[]>) || {},
        hasSelectedVideos: (tr.hasSelectedVideos as boolean[]) || [],
        selected: (tr.selected as (number | string | null)[]) || [],
        remap: (tr.remap as Transition['remap']) || { method: 'linear', target_duration: 0 },
      })),
      audioFile: kfData.audioFile || null,
      projectName: data.name,
      beats: Array.isArray(beatsData.beats) ? beatsData.beats : [],
      sections: Array.isArray(beatsData.sections) ? beatsData.sections : [],
      audioEvents: aiData.events || [],
      narrativeSections: narrativeData.sections || [],
      timelineInfo: timelineData,
      userEffects: effectsData.effects || [],
      beatSuppressions: effectsData.suppressions || [],
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
  .inputValidator((input: { projectName: string; timestamp: string; section: string; prompt: string }) => input)
  .handler(async ({ data }) => {
    return postAddKeyframe(data.projectName, data.timestamp, data.section, data.prompt)
  })

export const deleteKeyframe = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string }) => input)
  .handler(async ({ data }) => {
    return postDeleteKeyframe(data.projectName, data.keyframeId)
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

export const selectKeyframes = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; selections: Record<string, number> }) => input)
  .handler(async ({ data }) => {
    return postSelectKeyframes(data.projectName, data.selections)
  })

export const generateSlotKeyframeCandidates = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId?: string }) => input)
  .handler(async ({ data }) => {
    return postGenerateSlotKeyframeCandidates(data.projectName, data.transitionId)
  })

export const selectSlotKeyframes = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; selections: Record<string, number> }) => input)
  .handler(async ({ data }) => {
    return postSelectSlotKeyframes(data.projectName, data.selections)
  })

export const generateKeyframeCandidates = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string; count?: number }) => input)
  .handler(async ({ data }) => {
    return postGenerateKeyframeCandidates(data.projectName, data.keyframeId, data.count)
  })

export const generateTransitionAction = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId: string }) => input)
  .handler(async ({ data }) => {
    return postGenerateTransitionAction(data.projectName, data.transitionId)
  })

export const updateTransitionAction = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId: string; action: string; useGlobalPrompt: boolean }) => input)
  .handler(async ({ data }) => {
    return postUpdateTransitionAction(data.projectName, data.transitionId, data.action, data.useGlobalPrompt)
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
  .inputValidator((input: { projectName: string; selections: Record<string, number> }) => input)
  .handler(async ({ data }) => {
    return postSelectTransitions(data.projectName, data.selections)
  })

export const generateTransitionCandidates = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; transitionId: string; count?: number }) => input)
  .handler(async ({ data }) => {
    return postGenerateTransitionCandidates(data.projectName, data.transitionId, data.count)
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

  return (
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
      </div>

      {/* Timeline */}
      <div className="flex-1 min-h-0">
        <Timeline data={data} />
      </div>
    </div>
  )
}
