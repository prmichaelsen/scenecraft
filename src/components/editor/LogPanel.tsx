import { useCallback } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useServerLogs } from '@/hooks/useScenecraftSocket'

const STORAGE_KEY = 'scenecraft-side-panel-width'

export function LogPanel({ onClose }: { onClose: () => void }) {
  const logs = useServerLogs()

  const itemContent = useCallback((_index: number, log: { message: string; timestamp: string; level: string }) => (
    <div className={`py-0.5 ${log.level === 'error' ? 'text-red-400' : log.level === 'warn' ? 'text-yellow-400' : 'text-gray-500'}`}>
      <span className="text-gray-700 mr-1">{log.timestamp.split('T').pop()?.split('.')[0] || ''}</span>
      {log.message}
    </div>
  ), [])

  return (
    <div className="shrink-0 bg-gray-900 flex flex-col h-full w-full">
      <div className="flex-1 font-mono text-[10px] leading-relaxed">
        {logs.length === 0 ? (
          <div className="text-gray-600 text-center py-4">No logs yet</div>
        ) : (
          <Virtuoso
            data={logs}
            itemContent={itemContent}
            followOutput="smooth"
            initialTopMostItemIndex={logs.length - 1}
            className="h-full px-2"
            style={{ height: '100%' }}
          />
        )}
      </div>
    </div>
  )
}
