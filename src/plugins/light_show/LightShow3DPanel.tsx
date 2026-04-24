/**
 * light_show MVP 3D preview panel.
 *
 * Renders the hardcoded rig in a three.js + react-three-fiber scene. The
 * user picks a scene from the dropdown; the scene mutates per-frame fixture
 * state; the renderer reads that state to drive fixture rotation (pan/tilt
 * for moving heads) and beam shader uniforms (color + intensity).
 *
 * Deliberately hardcoded to validate the pipeline end-to-end without
 * backend, DB, or timeline coupling. Each piece (rig, scenes, evaluator,
 * panel layout) gets a real SQL + DSL-backed replacement in M17 proper.
 */

import { useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Grid } from '@react-three/drei'

import { RIG, type FixtureDef, type FixtureState, makeInitialStates } from './fixtures'
import { SCENES, getScene } from './scenes'
import { BeamCone } from './BeamCone'

/** One rigged fixture: body geometry + beam cone, driven by its state slot. */
function Fixture({ def, stateRef }: { def: FixtureDef; stateRef: React.MutableRefObject<FixtureState[]> }) {
  const pivotRef = useRef<THREE.Group>(null!)
  const headRef = useRef<THREE.Group>(null!)
  const [color, setColor] = useState<[number, number, number]>([1, 1, 1])
  const [intensity, setIntensity] = useState(0)

  useFrame(() => {
    const state = stateRef.current.find((s) => s.id === def.id)
    if (!state) return
    setColor([...state.color] as [number, number, number])
    setIntensity(state.intensity)
    if (def.role === 'moving_head' && headRef.current) {
      // Moving heads: yoke rotates for pan, head tilts for tilt.
      // Pan applied to the group wrapping the head, tilt on the head itself.
      headRef.current.rotation.x = def.rotation[0] + state.tilt
      headRef.current.rotation.y = state.pan
    }
  })

  const isMover = def.role === 'moving_head'
  const beamLength = isMover ? 6 : 4
  const beamHalfAngle = isMover ? Math.PI / 24 : Math.PI / 12

  return (
    <group ref={pivotRef} position={def.position}>
      {isMover ? (
        <>
          {/* Yoke base — flat plate */}
          <mesh position={[0, 0, 0]}>
            <boxGeometry args={[0.25, 0.1, 0.25]} />
            <meshStandardMaterial color="#222" />
          </mesh>
          {/* Head + beam — rotates for pan/tilt */}
          <group ref={headRef} position={[0, -0.15, 0]} rotation={def.rotation}>
            <mesh>
              <cylinderGeometry args={[0.1, 0.12, 0.25, 16]} />
              <meshStandardMaterial color="#333" />
            </mesh>
            <group position={[0, -0.125, 0]}>
              <BeamCone color={color} intensity={intensity} length={beamLength} halfAngle={beamHalfAngle} />
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
              <BeamCone color={color} intensity={intensity} length={beamLength} halfAngle={beamHalfAngle} />
            </group>
          </group>
        </>
      )}
    </group>
  )
}

/** Ticks the active scene every frame, writing into the shared state array. */
function SceneRunner({
  activeSceneId,
  stateRef,
  timeRef,
}: {
  activeSceneId: string
  stateRef: React.MutableRefObject<FixtureState[]>
  timeRef: React.MutableRefObject<number>
}) {
  useFrame((_, delta) => {
    const scene = getScene(activeSceneId)
    if (!scene) return
    // Accumulate scene-relative time independently of playhead for MVP.
    // Real playhead integration is a later task.
    timeRef.current += delta
    scene.apply(timeRef.current, stateRef.current)
  })
  return null
}

export function LightShow3DPanel() {
  const [activeSceneId, setActiveSceneId] = useState<string>(SCENES[0].id)
  const stateRef = useRef<FixtureState[]>(makeInitialStates())
  const timeRef = useRef<number>(0)

  // When the user picks a different scene, reset scene-time so it starts from 0.
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
          {RIG.length} fixtures · MVP (hardcoded rig + scenes)
        </span>
      </div>

      {/* 3D scene */}
      <div className="flex-1 min-h-0">
        <Canvas camera={{ position: [0, 3, -8], fov: 50 }} shadows={false}>
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
          <SceneRunner activeSceneId={activeSceneId} stateRef={stateRef} timeRef={timeRef} />
          {RIG.map((def) => (
            <Fixture key={def.id} def={def} stateRef={stateRef} />
          ))}
          <OrbitControls target={[0, 1, 0]} enableDamping />
        </Canvas>
      </div>
    </div>
  )
}
