# Task 103: Frontend isolate-vocals Plugin (Panel Contribution + Run Form + Client)

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md) — Directory Layout, Plugin Manifest, UX, Drag-to-Timeline
**Estimated Time**: 4 hours
**Dependencies**: [Task 101: Plugin host scaffolding](task-101-plugin-host-scaffolding.md), [Task 102: Backend plugin](task-102-backend-plugin.md)
**Status**: Not Started

---

## Objective

Build the frontend side of the isolate-vocals plugin as a **panel-contributing** plugin (not a dialog-contributing one). The plugin ships its manifest, the inline Run form (lives inside `AudioIsolationsPanel` built in task 104), the REST/WS client helper that handles multi-stem results, and the PluginHost registration.

No confirm dialog — the UX is "click Run button inside the panel → job kicks off immediately". Chat tool retains its elicitation (task 105) since chat lacks the panel's visual context.

Implements in `scenecraft/src/plugins/isolate-vocals/`.

---

## Steps

### 1. Directory & manifest

Create `scenecraft/src/plugins/isolate-vocals/plugin.yaml` — mirror of the backend manifest:

```yaml
name: isolate-vocals
version: 0.2.0
displayName: "Isolate Vocals"
description: "Separate a voice-over-noise audio source into vocal and background stems using DeepFilterNet3."
publisher: scenecraft
license: MIT

activationEvents:
  - onCommand:isolate-vocals.run
  - onContextMenu:audio_clip
  - onContextMenu:transition

contributes:
  operations:
    - id: isolate-vocals.run
      label: "Isolate vocals"
      entityTypes: [audio_clip, transition]
      handler: "backend:isolate_vocals.run"
      panel: "frontend:isolate_vocals.AudioIsolationsPanel"
      outputs:
        - kind: pool_segment
          stem_type_enum: [vocal, background]

  contextMenus:
    - entityType: audio_clip
      items:
        - operation: isolate-vocals.run
          label: "Isolate vocals…"
          icon: wave
          reveals: panel:audio-isolations
    - entityType: transition
      items:
        - operation: isolate-vocals.run
          label: "Isolate vocals from audio track…"
          icon: wave
          reveals: panel:audio-isolations
```

### 2. `plugins/isolate-vocals/index.ts`

Activates the plugin: registers the operation with a panel reference, registers the context-menu contribution, and exports the panel component for the plugin-host to mount.

```typescript
import type { PluginModule } from '@/lib/plugin-host'
import { AudioIsolationsPanel } from './AudioIsolationsPanel'
import { IsolateVocalsRunForm } from './IsolateVocalsRunForm'
import { callIsolateVocals, fetchIsolations } from './isolate-vocals-client'

export const activate: PluginModule['activate'] = (host) => {
  host.registerOperation({
    id: 'isolate-vocals.run',
    label: 'Isolate vocals',
    entityTypes: ['audio_clip', 'transition'],
    panel: AudioIsolationsPanel,           // panel, not dialog
  })
  host.registerContextMenu({
    entityType: 'audio_clip',
    items: [{ operation: 'isolate-vocals.run', label: 'Isolate vocals…', icon: 'wave', reveals: 'panel:audio-isolations' }],
  })
  host.registerContextMenu({
    entityType: 'transition',
    items: [{ operation: 'isolate-vocals.run', label: 'Isolate vocals from audio track…', icon: 'wave', reveals: 'panel:audio-isolations' }],
  })
}

export { AudioIsolationsPanel, IsolateVocalsRunForm, callIsolateVocals, fetchIsolations }
```

### 3. `plugins/isolate-vocals/IsolateVocalsRunForm.tsx`

The inline Run form hosted by `AudioIsolationsPanel` (task 104 wires it in). Not a modal — just a fieldset with controls.

