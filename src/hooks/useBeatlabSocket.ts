import { useEffect, useRef, useCallback, useState } from 'react'

const WS_URL = (import.meta.env.VITE_BEATLAB_WS_URL || 'ws://localhost:8889')

export type JobMessage =
  | { type: 'job_started'; jobId: string; jobType: string; total: number; meta: Record<string, unknown> }
  | { type: 'job_progress'; jobId: string; completed: number; total: number; detail: string }
  | { type: 'job_completed'; jobId: string; result: unknown }
  | { type: 'job_failed'; jobId: string; error: string }
  | { type: 'pong' }
  | { type: 'job_status'; jobId: string; status: string; completed: number; total: number; result: unknown; error: string | null }
  | { type: 'error'; message: string }

type JobListener = (msg: JobMessage) => void

export function useBeatlabSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const listenersRef = useRef<Map<string, Set<JobListener>>>(new Map())
  const globalListenersRef = useRef<Set<JobListener>>(new Set())
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let ws: WebSocket
    let reconnectTimer: ReturnType<typeof setTimeout>

    function connect() {
      ws = new WebSocket(WS_URL)

      ws.onopen = () => {
        wsRef.current = ws
        setConnected(true)
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as JobMessage
          // Notify global listeners
          for (const listener of globalListenersRef.current) {
            listener(msg)
          }
          // Notify job-specific listeners
          if ('jobId' in msg) {
            const jobListeners = listenersRef.current.get(msg.jobId)
            if (jobListeners) {
              for (const listener of jobListeners) {
                listener(msg)
              }
            }
          }
        } catch {}
      }

      ws.onclose = () => {
        wsRef.current = null
        setConnected(false)
        // Reconnect after 2 seconds
        reconnectTimer = setTimeout(connect, 2000)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [])

  const subscribeJob = useCallback((jobId: string, listener: JobListener) => {
    if (!listenersRef.current.has(jobId)) {
      listenersRef.current.set(jobId, new Set())
    }
    listenersRef.current.get(jobId)!.add(listener)

    return () => {
      listenersRef.current.get(jobId)?.delete(listener)
      if (listenersRef.current.get(jobId)?.size === 0) {
        listenersRef.current.delete(jobId)
      }
    }
  }, [])

  const subscribeAll = useCallback((listener: JobListener) => {
    globalListenersRef.current.add(listener)
    return () => { globalListenersRef.current.delete(listener) }
  }, [])

  return { connected, subscribeJob, subscribeAll }
}
