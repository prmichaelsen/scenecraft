/**
 * light_show MVP 3D preview panel.
 *
 * Renders the hardcoded rig in a three.js + react-three-fiber scene. The
 * user picks a scene from the dropdown; the scene mutates per-frame fixture
 * state; the renderer reads that state to drive fixture rotation (pan/tilt
 * for moving heads) and beam shader uniforms (color + intensity).
 *
 * Per-frame mutation is done via refs, not React state, so we don't
 * re-render the React tree 60x/sec. Canvas is pinned to
 * ``frameloop="always"`` so the scene runs independent of any external
 * playback state (the MVP's scene-time has its own clock).
 *
 * Deliberately hardcoded to validate the pipeline end-to-end without
 * backend, DB, or timeline coupling. Each piece (rig, scenes, evaluator,
 * panel layout) gets a real SQL + DSL-backed replacement in M17 proper.
 */

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Grid } from '@react-three/drei'

import { RIG, type FixtureDef, type FixtureState, type FixtureRole } from './fixtures'
import { SCENES, getScene } from './scenes'
import { BeamCone } from './BeamCone'
import { fetchFixtures, type FixtureRow } from './light-show-client'

const POLL_INTERVAL_MS = 2000

function rowToDef(row: FixtureRow): FixtureDef {
  return {
    id: row.id,
    role: row.role as FixtureRole,
    label: row.label,
    position: [row.position_x, row.position_y, row.position_z],
    rotation: [row.rotation_x, row.rotation_y, row.rotation_z],
  }
}

/** One rigged fixture: body geometry + beam cone, driven by its state slot.
 *  Uses refs only — no React state in the per-frame path. */
function Fixture({ def, stateRef }: { def: FixtureDef; stateRef: React.MutableRefObject<FixtureState[]> }) {
  const headRef = useRef<THREE.Group>(null!)

  useFrame(() => {
    if (def.role !== 'moving_head' || !headRef.current) return
    const state = stateRef.current.find((s) => s.id === def.id)
    if (!state) return
    headRef.current.rotation.x = def.rotation[0] + state.tilt
    headRef.current.rotation.y = state.pan
  })

  const isMover = def.role === 'moving_head'
  const beamLength = isMover ? 6 : 4
  const beamHalfAngle = isMover ? Math.PI / 24 : Math.PI / 12

  return (
    <group position={def.position}>
      {isMover ? (
        <>
          {/* Yoke base — flat plate */}
          <mesh>
            <boxGeometry args={[0.25, 0.1, 0.25]} />
            <meshStandardMaterial color="#222" />
          </mesh>
          {/* Head + beam — rotates for pan/tilt, ref-driven per frame */}
          <group ref={headRef} position={[0, -0.15, 0]} rotation={def.rotation}>
            <mesh>
              <cylinderGeometry args={[0.1, 0.12, 0.25, 16]} />
              <meshStandardMaterial color="#333" />
            </mesh>
            <group position={[0, -0.125, 0]}>
              <BeamCone fixtureId={def.id} stateRef={stateRef} length={beamLength} halfAngle={beamHalfAngle} />
            </group>
          </group>
        </>
      ) : (
        <>
          {/* Par body — short cylinder aimed via base rotation (no pan/tilt) */}
          <group rotation={def.rotation}>
            <mesh>
              <cylinderGeometry args={[0.1, 0.12, 0.2, 16]} />
              <meshStandardMaterial color="#333" />
            </mesh>
            <group position={[0, -0.1, 0]}>
              <BeamCone fixtureId={def.id} stateRef={stateRef} length={beamLength} halfAngle={beamHalfAngle} />
            </group>
          </group>
        </>
      )}
    </group>
  )
}

/** Ticks the active scene every frame, writing into the shared state array.
 *  Also bumps ``diagDomRef`` every 15 frames as a visible liveness probe —
 *  if the header doesn't show an incrementing tick count, useFrame isn't
 *  firing and that's the bug to chase. */
function SceneRunner({
  activeSceneIdRef,
  stateRef,
  timeRef,
  diagDomRef,
}: {
  activeSceneIdRef: React.MutableRefObject<string>
  stateRef: React.MutableRefObject<FixtureState[]>
  timeRef: React.MutableRefObject<number>
  diagDomRef: React.MutableRefObject<HTMLSpanElement | null>
}) {
  const tickRef = useRef(0)
  useFrame((_, delta) => {
    tickRef.current++
    if (tickRef.current % 15 === 0 && diagDomRef.current) {
      diagDomRef.current.textContent = `ticks ${tickRef.current} · t=${timeRef.current.toFixed(1)}s`
    }
    const scene = getScene(activeSceneIdRef.current)
    if (!scene) return
    timeRef.current += delta
    scene.apply(timeRef.current, stateRef.current)
  })
  return null
}

