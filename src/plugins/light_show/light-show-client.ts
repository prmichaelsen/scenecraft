/**
 * REST client for the light_show plugin backend.
 *
 * Endpoints (see scenecraft-engine plugins/light_show/routes.py):
 *   GET  /api/projects/:name/plugins/light_show/fixtures
 *   PUT  /api/projects/:name/plugins/light_show/fixtures
 *   POST /api/projects/:name/plugins/light_show/fixtures/reset
 *
 * The panel polls fetchFixtures() on a short interval so chat-driven
 * MCP tool invocations (light_show__set_rig_layout etc.) reflect in
 * the 3D preview within a second or two.
 */

const API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

export type FixtureRow = {
  id: string
  role: string
  label: string
  position_x: number
  position_y: number
  position_z: number
  rotation_x: number
  rotation_y: number
  rotation_z: number
  // DMX patch — null when fixture is unpatched (auto-patcher fills gaps).
  dmx_universe: number | null
  dmx_address: number | null
  dmx_channel_count: number | null
}

export type FixtureUpsert = {
  id: string
  role?: string
  label?: string
  position_x?: number
  position_y?: number
  position_z?: number
  rotation_x?: number
  rotation_y?: number
  rotation_z?: number
  // Pass null to explicitly clear back to auto-patch; omit to preserve.
  dmx_universe?: number | null
  dmx_address?: number | null
  dmx_channel_count?: number | null
}

function projectPath(projectName: string) {
  return `${API_URL}/api/projects/${encodeURIComponent(projectName)}/plugins/light_show/fixtures`
}

export async function fetchFixtures(projectName: string): Promise<FixtureRow[]> {
  const res = await fetch(projectPath(projectName))
  if (!res.ok) throw new Error(`fetchFixtures ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { fixtures?: FixtureRow[]; error?: string }
  if (body.error) throw new Error(body.error)
  return body.fixtures ?? []
}

export async function upsertFixtures(
  projectName: string,
  fixtures: FixtureUpsert[],
): Promise<FixtureRow[]> {
  const res = await fetch(projectPath(projectName), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtures }),
  })
  if (!res.ok) throw new Error(`upsertFixtures ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { fixtures?: FixtureRow[]; error?: string }
  if (body.error) throw new Error(body.error)
  return body.fixtures ?? []
}

export async function resetRig(projectName: string): Promise<FixtureRow[]> {
  const res = await fetch(`${projectPath(projectName)}/reset`, { method: 'POST' })
  if (!res.ok) throw new Error(`resetRig ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { fixtures?: FixtureRow[]; error?: string }
  if (body.error) throw new Error(body.error)
  return body.fixtures ?? []
}

// ── Overrides ─────────────────────────────────────────────────────────────

/** Per-fixture channel overrides. Keys appear only when the channel is
 *  currently overridden (NULL = scene-driven). */
export type Override = {
  fixture_id: string
  intensity?: number
  color?: [number, number, number]
  pan?: number
  tilt?: number
}

function overridesPath(projectName: string) {
  return `${API_URL}/api/projects/${encodeURIComponent(projectName)}/plugins/light_show/overrides`
}

export async function fetchOverrides(projectName: string): Promise<Override[]> {
  const res = await fetch(overridesPath(projectName))
  if (!res.ok) throw new Error(`fetchOverrides ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { overrides?: Override[]; error?: string }
  if (body.error) throw new Error(body.error)
  return body.overrides ?? []
}

export type OverrideSet = {
  id: string
  intensity?: number
  color?: [number, number, number]
  pan?: number
  tilt?: number
}

export async function setOverrides(
  projectName: string,
  overrides: OverrideSet[],
): Promise<Override[]> {
  const res = await fetch(overridesPath(projectName), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overrides }),
  })
  if (!res.ok) throw new Error(`setOverrides ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { overrides?: Override[]; error?: string }
  if (body.error) throw new Error(body.error)
  return body.overrides ?? []
}

export async function clearOverrides(
  projectName: string,
  ids?: string[],
): Promise<Override[]> {
  const res = await fetch(`${overridesPath(projectName)}/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ids ?? [] }),
  })
  if (!res.ok) throw new Error(`clearOverrides ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { overrides?: Override[]; error?: string }
  if (body.error) throw new Error(body.error)
  return body.overrides ?? []
}

// ── Screens ───────────────────────────────────────────────────────────────

/** One video screen in the 3D preview. MVP renders the scenecraft main
 *  timeline's frame preview onto every screen via a shared texture. */
export type ScreenRow = {
  id: string
  label: string
  position_x: number
  position_y: number
  position_z: number
  rotation_x: number
  rotation_y: number
  rotation_z: number
  width: number
  height: number
}

export type ScreenUpsert = {
  id: string
  label?: string
  position_x?: number
  position_y?: number
  position_z?: number
  rotation_x?: number
  rotation_y?: number
  rotation_z?: number
  width?: number
  height?: number
}

function screensPath(projectName: string) {
  return `${API_URL}/api/projects/${encodeURIComponent(projectName)}/plugins/light_show/screens`
}

export async function fetchScreens(projectName: string): Promise<ScreenRow[]> {
  const res = await fetch(screensPath(projectName))
  if (!res.ok) throw new Error(`fetchScreens ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { screens?: ScreenRow[]; error?: string }
  if (body.error) throw new Error(body.error)
  return body.screens ?? []
}

