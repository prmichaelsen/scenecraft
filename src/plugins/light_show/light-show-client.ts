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
