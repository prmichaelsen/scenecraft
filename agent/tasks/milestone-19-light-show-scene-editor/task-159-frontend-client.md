# Task 159: Frontend Client + Types

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — Interfaces > TypeScript types; REST endpoints
**Estimated Time**: 0.5 hour
**Dependencies**: task-153 (REST endpoints exist)
**Status**: Not Started

---

## Objective

Add TypeScript types + REST fetch helpers to `light-show-client.ts` for scenes / placements / live override / primitives. Sparse params preserved on round-trip — no merge with catalog defaults at fetch time.

---

## Steps

### 1. Append to `scenecraft/src/plugins/light_show/light-show-client.ts`

Types per spec (matching backend response shapes):

```ts
export type SceneRow = {
  id: string                     // server uuid
  label: string
  type: string
  params: Record<string, unknown>  // sparse — only explicit overrides
  created_at: string
  updated_at: string
}

export type SceneCreate = {
  label: string
  type: string
  params?: Record<string, unknown>
}

export type ScenePatch = {
  label?: string
  type?: string
  params?: Record<string, unknown> | null  // null on params object is rejected by server (R6)
}

export type PlacementRow = {
  id: string
  scene_id: string
  start_time: number
  end_time: number
  display_order: number
  fade_in_sec: number
  fade_out_sec: number
  created_at: string
  updated_at: string
}

export type PlacementCreate = Omit<PlacementRow, 'id' | 'created_at' | 'updated_at'> & {
  display_order?: number
  fade_in_sec?: number
  fade_out_sec?: number
}

export type PlacementPatch = Partial<Omit<PlacementRow, 'id' | 'created_at' | 'updated_at'>>

export type LiveOverrideRow =
  | { active: false }
  | {
      active: true
      scene_id: string | null            // null when inline override (no save_as)
      label: string
      activated_at: string
      fade_in_sec: number
      fade_out_sec: number
      deactivation_started_at: string | null
    }

export type ActivatePayload = {
  scene_id?: string                        // OR
  scene?: { type: string; params: Record<string, unknown> }
  label?: string
  save_as?: string                         // creates library scene with this label
  fade_in_sec?: number
}

export type PrimitiveCatalogEntry = {
  id: string
  label: string
  description: string
  params_schema: Record<string, unknown>   // JSON-schema
}
```

### 2. Fetchers (REST → typed responses)

```ts
export async function fetchScenes(projectName, opts: {
  filter?: { ids?: string[]; type?: string; label_query?: string }
  limit?: number; offset?: number
  order_by?: 'created_at' | 'updated_at' | 'label'
  order?: 'asc' | 'desc'
}): Promise<{ scenes: SceneRow[]; total: number; has_more: boolean }>

export async function createScene(projectName, body: SceneCreate): Promise<SceneRow>
export async function fetchScene(projectName, id: string): Promise<SceneRow | null>
export async function patchScene(projectName, id: string, body: ScenePatch): Promise<SceneRow>
export async function deleteScene(projectName, id: string): Promise<SceneRow>

export async function fetchPlacements(projectName, opts: {
  filter?: { ids?: string[]; scene_id?: string; time_range?: { start: number; end: number } }
  limit?: number; offset?: number
  order_by?: 'start_time' | 'created_at'
  order?: 'asc' | 'desc'
}): Promise<{ placements: PlacementRow[]; total: number; has_more: boolean }>

export async function createPlacement(projectName, body: PlacementCreate): Promise<PlacementRow>
export async function fetchPlacement(projectName, id: string): Promise<PlacementRow | null>
export async function patchPlacement(projectName, id: string, body: PlacementPatch): Promise<PlacementRow>
export async function deletePlacement(projectName, id: string): Promise<PlacementRow>

export async function fetchLiveOverride(projectName): Promise<LiveOverrideRow>
export async function activateLive(projectName, body: ActivatePayload): Promise<LiveOverrideRow>
export async function deactivateLive(projectName, opts?: { fade_out_sec?: number }): Promise<LiveOverrideRow>

export async function fetchPrimitivesCatalog(projectName): Promise<{ primitives: PrimitiveCatalogEntry[] }>
```

### 3. Query string serialization for filters

Repeated keys for arrays: `?ids=a&ids=b`. Build via `URLSearchParams`. Skip undefined fields.

### 4. Error handling

Each fetcher checks `res.ok`; on 4xx/5xx, throws `Error` with `{status, error}` info preserved. Caller surfaces error in UI / chat.

### 5. Rejected-PATCH marshaling

`patchScene` body where `params: null` will be rejected by the server (R6). The TS type already disallows it via `Record<string, unknown> | null` — but for the runtime case, the fetcher should let the server's 400 envelope flow through.

---

## Verification

- [ ] All types + fetchers exported from `light-show-client.ts`
- [ ] `tsc --noEmit` clean for the file
- [ ] Sparse-params round trip: `fetchScenes` returns `params` exactly as stored (no defaults filled in client-side)
- [ ] Query string assembly: `fetchScenes({filter: {ids: ['a','b']}})` produces `?ids=a&ids=b` (verified against actual fetched URL)
- [ ] Error path: server 409 on `deleteScene` surfaces as a thrown Error with the blocked structure

---

## Notes

- No merge with catalog defaults on the frontend client side. The evaluator (task-161) does that transiently per frame.
- The existing fetchers (fetchFixtures, fetchOverrides, fetchScreens) stay unchanged. New code lives at the bottom of the file.
