# Task 104: AudioIsolationsPanel (runs + stems list, mini-waveforms)

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md) — UX: AudioIsolationsPanel, Peaks Endpoint
**Estimated Time**: 5 hours
**Dependencies**: [Task 100b: isolations schema](task-100b-isolations-schema.md), [Task 101: Plugin host](task-101-plugin-host-scaffolding.md), [Task 102: Backend plugin + peaks route](task-102-backend-plugin.md), [Task 103: Frontend plugin client](task-103-frontend-plugin.md)
**Status**: Not Started

---

## Objective

Build `AudioIsolationsPanel` — the primary UX surface for M11. Panel shows the *runs* (not candidates) for the currently-selected entity (`audio_clip` OR `transition`), each run expanding to its stems with mini-waveforms, play controls, and drag handles for task 104b. Embeds the `IsolateVocalsRunForm` from task 103 at the top as the kickoff entry point.

Implements in `scenecraft/src/plugins/isolate-vocals/AudioIsolationsPanel.tsx` (inside the plugin dir, not `components/editor/`, so the plugin boundary stays clean) + panel registration in `EditorPanelLayout.tsx`.

---

## Steps

### 1. Verify backend endpoints exist (from task 102)

- `GET /api/projects/:name/audio-isolations?entityType=...&entityId=...` — returns `{isolations: [{id, status, model, range_mode, trim_in, trim_out, created_at, stems: [...]}, ...]}`
- `GET /api/projects/:name/pool/:seg_id/peaks?resolution=N` — float16 peaks for a raw pool_segment (stems aren't audio_clips, can't use the clip-keyed route)
- `GET /api/projects/:name/files/:pool_path` — existing range-request streaming for ▶ play

If any are missing when this task starts, fall back to implementing them locally before continuing.

### 2. `AudioIsolationsPanel.tsx`

Structure:

```tsx
type EntitySelection =
  | { type: 'audio_clip'; id: string; durationSeconds?: number; label?: string }
  | { type: 'transition'; id: string; durationSeconds?: number; label?: string }
  | null

type Props = {
  entity: EntitySelection
  projectName: string
  onClose?: () => void
}

export function AudioIsolationsPanel({ entity, projectName, onClose }: Props) {
  if (!entity) return <EmptyState message="Select an audio clip or transition to isolate audio." />

  const [runs, setRuns] = useState<IsolationRun[]>([])
  const [inFlight, setInFlight] = useState<Map<string, { pct: number; detail: string }>>(new Map())
  const [loading, setLoading] = useState(true)

  // Load + refresh on entity change
  useEffect(() => {
    setLoading(true)
    fetchIsolations(projectName, entity.type, entity.id)
      .then(list => { setRuns(list); setLoading(false) })
  }, [projectName, entity.type, entity.id])

  // Subscribe to in-flight jobs, patch progress & drop+refetch on completion
  const handleKickoff = (k: { isolation_id: string; job_id: string }) => {
    setInFlight(m => new Map(m).set(k.isolation_id, { pct: 0, detail: 'starting' }))
    subscribeIsolationJob(k.job_id, {
      progress: (pct, detail) => setInFlight(m => {
        const nm = new Map(m); nm.set(k.isolation_id, { pct, detail }); return nm
      }),
      completed: () => {
        setInFlight(m => { const nm = new Map(m); nm.delete(k.isolation_id); return nm })
        fetchIsolations(projectName, entity.type, entity.id).then(setRuns)
      },
      failed: (err) => {
        setInFlight(m => { const nm = new Map(m); nm.delete(k.isolation_id); return nm })
        fetchIsolations(projectName, entity.type, entity.id).then(setRuns)  // reflect 'failed' status
      },
    })
  }

  return (
    <Panel title={`Audio Isolations — ${entity.label ?? entity.id}`} onClose={onClose}>
      <IsolateVocalsRunForm entity={entity} projectName={projectName} onStart={handleKickoff} />

      <section className="mt-3">
        <h3 className="text-xs text-gray-400 mb-1">Runs ({runs.length})</h3>
        {loading && <SkeletonRunList />}
        {!loading && runs.length === 0 && <div className="text-xs text-gray-500">No isolations yet — click Run above to start.</div>}
        <ul className="space-y-2">
          {runs.map(run => (
            <RunCard
              key={run.id}
              run={run}
              projectName={projectName}
              inFlight={inFlight.get(run.id)}
            />
          ))}
        </ul>
      </section>
    </Panel>
  )
}
```