export async function upsertScreens(
  projectName: string,
  screens: ScreenUpsert[],
): Promise<ScreenRow[]> {
  const res = await fetch(screensPath(projectName), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ screens }),
  })
  if (!res.ok) throw new Error(`upsertScreens ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { screens?: ScreenRow[]; error?: string }
  if (body.error) throw new Error(body.error)
  return body.screens ?? []
}

export async function removeScreens(projectName: string, ids: string[]): Promise<ScreenRow[]> {
  const res = await fetch(`${screensPath(projectName)}/remove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!res.ok) throw new Error(`removeScreens ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { screens?: ScreenRow[]; error?: string }
  if (body.error) throw new Error(body.error)
  return body.screens ?? []
}

export async function resetScreens(projectName: string): Promise<ScreenRow[]> {
  const res = await fetch(`${screensPath(projectName)}/reset`, { method: 'POST' })
  if (!res.ok) throw new Error(`resetScreens ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { screens?: ScreenRow[]; error?: string }
  if (body.error) throw new Error(body.error)
  return body.screens ?? []
}

// ── M19 Scene Editor ─────────────────────────────────────────────────────

/** A scene library entry. ``params`` is the SPARSE stored value — only
 *  keys explicitly overridden by the user. Catalog defaults are merged
 *  at evaluator time, never on the wire. */
