import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Timeline } from '@/components/editor/Timeline'

const BEATLAB_WORK_DIR = process.env.BEATLAB_WORK_DIR
  || join(process.env.HOME || '', '.acp/projects/davinci-beat-lab/.beatlab_work')

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

export type EditorData = {
  meta: {
    title: string
    fps: number
    resolution: [number, number]
  }
  keyframes: Keyframe[]
  audioFile: string | null
  projectName: string
}

const getEditorData = createServerFn({ method: 'GET' })
  .inputValidator((input: { name: string }) => input)
  .handler(async ({ data }): Promise<EditorData> => {
    const projectDir = join(BEATLAB_WORK_DIR, data.name)

    // Load narrative_keyframes.yaml
    let keyframes: Keyframe[] = []
    let meta = { title: data.name, fps: 24, resolution: [1920, 1080] as [number, number] }

    try {
      const yamlContent = await readFile(join(projectDir, 'narrative_keyframes.yaml'), 'utf-8')
      const parsed = yaml.load(yamlContent) as Record<string, unknown>

      if (parsed?.meta) {
        const m = parsed.meta as Record<string, unknown>
        meta = {
          title: (m.title as string) || data.name,
          fps: (m.fps as number) || 24,
          resolution: (m.resolution as [number, number]) || [1920, 1080],
        }
      }

      if (Array.isArray(parsed?.keyframes)) {
        keyframes = await Promise.all(
          (parsed.keyframes as Array<Record<string, unknown>>).map(async (kf) => {
            const id = kf.id as string
            // Check if selected keyframe image exists
            const imgPath = join(projectDir, 'selected_keyframes', `${id}.png`)
            let hasSelectedImage = false
            try {
              await access(imgPath)
              hasSelectedImage = true
            } catch {}

            const ctx = kf.context as Record<string, unknown> | undefined
            return {
              id,
              timestamp: kf.timestamp as string,
              section: kf.section as string,
              prompt: (kf.prompt as string) || '',
              selected: kf.selected as number | string | null,
              hasSelectedImage,
              context: ctx ? {
                mood: (ctx.mood as string) || '',
                energy: (ctx.energy as string) || '',
                instruments: (ctx.instruments as string[]) || [],
                motifs: (ctx.motifs as string[]) || [],
                events: (ctx.events as string[]) || [],
                visual_direction: (ctx.visual_direction as string) || '',
                details: (ctx.details as string) || '',
              } : null,
              candidates: Array.isArray(kf.candidates)
                ? (kf.candidates as Array<string | Record<string, unknown>>).map((c) =>
                    typeof c === 'string' ? c : (c.path as string) || ''
                  ).filter(Boolean)
                : [],
            }
          })
        )
      }
    } catch {
      // No narrative_keyframes.yaml — that's OK
    }

    // Find audio file
    let audioFile: string | null = null
    for (const candidate of ['audio.wav', 'audio.mp3']) {
      try {
        await access(join(projectDir, candidate))
        audioFile = candidate
        break
      } catch {}
    }

    return { meta, keyframes, audioFile, projectName: data.name }
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
    const yamlPath = join(BEATLAB_WORK_DIR, data.projectName, 'narrative_keyframes.yaml')
    const content = await readFile(yamlPath, 'utf-8')

    // Find and replace the timestamp for the specific keyframe
    // The YAML structure has `- id: kf_XXX\n  timestamp: M:SS` patterns
    const idPattern = `- id: ${data.keyframeId}`
    const idx = content.indexOf(idPattern)
    if (idx === -1) {
      return { success: false, error: 'Keyframe not found' }
    }

    // Find the timestamp field after this id
    const tsPattern = /\n(\s+)timestamp:\s*'?([^'\n]+)'?/
    const after = content.slice(idx)
    const match = after.match(tsPattern)
    if (!match) {
      return { success: false, error: 'Timestamp field not found' }
    }

    const fullMatch = match[0]
    const indent = match[1]
    const replacement = `\n${indent}timestamp: '${data.newTimestamp}'`

    const updated = content.slice(0, idx) + after.replace(fullMatch, replacement)
    await writeFile(yamlPath, updated, 'utf-8')

    return { success: true }
  })