export function LightShow3DPanel({ projectName }: { projectName?: string } = {}) {
  const [activeSceneId, setActiveSceneId] = useState<string>(SCENES[0].id)
  // Ref mirror of activeSceneId so SceneRunner's useFrame picks up changes
  // without needing to re-subscribe (avoids tearing down the tick).
  const activeSceneIdRef = useRef<string>(SCENES[0].id)
  activeSceneIdRef.current = activeSceneId

  // Rig state. Start with the hardcoded RIG as fallback (so something
  // renders immediately), swap to backend-fetched fixtures once they arrive.
  // Polled every POLL_INTERVAL_MS so chat-driven MCP tool updates land
  // visibly in the 3D scene without explicit refresh.
  const [rig, setRig] = useState<FixtureDef[]>(RIG)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Per-frame fixture state (intensity/color/pan/tilt). Refs because useFrame
  // mutates them hot-path — never goes through React state. Rebuilt when the
  // rig shape changes so new fixtures have initial state and removed fixtures
  // are pruned.
  const stateRef = useRef<FixtureState[]>(
    RIG.map((f) => ({
      id: f.id,
      role: f.role,
      intensity: 1,
      color: [1, 1, 1],
      pan: 0,
      tilt: 0,
    })),
  )
  const timeRef = useRef<number>(0)
  const diagDomRef = useRef<HTMLSpanElement | null>(null)

  // Fetch fixtures from backend + poll. Only active when we have a projectName.
  useEffect(() => {
    if (!projectName) return
    let cancelled = false
    const tick = async () => {
      try {
        const rows = await fetchFixtures(projectName)
        if (cancelled) return
        setFetchError(null)
        const defs = rows.map(rowToDef)
        setRig(defs)
        // Reconcile stateRef: preserve existing state per id, add defaults
        // for new fixtures, drop removed ones. useFrame reads stateRef by
        // .find(id), so the order doesn't need to match defs.
        const byId = new Map(stateRef.current.map((s) => [s.id, s]))
        stateRef.current = defs.map((d) =>
          byId.get(d.id) ?? {
            id: d.id,
            role: d.role,
            intensity: 1,
            color: [1, 1, 1],
            pan: 0,
            tilt: 0,
          },
        )
      } catch (e) {
        if (cancelled) return
        setFetchError((e as Error).message)
      }
    }
    tick()
    const h = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(h)
    }
  }, [projectName])

  const onPickScene = (id: string) => {
    timeRef.current = 0
    setActiveSceneId(id)
  }

  return (
    <div className="flex flex-col h-full w-full bg-gray-950">
      {/* Scene picker */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900">
        <span className="text-xs uppercase tracking-wider text-gray-500">Scene</span>
        <select
          value={activeSceneId}
          onChange={(e) => onPickScene(e.target.value)}
          className="bg-gray-800 text-gray-100 text-sm rounded px-2 py-1 border border-gray-700 focus:outline-none focus:border-purple-500"
        >
          {SCENES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[10px] text-gray-600">
          {rig.length} fixtures{fetchError ? ' (fetch failed)' : projectName ? ' (live)' : ' (hardcoded)'} ·{' '}
          <span ref={diagDomRef}>ticks 0 · t=0.0s</span>
        </span>
      </div>

      {/* 3D scene — frameloop="always" so animation runs independent of any
          external playback state (the editor's timeline, audio playback, etc). */}
      <div className="flex-1 min-h-0">
        <Canvas
          frameloop="always"
          camera={{ position: [0, 3, -8], fov: 50 }}
          shadows={false}
        >
          <color attach="background" args={['#050510']} />
          <ambientLight intensity={0.08} />
          <Grid
            args={[20, 20]}
            position={[0, 0, 0]}
            cellColor="#222"
            sectionColor="#444"
            cellSize={1}
            sectionSize={5}
            fadeDistance={30}
            fadeStrength={1}
            infiniteGrid={false}
          />
          <SceneRunner
            activeSceneIdRef={activeSceneIdRef}
            stateRef={stateRef}
            timeRef={timeRef}
            diagDomRef={diagDomRef}
          />
          {rig.map((def) => (
            <Fixture key={def.id} def={def} stateRef={stateRef} />
          ))}
          <OrbitControls target={[0, 1, 0]} enableDamping />
        </Canvas>
      </div>
    </div>
  )
}
