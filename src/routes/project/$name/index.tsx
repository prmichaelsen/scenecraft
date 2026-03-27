import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState, useCallback } from 'react'
import { beatlabFileUrl, fetchDirectoryListing, type FileEntry } from '@/lib/beatlab-client'

const getProjectFiles = createServerFn({ method: 'GET' })
  .inputValidator((input: { name: string; path?: string }) => input)
  .handler(async ({ data }) => {
    return fetchDirectoryListing(data.name, data.path || '')
  })

export const Route = createFileRoute('/project/$name/')({
  component: ProjectPage,
  loader: ({ params }) => getProjectFiles({ data: { name: params.name } }),
})

function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function fileType(name: string): 'audio' | 'video' | 'image' | 'text' | 'other' {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (['wav', 'mp3', 'flac', 'ogg'].includes(ext)) return 'audio'
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image'
  if (['md', 'txt', 'yaml', 'yml', 'json'].includes(ext)) return 'text'
  return 'other'
}

const TYPE_COLORS: Record<string, string> = {
  audio: 'text-blue-400',
  video: 'text-purple-400',
  image: 'text-green-400',
  text: 'text-gray-400',
  other: 'text-gray-600',
}

function ProjectPage() {
  const { name } = Route.useParams()
  const initialFiles = Route.useLoaderData()
  const [currentPath, setCurrentPath] = useState('')
  const [files, setFiles] = useState<FileEntry[]>(initialFiles)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<FileEntry | null>(null)

  const navigateTo = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const entries = await getProjectFiles({ data: { name, path } })
      setFiles(entries)
      setCurrentPath(path)
      setPreview(null)
    } finally {
      setLoading(false)
    }
  }, [name])

  const navigateUp = useCallback(() => {
    const parts = currentPath.split('/').filter(Boolean)
    parts.pop()
    navigateTo(parts.join('/'))
  }, [currentPath, navigateTo])

  const breadcrumbs = currentPath ? currentPath.split('/').filter(Boolean) : []

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="mb-6">
        <Link to="/" className="text-sm text-gray-500 hover:text-gray-300">
          &larr; All Projects
        </Link>
        <div className="flex items-center gap-3 mt-2">
          <h1 className="text-2xl font-bold">{decodeURIComponent(name)}</h1>
          <Link
            to="/project/$name/editor"
            params={{ name }}
            className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors"
          >
            Open Editor
          </Link>
        </div>
      </div>

      {/* Breadcrumb path */}
      <div className="flex items-center gap-1 text-sm mb-3 min-h-[24px]">
        <button
          onClick={() => navigateTo('')}
          className={`hover:text-gray-200 transition-colors ${currentPath ? 'text-blue-400' : 'text-gray-300'}`}
        >
          /
        </button>
        {breadcrumbs.map((part, i) => {
          const pathUpTo = breadcrumbs.slice(0, i + 1).join('/')
          const isLast = i === breadcrumbs.length - 1
          return (
            <span key={pathUpTo} className="flex items-center gap-1">
              <span className="text-gray-600">/</span>
              {isLast ? (
                <span className="text-gray-300">{part}</span>
              ) : (
                <button
                  onClick={() => navigateTo(pathUpTo)}
                  className="text-blue-400 hover:text-gray-200 transition-colors"
                >
                  {part}
                </button>
              )}
            </span>
          )
        })}
        {loading && <span className="text-gray-600 ml-2 text-xs">loading...</span>}
      </div>

      <div className="flex gap-4">
        {/* File list */}
        <div className="flex-1 min-w-0">
          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
            {currentPath && (
              <button
                onClick={navigateUp}
                className="flex items-center gap-2 px-4 py-2 text-sm w-full text-left hover:bg-gray-800/50 transition-colors"
              >
                <span className="text-gray-500">..</span>
              </button>
            )}
            {files.map((file) => {
              const type = fileType(file.name)
              return (
                <button
                  key={file.name}
                  onClick={() => {
                    if (file.isDirectory) {
                      navigateTo(file.path)
                    } else {
                      setPreview(file)
                    }
                  }}
                  className="flex items-center justify-between px-4 py-2 text-sm w-full text-left hover:bg-gray-800/50 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {file.isDirectory ? (
                      <span className="text-yellow-500/70 shrink-0">dir</span>
                    ) : (
                      <span className={`${TYPE_COLORS[type]} shrink-0`}>*</span>
                    )}
                    <span className={`truncate ${file.isDirectory ? 'text-gray-200' : 'text-gray-400'}`}>
                      {file.name}
                    </span>
                  </div>
                  <span className="text-gray-600 text-xs shrink-0 ml-2">
                    {file.isDirectory ? '' : formatSize(file.size || 0)}
                  </span>
                </button>
              )
            })}
            {files.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-gray-600">Empty directory</div>
            )}
          </div>
        </div>

        {/* Preview panel */}
        {preview && (
          <div className="w-80 shrink-0">
            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
                <span className="text-sm font-medium text-gray-300 truncate">{preview.name}</span>
                <button
                  onClick={() => setPreview(null)}
                  className="text-gray-500 hover:text-gray-300 text-lg leading-none ml-2"
                >
                  &times;
                </button>
              </div>
              <FilePreview project={name} file={preview} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function FilePreview({ project, file }: { project: string; file: FileEntry }) {
  const url = beatlabFileUrl(project, file.path)
  const type = fileType(file.name)

  if (type === 'image') {
    return <img src={url} alt={file.name} className="w-full" loading="lazy" />
  }

  if (type === 'audio') {
    return (
      <div className="p-3">
        <audio controls className="w-full" src={url} />
      </div>
    )
  }

  if (type === 'video') {
    return <video controls className="w-full" src={url} />
  }

  return (
    <div className="p-3 text-sm text-gray-500">
      <div className="mb-2">{formatSize(file.size || 0)}</div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 hover:text-blue-300 text-xs"
      >
        Open raw file
      </a>
    </div>
  )
}
