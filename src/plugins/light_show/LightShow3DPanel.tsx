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
import { EffectComposer } from '@react-three/postprocessing'

import { useCurrentTime, usePlaybackState } from '@/components/editor/CurrentTimeContext'
import { useEditorData } from '@/components/editor/EditorDataContext'
import { subscribePluginEvent } from '@/hooks/useScenecraftSocket'

import { RIG, type FixtureDef, type FixtureState, type FixtureRole } from './fixtures'
import { SCENES, getScene } from './scenes'
import type { SceneContext } from './scene-types'
import { BeamCone } from './BeamCone'
import { VolumetricFog } from './VolumetricFog'
import {
  fetchFixtures,
  fetchOverrides,
  type FixtureRow,
  type Override,
} from './light-show-client'

/** Invisible component whose only job is to subscribe to the 20Hz playhead
 *  context and write it into a ref. Re-renders happen here (leaf, no DOM),
 *  not on the Canvas subtree. */
function PlayheadFeeder({
  playheadRef,
  isPlayingRef,
}: {
  playheadRef: React.MutableRefObject<number>
  isPlayingRef: React.MutableRefObject<boolean>
}) {
  const { currentTime } = useCurrentTime()
  const { isPlaying } = usePlaybackState()
  playheadRef.current = currentTime
  isPlayingRef.current = isPlaying
  return null
}

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
            <meshStandardMaterial color="#9a9aa5" metalness={0.25} roughness={0.55} />
          </mesh>
          {/* Head + beam — rotates for pan/tilt, ref-driven per frame */}
          <group ref={headRef} position={[0, -0.15, 0]} rotation={def.rotation}>
            <mesh>
              <cylinderGeometry args={[0.1, 0.12, 0.25, 16]} />
              <meshStandardMaterial color="#b0b0bb" metalness={0.3} roughness={0.5} />
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
              <meshStandardMaterial color="#b0b0bb" metalness={0.3} roughness={0.5} />
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

export type Beat = { time: number; intensity: number }

/** Ticks the active scene every frame, writing into the shared state array.
 *  Builds a SceneContext from the playhead + beat refs each frame so
 *  audio-reactive scenes can consult them. After the scene runs, overrides
 *  win per-channel. Also bumps ``diagDomRef`` every 15 frames as a visible
 *  liveness probe. */