```tsx
import { useState } from 'react'

type Props = {
  entity: { type: 'audio_clip' | 'transition'; id: string; durationSeconds?: number }
  projectName: string
  onStart?: (kickoff: { isolation_id: string; job_id: string }) => void
}

export function IsolateVocalsRunForm({ entity, projectName, onStart }: Props) {
  const [rangeMode, setRangeMode] = useState<'full' | 'subset'>('full')
  const [trimIn, setTrimIn] = useState<number | ''>('')
  const [trimOut, setTrimOut] = useState<number | ''>('')
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const totalDur = entity.durationSeconds ?? 0
  const activeDur = rangeMode === 'full' ? totalDur
    : Math.max(0, (Number(trimOut) || totalDur) - (Number(trimIn) || 0))
  const etaLow = Math.ceil(activeDur * 1.0)
  const etaHigh = Math.ceil(activeDur * 2.0)

  const onRun = async () => {
    setRunning(true)
    setErr(null)
    try {
      const kickoff = await callIsolateVocals(projectName, {
        entity_type: entity.type,
        entity_id: entity.id,
        range_mode: rangeMode,
        trim_in: rangeMode === 'subset' ? Number(trimIn) || 0 : undefined,
        trim_out: rangeMode === 'subset' ? Number(trimOut) || undefined : undefined,
      })
      onStart?.(kickoff)
    } catch (e: any) {
      setErr(e.message || String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <fieldset className="p-3 border border-gray-700 rounded space-y-2">
      <legend className="text-xs text-gray-400">New isolation</legend>
      {/* range toggle */}
      <div className="flex gap-3 text-xs">
        <label><input type="radio" checked={rangeMode === 'full'} onChange={() => setRangeMode('full')} /> Full source</label>
        <label><input type="radio" checked={rangeMode === 'subset'} onChange={() => setRangeMode('subset')} /> Subset</label>
      </div>
      {rangeMode === 'subset' && (
        <div className="flex gap-2 text-xs">
          <input type="number" placeholder="in (s)"  value={trimIn}  onChange={e => setTrimIn(e.target.value === '' ? '' : Number(e.target.value))} className="w-20 bg-gray-800 rounded px-1" />
          <input type="number" placeholder="out (s)" value={trimOut} onChange={e => setTrimOut(e.target.value === '' ? '' : Number(e.target.value))} className="w-20 bg-gray-800 rounded px-1" />
        </div>
      )}
      <div className="text-[11px] text-gray-500">
        Model: DeepFilterNet3 · ~{etaLow}–{etaHigh}s on CPU · Outputs: vocal + background stems
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="flex justify-end">
        <button onClick={onRun} disabled={running}
          className="px-3 py-1 text-sm rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white">
          {running ? 'Starting…' : 'Run'}
        </button>
      </div>
    </fieldset>
  )
}
```

### 4. `plugins/isolate-vocals/isolate-vocals-client.ts`

REST + WS helpers. Kickoff is a single POST; progress/completion stream over the existing job WS. Return shape is multi-stem.

```typescript
import { getSubscribeJob } from '@/lib/plugin-api'   // reuse existing WS helper

const API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

export type IsolateKickoff = { isolation_id: string; job_id: string }
export type IsolateStem   = { stem_type: 'vocal' | 'background'; pool_segment_id: string; pool_path: string }
export type IsolateResult = { isolation_id: string; stems: IsolateStem[] }

export type IsolationRun = {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  model: string
  range_mode: 'full' | 'subset'
  trim_in: number | null
  trim_out: number | null
  created_at: string
  error?: string
  stems: Array<IsolateStem & { duration_seconds: number }>
}

export async function callIsolateVocals(
  projectName: string,
  body: {
    entity_type: 'audio_clip' | 'transition'
    entity_id: string
    range_mode?: 'full' | 'subset'
    trim_in?: number
    trim_out?: number
  },
): Promise<IsolateKickoff> {
  const res = await fetch(
    `${API_URL}/api/projects/${encodeURIComponent(projectName)}/plugins/isolate-vocals/run`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  const json = await res.json()
  if (json.error) throw new Error(json.error)
  return { isolation_id: json.isolation_id, job_id: json.job_id }
}

export async function fetchIsolations(
  projectName: string,
  entityType: 'audio_clip' | 'transition',
  entityId: string,
): Promise<IsolationRun[]> {
  const url = new URL(`${API_URL}/api/projects/${encodeURIComponent(projectName)}/audio-isolations`)
  url.searchParams.set('entityType', entityType)
  url.searchParams.set('entityId', entityId)
  const res = await fetch(url.toString())
  const json = await res.json()
  return json.isolations || []
}

export function subscribeIsolationJob(
  jobId: string,
  on: {
    progress?: (pct: number, detail: string) => void
    completed?: (result: IsolateResult) => void
    failed?: (err: string) => void
  },
): () => void {
  // Subscribe via the shared job WS helper (plugin-api surface).
  // Returns an unsubscribe function.
  return getSubscribeJob()(jobId, {
    onProgress: (msg) => on.progress?.(msg.completed / Math.max(msg.total, 1), msg.detail || ''),
    onCompleted: (msg) => on.completed?.(msg.result as IsolateResult),
    onFailed:   (msg) => on.failed?.(msg.error),
  })
}
```

