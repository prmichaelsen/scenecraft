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
