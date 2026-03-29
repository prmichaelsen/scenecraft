import { useState, useCallback, useEffect } from 'react'
import {
  fetchVersionHistory,
  fetchVersionDiff,
  postVersionCommit,
  postVersionCheckout,
  postVersionBranch,
  postVersionDeleteBranch,
  type Commit,
  type DiffFile,
} from '@/lib/version-client'

type VersionHistoryPanelProps = {
  projectName: string
  onClose: () => void
  onRestore: () => void
}

export function VersionHistoryPanel({ projectName, onClose, onRestore }: VersionHistoryPanelProps) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [branch, setBranch] = useState('main')
  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Commit form
  const [commitMsg, setCommitMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitResult, setCommitResult] = useState<string | null>(null)

  // Diff
  const [diffFiles, setDiffFiles] = useState<DiffFile[] | null>(null)
  const [hasChanges, setHasChanges] = useState(false)

  // Branch creation
  const [showNewBranch, setShowNewBranch] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')

  const loadHistory = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [history, diff] = await Promise.all([
        fetchVersionHistory(projectName),
        fetchVersionDiff(projectName).catch(() => ({ files: [], hasChanges: false })),
      ])
      setCommits(history.commits || [])
      setBranch(history.branch || 'main')
      setBranches(history.branches || [])
      setDiffFiles(diff.files || [])
      setHasChanges(diff.hasChanges || false)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [projectName])

  useEffect(() => { loadHistory() }, [loadHistory])

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) return
    setCommitting(true)
    setCommitResult(null)
    try {
      const res = await postVersionCommit(projectName, commitMsg.trim())
      if (res.noChanges) {
        setCommitResult('No changes to commit')
      } else if (res.success) {
        setCommitResult(`Saved: ${res.sha?.slice(0, 7)}`)
        setCommitMsg('')
        loadHistory()
      }
    } catch (e) {
      setCommitResult(`Error: ${e}`)
    } finally {
      setCommitting(false)
    }
  }, [commitMsg, projectName, loadHistory])

  const handleRestore = useCallback(async (sha: string) => {
    try {
      await postVersionCheckout(projectName, sha)
      loadHistory()
      onRestore()
    } catch (e) {
      setError(String(e))
    }
  }, [projectName, loadHistory, onRestore])

  const handleSwitchBranch = useCallback(async (name: string) => {
    try {
      await postVersionBranch(projectName, name)
      loadHistory()
      onRestore()
    } catch (e) {
      setError(String(e))
    }
  }, [projectName, loadHistory, onRestore])

  const handleCreateBranch = useCallback(async () => {
    if (!newBranchName.trim()) return
    try {
      await postVersionBranch(projectName, newBranchName.trim(), true)
      setNewBranchName('')
      setShowNewBranch(false)
      loadHistory()
    } catch (e) {
      setError(String(e))
    }
  }, [newBranchName, projectName, loadHistory])

  const handleDeleteBranch = useCallback(async (name: string) => {
    if (name === branch) return
    try {
      await postVersionDeleteBranch(projectName, name)
      loadHistory()
    } catch (e) {
      setError(String(e))
    }
  }, [branch, projectName, loadHistory])

  return (
    <div className="shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col" style={{ width: parseInt(localStorage.getItem('beatlab-side-panel-width') || '360', 10) }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
        <div className="text-sm font-medium">Version History</div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">
          &times;
        </button>
      </div>

      {/* Branch selector */}
      <div className="px-3 py-2 border-b border-gray-800 shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <select
            value={branch}
            onChange={(e) => handleSwitchBranch(e.target.value)}
            className="flex-1 bg-gray-800 text-xs text-gray-300 rounded px-2 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
          >
            {branches.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <button
            onClick={() => setShowNewBranch(!showNewBranch)}
            className="text-[10px] text-blue-400 hover:text-blue-300 shrink-0"
          >
            + New
          </button>
        </div>

        {showNewBranch && (
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder="branch-name"
              className="flex-1 bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700 focus:border-blue-500 focus:outline-none"
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateBranch() }}
              autoFocus
            />
            <button
              onClick={handleCreateBranch}
              disabled={!newBranchName.trim()}
              className="text-[10px] bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white px-2 py-1 rounded"
            >
              Create
            </button>
          </div>
        )}

        {/* Other branches with delete */}
        {branches.filter((b) => b !== branch).length > 0 && (
          <div className="space-y-0.5">
            {branches.filter((b) => b !== branch).map((b) => (
              <div key={b} className="flex items-center justify-between text-[10px]">
                <button
                  onClick={() => handleSwitchBranch(b)}
                  className="text-gray-500 hover:text-gray-300"
                >
                  {b}
                </button>
                <button
                  onClick={() => handleDeleteBranch(b)}
                  className="text-red-500/50 hover:text-red-400"
                >
                  delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Save version */}
      <div className="px-3 py-2 border-b border-gray-800 shrink-0 space-y-1">
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Describe changes..."
            className="flex-1 bg-gray-800 text-xs text-gray-300 rounded px-2 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
            onKeyDown={(e) => { if (e.key === 'Enter') handleCommit() }}
          />
          <button
            onClick={handleCommit}
            disabled={committing || !commitMsg.trim()}
            className="text-xs bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-3 py-1.5 rounded shrink-0"
          >
            {committing ? '...' : 'Save'}
          </button>
        </div>
        {commitResult && (
          <div className={`text-[10px] ${commitResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
            {commitResult}
          </div>
        )}

        {/* Unsaved changes indicator */}
        {hasChanges && diffFiles && diffFiles.length > 0 && (
          <div className="text-[10px] text-yellow-400/70">
            {diffFiles.length} unsaved change{diffFiles.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 text-xs text-red-400 bg-red-900/20 border-b border-gray-800 shrink-0">
          {error}
        </div>
      )}

      {/* Commit list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-600">Loading...</div>
        ) : commits.length === 0 ? (
          <div className="p-4 text-center text-sm text-gray-600">
            No version history yet. Save your first version above.
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {commits.map((commit, i) => (
              <CommitEntry
                key={commit.sha}
                commit={commit}
                isCurrent={i === 0}
                onRestore={() => handleRestore(commit.sha)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function CommitEntry({ commit, isCurrent, onRestore }: { commit: Commit; isCurrent: boolean; onRestore: () => void }) {
  const date = new Date(commit.date)
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  const isToday = new Date().toDateString() === date.toDateString()

  return (
    <div className="px-3 py-2 group">
      <div className="flex items-start gap-2">
        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${isCurrent ? 'bg-green-400' : 'bg-gray-600'}`} />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-300 leading-snug">{commit.message}</div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-gray-600 font-mono">{commit.sha.slice(0, 7)}</span>
            <span className="text-[10px] text-gray-600">{isToday ? timeStr : `${dateStr} ${timeStr}`}</span>
          </div>
        </div>
        {!isCurrent && (
          <button
            onClick={onRestore}
            className="text-[10px] text-blue-400 hover:text-blue-300 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          >
            Restore
          </button>
        )}
      </div>
    </div>
  )
}
