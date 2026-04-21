# Task 104: AudioClipPanel (Candidates UI)

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md)
**Estimated Time**: 5 hours
**Dependencies**: [Task 100: Schema & helpers](task-100-schema-and-helpers.md), [Task 101: Plugin host scaffolding](task-101-plugin-host-scaffolding.md)
**Status**: Not Started

---

## Objective

Create the new `AudioClipPanel.tsx` — analogous to `KeyframePanel` / `TransitionPanel` — that shows an audio clip's candidate list, the currently-selected one, and lets the user switch selection. Also hook up the right-click context menu to dispatch plugin operations.

Implements in `scenecraft/src/components/editor/AudioClipPanel.tsx` + panel registration in the editor layout.

---

## Steps

### 1. REST endpoints the panel needs

Confirm (or add, if missing) backend endpoints:

- `GET /api/projects/:name/audio-clips/:clipId/candidates` → `{candidates: [pool_segment_dict, ...]}`
  - Backed by `db.get_audio_candidates(project_dir, clip_id)`
- `POST /api/projects/:name/audio-clips/:clipId/assign-candidate` body `{ pool_segment_id: string | null }`
  - Backed by `db.assign_audio_candidate(project_dir, clip_id, pool_segment_id)` + `undo_begin`
- `GET /api/projects/:name/audio-clips/:clipId` → includes `selected`

If any are missing in `api_server.py`, add them. Keep response shapes consistent with existing keyframe/transition candidate endpoints.

### 2. `AudioClipPanel.tsx`

Mirror `KeyframePanel.tsx` / `TransitionPanel.tsx` structure. Two main sections:

**Header:** clip name, timeline position, duration, track name.

