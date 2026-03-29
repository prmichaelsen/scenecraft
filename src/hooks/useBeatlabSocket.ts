import { useSyncExternalStore } from 'react'

const WS_URL = (import.meta.env.VITE_BEATLAB_WS_URL || 'ws://localhost:8889')
const PING_INTERVAL = 30_000
const RECONNECT_BASE = 2_000
const RECONNECT_MAX = 30_000

export type JobMessage =
  | { type: 'job_started'; jobId: string; jobType: string; total: number; meta: Record<string, unknown> }
  | { type: 'job_progress'; jobId: string; completed: number; total: number; detail: string }
  | { type: 'job_completed'; jobId: string; result: unknown }
  | { type: 'job_failed'; jobId: string; error: string }
  | { type: 'pong' }
  | { type: 'job_status'; jobId: string; status: string; completed: number; total: number; result: unknown; error: string | null }
  | { type: 'error'; message: string }

type JobListener = (msg: JobMessage) => void

// ── Module-level singleton ──────────────────────────────────────────

let ws: WebSocket | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = RECONNECT_BASE
let connected = false

const jobListeners = new Map<string, Set<JobListener>>()
const globalListeners = new Set<JobListener>()
const connectedSubscribers = new Set<() => void>()

function setConnected(value: boolean) {
  connected = value
  for (const cb of connectedSubscribers) cb()
}

function routeMessage(msg: JobMessage) {
  // Notify global listeners
  for (const listener of globalListeners) {
    listener(msg)
  }
  // Notify job-specific listeners
  if ('jobId' in msg) {
    const listeners = jobListeners.get(msg.jobId)
    if (listeners) {
      for (const listener of listeners) {
        listener(msg)
      }
    }
  }
}

function handleMessage(event: MessageEvent) {
  try {
    const msg = JSON.parse(event.data) as JobMessage

    // Convert job_status responses into the event types listeners expect
    if (msg.type === 'job_status') {
      if (msg.status === 'completed') {
        routeMessage({ type: 'job_completed', jobId: msg.jobId, result: msg.result })
        return
      }
      if (msg.status === 'failed') {
        routeMessage({ type: 'job_failed', jobId: msg.jobId, error: msg.error || 'Unknown error' })
        return
      }
    }

    routeMessage(msg)
  } catch {}
}

function reQueryActiveJobs() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  for (const jobId of jobListeners.keys()) {
    ws.send(JSON.stringify({ type: 'get_job', jobId }))
  }
}

function connect() {
  try {
    const socket = new WebSocket(WS_URL)

    socket.onopen = () => {
      ws = socket
      reconnectDelay = RECONNECT_BASE
      setConnected(true)

      // Start ping keepalive
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, PING_INTERVAL)

      // Re-query any jobs that have active listeners (may have completed while disconnected)
      reQueryActiveJobs()
    }

    socket.onmessage = handleMessage

    socket.onclose = () => {
      ws = null
      setConnected(false)
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
      reconnectTimer = setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX)
    }

    socket.onerror = () => {
      socket.close()
    }
  } catch {
    reconnectTimer = setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX)
  }
}

function subscribeJob(jobId: string, listener: JobListener) {
  if (!jobListeners.has(jobId)) {
    jobListeners.set(jobId, new Set())
  }
  jobListeners.get(jobId)!.add(listener)

  return () => {
    jobListeners.get(jobId)?.delete(listener)
    if (jobListeners.get(jobId)?.size === 0) {
      jobListeners.delete(jobId)
    }
  }
}

function subscribeAll(listener: JobListener) {
  globalListeners.add(listener)
  return () => { globalListeners.delete(listener) }
}

// Start connection immediately on import (client-side only)
if (typeof window !== 'undefined') {
  connect()
}

// ── React hook (thin wrapper) ───────────────────────────────────────

export function useBeatlabSocket() {
  const isConnected = useSyncExternalStore(
    (cb) => { connectedSubscribers.add(cb); return () => { connectedSubscribers.delete(cb) } },
    () => connected,
    () => false, // SSR snapshot
  )

  return { connected: isConnected, subscribeJob, subscribeAll }
}