export const addKeyframe = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; timestamp: string; section: string; prompt: string }) => input)
  .handler(async ({ data }) => {
    const yamlPath = join(BEATLAB_WORK_DIR, data.projectName, 'narrative_keyframes.yaml')
    const content = await readFile(yamlPath, 'utf-8')
    const parsed = yaml.load(content) as Record<string, unknown>
    const keyframes = (parsed.keyframes || []) as Array<Record<string, unknown>>

    // Find next ID
    const maxNum = keyframes.reduce((max, kf) => {
      const m = (kf.id as string).match(/kf_(\d+)/)
      return m ? Math.max(max, parseInt(m[1], 10)) : max
    }, 0)
    const newId = `kf_${String(maxNum + 1).padStart(3, '0')}`

    const newKf = {
      id: newId,
      timestamp: data.timestamp,
      section: data.section,
      source: 'assets/stills/default.png',
      prompt: data.prompt,
      context: null,
      candidates: [],
      selected: null,
    }

    keyframes.push(newKf)
    // Sort by timestamp
    keyframes.sort((a, b) => {
      const ta = parseTs(a.timestamp as string)
      const tb = parseTs(b.timestamp as string)
      return ta - tb
    })

    parsed.keyframes = keyframes
    await writeFile(yamlPath, yaml.dump(parsed, { lineWidth: -1, quotingType: "'", forceQuotes: false }), 'utf-8')
    return { success: true, id: newId }
  })

export const deleteKeyframe = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string }) => input)
  .handler(async ({ data }) => {
    const yamlPath = join(BEATLAB_WORK_DIR, data.projectName, 'narrative_keyframes.yaml')
    const content = await readFile(yamlPath, 'utf-8')
    const parsed = yaml.load(content) as Record<string, unknown>
    const keyframes = (parsed.keyframes || []) as Array<Record<string, unknown>>

    const idx = keyframes.findIndex((kf) => kf.id === data.keyframeId)
    if (idx === -1) return { success: false, error: 'Keyframe not found' }

    const [removed] = keyframes.splice(idx, 1)

    // Add to bin
    const bin = (parsed.bin || []) as Array<Record<string, unknown>>
    bin.push({ ...removed, deleted_at: new Date().toISOString() })
    parsed.bin = bin
    parsed.keyframes = keyframes

    await writeFile(yamlPath, yaml.dump(parsed, { lineWidth: -1, quotingType: "'", forceQuotes: false }), 'utf-8')
    return { success: true }
  })

export const restoreKeyframe = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string }) => input)
  .handler(async ({ data }) => {
    const yamlPath = join(BEATLAB_WORK_DIR, data.projectName, 'narrative_keyframes.yaml')
    const content = await readFile(yamlPath, 'utf-8')
    const parsed = yaml.load(content) as Record<string, unknown>
    const keyframes = (parsed.keyframes || []) as Array<Record<string, unknown>>
    const bin = (parsed.bin || []) as Array<Record<string, unknown>>

    const idx = bin.findIndex((kf) => kf.id === data.keyframeId)
    if (idx === -1) return { success: false, error: 'Keyframe not in bin' }

    const [restored] = bin.splice(idx, 1)
    delete restored.deleted_at
    keyframes.push(restored)
    keyframes.sort((a, b) => parseTs(a.timestamp as string) - parseTs(b.timestamp as string))

    parsed.keyframes = keyframes
    parsed.bin = bin
    await writeFile(yamlPath, yaml.dump(parsed, { lineWidth: -1, quotingType: "'", forceQuotes: false }), 'utf-8')
    return { success: true }
  })

export const updateKeyframePrompt = createServerFn({ method: 'POST' })
  .inputValidator((input: { projectName: string; keyframeId: string; prompt: string }) => input)
  .handler(async ({ data }) => {
    const yamlPath = join(BEATLAB_WORK_DIR, data.projectName, 'narrative_keyframes.yaml')
    const content = await readFile(yamlPath, 'utf-8')
    const parsed = yaml.load(content) as Record<string, unknown>
    const keyframes = (parsed.keyframes || []) as Array<Record<string, unknown>>

    const kf = keyframes.find((k) => k.id === data.keyframeId)
    if (!kf) return { success: false, error: 'Keyframe not found' }

    kf.prompt = data.prompt
    parsed.keyframes = keyframes
    await writeFile(yamlPath, yaml.dump(parsed, { lineWidth: -1, quotingType: "'", forceQuotes: false }), 'utf-8')
    return { success: true }
  })

function parseTs(ts: string): number {
  const parts = ts.split(':')
  if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseFloat(parts[1])
  return 0
}

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
