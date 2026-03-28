import { useState, useCallback, useEffect } from 'react'
import { getBin, restoreKeyframe, restoreTransition } from '@/routes/project/$name/editor'
import { beatlabFileUrl, fetchWatchedFolders, postUnwatchFolder } from '@/lib/beatlab-client'
import type { BinEntry, TransitionBinEntry } from '@/lib/beatlab-client'
import type { useBeatlabSocket } from '@/hooks/useBeatlabSocket'

type BinPanelProps = {
  projectName: string
  onClose: () => void
  onRestore: () => void
  socket: ReturnType<typeof useBeatlabSocket>
}

export function BinPanel({ projectName, onClose, onRestore, socket }: BinPanelProps) {
  const [keyframeEntries, setKeyframeEntries] = useState<BinEntry[]>([])
  const [transitionEntries, setTransitionEntries] = useState<TransitionBinEntry[]>([])
  const [watchedFolders, setWatchedFolders] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'keyframes' | 'transitions'>('keyframes')

  const loadBin = useCallback(async () => {
    setLoading(true)
    try {
      const [binData, watchData] = await Promise.all([
        getBin({ data: { projectName } }),
        fetchWatchedFolders(projectName).catch(() => ({ watchedFolders: [] })),
      ])
      setKeyframeEntries(binData.bin || [])
      setTransitionEntries(binData.transitionBin || [])
      setWatchedFolders(watchData.watchedFolders || [])
    } finally {
      setLoading(false)
    }
  }, [projectName])

  useEffect(() => { loadBin() }, [loadBin])

  const handleUnwatch = useCallback(async (folderPath: string) => {
    await postUnwatchFolder(projectName, folderPath)
    setWatchedFolders((prev) => prev.filter((p) => p !== folderPath))
  }, [projectName])

  // Auto-refresh bin when folder watcher imports new files
  useEffect(() => {
    return socket.subscribeAll((msg) => {
      if ('type' in msg && (msg as { type: string }).type === 'folder_import') {
        loadBin()
      }
    })
  }, [socket, loadBin])

  const handleRestoreKeyframe = useCallback(async (id: string) => {
    await restoreKeyframe({ data: { projectName, keyframeId: id } })
    setKeyframeEntries((prev) => prev.filter((e) => e.id !== id))
    onRestore()
  }, [projectName, onRestore])

  const handleRestoreTransition = useCallback(async (id: string) => {
    await restoreTransition({ data: { projectName, transitionId: id } })
    setTransitionEntries((prev) => prev.filter((e) => e.id !== id))
    onRestore()
  }, [projectName, onRestore])

  const kfCount = keyframeEntries.length
  const trCount = transitionEntries.length

  return (
    <div className="w-72 shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
        <div className="text-sm font-medium">Bin</div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 text-lg leading-none"
        >
          &times;
        </button>
      </div>

      {/* Watched folders */}
      {watchedFolders.length > 0 && (
        <div className="px-3 py-2 border-b border-gray-800 shrink-0 space-y-1">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Watching</div>
          {watchedFolders.map((folder) => (
            <div key={folder} className="flex items-center justify-between text-[10px]">
              <span className="text-green-400 truncate flex-1" title={folder}>{folder || '/'}</span>
              <button
                onClick={() => handleUnwatch(folder)}
                className="text-red-400/60 hover:text-red-400 ml-2 shrink-0"
              >
                stop
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gray-800 shrink-0">
        <button
          onClick={() => setTab('keyframes')}
          className={`flex-1 text-xs py-2 transition-colors ${tab === 'keyframes' ? 'text-gray-200 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-400'}`}
        >
          Keyframes{kfCount > 0 ? ` (${kfCount})` : ''}
        </button>
        <button
          onClick={() => setTab('transitions')}
          className={`flex-1 text-xs py-2 transition-colors ${tab === 'transitions' ? 'text-gray-200 border-b-2 border-orange-500' : 'text-gray-500 hover:text-gray-400'}`}
        >
          Transitions{trCount > 0 ? ` (${trCount})` : ''}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-600">Loading...</div>
        ) : tab === 'keyframes' ? (
          kfCount === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">No deleted keyframes</div>
          ) : (
            <div className="divide-y divide-gray-800">
              {keyframeEntries.map((entry) => (
                <div key={entry.id} className="p-2">
                  <div className="flex items-start gap-2">
                    {entry.hasSelectedImage ? (
                      <img
                        src={beatlabFileUrl(projectName, `selected_keyframes/${entry.id}.png`)}
                        alt={entry.id}
                        className="w-16 h-10 object-cover rounded shrink-0"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-16 h-10 bg-gray-800 rounded shrink-0 flex items-center justify-center">
                        <span className="text-[8px] text-gray-600">{entry.id}</span>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-300 font-mono">{entry.id}</div>
                      <div className="text-[10px] text-gray-500">{entry.timestamp} — {entry.section}</div>
                      {entry.prompt && (
                        <div className="text-[10px] text-gray-600 truncate mt-0.5">{entry.prompt}</div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRestoreKeyframe(entry.id)}
                    className="mt-1 text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Restore to timeline
                  </button>
                </div>
              ))}
            </div>
          )
        ) : (
          trCount === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">No deleted transitions</div>
          ) : (
            <div className="divide-y divide-gray-800">
              {transitionEntries.map((entry) => (
                <div key={entry.id} className="p-2">
                  <div className="flex-1">
                    <div className="text-xs text-gray-300 font-mono">{entry.id}</div>
                    <div className="text-[10px] text-gray-500">
                      {entry.from} → {entry.to} ({entry.durationSeconds.toFixed(1)}s, {entry.slots} slot{entry.slots !== 1 ? 's' : ''})
                    </div>
                  </div>
                  <button
                    onClick={() => handleRestoreTransition(entry.id)}
                    className="mt-1 text-[10px] text-orange-400 hover:text-orange-300 transition-colors"
                  >
                    Restore to timeline
                  </button>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
