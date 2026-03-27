import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { fetchProjects } from '@/lib/beatlab-client'

const getProjects = createServerFn({ method: 'GET' }).handler(async () => {
  const projects = await fetchProjects()
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
