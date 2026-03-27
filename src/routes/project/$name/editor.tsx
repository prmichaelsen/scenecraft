import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { Timeline } from '@/components/editor/Timeline'
import {
  fetchKeyframes,
  fetchBeats,
  postUpdateTimestamp,
  postAddKeyframe,
  postDeleteKeyframe,
  postRestoreKeyframe,
  postUpdatePrompt,
} from '@/lib/beatlab-client'

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

export type EditorData = {
  meta: {
    title: string
    fps: number
    resolution: [number, number]
  }
  keyframes: Keyframe[]
  audioFile: string | null
  projectName: string
  beats: Beat[]
  sections: Section[]
}

const getEditorData = createServerFn({ method: 'GET' })
  .inputValidator((input: { name: string }) => input)
  .handler(async ({ data }): Promise<EditorData> => {
    const [kfData, beatsData] = await Promise.all([
      fetchKeyframes(data.name),
      fetchBeats(data.name).catch(() => ({ beats: [], sections: [] })),
    ])

    return {
      meta: kfData.meta || { title: data.name, fps: 24, resolution: [1920, 1080] },
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
      audioFile: kfData.audioFile || null,
      projectName: data.name,
      beats: Array.isArray(beatsData.beats) ? beatsData.beats : [],
      sections: Array.isArray(beatsData.sections) ? beatsData.sections : [],
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

export const Route = createFileRoute('/project/$name/editor')({
  component: EditorPage,
  loader: ({ params }) => getEditorData({ data: { name: params.name } }),
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
      </div>

      {/* Timeline */}
      <div className="flex-1 min-h-0">
        <Timeline data={data} />
      </div>
    </div>
  )
}
