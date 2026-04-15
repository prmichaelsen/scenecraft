import { useState, useCallback, useEffect } from 'react'
import {
  fetchCheckpoints,
  createCheckpoint,
  restoreCheckpoint,
  deleteCheckpoint,
  type Checkpoint,
} from '@/lib/checkpoint-client'

type CheckpointsPanelProps = {
  projectName: string
  onClose: () => void
  onRestore: () => void
}

export function CheckpointsPanel({ projectName, onClose, onRestore }: CheckpointsPanelProps) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [checkpointName, setCheckpointName] = useState('')
  const [restoringFile, setRestoringFile] = useState<string | null>(null)

  const loadCheckpoints = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchCheckpoints(projectName)
      setCheckpoints(data.checkpoints || [])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [projectName])

  useEffect(() => { loadCheckpoints() }, [loadCheckpoints])

  const handleCreate = useCallback(async () => {
    setCreating(true)
    setError(null)
    try {
      await createCheckpoint(projectName, checkpointName || undefined)
      setCheckpointName('')
      loadCheckpoints()
    } catch (e) {
      setError(String(e))
    } finally {
      setCreating(false)
    }
  }, [projectName, checkpointName, loadCheckpoints])

  const handleRestore = useCallback(async (filename: string) => {
    setRestoringFile(filename)
    setError(null)
    try {
      await restoreCheckpoint(projectName, filename)
      loadCheckpoints()
      onRestore()
    } catch (e) {
      setError(String(e))
    } finally {
      setRestoringFile(null)
    }
  }, [projectName, loadCheckpoints, onRestore])

  const handleDelete = useCallback(async (filename: string) => {
    setError(null)
    try {
      await deleteCheckpoint(projectName, filename)
      loadCheckpoints()
    } catch (e) {
      setError(String(e))
    }
  }, [projectName, loadCheckpoints])

  return (
    <div className="shrink-0 bg-gray-900 flex flex-col h-full w-full">
      {/* Create checkpoint */}
      <div className="px-3 py-2 border-b border-gray-800 shrink-0 space-y-1.5">
        <input
          type="text"
          value={checkpointName}
          onChange={(e) => setCheckpointName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !creating) handleCreate() }}
          placeholder="Checkpoint name (optional)"
          className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={handleCreate}
          disabled={creating}
          className="w-full text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-3 py-1.5 rounded"
        >
          {creating ? 'Creating...' : 'Create Checkpoint'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 text-xs text-red-400 bg-red-900/20 border-b border-gray-800 shrink-0">
          {error}
        </div>
      )}

      {/* Checkpoint list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-600">Loading...</div>
        ) : checkpoints.length === 0 ? (
          <div className="p-4 text-center text-sm text-gray-600">
            No checkpoints yet. Create one to snapshot the current database.
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {checkpoints.map((cp) => (
              <CheckpointEntry
                key={cp.filename}
                checkpoint={cp}
                restoring={restoringFile === cp.filename}
                onRestore={() => handleRestore(cp.filename)}
                onDelete={() => handleDelete(cp.filename)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function CheckpointEntry({ checkpoint, restoring, onRestore, onDelete }: {
  checkpoint: Checkpoint
  restoring: boolean
  onRestore: () => void
  onDelete: () => void
}) {
  const date = new Date(checkpoint.created)
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  const isToday = new Date().toDateString() === date.toDateString()
  const sizeMb = (checkpoint.size_bytes / (1024 * 1024)).toFixed(1)

  const label = checkpoint.name || `${dateStr} ${timeStr}`

  return (
    <div className="px-3 py-2 group">
      <div className="flex items-start gap-2">
        <div className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 bg-blue-500" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-300 leading-snug">{label}</div>
          <div className="flex items-center gap-2 mt-0.5">
            {checkpoint.name && <span className="text-[10px] text-gray-600">{isToday ? timeStr : `${dateStr} ${timeStr}`}</span>}
            <span className="text-[10px] text-gray-600">{sizeMb} MB</span>
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            onClick={onRestore}
            disabled={restoring}
            className="text-[10px] text-blue-400 hover:text-blue-300 disabled:text-gray-600"
          >
            {restoring ? '...' : 'Restore'}
          </button>
          <button
            onClick={onDelete}
            className="text-[10px] text-red-500/50 hover:text-red-400"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
