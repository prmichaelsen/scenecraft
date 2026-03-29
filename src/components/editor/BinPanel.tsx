import { useState, useCallback, useEffect, useRef } from 'react'
import { getBin, restoreKeyframe, restoreTransition } from '@/routes/project/$name/editor'
import { beatlabFileUrl, fetchWatchedFolders, postUnwatchFolder, fetchPool, type PoolEntry } from '@/lib/beatlab-client'
import type { BinEntry, TransitionBinEntry } from '@/lib/beatlab-client'
import { useBeatlabSocket } from '@/hooks/useBeatlabSocket'

export type PoolSelection = {
  type: 'keyframe' | 'segment'
  entry: PoolEntry
}

type BinPanelProps = {
  projectName: string
  onClose: () => void
  onRestore: () => void
  onPoolSelect: (selection: PoolSelection | null) => void
  poolSelection: PoolSelection | null
}

export function BinPanel({ projectName, onClose, onRestore, onPoolSelect, poolSelection }: BinPanelProps) {
  const socket = useBeatlabSocket()
  const [keyframeEntries, setKeyframeEntries] = useState<BinEntry[]>([])
  const [transitionEntries, setTransitionEntries] = useState<TransitionBinEntry[]>([])
  const [poolKeyframes, setPoolKeyframes] = useState<PoolEntry[]>([])
  const [poolSegments, setPoolSegments] = useState<PoolEntry[]>([])
  const [watchedFolders, setWatchedFolders] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'keyframes' | 'transitions' | 'pool'>('keyframes')

  const loadBin = useCallback(async () => {
    setLoading(true)
    try {
      const [binData, watchData, poolData] = await Promise.all([
        getBin({ data: { projectName } }).catch(() => ({ bin: [], transitionBin: [] })),
        fetchWatchedFolders(projectName).catch(() => ({ watchedFolders: [] })),
        fetchPool(projectName).catch(() => ({ keyframes: [], segments: [] })),
      ])
      setKeyframeEntries(binData.bin || [])
      setTransitionEntries(binData.transitionBin || [])
      setWatchedFolders(watchData.watchedFolders || [])
      setPoolKeyframes(poolData.keyframes || [])
      setPoolSegments(poolData.segments || [])
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
  const poolCount = poolKeyframes.length + poolSegments.length

  return (
    <div className="shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col" style={{ width: parseInt(localStorage.getItem('beatlab-side-panel-width') || '360', 10) }}>
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
          KFs{kfCount > 0 ? ` (${kfCount})` : ''}
        </button>
        <button
          onClick={() => setTab('transitions')}
          className={`flex-1 text-xs py-2 transition-colors ${tab === 'transitions' ? 'text-gray-200 border-b-2 border-orange-500' : 'text-gray-500 hover:text-gray-400'}`}
        >
          TRs{trCount > 0 ? ` (${trCount})` : ''}
        </button>
        <button
          onClick={() => setTab('pool')}
          className={`flex-1 text-xs py-2 transition-colors ${tab === 'pool' ? 'text-gray-200 border-b-2 border-green-500' : 'text-gray-500 hover:text-gray-400'}`}
        >
          Pool{poolCount > 0 ? ` (${poolCount})` : ''}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-600">Loading...</div>
        ) : tab === 'keyframes' ? (
          kfCount === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">Empty</div>
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
        ) : tab === 'transitions' ? (
          trCount === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">Empty</div>
          ) : (
            <div className="divide-y divide-gray-800">
              {transitionEntries.map((entry) => (
                <div key={entry.id} className="p-2">
                  <div className="flex-1">
                    <div className="text-xs text-gray-300 font-mono">{entry.id}</div>
                    <div className="text-[10px] text-gray-500">
                      {entry.from} → {entry.to} ({entry.durationSeconds.toFixed(1)}s)
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
        ) : (
          /* Pool tab */
          poolCount === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">Pool is empty</div>
          ) : (
            <div className="space-y-3 p-2">
              {poolKeyframes.length > 0 && (
                <div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                    Keyframe Images ({poolKeyframes.length})
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {poolKeyframes.map((entry) => {
                      const isSelected = poolSelection?.type === 'keyframe' && poolSelection.entry.name === entry.name
                      return (
                        <div
                          key={entry.name}
                          className={`relative group cursor-pointer rounded overflow-hidden border-2 transition-colors ${isSelected ? 'border-blue-500' : 'border-transparent hover:border-gray-600'}`}
                          onClick={() => onPoolSelect(isSelected ? null : { type: 'keyframe', entry })}
                        >
                          <img
                            src={beatlabFileUrl(projectName, entry.path)}
                            alt={entry.name}
                            className="w-full aspect-video object-cover"
                            loading="lazy"
                          />
                          <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <div className="text-[7px] text-gray-300 truncate">{entry.name}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              {poolSegments.length > 0 && (
                <div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                    Video Segments ({poolSegments.length})
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {poolSegments.map((entry) => (
                      <PoolVideoCard
                        key={entry.name}
                        entry={entry}
                        projectName={projectName}
                        isSelected={poolSelection?.type === 'segment' && poolSelection.entry.name === entry.name}
                        onSelect={() => onPoolSelect(
                          poolSelection?.type === 'segment' && poolSelection.entry.name === entry.name
                            ? null : { type: 'segment', entry }
                        )}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  )
}

const poolBlobCache = new Map<string, string>()

function PoolVideoCard({ entry, projectName, isSelected, onSelect }: { entry: PoolEntry; projectName: string; isSelected: boolean; onSelect: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => poolBlobCache.get(entry.path) ?? null)
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const url = beatlabFileUrl(projectName, entry.path)

  // Lazy-load blob on first hover
  useEffect(() => {
    if (!hovered || blobUrl || loading) return
    setLoading(true)
    fetch(url)
      .then((res) => res.blob())
      .then((blob) => {
        const bu = URL.createObjectURL(blob)
        poolBlobCache.set(entry.path, bu)
        setBlobUrl(bu)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [hovered, blobUrl, loading, url, entry.path])

  // Play/pause on hover
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (hovered) el.play().catch(() => {})
    else { el.pause(); el.currentTime = 0 }
  }, [hovered, blobUrl])

  return (
    <div
      className={`relative rounded overflow-hidden bg-gray-800 group cursor-pointer border-2 transition-colors ${isSelected ? 'border-orange-500' : 'border-transparent hover:border-gray-600'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
    >
      {blobUrl ? (
        <video
          ref={videoRef}
          src={blobUrl}
          className="w-full aspect-video object-cover"
          muted
          loop
          playsInline
          preload="metadata"
        />
      ) : (
        <div className="w-full aspect-video flex items-center justify-center">
          <span className="text-[9px] text-gray-500 font-mono">{loading ? '...' : entry.name.replace(/\.\w+$/, '')}</span>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1 py-0.5">
        <div className="text-[7px] text-gray-300 truncate">{entry.name}</div>
      </div>
    </div>
  )
}

