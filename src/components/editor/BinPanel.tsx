import { useState, useCallback, useEffect, useRef } from 'react'
import { getBin, restoreKeyframe, restoreTransition } from '@/routes/project/$name/editor'
import { beatlabFileUrl, fetchWatchedFolders, postUnwatchFolder, fetchPool, type PoolEntry } from '@/lib/beatlab-client'
import type { BinEntry, TransitionBinEntry } from '@/lib/beatlab-client'
import { useBeatlabSocket } from '@/hooks/useBeatlabSocket'

export type PoolSelection = {
  type: 'keyframe' | 'segment'
  entry: PoolEntry
}

type ActiveKeyframe = { id: string; timestamp: string; section: string; prompt: string; hasSelectedImage: boolean }
type ActiveTransition = { id: string; from: string; to: string; durationSeconds: number; hasSelectedVideo: boolean }

type BinPanelProps = {
  projectName: string
  onClose: () => void
  onRestore: () => void
  onPoolSelect: (selection: PoolSelection | null) => void
  onInsertPoolItem: (selection: PoolSelection, mode: 'at-playhead' | 'after-current-kf') => void
  poolSelection: PoolSelection | null
  activeKeyframes: ActiveKeyframe[]
  activeTransitions: ActiveTransition[]
}

export function BinPanel({ projectName, onClose, onRestore, onPoolSelect, onInsertPoolItem, poolSelection, activeKeyframes, activeTransitions }: BinPanelProps) {
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

  const allKfCount = activeKeyframes.length + keyframeEntries.length
  const allTrCount = activeTransitions.length + transitionEntries.length
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
          KFs{allKfCount > 0 ? ` (${allKfCount})` : ''}
        </button>
        <button
          onClick={() => setTab('transitions')}
          className={`flex-1 text-xs py-2 transition-colors ${tab === 'transitions' ? 'text-gray-200 border-b-2 border-orange-500' : 'text-gray-500 hover:text-gray-400'}`}
        >
          TRs{allTrCount > 0 ? ` (${allTrCount})` : ''}
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
          allKfCount === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">Empty</div>
          ) : (
            <div className="p-2 space-y-1">
              {/* Active keyframes */}
              <div className="grid grid-cols-3 gap-1">
                {activeKeyframes.map((kf) => (
                  <div key={kf.id} className="relative group rounded overflow-hidden">
                    {kf.hasSelectedImage ? (
                      <img
                        src={beatlabFileUrl(projectName, `selected_keyframes/${kf.id}.png`)}
                        alt={kf.id}
                        className="w-full aspect-video object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full aspect-video bg-gray-800 flex items-center justify-center">
                        <span className="text-[8px] text-gray-600">{kf.id}</span>
                      </div>
                    )}
                    <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="text-[7px] text-gray-300 truncate">{kf.id} @ {kf.timestamp}</div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Binned keyframes */}
              {keyframeEntries.length > 0 && (
                <>
                  <div className="text-[10px] text-red-400/60 uppercase tracking-wider mt-2">Deleted</div>
                  <div className="grid grid-cols-3 gap-1">
                    {keyframeEntries.map((entry) => (
                      <div key={entry.id} className="relative group rounded overflow-hidden opacity-60 hover:opacity-100 transition-opacity cursor-pointer" onClick={() => handleRestoreKeyframe(entry.id)}>
                        {entry.hasSelectedImage ? (
                          <img
                            src={beatlabFileUrl(projectName, `selected_keyframes/${entry.id}.png`)}
                            alt={entry.id}
                            className="w-full aspect-video object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full aspect-video bg-gray-800 flex items-center justify-center">
                            <span className="text-[8px] text-gray-600">{entry.id}</span>
                          </div>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 bg-red-900/70 px-1 py-0.5">
                          <div className="text-[7px] text-red-300 truncate">{entry.id} — click to restore</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )
        ) : tab === 'transitions' ? (
          allTrCount === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">Empty</div>
          ) : (
            <div className="p-2 space-y-1">
              {/* Active transitions as video grid */}
              <div className="grid grid-cols-2 gap-1">
                {activeTransitions.filter((tr) => tr.hasSelectedVideo).map((tr) => (
                  <PoolVideoCard
                    key={tr.id}
                    entry={{ name: `${tr.id} (${tr.from}→${tr.to})`, path: `selected_transitions/${tr.id}_slot_0.mp4`, size: 0 }}
                    projectName={projectName}
                    isSelected={false}
                    onSelect={() => {}}
                  />
                ))}
              </div>
              {/* Transitions without video */}
              {activeTransitions.filter((tr) => !tr.hasSelectedVideo).length > 0 && (
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-2">No Video</div>
              )}
              {activeTransitions.filter((tr) => !tr.hasSelectedVideo).map((tr) => (
                <div key={tr.id} className="px-2 py-1 bg-gray-800/30 rounded text-[10px] text-gray-500">
                  {tr.id}: {tr.from} → {tr.to} ({tr.durationSeconds.toFixed(1)}s)
                </div>
              ))}
              {/* Binned transitions */}
              {transitionEntries.length > 0 && (
                <>
                  <div className="text-[10px] text-red-400/60 uppercase tracking-wider mt-2">Deleted</div>
                  {transitionEntries.map((entry) => (
                    <div key={entry.id} className="px-2 py-1 bg-red-900/20 rounded text-[10px] text-gray-400 cursor-pointer hover:bg-red-900/30" onClick={() => handleRestoreTransition(entry.id)}>
                      {entry.id}: {entry.from} → {entry.to} — click to restore
                    </div>
                  ))}
                </>
              )}
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

              {/* Insert buttons — only shown when a pool item is selected */}
              {poolSelection && (
                <div className="sticky bottom-0 bg-gray-900 border-t border-gray-800 p-2 space-y-1">
                  <div className="text-[10px] text-gray-400 truncate mb-1">
                    Selected: {poolSelection.entry.name}
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => onInsertPoolItem(poolSelection, 'at-playhead')}
                      className="flex-1 text-xs bg-green-700 hover:bg-green-600 text-white py-1.5 rounded transition-colors"
                    >
                      Insert at Playhead
                    </button>
                    <button
                      onClick={() => onInsertPoolItem(poolSelection, 'after-current-kf')}
                      className="flex-1 text-xs bg-blue-700 hover:bg-blue-600 text-white py-1.5 rounded transition-colors"
                    >
                      Insert After KF
                    </button>
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

// Pool blob cache: in-memory + IndexedDB persistence
const poolBlobCache = new Map<string, string>()
const POOL_DB_NAME = 'beatlab-pool-cache'
const POOL_STORE = 'blobs'

function openPoolDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(POOL_DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(POOL_STORE)) db.createObjectStore(POOL_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function getPoolBlob(key: string): Promise<Blob | null> {
  try {
    const db = await openPoolDb()
    return new Promise((resolve) => {
      const tx = db.transaction(POOL_STORE, 'readonly')
      const req = tx.objectStore(POOL_STORE).get(key)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

async function putPoolBlob(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openPoolDb()
    const tx = db.transaction(POOL_STORE, 'readwrite')
    tx.objectStore(POOL_STORE).put(blob, key)
  } catch {}
}

async function loadPoolBlobUrl(path: string, fetchUrl: string): Promise<string> {
  // In-memory hit
  if (poolBlobCache.has(path)) return poolBlobCache.get(path)!

  // IndexedDB hit
  const cached = await getPoolBlob(path)
  if (cached) {
    const bu = URL.createObjectURL(cached)
    poolBlobCache.set(path, bu)
    return bu
  }

  // Network fetch + persist
  const res = await fetch(fetchUrl)
  const blob = await res.blob()
  const bu = URL.createObjectURL(blob)
  poolBlobCache.set(path, bu)
  putPoolBlob(path, blob) // fire and forget
  return bu
}

function PoolVideoCard({ entry, projectName, isSelected, onSelect }: { entry: PoolEntry; projectName: string; isSelected: boolean; onSelect: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => poolBlobCache.get(entry.path) ?? null)
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const url = beatlabFileUrl(projectName, entry.path)

  // Lazy-load blob on first hover (checks IndexedDB before network)
  useEffect(() => {
    if (!hovered || blobUrl || loading) return
    setLoading(true)
    loadPoolBlobUrl(entry.path, url)
      .then((bu) => setBlobUrl(bu))
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

