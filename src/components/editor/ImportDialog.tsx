import { useState, useCallback } from 'react'
import { importAssets } from '@/routes/project/$name/editor'

type ImportDialogProps = {
  projectName: string
  onClose: () => void
  onImported: () => void
}

export function ImportDialog({ projectName, onClose, onImported }: ImportDialogProps) {
  const [sourcePath, setSourcePath] = useState('')
  const [timestamp, setTimestamp] = useState('0:00')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleImport = useCallback(async () => {
    if (!sourcePath.trim()) return
    setImporting(true)
    setError(null)
    setResult(null)
    try {
      const res = await importAssets({
        data: { projectName, sourcePath: sourcePath.trim(), timestamp },
      })
      if (res.success) {
        setResult(res.summary)
        onImported()
      } else {
        setError((res as { error?: string }).error || 'Import failed')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setImporting(false)
    }
  }, [sourcePath, timestamp, projectName, onImported])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-[480px] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-medium">Import Assets</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">
            &times;
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          <div className="text-xs text-gray-400 leading-relaxed">
            Import images as keyframes and videos as transitions. All imported items go to the <strong>bin</strong> for review — restore them to the timeline from there.
          </div>

          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">
              Source Path
            </label>
            <input
              type="text"
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder="/path/to/directory/or/file"
              className="w-full bg-gray-800 text-sm text-gray-300 rounded px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleImport()
              }}
              autoFocus
            />
            <div className="text-[9px] text-gray-600 mt-1">
              Directory: imports all images + videos inside. File: imports just that file.
            </div>
          </div>

          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">
              Starting Timestamp (for keyframes)
            </label>
            <input
              type="text"
              value={timestamp}
              onChange={(e) => setTimestamp(e.target.value)}
              placeholder="0:00"
              className="w-full bg-gray-800 text-sm text-gray-300 rounded px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none"
            />
            <div className="text-[9px] text-gray-600 mt-1">
              Each imported keyframe gets this timestamp + 1s offset. Reposition after restoring from bin.
            </div>
          </div>

          <div className="text-[10px] text-gray-500 space-y-1">
            <div>Images (.png, .jpg, .jpeg, .webp) → keyframes</div>
            <div>Videos (.mp4, .webm, .mov) → transitions</div>
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 rounded px-3 py-2">{error}</div>
          )}

          {result && (
            <div className="text-xs text-green-400 bg-green-900/20 rounded px-3 py-2">{result}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-800">
          <button
            onClick={onClose}
            className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded transition-colors"
          >
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button
              onClick={handleImport}
              disabled={importing || !sourcePath.trim()}
              className="text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-4 py-1.5 rounded transition-colors"
            >
              {importing ? 'Importing...' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
