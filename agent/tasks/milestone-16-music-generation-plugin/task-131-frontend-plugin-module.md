# Task 131: Frontend Plugin Module

**Milestone**: [M16](../../milestones/milestone-16-music-generation-plugin.md)
**Spec**: `agent/specs/local.music-generation-plugin.md` — R1-R3, R41-R49 (chat + WS + panel registration contract)
**Estimated Time**: 3 hours
**Dependencies**: task-130 (backend endpoints exist)
**Status**: Not Started

---

## Objective

Create the frontend plugin module at `scenecraft/src/plugins/generate-music/`. Provides:
- `plugin.yaml` manifest mirror
- REST client helpers calling task-130's endpoints
- WS subscription for job events
- `activate(host)` — registers the panel with `EditorPanelLayout`'s `PanelRegistry` via the host's `registerPanel` contribution (NOT dockview)

UI itself (the panel component) lives in task-132 to keep files focused.

---

## Files

Create:
- `scenecraft/src/plugins/generate-music/plugin.yaml`
- `scenecraft/src/plugins/generate-music/index.ts` — `activate(host)` + panel registration
- `scenecraft/src/plugins/generate-music/client.ts` — REST + WS helpers
- `scenecraft/src/plugins/generate-music/types.ts` — TypeScript types mirroring backend response shapes

Modify:
- `scenecraft/src/routes/project/$name/editor.tsx` — uncomment the `PluginHost.register(generateMusic, 'generate-music')` line (similar to the M11 `isolate-vocals` TODO already present)

---

## Steps

### 1. `plugin.yaml`

Mirror the backend manifest:

```yaml
name: generate-music
version: 1.0.0
displayName: "Music Generation"
description: "AI-composed music and scores via Musicful."
publisher: scenecraft
license: MIT
schema_version: 1

activationEvents:
  - onCommand:generate-music.run

contributes:
  operations:
    - id: generate-music.run
      label: "Generate music"
      entityTypes: [audio_clip, transition, null]
      handler: "backend:generate_music.run"
      panel: "frontend:generate_music.MusicGenerationsPanel"

  invariants:
    - id: "musicful-api-key-present"
      description: "MUSICFUL_API_KEY environment variable must be set."
      check: "backend:generate_music.check_api_key"
      severity: blocking
      user_message: "This plugin requires a Musicful API key. Please contact your administrator."
```

### 2. `types.ts`

```typescript
export type GenerationAction = 'auto' | 'custom'
export type GenerationStatus = 'pending' | 'running' | 'completed' | 'failed'

export type Generation = {
  id: string
  action: GenerationAction
  model: string
  style: string | null
  lyrics: string | null
  title: string | null
  instrumental: 0 | 1
  gender: 'male' | 'female' | '' | null
  task_ids: string[]
  status: GenerationStatus
  error: string | null
  entity_type: 'audio_clip' | 'transition' | null
  entity_id: string | null
  reused_from: string | null
  created_at: string
  tracks: GenerationTrack[]
}

export type GenerationTrack = {
  generation_id: string
  pool_segment_id: string
  musicful_task_id: string
  song_title: string | null
  duration_seconds: number | null
  cover_url: string | null
}

export type CreditsResponse = {
  credits: number | null
  last_checked_at: string
  error?: string
}
```

### 3. `client.ts` — REST

Thin wrappers over fetch, co-located with other scenecraft clients. Attach `X-Scenecraft-API-Key` + session auth via existing fetch helper (from M6 frontend auth work).

```typescript
export async function runGeneration(projectName: string, payload: RunPayload): Promise<RunResponse>
export async function listGenerations(projectName: string, filter?: {entityType?: string, entityId?: string}): Promise<Generation[]>
export async function retryGeneration(projectName: string, generationId: string): Promise<RunResponse>
export async function getCredits(projectName: string): Promise<CreditsResponse>
```

### 4. `client.ts` — WS subscription

Reuse the existing `/ws/jobs` client (from M11 task-101 frontend plugin-api). Expose a hook:

```typescript
export function useMusicGenerationEvents(projectName: string, onEvent: (event: JobEvent) => void): void
```

Subscribes to the project's job WS, filters for `jobType === 'generate_music'`, and delivers `job_started | job_progress | job_completed | job_failed` events. Panel will use this to refresh its run list + credits.

### 5. `index.ts` — `activate(host)`

```typescript
import type { PluginHost, Disposable } from '@/lib/plugin-host'
import { MusicGenerationsPanel } from './MusicGenerationsPanel'  // from task-132

export function activate(host: PluginHost): Disposable {
  const disp = host.registerPanel({
    id: 'music-generations',
    title: 'Music Generations',
    component: MusicGenerationsPanel,
    // icon: optional lucide-react icon component
  })
  return { dispose: () => disp.dispose() }
}
```

Uses the `host.registerPanel` contribution added by the corrected research in clarification-10 (custom panel-layout, NOT dockview).

### 6. Wire into editor entry

In `scenecraft/src/routes/project/$name/editor.tsx`, add (after the existing isolate-vocals registration pattern):

```typescript
import * as generateMusic from '@/plugins/generate-music'
PluginHost.register(generateMusic, 'generate-music')
```

### 7. Tests

- `client-run-generation-posts-correct-body` — mock fetch; assert body shape + auth header
- `client-list-generations-filter-query` — asserts correct query string
- `useMusicGenerationEvents-filters-by-job-type` — emit an isolation event + a music event; only music fires the callback
- `plugin-registration-adds-panel` — after `activate(host)`, `PanelRegistry` contains `music-generations`

---

## Verification

- [ ] `plugin.yaml` mirrors backend manifest exactly
- [ ] Plugin registers cleanly via `PluginHost.register`
- [ ] Panel appears in `EditorPanelLayout`'s `PanelRegistry`
- [ ] REST client calls carry session cookie + `X-Scenecraft-API-Key` header
- [ ] WS hook filters by `jobType`
- [ ] HMR-safe (plugin can be re-registered without duplication — see M11's `registerIdempotent` pattern)

---

## Notes

- The auth headers should be attached by a shared fetch wrapper (from M6 frontend auth). If there isn't one yet, add a minimal wrapper in `scenecraft/src/lib/authed-fetch.ts` that reads session token + API key from a session store.
- Panel component is out of scope for this task — just reference the import; task-132 delivers it.
- The `host.registerPanel` method was flagged in clarification-10's dockview correction as part of the plugin-api surface; if it doesn't exist yet, extend `scenecraft/src/lib/plugin-host.ts` and `plugin-api.ts` here.