function SceneRunner({
  activeSceneIdRef,
  stateRef,
  timeRef,
  diagDomRef,
  overridesRef,
  playheadRef,
  isPlayingRef,
  beatsRef,
}: {
  activeSceneIdRef: React.MutableRefObject<string>
  stateRef: React.MutableRefObject<FixtureState[]>
  timeRef: React.MutableRefObject<number>
  diagDomRef: React.MutableRefObject<HTMLSpanElement | null>
  overridesRef: React.MutableRefObject<Map<string, Override>>
  playheadRef: React.MutableRefObject<number>
  isPlayingRef: React.MutableRefObject<boolean>
  beatsRef: React.MutableRefObject<Beat[]>
}) {
  const tickRef = useRef(0)
  // Bookkeeping for beat tracking: which beat was the most recent fired,
  // so beatIndex increments on crossings rather than re-scanning every frame.
  const lastBeatIdxRef = useRef<number>(-1)

  useFrame((_, delta) => {
    tickRef.current++

    // Update beat bookkeeping based on current playhead. Handles forward
    // play (increment) and scrub back (reset). Binary search would be
    // fancier; linear scan is plenty for a few hundred beats.
    const playheadTime = playheadRef.current
    const beats = beatsRef.current
    let lastIdx = -1
    for (let i = 0; i < beats.length; i++) {
      if (beats[i].time <= playheadTime) lastIdx = i
      else break
    }
    lastBeatIdxRef.current = lastIdx

    const lastBeat = lastIdx >= 0 ? beats[lastIdx] : null
    const beatAge = lastBeat !== null ? playheadTime - lastBeat.time : Infinity
    const lastBeatIntensity = lastBeat ? lastBeat.intensity : 0
    const beatIndex = lastIdx + 1

    if (tickRef.current % 15 === 0 && diagDomRef.current) {
      const overrideCount = overridesRef.current.size
      const overrideLabel = overrideCount > 0 ? ` · ${overrideCount} override${overrideCount === 1 ? '' : 's'}` : ''
      const beatLabel = beats.length > 0 ? ` · beat ${beatIndex}/${beats.length}` : ''
      diagDomRef.current.textContent = `ticks ${tickRef.current} · t=${timeRef.current.toFixed(1)}s${beatLabel}${overrideLabel}`
    }

    const context: SceneContext = {
      playheadTime,
      beatAge,
      lastBeatIntensity,
      beatIndex,
      isPlaying: isPlayingRef.current,
    }

    const scene = getScene(activeSceneIdRef.current)
    if (scene) {
      timeRef.current += delta
      scene.apply(timeRef.current, stateRef.current, context)
    }
    // Apply overrides after scene — they win per-channel until cleared.
    const overrides = overridesRef.current
    if (overrides.size > 0) {
      for (const s of stateRef.current) {
        const o = overrides.get(s.id)
        if (!o) continue
        if (o.intensity !== undefined) s.intensity = o.intensity
        if (o.color !== undefined) s.color = [o.color[0], o.color[1], o.color[2]]
        if (o.pan !== undefined) s.pan = o.pan
        if (o.tilt !== undefined) s.tilt = o.tilt
      }
    }
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
  // Ref mirror of ``rig`` so VolumetricFog's shader updater can pull the
  // latest rig each frame without re-subscribing a useFrame callback.
  const rigRef = useRef<FixtureDef[]>(RIG)
  useEffect(() => { rigRef.current = rig }, [rig])

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
  // Overrides keyed by fixture id for O(1) lookup per frame. Populated by
  // the polling loop; consumed by SceneRunner after scene.apply() runs.
  const overridesRef = useRef<Map<string, Override>>(new Map())
  const [overrideCount, setOverrideCount] = useState(0)
  // Scenecraft main-timeline playhead + pre-analyzed beats fed into the
  // render loop for audio-reactive scenes. PlayheadFeeder writes playhead
  // from useCurrentTime; beats are refreshed whenever editorData.beats
  // changes (rare).
  const playheadRef = useRef<number>(0)
  const isPlayingRef = useRef<boolean>(false)
  const beatsRef = useRef<Beat[]>([])

  // Beats come from scenecraft's audio intel loaded at editor mount.
  // Absent beats (non-audio project) just means audio-reactive scenes
  // render static / default behavior — no crash.
  const editorData = useEditorData()
  useEffect(() => {
    beatsRef.current = (editorData.beats ?? []) as Beat[]
  }, [editorData.beats])

  // Fetch fixtures + overrides from backend. Runs on mount, on WS
  // 'light_show__changed' events, and on a 2s fallback poll (WS-less
  // deployments / reconnect windows).
  useEffect(() => {
    if (!projectName) return
    let cancelled = false
    const tick = async () => {
      try {
        const [rows, overrides] = await Promise.all([
          fetchFixtures(projectName),
          fetchOverrides(projectName),
        ])
        if (cancelled) return
        setFetchError(null)

        // Fixtures — replace state if rig shape changed.
        const defs = rows.map(rowToDef)
        setRig(defs)
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

        // Overrides — rebuild the lookup map. Cheap, small N.
        const next = new Map<string, Override>()
        for (const o of overrides) next.set(o.fixture_id, o)
        overridesRef.current = next
        setOverrideCount(next.size)
      } catch (e) {
        if (cancelled) return
        setFetchError((e as Error).message)
      }
    }
    tick()
    const h = setInterval(tick, POLL_INTERVAL_MS)
    const unsub = subscribePluginEvent('light_show', 'changed', (msg) => {
      if (msg.projectName === projectName) tick()
    })
    return () => {
      cancelled = true
      clearInterval(h)
      unsub()
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
          {rig.length} fixtures{fetchError ? ' (fetch failed)' : projectName ? ' (live)' : ' (hardcoded)'}
          {overrideCount > 0 ? ` · ${overrideCount} pinned` : ''} ·{' '}
          <span ref={diagDomRef}>ticks 0 · t=0.0s</span>
        </span>
      </div>

      {/* Playhead feeder runs outside the Canvas — its re-renders don't
          propagate into the 3D subtree. Only active when there's a
          CurrentTime provider in the tree (i.e. the editor is mounted). */}
      <PlayheadFeeder playheadRef={playheadRef} isPlayingRef={isPlayingRef} />

      {/* 3D scene — frameloop="always" so animation runs independent of any
          external playback state (the editor's timeline, audio playback, etc). */}
      <div className="flex-1 min-h-0">
        <Canvas
          frameloop="always"
          camera={{ position: [0, 3, -8], fov: 50 }}
          shadows={false}
        >
          <color attach="background" args={['#050510']} />
          {/* Lighting for the fixture bodies (NOT the beams — beams are their
              own additive emissive geometry). Goal: give the rig physical
              presence against the dark stage without killing the mood.
              Key + rim + low ambient reads as "film set under work light". */}
          <ambientLight intensity={0.25} />
          <directionalLight position={[10, 12, 8]} intensity={0.9} color="#bfd4ff" />
          <directionalLight position={[-8, 6, -10]} intensity={0.5} color="#ffc29e" />
          <hemisphereLight args={['#6070a0', '#1a1a2a', 0.35]} />
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
            overridesRef={overridesRef}
            playheadRef={playheadRef}
            isPlayingRef={isPlayingRef}
            beatsRef={beatsRef}
          />
          {rig.map((def) => (
            <Fixture key={def.id} def={def} stateRef={stateRef} />
          ))}
          <OrbitControls target={[0, 1, 0]} enableDamping />

          {/* Phase C — ray-marched volumetric fog. Beams illuminate
              atmospheric haze in 3D space; crossing beams brighten on
              intersection. Stacks on top of the existing additive cones
              for the "physical beam body + atmospheric shaft" look. */}
          <EffectComposer>
            {/* Phase C default tuning. Bump fogDensity up for smokier
                look, stepCount up for less banding at the cost of GPU. */}
            <VolumetricFog rigRef={rigRef} stateRef={stateRef} fogDensity={0.25} />
          </EffectComposer>
        </Canvas>
      </div>
    </div>
  )
}
