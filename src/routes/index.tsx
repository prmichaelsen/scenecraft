import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const BEATLAB_WORK_DIR = process.env.BEATLAB_WORK_DIR
  || join(process.env.HOME || '', '.acp/projects/davinci-beat-lab/.beatlab_work')

const getProjects = createServerFn({ method: 'GET' }).handler(async () => {
  const entries = await readdir(BEATLAB_WORK_DIR, { withFileTypes: true })
  const projects = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const dirPath = join(BEATLAB_WORK_DIR, e.name)
        const files = await readdir(dirPath)
        const hasAudio = files.some((f) => f.endsWith('.wav') || f.endsWith('.mp3'))
        const hasVideo = files.some((f) => f.endsWith('.mp4'))
        const dirStat = await stat(dirPath)
        return {
          name: e.name,
          hasAudio,
          hasVideo,
          fileCount: files.length,
          modified: dirStat.mtimeMs,
        }
      })
  )
  return projects.sort((a, b) => b.modified - a.modified)
})

export const Route = createFileRoute('/')({
  component: HomePage,
  loader: () => getProjects(),
})

function HomePage() {
  const projects = Route.useLoaderData()

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-1">Beatlab Synthesizer</h1>
      <p className="text-gray-400 mb-8 text-sm">Browse and play project media files</p>

      <div className="space-y-2">
        {projects.map((project) => (
          <a
            key={project.name}
            href={`/project/${encodeURIComponent(project.name)}`}
            className="block bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 hover:border-gray-600 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{project.name}</div>
                <div className="text-sm text-gray-500 mt-0.5">
                  {project.fileCount} files
                  {project.hasAudio && <span className="ml-2 text-blue-400">audio</span>}
                  {project.hasVideo && <span className="ml-2 text-purple-400">video</span>}
                </div>
              </div>
              <div className="text-gray-600 text-xs">
                {new Date(project.modified).toLocaleDateString()}
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}
