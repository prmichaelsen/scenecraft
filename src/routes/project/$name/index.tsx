import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState, useCallback, useRef } from 'react'
import { scenecraftFileUrl, scenecraftThumbnailUrl, fetchDirectoryListing, type FileEntry } from '@/lib/scenecraft-client'

const getProjectFiles = createServerFn({ method: 'GET' })
  .inputValidator((input: { name: string; path?: string }) => input)
  .handler(async ({ data }) => {
    return fetchDirectoryListing(data.name, data.path || '')
  })

export const Route = createFileRoute('/project/$name/')({
  component: ProjectPage,
  loader: ({ params }) => getProjectFiles({ data: { name: params.name } }),
})

function naturalCompare(a: string, b: string): number {
  const re = /(\d+)/g
  const aParts = a.split(re)
  const bParts = b.split(re)
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const ap = aParts[i] || ''
    const bp = bParts[i] || ''
    if (/^\d+$/.test(ap) && /^\d+$/.test(bp)) {
      const diff = parseInt(ap, 10) - parseInt(bp, 10)
      if (diff !== 0) return diff
    } else {
      const cmp = ap.localeCompare(bp)
      if (cmp !== 0) return cmp
    }
  }
  return 0
}

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
  const [navFiles, setNavFiles] = useState<FileEntry[] | null>(null)
  const files = (currentPath === '' ? initialFiles : navFiles ?? initialFiles)
    .slice()
    .sort((a: FileEntry, b: FileEntry) => naturalCompare(a.name, b.name))
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<FileEntry | null>(null)
  const [typeFilter, setTypeFilter] = useState<'all' | 'video' | 'image' | 'audio' | 'text'>('all')

  const navigateTo = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const entries = await getProjectFiles({ data: { name, path } })
      setNavFiles(entries)
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

      {/* File type filter tabs */}
      {(() => {
        const nonDirFiles = files.filter((f) => !f.isDirectory)
        const counts: Record<string, number> = { all: nonDirFiles.length }
        for (const f of nonDirFiles) {
          const t = fileType(f.name)
          counts[t] = (counts[t] || 0) + 1
        }
        const tabs = [
          { key: 'all' as const, label: 'All' },
          { key: 'video' as const, label: 'Video' },
          { key: 'image' as const, label: 'Image' },
          { key: 'audio' as const, label: 'Audio' },
          { key: 'text' as const, label: 'Text' },
        ].filter((t) => t.key === 'all' || (counts[t.key] || 0) > 0)

        return (
          <div className="flex gap-1 mb-3">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setTypeFilter(tab.key)}
                className={`text-xs px-2.5 py-1 rounded transition-colors ${
                  typeFilter === tab.key
                    ? 'bg-gray-700 text-gray-200'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
                }`}
              >
                {tab.label}
                <span className="ml-1 text-gray-600">{counts[tab.key] || 0}</span>
              </button>
            ))}
          </div>
        )
      })()}

      <div className="flex gap-4">
        {/* File list */}
        <div className="flex-1 min-w-0">
          {/* Video grid — shown when directory contains videos and filter includes them */}
          {(() => {
            if (typeFilter !== 'all' && typeFilter !== 'video') return null
            const videoFiles = files.filter((f) => !f.isDirectory && fileType(f.name) === 'video')
            if (videoFiles.length === 0) return null
            return (
              <div className="mb-4">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
                  Videos ({videoFiles.length})
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {videoFiles.map((file) => (
                    <VideoTile
                      key={file.name}
                      file={file}
                      project={name}
                      selected={preview?.name === file.name}
                      onSelect={() => setPreview(file)}
                    />
                  ))}
                </div>
              </div>
            )
          })()}

          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
            {currentPath && (
              <button
                onClick={navigateUp}
                className="flex items-center gap-2 px-4 py-2 text-sm w-full text-left hover:bg-gray-800/50 transition-colors"
              >
                <span className="text-gray-500">..</span>
              </button>
            )}
            {files.filter((f) => {
              if (f.isDirectory) return true
              const t = fileType(f.name)
              // Videos shown in grid above, not in list (unless filter is not video-only)
              if (t === 'video' && (typeFilter === 'all' || typeFilter === 'video')) return false
              if (typeFilter === 'all') return true
              return t === typeFilter
            }).map((file) => {
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

function VideoTile({ file, project, selected, onSelect }: { file: FileEntry; project: string; selected: boolean; onSelect: () => void }) {
  const [hovering, setHovering] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  return (
    <button
      onClick={onSelect}
      className={`relative rounded-lg overflow-hidden border-2 transition-colors bg-black ${
        selected ? 'border-purple-500' : 'border-gray-800 hover:border-gray-600'
      }`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => {
        setHovering(false)
        if (videoRef.current) {
          videoRef.current.pause()
          videoRef.current.currentTime = 0
        }
      }}
    >
      {/* Poster image — always loaded, lightweight */}
      <img
        src={scenecraftThumbnailUrl(project, file.path)}
        alt={file.name}
        className={`w-full aspect-video object-cover ${hovering ? 'hidden' : ''}`}
        loading="lazy"
      />
      {/* Video — only mounted on hover */}
      {hovering && (
        <video
          ref={videoRef}
          src={scenecraftFileUrl(project, file.path)}
          className="w-full aspect-video object-cover"
          muted
          playsInline
          autoPlay
        />
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1.5 py-1">
        <div className="text-[10px] text-gray-300 truncate">{file.name}</div>
        <div className="text-[9px] text-gray-500">{formatSize(file.size || 0)}</div>
      </div>
    </button>
  )
}

function FilePreview({ project, file }: { project: string; file: FileEntry }) {
  const url = scenecraftFileUrl(project, file.path)
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