> Implementation note: `getSubscribeJob()` is exposed through `plugin-api.ts` (part of task 101). If task 101 didn't add it yet, landing the shim there is a sub-step of this task — plugins MUST go through `plugin-api`, not directly open a WS.

### 5. Wire into editor entry

In `scenecraft/src/routes/project/$name/editor.tsx` (or wherever PluginHost is bootstrapped per task 101):

```typescript
import { PluginHost } from '@/lib/plugin-host'
import * as isolateVocals from '@/plugins/isolate-vocals'

PluginHost.register(isolateVocals, 'isolate-vocals')
```

Once at module load, outside React render.

### 6. Tests

`src/plugins/isolate-vocals/__tests__/index.test.ts`:
- `activate(host)` registers one operation and two context-menu contributions (audio_clip + transition)
- `host.getOperation('isolate-vocals.run')` resolves; has `panel` set to `AudioIsolationsPanel`
- `host.getContextMenuItems('audio_clip')` / `('transition')` each include their respective "Isolate vocals…" item

`__tests__/IsolateVocalsRunForm.test.tsx` (vitest + RTL):
- Renders with `entity.durationSeconds = 100`; ETA renders as ~100–200s
- Toggling to "Subset" reveals trim_in/trim_out inputs; ETA recomputes against the window
- Clicking Run invokes `callIsolateVocals` with the correct payload; disables button while running
- Error surfaces when kickoff returns `{error}`

`__tests__/isolate-vocals-client.test.ts` (mocked fetch + mocked WS):
- `callIsolateVocals` POSTs the expected body; returns `{isolation_id, job_id}`
- `subscribeIsolationJob` maps `job_progress` → `on.progress`, `job_completed(result)` → `on.completed` with multi-stem array, `job_failed` → `on.failed`
- Unsubscribe stops further callbacks

---

## Verification

- [ ] `scenecraft/src/plugins/isolate-vocals/` directory exists with `plugin.yaml`, `index.ts`, `IsolateVocalsRunForm.tsx`, `isolate-vocals-client.ts` (AudioIsolationsPanel lives here too, built in task 104)
- [ ] `activate(host)` registers one operation (with `panel` set) and two context-menu contributions
- [ ] Editor entry calls `PluginHost.register(isolateVocals, 'isolate-vocals')` on load
- [ ] `IsolateVocalsRunForm` handles both full + subset ranges; shows model + ETA; disables Run while in-flight
- [ ] `callIsolateVocals` POSTs to `/api/projects/:name/plugins/isolate-vocals/run` and returns `{isolation_id, job_id}`
- [ ] `fetchIsolations` queries `/audio-isolations?entityType=...&entityId=...` and returns run-with-stems list
- [ ] `subscribeIsolationJob` streams progress + resolves with multi-stem result (not single candidate)
- [ ] No dialog-based confirm — kickoff is immediate on Run click (by design)
- [ ] No direct WS/REST calls outside `@/lib/plugin-api` — plugin surface stays narrow
- [ ] All tests pass (unit + form + client)
