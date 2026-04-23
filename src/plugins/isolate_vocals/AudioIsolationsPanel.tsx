/**
 * AudioIsolationsPanel — primary UX for the isolate_vocals plugin.
 *
 * Layout:
 *   • IsolateVocalsRunForm at top (kickoff entry point).
 *   • Runs list below, newest-first. Each run is a RunCard showing status,
 *     model, range, timestamp + (when completed) stem rows with
 *     mini-waveforms, play controls, and drag handles (drag payload
 *     `application/x-scenecraft-stem` is consumed by task-104b's timeline
 *     drop handler).
 *
 * State is panel-local: fetched on entity change, refetched on job
 * completion. No router invalidation — the panel owns its own runs list.
 */

import { useEffect, useRef, useState } from 'react'

import { IsolateVocalsRunForm } from './IsolateVocalsRunForm'
import {
  fetchIsolations,
  fetchPoolPeaks,
  subscribeIsolationJob,
  type IsolateKickoff,
  type IsolationRun,
  type IsolationStem,
  type StemType,
} from './isolate-vocals-client'

const API_URL =
  import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'


export type AudioIsolationsPanelProps = {
  entity:
    | {
        type: 'audio_clip' | 'transition'
        id: string
        durationSeconds?: number
        label?: string
      }
    | null
  projectName: string
  onClose?: () => void
}

type InFlightEntry = { pct: number; detail: string }


export function AudioIsolationsPanel({
  entity,
  projectName,
  onClose,
}: AudioIsolationsPanelProps) {
  if (!entity) {
    return (
      <EmptyState message="Select an audio clip or transition to isolate audio." />
    )
  }

  return (
    <PanelBody
      key={`${entity.type}:${entity.id}`}
      entity={entity}
      projectName={projectName}
      onClose={onClose}
    />
  )
}


