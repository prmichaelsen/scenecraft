# Task 103: Frontend isolate-vocals Plugin

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md)
**Estimated Time**: 5 hours
**Dependencies**: [Task 101: Plugin host scaffolding](task-101-plugin-host-scaffolding.md), [Task 102: Backend plugin](task-102-backend-plugin.md)
**Status**: Not Started

---

## Objective

Build the frontend side of the isolate-vocals plugin: `plugin.yaml` manifest, context-menu descriptor, confirm dialog, and REST/WS client. Register with `PluginHost` at editor entry.

Implements in `scenecraft/src/plugins/isolate-vocals/`.

---

## Steps

### 1. Directory & manifest

Create `scenecraft/src/plugins/isolate-vocals/plugin.yaml` — mirror of the backend manifest:

```yaml
name: isolate-vocals
version: 0.1.0
displayName: "Isolate Vocals"
description: "Strip background noise from an audio clip using DeepFilterNet3."
publisher: scenecraft
license: MIT

activationEvents:
  - onCommand:isolate-vocals.run
  - onContextMenu:audio_clip

contributes:
  operations:
    - id: isolate-vocals.run
      label: "Isolate vocals"
      entityTypes: [audio_clip]
      handler: "backend:isolate_vocals.run"
      ui: "frontend:isolate_vocals.Dialog"
      output: audio_candidate

  contextMenus:
    - entityType: audio_clip
      items:
        - operation: isolate-vocals.run
          label: "Isolate vocals…"
          icon: wave
```

### 2. `plugins/isolate-vocals/index.ts`

Exports `activate(host)` and the context-menu descriptor.

```typescript
import type { PluginModule } from '@/lib/plugin-host'
import { IsolateVocalsDialog } from './IsolateVocalsDialog'
import { callIsolateVocals } from './isolate-vocals-client'

export const activate: PluginModule['activate'] = (host) => {
  host.registerOperation({
    id: 'isolate-vocals.run',
    label: 'Isolate vocals',
    entityTypes: ['audio_clip'],
    dialog: IsolateVocalsDialog,
  })
  host.registerContextMenu({
    entityType: 'audio_clip',
    items: [{ operation: 'isolate-vocals.run', label: 'Isolate vocals…', icon: 'wave' }],
  })
}

export { callIsolateVocals }
```

### 3. `plugins/isolate-vocals/IsolateVocalsDialog.tsx`

Confirm dialog component. Shows model name, ETA, Run/Cancel buttons.

```tsx
import { useState } from 'react'

type Props = {
  entity: { id: string; durationSeconds?: number }
  onRun: () => void
  onCancel: () => void
}

export function IsolateVocalsDialog({ entity, onRun, onCancel }: Props) {
  const etaLow = Math.ceil((entity.durationSeconds ?? 30) * 1.0)
  const etaHigh = Math.ceil((entity.durationSeconds ?? 30) * 2.0)

  return (
    <div className="p-4 max-w-md">
      <h2 className="text-lg font-semibold mb-2">Isolate Vocals</h2>
      <p className="text-sm text-gray-300 mb-3">
        Remove background noise (chatter, wind, HVAC, hiss) and keep the voice.
      </p>
      <dl className="text-xs text-gray-400 space-y-1 mb-4">
        <div><span className="text-gray-500">Model:</span> DeepFilterNet3</div>
        <div><span className="text-gray-500">Estimated:</span> ~{etaLow}–{etaHigh}s (CPU)</div>
        <div><span className="text-gray-500">Output:</span> new audio candidate, auto-selected</div>
      </dl>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1 text-sm rounded bg-gray-800 hover:bg-gray-700">
          Cancel
        </button>
        <button onClick={onRun} className="px-3 py-1 text-sm rounded bg-amber-700 hover:bg-amber-600 text-white">
          Run
        </button>
      </div>
    </div>
  )
}
```

### 4. `plugins/isolate-vocals/isolate-vocals-client.ts`

REST/WS client helper.

