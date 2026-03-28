import { useState, useCallback, useEffect } from 'react'
import { importAssets } from '@/routes/project/$name/editor'
import { fetchBrowse, type BrowseEntry } from '@/lib/beatlab-client'

type ImportDialogProps = {
  projectName: string
  onClose: () => void
  onImported: () => void
}

export function ImportDialog({ projectName, onClose, onImported }: ImportDialogProps) {
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [timestamp, setTimestamp] = useState('0:00')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadDir = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const data = await fetchBrowse(path)
      setEntries(data.entries)
      setCurrentPath(data.path)
      setSelected(new Set())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadDir('') }, [loadDir])

  const navigateTo = useCallback((path: string) => {
    loadDir(path)
  }, [loadDir])

  const navigateUp = useCallback(() => {
    const parts = currentPath.split('/').filter(Boolean)
    parts.pop()
    loadDir(parts.join('/'))
  }, [currentPath, loadDir])

  const toggleSelect = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const selectAllImportable = useCallback(() => {
    const importable = entries
      .filter((e) => !e.isDirectory && (e.type === 'image' || e.type === 'video'))
      .map((e) => e.path)
    setSelected((prev) => {
      if (importable.every((p) => prev.has(p))) return new Set() // deselect all if all selected
      return new Set(importable)
    })
  }, [entries])

  const handleImport = useCallback(async () => {
    if (selected.size === 0) return
    setImporting(true)
    setError(null)
    setResult(null)

    // Import each selected file (the server handles them via the work dir)
    // We pass the directory and let the server process, or pass individual paths
    // Since the paths are relative to .beatlab_work, we need to tell the server the absolute path
    // The server's import endpoint expects an absolute sourcePath — we need to construct it
    // from the browse path which is relative to work_dir
    try {
      // If all selected files are in the same directory, import the dir with a filter
      // Otherwise, import individually. For simplicity, import each file.
      const paths = Array.from(selected)
      let totalKf = 0
      let totalTr = 0

      for (const relPath of paths) {
        const res = await importAssets({
          data: { projectName, sourcePath: relPath, timestamp },
        })
        if (res.success) {
          totalKf += res.imported.keyframes.length
          totalTr += res.imported.transitions.length
        }
      }

      setResult(`${totalKf} keyframe(s), ${totalTr} transition(s) imported to bin`)
      onImported()
    } catch (e) {
      setError(String(e))
    } finally {
      setImporting(false)
    }
  }, [selected, projectName, timestamp, onImported])

  const breadcrumbs = currentPath ? currentPath.split('/').filter(Boolean) : []
  const importableCount = entries.filter((e) => !e.isDirectory && (e.type === 'image' || e.type === 'video')).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-[560px] max-w-[90vw] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
          <h2 className="text-sm font-medium">Import from .beatlab_work</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">
            &times;
          </button>
        </div>

        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 text-xs px-4 py-2 border-b border-gray-800 shrink-0 min-h-[32px]">
          <button
            onClick={() => navigateTo('')}
            className={`hover:text-gray-200 transition-colors ${currentPath ? 'text-blue-400' : 'text-gray-300'}`}
          >
            .beatlab_work
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
          {loading && <span className="text-gray-600 ml-2">loading...</span>}
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {currentPath && (
            <button
              onClick={navigateUp}
              className="flex items-center gap-2 px-4 py-1.5 text-xs w-full text-left hover:bg-gray-800/50 transition-colors text-gray-500"
            >
              ..
            </button>
          )}
          {entries.map((entry) => {
            const isImportable = !entry.isDirectory && (entry.type === 'image' || entry.type === 'video')
            const isChecked = selected.has(entry.path)
            return (
              <div
                key={entry.name}
                className={`flex items-center gap-2 px-4 py-1.5 text-xs hover:bg-gray-800/50 transition-colors cursor-pointer ${isChecked ? 'bg-blue-900/20' : ''}`}
                onClick={() => {
                  if (entry.isDirectory) navigateTo(entry.path)
                  else if (isImportable) toggleSelect(entry.path)
                }}
              >
                {isImportable && (
                  <input
                    type="checkbox"
                    checked={isChecked}
                    readOnly
                    className="rounded border-gray-600 bg-gray-800 text-blue-500 pointer-events-none"
                  />
                )}
                {entry.isDirectory ? (
                  <span className="text-yellow-500/70 w-4 text-center shrink-0">dir</span>
                ) : entry.type === 'image' ? (
                  <span className="text-green-400 w-4 text-center shrink-0">img</span>
                ) : entry.type === 'video' ? (
                  <span className="text-purple-400 w-4 text-center shrink-0">vid</span>
                ) : (
                  <span className="text-gray-600 w-4 text-center shrink-0">-</span>
                )}
                <span className={`flex-1 truncate ${entry.isDirectory ? 'text-gray-200' : isImportable ? 'text-gray-300' : 'text-gray-600'}`}>
                  {entry.name}
                </span>
                {entry.size != null && (
                  <span className="text-gray-600 shrink-0">{formatSize(entry.size)}</span>
                )}
              </div>
            )
          })}
          {entries.length === 0 && !loading && (
            <div className="px-4 py-6 text-center text-xs text-gray-600">Empty directory</div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-800 px-4 py-3 space-y-2 shrink-0">
          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 rounded px-3 py-2">{error}</div>
          )}
          {result && (
            <div className="text-xs text-green-400 bg-green-900/20 rounded px-3 py-2">{result}</div>
          )}

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 flex-1">
              <label className="text-[10px] text-gray-500 shrink-0">Start at:</label>
              <input
                type="text"
                value={timestamp}
                onChange={(e) => setTimestamp(e.target.value)}
                className="w-16 bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700 focus:border-blue-500 focus:outline-none"
              />
            </div>

            {importableCount > 0 && !result && (
              <button
                onClick={selectAllImportable}
                className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors shrink-0"
              >
                {selected.size === importableCount ? 'Deselect all' : 'Select all'}
              </button>
            )}

            <button
              onClick={result ? onClose : handleImport}
              disabled={importing || (!result && selected.size === 0)}
              className="text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-4 py-1.5 rounded transition-colors shrink-0"
            >
              {result ? 'Done' : importing ? 'Importing...' : `Import ${selected.size} file${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