**Candidates list:** scrollable list of candidates including an implicit "Original" row (pool_segment_id=null, representing the clip's native source file). Each row:
- Mini-waveform preview (reuse existing waveform-rendering component if available; simple static SVG bars as placeholder is OK for MVP)
- Source badge (`Original` / `Imported` / `Plugin — isolate-vocals` / `Generated`)
- Created timestamp
- Selected indicator (radio / checkmark) — clicking assigns this candidate via the REST endpoint
- Secondary actions: Delete candidate (calls `remove_audio_candidate`, skipped for MVP if time-constrained)

**Job-in-flight indicator:** if `PluginHost.pendingJobs[clipId]` exists, show a spinner row at the top of the list with the current progress.

```tsx
type Candidate = {
  id: string | null              // pool_segment_id, null = original source
  poolPath?: string
  source: string                 // 'original' | 'generated' | 'imported' | 'plugin'
  createdAt?: string
  durationSeconds?: number
}

type Props = {
  clip: AudioClip
  projectName: string
  onClose?: () => void
  onSelectChange?: () => void    // triggers router.invalidate() in parent
}

export function AudioClipPanel({ clip, projectName, onClose, onSelectChange }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(clip.selected ?? null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadCandidates(projectName, clip.id).then(list => {
      setCandidates([
        { id: null, source: 'original', durationSeconds: clip.end_time - clip.start_time },
        ...list,
      ])
      setSelectedId(clip.selected ?? null)
      setLoading(false)
    })
  }, [projectName, clip.id, clip.selected])

  const handleAssign = async (candidateId: string | null) => {
    await assignCandidate(projectName, clip.id, candidateId)
    setSelectedId(candidateId)
    onSelectChange?.()
  }

  const contextMenuItems = PluginHost.getContextMenuItems('audio_clip')

  return (
    <Panel>
      <Header clip={clip} onClose={onClose} />
      <section>
        <h3 className="text-xs font-semibold text-gray-400 mb-2">Candidates ({candidates.length})</h3>
        <ul className="space-y-1">
          {candidates.map(c => (
            <CandidateRow
              key={c.id ?? '_original'}
              candidate={c}
              selected={c.id === selectedId}
              onClick={() => handleAssign(c.id)}
            />
          ))}
        </ul>
      </section>
      <section>
        <h3 className="text-xs font-semibold text-gray-400 mb-2 mt-4">Operations</h3>
        {contextMenuItems.map(item => (
          <button
            key={item.operation}
            onClick={() => dispatchOperation(item.operation, 'audio_clip', clip.id, projectName)}
            className="w-full text-left px-2 py-1 text-xs hover:bg-gray-800"
          >
            {item.label}
          </button>
        ))}
      </section>
    </Panel>
  )
}
```

`dispatchOperation` lives in `lib/plugin-api.ts` (or a new helper file); same code path as the context-menu click in task 103 — keeps the two surfaces in sync.

### 3. `CandidateRow` component

```tsx
function CandidateRow({ candidate, selected, onClick }: { ... }) {
  const label = candidate.source === 'original' ? 'Original source'
             : candidate.source === 'plugin' ? 'Plugin — isolate-vocals'
             : candidate.source
  return (
    <li
      onClick={onClick}
      className={`flex items-center gap-2 p-2 rounded cursor-pointer ${
        selected ? 'bg-blue-900/30 border border-blue-700/60' : 'hover:bg-gray-800/40'
      }`}
    >
      <div className="w-3 h-3 rounded-full flex-shrink-0 border border-gray-600"
           data-selected={selected}>
        {selected && <div className="w-full h-full rounded-full bg-blue-500" />}
      </div>
      <MiniWaveform poolPath={candidate.poolPath} className="flex-1 h-6" />
      <div className="text-xs">
        <div className="text-gray-200">{label}</div>
        {candidate.createdAt && (
          <div className="text-gray-500 text-[10px]">
            {new Date(candidate.createdAt).toLocaleString()}
          </div>
        )}
      </div>
    </li>
  )
}
```

`MiniWaveform` — for MVP, can be a placeholder `<div className="bg-gray-800">` with `{candidate.durationSeconds?.toFixed(1)}s` as text. Real waveform rendering can come later (or reuse whatever `AudioTrack.tsx` uses for the timeline).

### 4. Panel registration

Add `AudioClipPanel` to `EditorPanelLayout.tsx`'s panel registry (similar to how `KeyframePanel` is wired):

```tsx
function PropertiesPanelComponent() {
  const { selectedAudioClip, ... } = useEditorState()
  if (selectedAudioClip) return <Panel><AudioClipPanel clip={selectedAudioClip} ... /></Panel>
  // ... existing keyframe / transition branches
}
```

If `selectedAudioClip` doesn't yet exist in `EditorStateContext`, add it alongside `selectedKeyframe` / `selectedTransition` (new selection type). Clicking an audio clip on the timeline sets it; clicking elsewhere clears it.

### 5. Auto-refresh on job completion

When the isolate-vocals job completes (via the WS broadcast from task 102), the panel should re-fetch candidates so the new candidate appears without a page refresh.

Options:
1. Subscribe to WS `job_completed` events for this clip, invalidate state on match
2. Use a global refetch after any plugin-registered operation via `router.invalidate()` in `onSelectChange`

For MVP: option 2 — call `router.invalidate()` in the plugin's client-side success callback. It's a hammer but it's what existing flows use.

### 6. Right-click timeline hookup

Wherever audio clips render in the timeline (probably `src/components/editor/AudioTrack.tsx`), add a right-click menu that consults `PluginHost.getContextMenuItems('audio_clip')` and dispatches through the same `dispatchOperation` helper. This overlaps with task 103; coordinate so there's one `dispatchOperation` implementation.

### 7. Tests

`__tests__/AudioClipPanel.test.tsx`:
- Mount with a clip that has 0 candidates → only "Original source" row, selected
- Mount with a clip that has 2 candidates → 3 rows (original + 2), correct one highlighted as selected
- Click a row → POST fires to `/assign-candidate` with the right id → `onSelectChange` called
- Plugin operation list is populated from `PluginHost.getContextMenuItems('audio_clip')`

---

## Verification

- [ ] `AudioClipPanel.tsx` exists and renders for audio_clip selections
- [ ] REST endpoints for `/audio-clips/:id/candidates` and `/audio-clips/:id/assign-candidate` exist and are wired
- [ ] "Original source" row is always present and selectable (assigns `null`)
- [ ] Plugin-generated candidates appear with a distinct source label
- [ ] Clicking a candidate updates `audio_clips.selected` via REST; UI reflects the change
- [ ] Context menu / Operations section shows "Isolate vocals…" (via PluginHost)
- [ ] After a job completes, the new candidate appears without manual refresh (router invalidation works)
- [ ] Panel tests pass