### 3. `RunCard` — one run

Shows run metadata + stems.

```tsx
function RunCard({ run, projectName, inFlight }: {
  run: IsolationRun
  projectName: string
  inFlight?: { pct: number; detail: string }
}) {
  const statusColor = {
    pending: 'bg-gray-700', running: 'bg-amber-700',
    completed: 'bg-emerald-700', failed: 'bg-red-800',
  }[run.status]

  return (
    <li className="border border-gray-800 rounded p-2 bg-gray-900/30">
      <header className="flex items-center gap-2 text-xs">
        <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide text-white ${statusColor}`}>
          {run.status}
        </span>
        <span className="text-gray-300">{run.model}</span>
        <span className="text-gray-500">·</span>
        <span className="text-gray-500">
          {run.range_mode === 'full' ? 'full' : `${run.trim_in}s–${run.trim_out}s`}
        </span>
        <span className="ml-auto text-gray-500 text-[10px]">
          {new Date(run.created_at).toLocaleString()}
        </span>
      </header>

      {run.status === 'running' && inFlight && (
        <ProgressBar pct={inFlight.pct} detail={inFlight.detail} />
      )}

      {run.status === 'failed' && run.error && (
        <div className="mt-1 text-xs text-red-400 break-all">{run.error}</div>
      )}

      {run.status === 'completed' && (
        <ul className="mt-2 space-y-1">
          {run.stems.map(s => (
            <StemRow key={s.pool_segment_id} stem={s} projectName={projectName} />
          ))}
        </ul>
      )}
    </li>
  )
}
```

### 4. `StemRow` — vocal/background row with waveform + ▶ + drag handle

```tsx
function StemRow({ stem, projectName }: { stem: IsolateStem & { duration_seconds: number }; projectName: string }) {
  const stemColor = stem.stem_type === 'vocal' ? 'text-emerald-400' : 'text-sky-400'

  const onDragStart = (ev: React.DragEvent) => {
    ev.dataTransfer.effectAllowed = 'copy'
    ev.dataTransfer.setData('application/x-scenecraft-stem', JSON.stringify({
      pool_segment_id: stem.pool_segment_id,
      pool_path: stem.pool_path,
      stem_type: stem.stem_type,
      duration_seconds: stem.duration_seconds,
    }))
  }

  return (
    <li
      draggable
      onDragStart={onDragStart}
      className="flex items-center gap-2 p-1.5 bg-gray-900 rounded cursor-grab hover:bg-gray-800"
    >
      <span className={`text-[10px] w-16 uppercase tracking-wide ${stemColor}`}>{stem.stem_type}</span>
      <PoolPeaksMiniWaveform
        projectName={projectName}
        poolSegmentId={stem.pool_segment_id}
        durationSeconds={stem.duration_seconds}
        className="flex-1 h-6"
      />
      <span className="text-[10px] text-gray-500 w-14 text-right">
        {stem.duration_seconds.toFixed(1)}s
      </span>
      <PoolAudioPlayButton projectName={projectName} poolPath={stem.pool_path} />
    </li>
  )
}
```

### 5. `PoolPeaksMiniWaveform` — mini canvas from `/pool/:seg_id/peaks`

Thin clone of the existing audio-clip mini-waveform component, but sourced from the new pool peaks route. If there's already a `MiniWaveform` that accepts a custom peaks URL, reuse it; otherwise create one local to this plugin.

```tsx
function PoolPeaksMiniWaveform({ projectName, poolSegmentId, durationSeconds, className }: {...}) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  useEffect(() => {
    const url = `${API_URL}/api/projects/${encodeURIComponent(projectName)}/pool/${poolSegmentId}/peaks?resolution=200`
    fetch(url).then(r => r.arrayBuffer()).then(buf => setPeaks(decodeFloat16(buf)))
  }, [projectName, poolSegmentId])

  // Render peaks to a 200×20 canvas inside className; simple min/max bars
  ...
}
```

`decodeFloat16` exists as a frontend helper for the audio-clip peaks flow — reuse.

### 6. `PoolAudioPlayButton` — native audio with range streaming

```tsx
function PoolAudioPlayButton({ projectName, poolPath }: { projectName: string; poolPath: string }) {
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const src = `${API_URL}/api/projects/${encodeURIComponent(projectName)}/files/${poolPath}`

  const toggle = () => {
    if (!audioRef.current) audioRef.current = new Audio(src)
    if (playing) { audioRef.current.pause(); setPlaying(false) }
    else { audioRef.current.play(); setPlaying(true) }
  }

  useEffect(() => () => { audioRef.current?.pause() }, [])

  return <button onClick={toggle} className="text-gray-400 hover:text-gray-200">{playing ? '■' : '▶'}</button>
}
```

### 7. Panel registration in `EditorPanelLayout.tsx`

Register a new `panel:audio-isolations` panel type with dockview (or the existing panel registry). Content component reads the current entity selection from `EditorStateContext` and renders `<AudioIsolationsPanel entity={...} projectName={projectName} />`.

Add a default docking position — suggest right-rail, sibling to the keyframe/transition panels. Opens in response to:
- Clicking the "Audio Isolations" panel in the panel menu
- The `reveals: panel:audio-isolations` hint from the context-menu items (task 103 manifest) — requires a tiny helper in `EditorPanelLayout` that opens a panel by id.

`EditorStateContext` selection already handles `selectedKeyframe` and `selectedTransition`. This task adds/consumes `selectedAudioClip` (if not already present from M10-era audio work). The panel consumes whichever of those three is set.

### 8. Auto-refresh on completion

Completion flow uses the in-panel WS subscription (step 2). The `AudioIsolationsPanel` doesn't call `router.invalidate()` — the runs list is panel-local state driven by `fetchIsolations` on entity change + on completion.

If the user has the panel open on entity A and then switches to entity B, the effect re-fires and re-fetches. Good.

### 9. Tests

`src/plugins/isolate-vocals/__tests__/AudioIsolationsPanel.test.tsx`:
- Empty state: no entity → "Select an audio clip or transition…"
- Entity with zero runs → Run form + "No isolations yet…"
- Entity with two completed runs → two RunCards, each with 2 StemRows (vocal + background)
- In-flight run: subscribe callback fires → progress bar updates
- On job completed → `fetchIsolations` refetches → new run appears in completed state

`__tests__/StemRow.test.tsx`:
- Drag start sets `application/x-scenecraft-stem` payload with pool_segment_id + stem_type + duration_seconds + pool_path
- Play button toggles `<audio>` play/pause
- Stem label colored by stem_type

`__tests__/PoolPeaksMiniWaveform.test.tsx`:
- Fetches `/pool/:seg_id/peaks?resolution=200`; renders canvas after peaks arrive
- Error response → renders placeholder, no crash

---

## Verification

- [ ] `AudioIsolationsPanel.tsx` lives under `src/plugins/isolate-vocals/` (plugin boundary)
- [ ] Panel renders for both `audio_clip` and `transition` selections
- [ ] Run form embedded at top; kicking off a job adds an in-flight RunCard immediately with progress bar
- [ ] Completed runs show each stem with a mini-waveform (via `/pool/:seg_id/peaks`), ▶ play, drag handle
- [ ] Stem drag sets `application/x-scenecraft-stem` MIME payload (consumed by task 104b)
- [ ] `EditorPanelLayout` registers `panel:audio-isolations` panel type; context-menu `reveals` opens it
- [ ] Entity-change effect re-fetches runs without stale state
- [ ] Completion path refetches the runs list (no full page reload)
- [ ] Failed-run state shows the error string; failed stems NOT rendered
- [ ] No cross-boundary imports from editor internals into the plugin (beyond `@/lib/plugin-api`)
- [ ] All tests pass
