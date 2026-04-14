import { useState, useEffect, useCallback } from 'react'
import { useScenecraftSocket } from '@/hooks/useScenecraftSocket'
import { getActivePreloads, getMemoryUsage } from '@/lib/frame-cache'
import { useJobContext } from '@/contexts/JobStateContext'

type QueueItem = {
  id: string
  type: 'generation' | 'preview-render'
  label: string
  progress: number
  status: 'in_progress' | 'completed' | 'failed'
  detail?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function parsePreloadKey(key: string): string {
  // key format: "tr:tr_001:slot_0:v1"
  const match = key.match(/^tr:(\w+):slot_(\d+):v(.+)$/)
  if (match) return `${match[1]} slot ${match[2]}`
  return key
}

export function StatusBar() {
  const socket = useScenecraftSocket()
  const jobCtx = useJobContext()
  const [showPanel, setShowPanel] = useState(false)
  const [items, setItems] = useState<QueueItem[]>([])

  const [memoryInfo, setMemoryInfo] = useState({ usedBytes: 0, limitBytes: 1, pct: 0 })

  // Poll for frame cache preloads + rebuild items list from job context + memory
  useEffect(() => {
    const update = () => {
      const preloads = getActivePreloads()
      const preloadItems: QueueItem[] = preloads.map((p) => ({
        id: `preload:${p.key}`,
        type: 'preview-render' as const,
        label: parsePreloadKey(p.key),
        progress: p.progress,
        status: 'in_progress' as const,
        detail: `${Math.round(p.progress * 100)}%`,
      }))

      const jobItems: QueueItem[] = jobCtx.getAllJobs().map((j) => ({
        id: j.jobId,
        type: 'generation' as const,
        label: j.entityKey,
        progress: j.progress,
        status: j.status,
        detail: j.detail,
      }))
      setItems([...jobItems, ...preloadItems])
      setMemoryInfo(getMemoryUsage())
    }
    update()
    const interval = setInterval(update, 500)
    return () => clearInterval(interval)
  }, [])

  const activeCount = items.filter((i) => i.status === 'in_progress').length
  const hasItems = items.length > 0

  const togglePanel = useCallback(() => setShowPanel((v) => !v), [])

  return (
    <div className="relative shrink-0">
      {/* Queue panel */}
      {showPanel && hasItems && (
        <div className="absolute bottom-7 right-0 w-80 max-h-64 overflow-y-auto bg-gray-900 border border-gray-700 rounded-tl-lg shadow-xl z-50">
          <div className="px-3 py-1.5 border-b border-gray-800 text-[10px] font-medium text-gray-400 uppercase tracking-wider">
            Operations Queue
          </div>
          {items.map((item) => (
            <div key={item.id} className={`px-3 py-1.5 border-b border-gray-800/50 ${item.status === 'completed' ? 'opacity-50' : ''}`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    item.status === 'in_progress' ? 'bg-blue-400 animate-pulse' :
                    item.status === 'completed' ? 'bg-green-400' : 'bg-red-400'
                  }`} />
                  <span className="text-[11px] text-gray-300 font-mono truncate max-w-[180px]">
                    {item.label}
                  </span>
                </div>
                <span className={`text-[10px] ${
                  item.status === 'failed' ? 'text-red-400' :
                  item.status === 'completed' ? 'text-green-400' : 'text-gray-500'
                }`}>
                  {item.detail}
                </span>
              </div>
              <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ${
                    item.status === 'failed' ? 'bg-red-500' :
                    item.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'
                  }`}
                  style={{ width: `${item.progress * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Status bar */}
      <div className="h-7 bg-gray-900 border-t border-gray-800 px-3 flex items-center text-xs shrink-0">
        <div className="flex items-center gap-2 text-gray-500">
          {socket.connected ? (
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" title="Connected" />
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" title="Disconnected" />
          )}
          <span>
            {activeCount > 0
              ? `${activeCount} operation${activeCount > 1 ? 's' : ''} in progress`
              : 'Ready'}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={togglePanel}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
          >
            {activeCount > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            )}
            <span className="text-[11px] font-mono">
              {items.length} op{items.length > 1 ? 's' : ''}
            </span>
          </button>
          <span className={`text-[10px] font-mono ${memoryInfo.pct >= 50 ? 'text-red-400' : 'text-gray-500'}`} title={`Frame cache: ${formatBytes(memoryInfo.usedBytes)} / ${formatBytes(memoryInfo.limitBytes)}`}>
            {formatBytes(memoryInfo.usedBytes)}{memoryInfo.pct >= 50 ? ` (${memoryInfo.pct}%)` : ''}
          </span>
        </div>
      </div>
    </div>
  )
}
