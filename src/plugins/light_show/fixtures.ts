/**
 * Hardcoded rig for the light_show MVP. Positions in meters, right-handed,
 * origin at center-stage, +Y up (three.js convention). Rotation is Euler
 * radians defining the fixture's default aim direction.
 *
 * Real rigs will load from a SQL-backed fixtures table in a later milestone.
 * This hardcoded set exists to validate the 3D pipeline end-to-end with
 * minimal backend coupling — see the task-135 MVP decision.
 */

export type FixtureRole = 'moving_head' | 'par'

export interface FixtureDef {
  id: string
  role: FixtureRole
  label: string
  position: [number, number, number]
  /** Base rotation — the fixture's "home" aim before scene animation kicks in. */
  rotation: [number, number, number]
}

/** 4 moving heads on an upstage truss + 4 RGB wash pars along the downstage front. */
export const RIG: FixtureDef[] = [
  // Moving heads — upstage truss, 4m up, aimed slightly down toward the stage
  { id: 'mh_1', role: 'moving_head', label: 'MH 1', position: [-3,   4,  2], rotation: [-Math.PI / 4, 0, 0] },
  { id: 'mh_2', role: 'moving_head', label: 'MH 2', position: [-1,   4,  2], rotation: [-Math.PI / 4, 0, 0] },
  { id: 'mh_3', role: 'moving_head', label: 'MH 3', position: [ 1,   4,  2], rotation: [-Math.PI / 4, 0, 0] },
  { id: 'mh_4', role: 'moving_head', label: 'MH 4', position: [ 3,   4,  2], rotation: [-Math.PI / 4, 0, 0] },
  // Wash pars — downstage front, 2m up, aimed upstage at ~30° from horizontal
  { id: 'par_1', role: 'par', label: 'PAR 1', position: [-3, 2, -3], rotation: [-Math.PI / 6, 0, 0] },
  { id: 'par_2', role: 'par', label: 'PAR 2', position: [-1, 2, -3], rotation: [-Math.PI / 6, 0, 0] },
  { id: 'par_3', role: 'par', label: 'PAR 3', position: [ 1, 2, -3], rotation: [-Math.PI / 6, 0, 0] },
  { id: 'par_4', role: 'par', label: 'PAR 4', position: [ 3, 2, -3], rotation: [-Math.PI / 6, 0, 0] },
]

/**
 * Per-frame mutable state for a fixture. Scenes write into these fields each
 * frame; the renderer reads them to drive geometry rotation + beam shader
 * uniforms.
 */
export interface FixtureState {
  id: string
  role: FixtureRole
  /** Light output 0-1. */
  intensity: number
  /** RGB 0-1 (linear). */
  color: [number, number, number]
  /** Pan offset in radians (moving_head only — applied on top of base rotation). */
  pan: number
  /** Tilt offset in radians (moving_head only). */
  tilt: number
}

export function makeInitialStates(): FixtureState[] {
  return RIG.map((f) => ({
    id: f.id,
    role: f.role,
    intensity: 0,
    color: [1, 1, 1],
    pan: 0,
    tilt: 0,
  }))
}