// Inner component keyed on entity so switching entities clears state cleanly.
function PanelBody({
  entity,
  projectName,
  onClose,
}: {
  entity: NonNullable<AudioIsolationsPanelProps['entity']>
  projectName: string
  onClose?: () => void
}) {
  const [runs, setRuns] = useState<IsolationRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState<Map<string, InFlightEntry>>(
    () => new Map(),
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchIsolations(projectName, entity.type, entity.id)
      .then((list) => {
        if (cancelled) return
        setRuns(list)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectName, entity.type, entity.id])

  const handleKickoff = (k: IsolateKickoff) => {
    // Immediately mark as in-flight; the refetch at completion will replace
    // this with the persisted run.
    setInFlight((prev) => {
      const next = new Map(prev)
      next.set(k.isolation_id, { pct: 0, detail: 'starting' })
      return next
    })
    // Optimistically insert a "running" placeholder at the top of the list.
    setRuns((prev) => [
      {
        id: k.isolation_id,
        status: 'running',
        model: 'deepfilternet3',
        range_mode: 'full',
        trim_in: null,
        trim_out: null,
        created_at: new Date().toISOString(),
        error: null,
        stems: [],
      },
      ...prev,
    ])

    subscribeIsolationJob(k.job_id, {
      onProgress: (pct, detail) => {
        setInFlight((prev) => {
          const next = new Map(prev)
          next.set(k.isolation_id, { pct, detail })
          return next
        })
      },
      onCompleted: () => {
        setInFlight((prev) => {
          const next = new Map(prev)
          next.delete(k.isolation_id)
          return next
        })
        fetchIsolations(projectName, entity.type, entity.id)
          .then(setRuns)
          .catch(() => {})
      },
      onFailed: () => {
        setInFlight((prev) => {
          const next = new Map(prev)
          next.delete(k.isolation_id)
          return next
        })
        fetchIsolations(projectName, entity.type, entity.id)
          .then(setRuns)
          .catch(() => {})
      },
    })
  }

  return (
    <div className="h-full flex flex-col bg-[#111827] text-gray-200">
      <header className="p-3 border-b border-gray-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Audio Isolations —{' '}
          <span className="text-gray-400">{entity.label ?? entity.id}</span>
        </h2>
        {onClose && (
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 text-xs"
            aria-label="Close"
          >
            ✕
          </button>
        )}
      </header>

      <div className="p-3 space-y-3 overflow-auto">
        <IsolateVocalsRunForm
          entity={entity}
          projectName={projectName}
          onStart={handleKickoff}
        />

        <section>
          <h3 className="text-xs text-gray-400 mb-1">Runs ({runs.length})</h3>
          {loading && (
            <div className="text-xs text-gray-500">Loading runs…</div>
          )}
          {error && <div className="text-xs text-red-400">Error: {error}</div>}
          {!loading && !error && runs.length === 0 && (
            <div className="text-xs text-gray-500">
              No isolations yet — click Run above to start.
            </div>
          )}
          <ul className="space-y-2">
            {runs.map((run) => (
              <RunCard
                key={run.id}
                run={run}
                projectName={projectName}
                inFlight={inFlight.get(run.id)}
              />
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}


function EmptyState({ message }: { message: string }) {
  return (
    <div className="h-full flex items-center justify-center text-xs text-gray-500 bg-[#111827]">
      {message}
    </div>
  )
}


// ── RunCard ──────────────────────────────────────────────────────────────


function RunCard({
  run,
  projectName,
  inFlight,
}: {
  run: IsolationRun
  projectName: string
  inFlight?: InFlightEntry
}) {
  const statusClasses: Record<IsolationRun['status'], string> = {
    pending: 'bg-gray-700',
    running: 'bg-amber-700',
    completed: 'bg-emerald-700',
    failed: 'bg-red-800',
  }

  return (
    <li className="border border-gray-800 rounded p-2 bg-gray-900/30" data-testid="run-card">
      <header className="flex items-center gap-2 text-xs">
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide text-white ${statusClasses[run.status]}`}
        >
          {run.status}
        </span>
        <span className="text-gray-300">{run.model}</span>
        <span className="text-gray-500">·</span>
        <span className="text-gray-500">
          {run.range_mode === 'full'
            ? 'full'
            : `${run.trim_in ?? 0}s–${run.trim_out ?? '?'}s`}
        </span>
        <span className="ml-auto text-gray-500 text-[10px]">
          {run.created_at ? new Date(run.created_at).toLocaleString() : ''}
        </span>
      </header>

      {run.status === 'running' && inFlight && (
        <div className="mt-2">
          <div className="h-1 bg-gray-800 rounded overflow-hidden">
            <div
              className="h-full bg-amber-500"
              style={{ width: `${Math.round(inFlight.pct * 100)}%` }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(inFlight.pct * 100)}
            />
          </div>
          <div className="text-[10px] text-gray-500 mt-1">
            {inFlight.detail}
          </div>
        </div>
      )}

      {run.status === 'failed' && run.error && (
        <div className="mt-1 text-xs text-red-400 break-all">{run.error}</div>
      )}

      {run.status === 'completed' && run.stems.length > 0 && (
        <ul className="mt-2 space-y-1">
          {run.stems.map((stem) => (
            <StemRow
              key={stem.pool_segment_id}
              stem={stem}
              projectName={projectName}
              sourceLabel={`run-${run.id.slice(0, 8)}`}
            />
          ))}
        </ul>
      )}
    </li>
  )
}


// ── StemRow ──────────────────────────────────────────────────────────────


function StemRow({
  stem,
  projectName,
  sourceLabel,
}: {
  stem: IsolationStem
  projectName: string
  sourceLabel: string
}) {
  const stemClass: Record<StemType, string> = {
    vocal: 'text-emerald-400',
    background: 'text-sky-400',
  }

  const onDragStart = (ev: React.DragEvent) => {
    ev.dataTransfer.effectAllowed = 'copy'
    const payload: StemDragPayload = {
      pool_segment_id: stem.pool_segment_id,
      pool_path: stem.pool_path,
      stem_type: stem.stem_type,
      duration_seconds: stem.duration_seconds,
      source_label: sourceLabel,
    }
    ev.dataTransfer.setData(
      'application/x-scenecraft-stem',
      JSON.stringify(payload),
    )
  }

  return (
    <li
      draggable
      onDragStart={onDragStart}
      className="flex items-center gap-2 p-1.5 bg-gray-900 rounded cursor-grab hover:bg-gray-800"
      data-testid="stem-row"
    >
      <span
        className={`text-[10px] w-16 uppercase tracking-wide ${stemClass[stem.stem_type]}`}
      >
        {stem.stem_type}
      </span>
      <PoolPeaksMiniWaveform
        projectName={projectName}
        poolSegmentId={stem.pool_segment_id}
        durationSeconds={stem.duration_seconds}
        className="flex-1 h-6"
      />
      <span className="text-[10px] text-gray-500 w-14 text-right">
        {stem.duration_seconds.toFixed(1)}s
      </span>
      <PoolAudioPlayButton
        projectName={projectName}
        poolPath={stem.pool_path}
      />
    </li>
  )
}


// Drag payload — shape shared with task-104b's drop handler.
export type StemDragPayload = {
  pool_segment_id: string
  pool_path: string
  stem_type: StemType
  duration_seconds: number
  source_label: string
}


// ── Mini-waveform ────────────────────────────────────────────────────────


function PoolPeaksMiniWaveform({
  projectName,
  poolSegmentId,
  durationSeconds: _durationSeconds,
  className,
}: {
  projectName: string
  poolSegmentId: string
  durationSeconds: number
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(false)
    fetchPoolPeaks(projectName, poolSegmentId, 200)
      .then((p) => {
        if (!cancelled) setPeaks(p)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [projectName, poolSegmentId])

  useEffect(() => {
    if (!peaks || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#60a5fa' // blue-400
    const bins = peaks.length / 2
    for (let i = 0; i < bins; i++) {
      const min = peaks[i * 2]
      const max = peaks[i * 2 + 1]
      const y1 = ((1 - max) / 2) * h
      const y2 = ((1 - min) / 2) * h
      const x = (i / bins) * w
      ctx.fillRect(x, y1, Math.max(1, w / bins - 0.5), Math.max(1, y2 - y1))
    }
  }, [peaks])

  if (error) {
    return (
      <div className={className} aria-label="peaks failed to load">
        <div className="h-full bg-gray-800 rounded" />
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      width={200}
      height={24}
      className={className}
      aria-label="stem waveform"
    />
  )
}


// ── Play button ──────────────────────────────────────────────────────────


function PoolAudioPlayButton({
  projectName,
  poolPath,
}: {
  projectName: string
  poolPath: string
}) {
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const src = `${API_URL}/api/projects/${encodeURIComponent(projectName)}/files/${poolPath
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')}`

  const toggle = () => {
    if (!audioRef.current) {
      audioRef.current = new Audio(src)
      audioRef.current.addEventListener('ended', () => setPlaying(false))
    }
    if (playing) {
      audioRef.current.pause()
      setPlaying(false)
    } else {
      audioRef.current.play().catch(() => setPlaying(false))
      setPlaying(true)
    }
  }

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
    }
  }, [])

  return (
    <button
      onClick={toggle}
      className="text-gray-400 hover:text-gray-200 w-5"
      aria-label={playing ? 'pause stem' : 'play stem'}
    >
      {playing ? '■' : '▶'}
    </button>
  )
}
