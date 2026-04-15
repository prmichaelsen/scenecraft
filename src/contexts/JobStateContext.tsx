import { createContext, useContext, useCallback, useRef, useSyncExternalStore } from 'react'
import { useScenecraftSocket, type JobMessage } from '@/hooks/useScenecraftSocket'
import { useEffect } from 'react'

export type JobEntry = {
  jobId: string
  entityKey: string
  status: 'in_progress' | 'completed' | 'failed'
  progress: number
  detail: string
  result: unknown
}

type JobStore = {
  /** Map from entityKey -> JobEntry */
  jobs: Map<string, JobEntry>
  /** Map from jobId -> entityKey (reverse lookup) */
  jobIdToEntity: Map<string, string>
}

type JobStateContextValue = {
  startJob: (entityKey: string, jobId: string, label?: string) => void
  getJob: (entityKey: string) => JobEntry | null
  getAllJobs: () => JobEntry[]
  consumeResult: (entityKey: string) => unknown
  subscribe: (cb: () => void) => () => void
  getSnapshot: () => number // change counter for useSyncExternalStore
}

const JobStateContext = createContext<JobStateContextValue | null>(null)

export function JobStateProvider({ children }: { children: React.ReactNode }) {
  const socket = useScenecraftSocket()
  const storeRef = useRef<JobStore>({ jobs: new Map(), jobIdToEntity: new Map() })
  const changeCounter = useRef(0)
  const listeners = useRef(new Set<() => void>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const notify = useCallback(() => {
    changeCounter.current++
    for (const cb of listeners.current) cb()
  }, [])

  const subscribe = useCallback((cb: () => void) => {
    listeners.current.add(cb)
    return () => { listeners.current.delete(cb) }
  }, [])

  const getSnapshot = useCallback(() => changeCounter.current, [])

  const startJob = useCallback((entityKey: string, jobId: string, _label?: string) => {
    const store = storeRef.current
    // Clear any existing timer for this entity
    const oldTimer = timers.current.get(entityKey)
    if (oldTimer) clearTimeout(oldTimer)
    timers.current.delete(entityKey)

    const entry: JobEntry = {
      jobId,
      entityKey,
      status: 'in_progress',
      progress: 0,
      detail: 'Starting...',
      result: null,
    }
    store.jobs.set(entityKey, entry)
    store.jobIdToEntity.set(jobId, entityKey)
    notify()
  }, [notify])

  const getJob = useCallback((entityKey: string): JobEntry | null => {
    return storeRef.current.jobs.get(entityKey) ?? null
  }, [])

  const getAllJobs = useCallback((): JobEntry[] => {
    return Array.from(storeRef.current.jobs.values())
  }, [])

  const consumeResult = useCallback((entityKey: string): unknown => {
    const entry = storeRef.current.jobs.get(entityKey)
    if (!entry) return null
    const result = entry.result
    entry.result = null
    return result
  }, [])

  // Subscribe to all WebSocket events and route to job entries
  useEffect(() => {
    const unsub = socket.subscribeAll((msg: JobMessage) => {
      if (!('jobId' in msg)) return
      const store = storeRef.current
      let entityKey = store.jobIdToEntity.get(msg.jobId)

      // Auto-register unknown jobs from external sources (CLI, other tabs, agents)
      if (!entityKey && msg.type === 'job_started') {
        const meta = (msg as { meta?: Record<string, unknown> }).meta || {}
        const id = (meta.keyframeId || meta.transitionId || msg.jobId) as string
        entityKey = id
        startJob(entityKey, msg.jobId)
      }

      if (!entityKey) return
      const entry = store.jobs.get(entityKey)
      if (!entry || entry.jobId !== msg.jobId) return

      if (msg.type === 'job_started') {
        entry.status = 'in_progress'
        entry.progress = 0
        entry.detail = `0/${msg.total}`
      } else if (msg.type === 'job_progress') {
        entry.progress = msg.total > 0 ? msg.completed / msg.total : 0
        entry.detail = msg.detail || `${msg.completed}/${msg.total}`
        entry.status = 'in_progress'
      } else if (msg.type === 'job_completed') {
        entry.progress = 1
        entry.status = 'completed'
        entry.detail = 'Complete'
        entry.result = msg.result
        // Auto-expire after 30s
        timers.current.set(entityKey, setTimeout(() => {
          store.jobs.delete(entityKey)
          store.jobIdToEntity.delete(msg.jobId)
          timers.current.delete(entityKey)
          notify()
        }, 30000))
      } else if (msg.type === 'job_failed') {
        entry.status = 'failed'
        entry.detail = msg.error || 'Failed'
        timers.current.set(entityKey, setTimeout(() => {
          store.jobs.delete(entityKey)
          store.jobIdToEntity.delete(msg.jobId)
          timers.current.delete(entityKey)
          notify()
        }, 10000))
      }
      notify()
    })
    return () => {
      unsub()
      for (const t of timers.current.values()) clearTimeout(t)
    }
  }, [socket, notify])

  const value: JobStateContextValue = { startJob, getJob, getAllJobs, consumeResult, subscribe, getSnapshot }

  return (
    <JobStateContext.Provider value={value}>
      {children}
    </JobStateContext.Provider>
  )
}

/** Get the job state for a specific entity key. Re-renders when any job state changes. */
export function useJobState(entityKey: string): JobEntry | null {
  const ctx = useContext(JobStateContext)
  if (!ctx) throw new Error('useJobState must be used within JobStateProvider')
  useSyncExternalStore(ctx.subscribe, ctx.getSnapshot, () => 0)
  return ctx.getJob(entityKey)
}

/** Get the full job context (startJob, consumeResult, etc.) */
export function useJobContext() {
  const ctx = useContext(JobStateContext)
  if (!ctx) throw new Error('useJobContext must be used within JobStateProvider')
  // Subscribe so component re-renders on changes
  useSyncExternalStore(ctx.subscribe, ctx.getSnapshot, () => 0)
  return ctx
}