```typescript
const API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'
const WS_URL = import.meta.env.VITE_SCENECRAFT_WS_URL || 'ws://localhost:8891'

export type IsolateResult = {
  audio_clip_id: string
  pool_segment_id: string
  pool_path: string
}

export async function callIsolateVocals(
  projectName: string,
  audioClipId: string,
  onProgress?: (pct: number, detail: string) => void,
): Promise<IsolateResult> {
  // POST to the plugin-registered REST route
  const res = await fetch(
    `${API_URL}/api/projects/${encodeURIComponent(projectName)}/plugins/isolate-vocals/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_clip_id: audioClipId }),
    },
  )
  const kickoff = await res.json()
  if (kickoff.error) throw new Error(kickoff.error)

  // Subscribe to job progress over the existing job WS
  return new Promise<IsolateResult>((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}`)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.jobId !== kickoff.job_id) return
      if (msg.type === 'job_progress' && onProgress) {
        onProgress(msg.completed / Math.max(msg.total, 1), msg.detail || '')
      } else if (msg.type === 'job_completed') {
        ws.close()
        resolve(msg.result as IsolateResult)
      } else if (msg.type === 'job_failed') {
        ws.close()
        reject(new Error(msg.error))
      }
    }
    ws.onerror = () => reject(new Error('ws error'))
  })
}
```

Note: real project may already have a WS job-subscription helper (see `ChatWebSocket` or similar). Prefer reusing that via `plugin-api.ts` rather than opening a new WS from the plugin. Adjust during implementation.

### 5. Wire into editor entry

In `scenecraft/src/routes/project/$name/editor.tsx` (or wherever `PluginHost` is initialized per task 101):

```typescript
import { PluginHost } from '@/lib/plugin-host'
import * as isolateVocals from '@/plugins/isolate-vocals'

PluginHost.register(isolateVocals, 'isolate-vocals')
```

Do this once at module load, outside React's render tree.

### 6. Context menu integration

Wherever audio clips render on the timeline (likely `src/components/editor/AudioTrack.tsx` or the audio-clip element inside the timeline), hook into the right-click handler:

```typescript
import { PluginHost } from '@/lib/plugin-host'

function AudioClipContextMenu({ clipId, ... }) {
  const items = PluginHost.getContextMenuItems('audio_clip')
  return (
    <ul>
      {items.map(item => (
        <li key={item.operation} onClick={() => invokeOperation(item.operation, clipId)}>
          {item.label}
        </li>
      ))}
    </ul>
  )
}

async function invokeOperation(operationId: string, entityId: string) {
  const op = PluginHost.getOperation(operationId)
  if (!op) return
  if (op.dialog) {
    const confirmed = await showDialog(op.dialog, { entity: { id: entityId } })
    if (!confirmed) return
  }
  // Dispatch to the plugin's client helper (map operation id → client fn)
  if (operationId === 'isolate-vocals.run') {
    const { callIsolateVocals } = await import('@/plugins/isolate-vocals')
    const projectName = /* from route */
    callIsolateVocals(projectName, entityId, (pct, detail) => toast(`${Math.round(pct*100)}% ${detail}`))
      .then(result => toast(`✓ candidate ${result.pool_segment_id.slice(0, 8)}…`, 'success'))
      .catch(err => toast(`✗ ${err.message}`, 'error'))
  }
}
```

For a cleaner future, the mapping from operation id → client function should live in `plugin-api.ts` or on the operation descriptor itself. For MVP, the hardcoded switch is fine.

### 7. Tests

`src/plugins/isolate-vocals/__tests__/index.test.ts`:
- `activate(host)` registers one operation and one context-menu
- `host.getContextMenuItems('audio_clip')` returns the "Isolate vocals…" item
- `host.getOperation('isolate-vocals.run').dialog` resolves to `IsolateVocalsDialog`

Dialog component test (vitest + testing-library):
- Renders with a known duration, shows ETA range
- Run button invokes `onRun`; Cancel invokes `onCancel`

Client test (mocked fetch + mocked WS):
- Kickoff POST receives expected body
- `onProgress` fires when WS yields `job_progress` with matching jobId
- `job_completed` resolves; `job_failed` rejects

---

## Verification

- [ ] `scenecraft/src/plugins/isolate-vocals/` directory exists with all 4 files
- [ ] `activate(host)` registers the operation + context menu
- [ ] Editor entry calls `PluginHost.register(isolateVocals, 'isolate-vocals')` on load
- [ ] Right-clicking an audio_clip on the timeline shows "Isolate vocals…" (wired in task 104 but placeholder possible here)
- [ ] Clicking "Isolate vocals…" shows the `IsolateVocalsDialog`
- [ ] Run → job kicks off → progress streams to a toast → success toast on completion
- [ ] No import from `@/lib/scenecraft-client` or `@/components/*` in the plugin — everything routes through `@/lib/plugin-api` / `@/lib/plugin-host`
- [ ] All tests pass (unit + dialog + client)
