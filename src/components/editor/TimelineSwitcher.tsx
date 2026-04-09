import { useState, useCallback, useEffect } from 'react'
import {
  fetchTimelines,
  postSwitchTimeline,
  postCreateTimeline,
  postImportTimeline,
  type TimelineInfo,
} from '@/lib/timeline-client'
import { fetchBrowse, type BrowseEntry } from '@/lib/beatlab-client'

type TimelineSwitcherProps = {
  projectName: string
  onSwitch: () => void
}

export function TimelineSwitcher({ projectName, onSwitch }: TimelineSwitcherProps) {
  const [info, setInfo] = useState<TimelineInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [importName, setImportName] = useState('')
  const [newName, setNewName] = useState('')
  const [copyFrom, setCopyFrom] = useState('')

  const loadTimelines = useCallback(async () => {
    try {
      const data = await fetchTimelines(projectName)
      setInfo(data)
    } catch {
      // Backend doesn't support timelines yet — hide the switcher
      setInfo(null)
    }
  }, [projectName])

  useEffect(() => { loadTimelines() }, [loadTimelines])

  const handleSwitch = useCallback(async (name: string) => {
    setLoading(true)
    try {
      await postSwitchTimeline(projectName, name)
      await loadTimelines()
      onSwitch()
    } finally {
      setLoading(false)
      setShowMenu(false)
    }
  }, [projectName, loadTimelines, onSwitch])

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return
    setLoading(true)
    try {
      await postCreateTimeline(projectName, newName.trim(), copyFrom || undefined)
      setNewName('')
      setCopyFrom('')
      setShowCreate(false)
      await loadTimelines()
      onSwitch()
    } finally {
      setLoading(false)
    }
  }, [newName, copyFrom, projectName, loadTimelines, onSwitch])

  const handleImport = useCallback(async () => {
    if (!importPath.trim()) return
    setLoading(true)
    try {
      await postImportTimeline(projectName, importPath.trim(), importName.trim() || undefined)
      setImportPath('')
      setImportName('')
      setShowImport(false)
      await loadTimelines()
      onSwitch()
    } finally {
      setLoading(false)
    }
  }, [importPath, importName, projectName, loadTimelines, onSwitch])

  // Don't render if backend doesn't support timelines
  if (!info || info.timelines.length === 0) return null

  // Only show switcher if there are multiple timelines or user might want to create one
  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-2 py-1 rounded transition-colors flex items-center gap-1"
        title="Switch timeline"
      >
        <span className="text-purple-400 font-mono">{info.active}</span>
        {info.timelines.length > 1 && <span className="text-gray-600">({info.timelines.length})</span>}
      </button>

      {showMenu && (
        <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-10 min-w-[200px]">
          <div className="py-1">
            {info.timelines.map((name) => (
              <button
                key={name}
                onClick={() => handleSwitch(name)}
                disabled={loading || name === info.active}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  name === info.active
                    ? 'text-purple-400 bg-purple-900/20'
                    : 'text-gray-300 hover:bg-gray-700'
                }`}
              >
                {name} {name === info.active && '(active)'}
              </button>
            ))}
          </div>

          <div className="border-t border-gray-700 p-2 space-y-2">
            {!showCreate && !showImport && (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => { setShowCreate(true); setShowImport(false) }}
                  className="text-[10px] text-blue-400 hover:text-blue-300"
                >
                  + New timeline
                </button>
                <button
                  onClick={() => { setShowImport(true); setShowCreate(false) }}
                  className="text-[10px] text-green-400 hover:text-green-300"
                >
                  Import timeline
                </button>
              </div>
            )}

            {showCreate && (
              <div className="space-y-1">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="timeline-name"
                  className="w-full bg-gray-900 text-xs text-gray-300 rounded px-2 py-1 border border-gray-600 focus:border-blue-500 focus:outline-none"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
                  autoFocus
                />
                <div className="flex items-center gap-1">
                  <select
                    value={copyFrom}
                    onChange={(e) => setCopyFrom(e.target.value)}
                    className="flex-1 bg-gray-900 text-[10px] text-gray-400 rounded px-1 py-0.5 border border-gray-600"
                  >
                    <option value="">Empty timeline</option>
                    {info.timelines.map((t) => (
                      <option key={t} value={t}>Copy from: {t}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleCreate}
                    disabled={!newName.trim() || loading}
                    className="text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded disabled:bg-gray-700"
                  >
                    Create
                  </button>
                </div>
              </div>
            )}

            {showImport && (
              <TimelineImportBrowser
                importPath={importPath}
                setImportPath={setImportPath}
                importName={importName}
                setImportName={setImportName}
                onImport={handleImport}
                loading={loading}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TimelineImportBrowser({
  importPath, setImportPath, importName, setImportName, onImport, loading,
}: {
  importPath: string; setImportPath: (v: string) => void
  importName: string; setImportName: (v: string) => void
  onImport: () => void; loading: boolean
}) {
  const [browsePath, setBrowsePath] = useState('')
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [browseLoading, setBrowseLoading] = useState(true)

  const loadDir = useCallback(async (path: string) => {
    setBrowseLoading(true)
    try {
      const data = await fetchBrowse(path)
      setEntries(data.entries)
      setBrowsePath(data.path)
    } finally {
      setBrowseLoading(false)
    }
  }, [])

  useEffect(() => { loadDir('') }, [loadDir])

  const breadcrumbs = browsePath ? browsePath.split('/').filter(Boolean) : []
  const yamlFiles = entries.filter((e) => !e.isDirectory && e.name.endsWith('.yaml'))
  const dirs = entries.filter((e) => e.isDirectory)

  return (
    <div className="space-y-1">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-0.5 text-[10px] flex-wrap">
        <button onClick={() => loadDir('')} className="text-green-400 hover:text-green-300">.beatlab_work</button>
        {breadcrumbs.map((part, i) => {
          const pathUpTo = breadcrumbs.slice(0, i + 1).join('/')
          const isLast = i === breadcrumbs.length - 1
          return (
            <span key={pathUpTo} className="flex items-center gap-0.5">
              <span className="text-gray-600">/</span>
              {isLast ? (
                <span className="text-gray-300">{part}</span>
              ) : (
                <button onClick={() => loadDir(pathUpTo)} className="text-green-400 hover:text-green-300">{part}</button>
              )}
            </span>
          )
        })}
        {browseLoading && <span className="text-gray-600 ml-1">...</span>}
      </div>

      {/* File list */}
      <div className="max-h-[120px] overflow-y-auto bg-gray-900 rounded border border-gray-700">
        {browsePath && (
          <button
            onClick={() => { const parts = browsePath.split('/').filter(Boolean); parts.pop(); loadDir(parts.join('/')) }}
            className="flex items-center gap-1 px-2 py-1 text-[10px] w-full text-left hover:bg-gray-800 text-gray-500"
          >
            ..
          </button>
        )}
        {dirs.map((entry) => (
          <button
            key={entry.name}
            onClick={() => loadDir(entry.path)}
            className="flex items-center gap-1 px-2 py-1 text-[10px] w-full text-left hover:bg-gray-800 text-gray-200"
          >
            <span className="text-yellow-500/70 w-3 shrink-0">dir</span>
            <span className="truncate">{entry.name}</span>
          </button>
        ))}
        {yamlFiles.map((entry) => (
          <button
            key={entry.name}
            onClick={() => setImportPath(entry.path)}
            className={`flex items-center gap-1 px-2 py-1 text-[10px] w-full text-left hover:bg-gray-800 transition-colors ${importPath === entry.path ? 'bg-green-900/30 text-green-300' : 'text-gray-300'}`}
          >
            <span className="text-green-400 w-3 shrink-0">yml</span>
            <span className="truncate">{entry.name}</span>
          </button>
        ))}
        {entries.filter((e) => !e.isDirectory && !e.name.endsWith('.yaml')).length > 0 && dirs.length === 0 && yamlFiles.length === 0 && (
          <div className="px-2 py-2 text-[10px] text-gray-600 text-center">No YAML files in this directory</div>
        )}
        {entries.length === 0 && !browseLoading && (
          <div className="px-2 py-2 text-[10px] text-gray-600 text-center">Empty directory</div>
        )}
      </div>

      {/* Selected file + name + import button */}
      {importPath && (
        <div className="text-[10px] text-green-400 truncate" title={importPath}>
          Selected: {importPath.split('/').pop()}
        </div>
      )}
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={importName}
          onChange={(e) => setImportName(e.target.value)}
          placeholder="name (optional)"
          className="flex-1 bg-gray-900 text-[10px] text-gray-400 rounded px-1 py-0.5 border border-gray-600"
        />
        <button
          onClick={onImport}
          disabled={!importPath.trim() || loading}
          className="text-[10px] bg-green-600 text-white px-2 py-0.5 rounded disabled:bg-gray-700"
        >
          Import
        </button>
      </div>
    </div>
  )
}