export type SceneRow = {
  id: string
  label: string
  type: string
  params: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type SceneCreate = {
  label: string
  type: string
  params?: Record<string, unknown>
}

/** RFC 7396 JSON Merge Patch on params. Server rejects ``params: null``
 *  (use ``{}`` to preserve, ``{key: null}`` to delete a key). */
export type ScenePatch = {
  label?: string
  type?: string
  params?: Record<string, unknown>
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

export type PlacementCreate = {
  scene_id: string
  start_time: number
  end_time: number
  display_order?: number
  fade_in_sec?: number
  fade_out_sec?: number
}

export type PlacementPatch = Partial<Omit<PlacementRow, 'id' | 'created_at' | 'updated_at'>>

export type LiveOverrideRow =
  | { active: false }
  | {
      active: true
      scene_id: string | null
      inline_type?: string | null
      inline_params?: Record<string, unknown> | null
      label: string
      activated_at: string
      fade_in_sec: number
      fade_out_sec: number
      deactivation_started_at: string | null
    }

export type ActivatePayload = {
  scene_id?: string
  scene?: { type: string; params: Record<string, unknown> }
  label?: string
  /** Inline only — also persists to library with this label. */
  save_as?: string
  fade_in_sec?: number
}

export type PrimitiveCatalogEntry = {
  id: string
  label: string
  description: string
  params_schema: Record<string, unknown>
}

function lsBase(projectName: string): string {
  return `${API_URL}/api/projects/${encodeURIComponent(projectName)}/plugins/light_show`
}

/** Build a query string with repeated-key array form (?ids=a&ids=b).
 *  Skips undefined / null. Top-level dotted paths (filter.ids, filter.type)
 *  flatten to their leaf names since the backend reads filter.* via parse_qs. */
function buildScenesQuery(opts: {
  filter?: { ids?: string[]; type?: string; label_query?: string }
  limit?: number
  offset?: number
  order_by?: 'created_at' | 'updated_at' | 'label'
  order?: 'asc' | 'desc'
}): string {
  const p = new URLSearchParams()
  if (opts.filter?.ids) for (const id of opts.filter.ids) p.append('ids', id)
  if (opts.filter?.type) p.set('type', opts.filter.type)
  if (opts.filter?.label_query) p.set('label_query', opts.filter.label_query)
  if (opts.limit !== undefined) p.set('limit', String(opts.limit))
  if (opts.offset !== undefined) p.set('offset', String(opts.offset))
  if (opts.order_by) p.set('order_by', opts.order_by)
  if (opts.order) p.set('order', opts.order)
  const s = p.toString()
  return s ? `?${s}` : ''
}

function buildPlacementsQuery(opts: {
  filter?: { ids?: string[]; scene_id?: string; time_range?: { start: number; end: number } }
  limit?: number
  offset?: number
  order_by?: 'start_time' | 'created_at'
  order?: 'asc' | 'desc'
}): string {
  const p = new URLSearchParams()
  if (opts.filter?.ids) for (const id of opts.filter.ids) p.append('ids', id)
  if (opts.filter?.scene_id) p.set('scene_id', opts.filter.scene_id)
  if (opts.filter?.time_range) {
    p.set('time_start', String(opts.filter.time_range.start))
    p.set('time_end', String(opts.filter.time_range.end))
  }
  if (opts.limit !== undefined) p.set('limit', String(opts.limit))
  if (opts.offset !== undefined) p.set('offset', String(opts.offset))
  if (opts.order_by) p.set('order_by', opts.order_by)
  if (opts.order) p.set('order', opts.order)
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Common error path. The api_server returns 200 with a body ``{error}`` on
 *  validation failures (existing convention) — we still throw so callers
 *  bubble it the same way as a 4xx. Blocked-delete shapes (``blocked``
 *  array, ``blocked_by_live``) flow through the thrown error's message
 *  via JSON.stringify. */
function throwIfError<T extends Record<string, unknown>>(body: T, op: string): void {
  const err = (body as { error?: string }).error
  if (err) throw new Error(`${op}: ${err} :: ${JSON.stringify(body)}`)
}

// ── primitives ──────────────────────────────────────────────────────────

export async function fetchPrimitivesCatalog(
  projectName: string,
): Promise<{ primitives: PrimitiveCatalogEntry[] }> {
  const res = await fetch(`${lsBase(projectName)}/primitives`)
  if (!res.ok) throw new Error(`fetchPrimitivesCatalog ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { primitives?: PrimitiveCatalogEntry[]; error?: string }
  throwIfError(body, 'fetchPrimitivesCatalog')
  return { primitives: body.primitives ?? [] }
}

// ── scenes ──────────────────────────────────────────────────────────────

export async function fetchScenes(
  projectName: string,
  opts: Parameters<typeof buildScenesQuery>[0] = {},
): Promise<{ scenes: SceneRow[]; total: number; has_more: boolean }> {
  const url = `${lsBase(projectName)}/scenes${buildScenesQuery(opts)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetchScenes ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as {
    scenes?: SceneRow[]
    total?: number
    has_more?: boolean
    error?: string
  }
  throwIfError(body, 'fetchScenes')
  return {
    scenes: body.scenes ?? [],
    total: body.total ?? 0,
    has_more: body.has_more ?? false,
  }
}

export async function createScene(
  projectName: string,
  body: SceneCreate,
): Promise<SceneRow> {
  const res = await fetch(`${lsBase(projectName)}/scenes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`createScene ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { scene?: SceneRow; error?: string }
  throwIfError(data, 'createScene')
  if (!data.scene) throw new Error('createScene: no scene in response')
  return data.scene
}

export async function fetchScene(
  projectName: string,
  id: string,
): Promise<SceneRow | null> {
  const res = await fetch(`${lsBase(projectName)}/scenes/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`fetchScene ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { scene?: SceneRow; error?: string; status?: number }
  if (data.error && data.status === 404) return null
  throwIfError(data, 'fetchScene')
  return data.scene ?? null
}

export async function patchScene(
  projectName: string,
  id: string,
  body: ScenePatch,
): Promise<SceneRow> {
  const res = await fetch(`${lsBase(projectName)}/scenes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`patchScene ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { scene?: SceneRow; error?: string }
  throwIfError(data, 'patchScene')
  if (!data.scene) throw new Error('patchScene: no scene in response')
  return data.scene
}

export async function deleteScene(
  projectName: string,
  id: string,
): Promise<SceneRow> {
  const res = await fetch(`${lsBase(projectName)}/scenes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`deleteScene ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as {
    scene?: SceneRow
    error?: string
    blocked?: Array<{ scene_id: string; placement_ids: string[] }>
    blocked_by_live?: string
  }
  throwIfError(data, 'deleteScene')
  if (!data.scene) throw new Error('deleteScene: no scene in response')
  return data.scene
}

// ── placements ──────────────────────────────────────────────────────────

export async function fetchPlacements(
  projectName: string,
  opts: Parameters<typeof buildPlacementsQuery>[0] = {},
): Promise<{ placements: PlacementRow[]; total: number; has_more: boolean }> {
  const res = await fetch(`${lsBase(projectName)}/placements${buildPlacementsQuery(opts)}`)
  if (!res.ok) throw new Error(`fetchPlacements ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as {
    placements?: PlacementRow[]
    total?: number
    has_more?: boolean
    error?: string
  }
  throwIfError(body, 'fetchPlacements')
  return {
    placements: body.placements ?? [],
    total: body.total ?? 0,
    has_more: body.has_more ?? false,
  }
}

export async function createPlacement(
  projectName: string,
  body: PlacementCreate,
): Promise<PlacementRow> {
  const res = await fetch(`${lsBase(projectName)}/placements`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`createPlacement ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { placement?: PlacementRow; error?: string }
  throwIfError(data, 'createPlacement')
  if (!data.placement) throw new Error('createPlacement: no placement in response')
  return data.placement
}

export async function fetchPlacement(
  projectName: string,
  id: string,
): Promise<PlacementRow | null> {
  const res = await fetch(`${lsBase(projectName)}/placements/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`fetchPlacement ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { placement?: PlacementRow; error?: string; status?: number }
  if (data.error && data.status === 404) return null
  throwIfError(data, 'fetchPlacement')
  return data.placement ?? null
}

export async function patchPlacement(
  projectName: string,
  id: string,
  body: PlacementPatch,
): Promise<PlacementRow> {
  const res = await fetch(`${lsBase(projectName)}/placements/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`patchPlacement ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { placement?: PlacementRow; error?: string }
  throwIfError(data, 'patchPlacement')
  if (!data.placement) throw new Error('patchPlacement: no placement in response')
  return data.placement
}

export async function deletePlacement(
  projectName: string,
  id: string,
): Promise<PlacementRow> {
  const res = await fetch(`${lsBase(projectName)}/placements/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`deletePlacement ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { placement?: PlacementRow; error?: string }
  throwIfError(data, 'deletePlacement')
  if (!data.placement) throw new Error('deletePlacement: no placement in response')
  return data.placement
}

// ── live override ──────────────────────────────────────────────────────

export async function fetchLiveOverride(projectName: string): Promise<LiveOverrideRow> {
  const res = await fetch(`${lsBase(projectName)}/live`)
  if (!res.ok) throw new Error(`fetchLiveOverride ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as LiveOverrideRow & { error?: string }
  if (data.error) throw new Error(`fetchLiveOverride: ${data.error}`)
  return data
}

export async function activateLive(
  projectName: string,
  body: ActivatePayload,
): Promise<LiveOverrideRow> {
  const res = await fetch(`${lsBase(projectName)}/live`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`activateLive ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as LiveOverrideRow & { error?: string }
  if (data.error) throw new Error(`activateLive: ${data.error}`)
  return data
}

export async function deactivateLive(
  projectName: string,
  opts: { fade_out_sec?: number } = {},
): Promise<LiveOverrideRow> {
  const qs = opts.fade_out_sec !== undefined ? `?fade_out_sec=${opts.fade_out_sec}` : ''
  const res = await fetch(`${lsBase(projectName)}/live${qs}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`deactivateLive ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as LiveOverrideRow & { error?: string }
  if (data.error) throw new Error(`deactivateLive: ${data.error}`)
  return data
}
