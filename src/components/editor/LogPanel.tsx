import { useEffect, useRef } from 'react'
import { useServerLogs } from '@/hooks/useBeatlabSocket'

const STORAGE_KEY = 'beatlab-side-panel-width'

export function LogPanel({ onClose }: { onClose: () => void }) {
  const logs = useServerLogs()
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScroll = useRef(true)

  useEffect(() => {
    if (autoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  return (
    <div className="shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col" style={{ width: parseInt(localStorage.getItem(STORAGE_KEY) || '360', 10) }}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
        <span className="text-xs text-gray-400 font-medium">Server Logs</span>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-gray-600">{logs.length} entries</span>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">&times;</button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto font-mono text-[10px] leading-relaxed p-2 space-y-0"
        onScroll={(e) => {
          const el = e.currentTarget
          autoScroll.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20
        }}
      >
        {logs.length === 0 ? (
          <div className="text-gray-600 text-center py-4">No logs yet</div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className={`py-0.5 ${log.level === 'error' ? 'text-red-400' : log.level === 'warn' ? 'text-yellow-400' : 'text-gray-500'}`}>
              <span className="text-gray-700 mr-1">{log.timestamp.split('T').pop()?.split('.')[0] || ''}</span>
              {log.message}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
