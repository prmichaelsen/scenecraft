import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { fetchProjects, postCreateProject } from '@/lib/scenecraft-client'
import { useState } from 'react'

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
  const router = useRouter()
  const [creating, setCreating] = useState(false)

  const handleCreateProject = async () => {
    const name = prompt('Project name:')
    if (!name?.trim()) return
    setCreating(true)
    try {
      await postCreateProject(name.trim())
      window.location.href = `/project/${encodeURIComponent(name.trim())}/editor`
    } catch (e) {
      alert(`Failed: ${e}`)
      setCreating(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold mb-1">SceneCraft</h1>
          <p className="text-gray-400 text-sm">AI powered video editing</p>
        </div>
        <button
          onClick={handleCreateProject}
          disabled={creating}
          className="text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white px-4 py-2 rounded transition-colors"
        >
          {creating ? 'Creating...' : '+ New Project'}
        </button>
      </div>

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
