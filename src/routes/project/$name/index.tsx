import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { readdir, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'

const BEATLAB_WORK_DIR = process.env.BEATLAB_WORK_DIR
  || join(process.env.HOME || '', '.acp/projects/davinci-beat-lab/.beatlab_work')

type FileEntry = {
  name: string
  type: 'audio' | 'video' | 'image' | 'json' | 'text' | 'other'
  size: number
  isDirectory: boolean
}

function classifyFile(name: string): FileEntry['type'] {
  const ext = extname(name).toLowerCase()
  if (['.wav', '.mp3', '.flac', '.ogg'].includes(ext)) return 'audio'
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'video'
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image'
  if (ext === '.json') return 'json'
  if (['.md', '.txt', '.yaml', '.yml'].includes(ext)) return 'text'
  return 'other'
}

const getProjectFiles = createServerFn({ method: 'GET' })
  .inputValidator((input: { name: string }) => input)
  .handler(async ({ data }) => {
    const projectDir = join(BEATLAB_WORK_DIR, data.name)
    const targetDir = projectDir
    const entries = await readdir(targetDir, { withFileTypes: true })

    const files: FileEntry[] = await Promise.all(
      entries.map(async (e) => {
        const fullPath = join(targetDir, e.name)
        const fileStat = await stat(fullPath)
        return {
          name: e.name,
          type: classifyFile(e.name),
          size: fileStat.size,
          isDirectory: e.isDirectory(),
        }
      })
    )

    // Sort: directories first, then by type, then name
    return files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  })

export const Route = createFileRoute('/project/$name/')({
  component: ProjectPage,
  loader: ({ params }) => getProjectFiles({ data: { name: params.name } }),
})

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const TYPE_COLORS: Record<FileEntry['type'], string> = {
  audio: 'text-blue-400',
  video: 'text-purple-400',
  image: 'text-green-400',
  json: 'text-yellow-400',
  text: 'text-gray-400',
  other: 'text-gray-600',
}

function ProjectPage() {
  const { name } = Route.useParams()
  const files = Route.useLoaderData()
  const mediaFiles = files.filter((f) => f.type === 'audio' || f.type === 'video')

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <Link to="/" className="text-sm text-gray-500 hover:text-gray-300">
          &larr; All Projects
        </Link>
        <h1 className="text-2xl font-bold mt-2">{decodeURIComponent(name)}</h1>
        <Link
          to="/project/$name/editor"
          params={{ name }}
          className="inline-block mt-2 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors"
        >
          Open Editor
        </Link>
      </div>

      {/* Media Player Section */}
      {mediaFiles.length > 0 && (
        <div className="mb-8 space-y-4">
          <h2 className="text-lg font-semibold text-gray-300">Media</h2>
          {mediaFiles.map((file) => (
            <div key={file.name} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <div className="text-sm text-gray-400 mb-2">
                {file.name}
                <span className="ml-2 text-gray-600">{formatSize(file.size)}</span>
              </div>
              {file.type === 'audio' ? (
                <audio
                  controls
                  className="w-full"
                  src={`/api/files/${encodeURIComponent(name)}/${encodeURIComponent(file.name)}`}
                />
              ) : (
                <video
                  controls
                  className="w-full rounded max-h-[500px]"
                  src={`/api/files/${encodeURIComponent(name)}/${encodeURIComponent(file.name)}`}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* File List */}
      <div>
        <h2 className="text-lg font-semibold text-gray-300 mb-3">Files</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
          {files.map((file) => (
            <div
              key={file.name}
              className="flex items-center justify-between px-4 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                {file.isDirectory ? (
                  <span className="text-gray-500">📁</span>
                ) : (
                  <span className={TYPE_COLORS[file.type]}>●</span>
                )}
                <span className={file.isDirectory ? 'text-gray-300' : ''}>{file.name}</span>
              </div>
              <span className="text-gray-600 text-xs">
                {file.isDirectory ? 'dir' : formatSize(file.size)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
