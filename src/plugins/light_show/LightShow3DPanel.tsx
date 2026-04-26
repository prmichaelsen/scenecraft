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
import { HelpCircle } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'

import { useCurrentTime, usePlaybackState } from '@/components/editor/CurrentTimeContext'
import { useEditorData } from '@/components/editor/EditorDataContext'
import { subscribePluginEvent } from '@/hooks/useScenecraftSocket'
import { getActiveAudioMixer } from '@/lib/audio-mixer-ref'

import { RIG, type FixtureDef, type FixtureState, type FixtureRole } from './fixtures'
import { SCENES, getScene } from './scenes'
import type { SceneContext } from './scene-types'
import { VolumetricFog } from './VolumetricFog'
import { Screen } from './Screen'
import {
  fetchFixtures,
  fetchOverrides,
  fetchScreens,
  type FixtureRow,
  type Override,
  type ScreenRow,
} from './light-show-client'
import { EnttecPro, type DMXOutputState } from './enttec-pro'
import { autoPatch, fixturesToDMX, type DMXPatch } from './dmx-mapper'

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
    dmxUniverse: row.dmx_universe,
    dmxAddress: row.dmx_address,
    dmxChannelCount: row.dmx_channel_count,
  }
}

/** One rigged fixture: body geometry only. Beams are rendered by the
 *  volumetric fog pass (Phase C); the Phase A cone meshes are gone.
 *  Uses refs only — no React state in the per-frame path.
 *
 *  Rotation order note (fixes the 'pan animates on X axis' bug): three.js
 *  default Euler order is 'XYZ' which applies intrinsic X first, then Y.
 *  For a fixture aiming along local -Y, Y rotation (pan) has zero effect
 *  on the -Y axis before X rotation tilts it off-axis — so pan never
 *  visibly rotated the beam. Setting rotation order to 'YXZ' matches how
 *  real moving-head yokes mechanically work (pan rotates the yoke first,
 *  then tilt nods the head around the now-rotated horizontal axis) and
 *  also matches the volumetric shader's aim vector math, which composes
 *  Rx then Ry on the -Y aim vector. */
function Fixture({ def, stateRef }: { def: FixtureDef; stateRef: React.MutableRefObject<FixtureState[]> }) {
  const headRef = useRef<THREE.Group>(null!)

  // Apply YXZ Euler order once on mount — setting rotation.order re-derives
  // the object's internal quaternion on the next rotation mutation.
  useEffect(() => {
    if (headRef.current) headRef.current.rotation.order = 'YXZ'
  }, [])

  useFrame(() => {
    if (def.role !== 'moving_head' || !headRef.current) return
    const state = stateRef.current.find((s) => s.id === def.id)
    if (!state) return
    headRef.current.rotation.x = def.rotation[0] + state.tilt
    headRef.current.rotation.y = state.pan
  })

  const isMover = def.role === 'moving_head'

  return (
    <group position={def.position}>
      {isMover ? (
        <>
          {/* Yoke base — flat plate */}
          <mesh>
            <boxGeometry args={[0.25, 0.1, 0.25]} />
            <meshStandardMaterial color="#9a9aa5" metalness={0.25} roughness={0.55} />
          </mesh>
          {/* Head — rotates for pan/tilt, ref-driven per frame */}
          <group ref={headRef} position={[0, -0.15, 0]} rotation={def.rotation}>
            <mesh>
              <cylinderGeometry args={[0.1, 0.12, 0.25, 16]} />
              <meshStandardMaterial color="#b0b0bb" metalness={0.3} roughness={0.5} />
            </mesh>
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
          </group>
        </>
      )}
    </group>
  )
}

export type Beat = { time: number; intensity: number }

/**
 * Per-frame master-bus sampler. Reads the AudioMixer's master AnalyserNode
 * (L channel — stereo is roughly correlated for our purposes) each frame
 * and computes:
 *   - RMS of the full spectrum → ``masterLevelRef``
 *   - RMS of the low-band (bins <= ~150Hz) → ``masterLowLevelRef``
 *
 * Both are smoothed with an asymmetric envelope (fast attack / slow release)
 * so a kick snaps the level up instantly but the decay is gentle enough for
 * scene animations to read. Attack ~8ms, release ~180ms.
 *
 * The mixer is fetched via audio-mixer-ref on every frame — no subscription —
 * so we pick it up whenever Timeline mounts / swaps projects without any
 * explicit re-init.
 */
function MasterBusSampler({
  masterLevelRef,
  masterLowLevelRef,
}: {
  masterLevelRef: React.MutableRefObject<number>
  masterLowLevelRef: React.MutableRefObject<number>
}) {
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)

  useFrame(() => {
    const mixer = getActiveAudioMixer()
    const pair = mixer?.getMasterAnalysers() ?? null
    if (!pair) {
      // No audio playing / mixer disposed — bleed the envelope to zero.
      masterLevelRef.current *= 0.9
      masterLowLevelRef.current *= 0.9
      return
    }
    const analyser = pair.left
    const binCount = analyser.frequencyBinCount
    if (!freqDataRef.current || freqDataRef.current.length !== binCount) {
      // Allocate on a dedicated ArrayBuffer so the Uint8Array is typed as
      // Uint8Array<ArrayBuffer> (what AnalyserNode.getByteFrequencyData
      // expects under TS 5.7's tightened DOM typings).
      freqDataRef.current = new Uint8Array(new ArrayBuffer(binCount))
    }
    const data = freqDataRef.current
    analyser.getByteFrequencyData(data)

    // Overall RMS (bytes are 0..255, normalize to 0..1).
    let sum = 0
    for (let i = 0; i < binCount; i++) {
      const v = data[i] / 255
      sum += v * v
    }
    const rms = Math.sqrt(sum / binCount)

    // Low-band energy. FFT bin covers ``sampleRate / fftSize`` Hz. For a
    // 44.1kHz context with fftSize=2048 → ~21.5Hz per bin → first ~7 bins
    // cover 0-150Hz. Compute per-frame so it auto-adjusts to the mixer's
    // actual sample rate / fft size.
    const sampleRate = analyser.context.sampleRate
    const binHz = sampleRate / (analyser.fftSize || 2048)
    const lowBins = Math.max(2, Math.floor(150 / binHz))
    let lowSum = 0
    for (let i = 0; i < lowBins; i++) {
      const v = data[i] / 255
      lowSum += v * v
    }
    const lowRms = Math.sqrt(lowSum / lowBins)

    // Asymmetric envelope: fast attack, slow release. Per-frame coefficients
    // at 60fps — attack 8ms (α≈0.85), release 180ms (α≈0.08).
    const apply = (prev: number, target: number) => {
      const alpha = target > prev ? 0.85 : 0.08
      return prev + (target - prev) * alpha
    }
    masterLevelRef.current = apply(masterLevelRef.current, rms)
    masterLowLevelRef.current = apply(masterLowLevelRef.current, lowRms)
  })

  return null
}

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
  masterLevelRef,
  masterLowLevelRef,
  dmxRef,
  dmxPatchesRef,
}: {
  activeSceneIdRef: React.MutableRefObject<string>
  stateRef: React.MutableRefObject<FixtureState[]>
  timeRef: React.MutableRefObject<number>
  diagDomRef: React.MutableRefObject<HTMLSpanElement | null>
  overridesRef: React.MutableRefObject<Map<string, Override>>
  playheadRef: React.MutableRefObject<number>
  isPlayingRef: React.MutableRefObject<boolean>
  beatsRef: React.MutableRefObject<Beat[]>
  masterLevelRef: React.MutableRefObject<number>
  masterLowLevelRef: React.MutableRefObject<number>
  dmxRef: React.MutableRefObject<EnttecPro | null>
  dmxPatchesRef: React.MutableRefObject<DMXPatch[]>
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

    const masterLevel = masterLevelRef.current
    const masterLowLevel = masterLowLevelRef.current

    if (tickRef.current % 15 === 0 && diagDomRef.current) {
      const overrideCount = overridesRef.current.size
      const overrideLabel = overrideCount > 0 ? ` · ${overrideCount} override${overrideCount === 1 ? '' : 's'}` : ''
      const beatLabel = beats.length > 0 ? ` · beat ${beatIndex}/${beats.length}` : ''
      const levelLabel = ` · L ${masterLevel.toFixed(2)} / Lo ${masterLowLevel.toFixed(2)}`
      diagDomRef.current.textContent = `ticks ${tickRef.current} · t=${timeRef.current.toFixed(1)}s${beatLabel}${levelLabel}${overrideLabel}`
    }

    const context: SceneContext = {
      playheadTime,
      beatAge,
      lastBeatIntensity,
      beatIndex,
      isPlaying: isPlayingRef.current,
      masterLevel,
      masterLowLevel,
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

    // Send DMX frame to hardware if connected. Non-blocking — EnttecPro
    // coalesces frames internally so 60fps useFrame won't stall on USB writes.
    const dmx = dmxRef.current
    if (dmx?.connected) {
      const buf = fixturesToDMX(stateRef.current, dmxPatchesRef.current)
      dmx.send(buf)
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
  // Video screens (flat textured planes). Empty by default — screens are
  // authored via the `screens` MCP tool. All screens share the main
  // timeline's preview surface (MVP).
  const [screens, setScreens] = useState<ScreenRow[]>([])
  // Scenecraft main-timeline playhead + pre-analyzed beats fed into the
  // render loop for audio-reactive scenes. PlayheadFeeder writes playhead
  // from useCurrentTime; beats are refreshed whenever editorData.beats
  // changes (rare).
  const playheadRef = useRef<number>(0)
  const isPlayingRef = useRef<boolean>(false)
  const beatsRef = useRef<Beat[]>([])
  // Smoothed master-bus energy sampled from the AudioMixer's analysers each
  // frame. MasterBusSampler writes these; SceneRunner reads them into the
  // SceneContext so audio-reactive scenes drive off live audio (not the
  // pre-computed beat list, which is empty on modern audio-intelligence
  // projects).
  const masterLevelRef = useRef<number>(0)
  const masterLowLevelRef = useRef<number>(0)

  // WebSerial DMX output — ENTTEC DMX USB Pro.
  const dmxRef = useRef<EnttecPro | null>(null)
  const dmxPatchesRef = useRef<DMXPatch[]>([])
  const [dmxState, setDmxState] = useState<DMXOutputState>('disconnected')
  const [dmxHelpOpen, setDmxHelpOpen] = useState(false)
  // Detect WebSerial after mount, never during SSR — `'serial' in navigator`
  // is always false during server render (Node has no Web Serial API), and a
  // const-evaluated check would cause the SSR'd HTML to ship with the button
  // disabled, then never re-evaluate post-hydration. The useEffect runs
  // client-side only, flipping the flag once we're in the browser.
  const [webSerialSupported, setWebSerialSupported] = useState(false)
  useEffect(() => {
    setWebSerialSupported(
      typeof navigator !== 'undefined' && 'serial' in navigator,
    )
  }, [])

  // Rebuild auto-patch whenever rig changes. autoPatch now takes the
  // FixtureDef list directly so it can honor explicit dmxAddress /
  // dmxUniverse / dmxChannelCount fields and only auto-fill the gaps.
  useEffect(() => {
    dmxPatchesRef.current = autoPatch(rig)
  }, [rig])

  const handleDmxToggle = async () => {
    if (dmxRef.current?.connected) {
      await dmxRef.current.disconnect()
      dmxRef.current = null
      return
    }
    const pro = new EnttecPro({
      onStateChange: setDmxState,
      onError: (msg) => console.warn('[DMX]', msg),
    })
    dmxRef.current = pro
    await pro.connect()
  }

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
        const [rows, overrides, screenRows] = await Promise.all([
          fetchFixtures(projectName),
          fetchOverrides(projectName),
          fetchScreens(projectName),
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

        // Screens — straight list; Screen components own per-fixture state.
        setScreens(screenRows)
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
        <button
          onClick={handleDmxToggle}
          disabled={!webSerialSupported}
          title={
            webSerialSupported
              ? undefined
              : 'WebSerial unavailable in this browser — click (?) for setup details'
          }
          className={`ml-2 px-2 py-0.5 text-xs rounded border ${
            !webSerialSupported
              ? 'bg-gray-900 border-gray-700 text-gray-600 cursor-not-allowed'
              : dmxState === 'connected'
                ? 'bg-green-900 border-green-600 text-green-300'
                : dmxState === 'connecting'
                  ? 'bg-yellow-900 border-yellow-600 text-yellow-300'
                  : dmxState === 'error'
                    ? 'bg-red-900 border-red-600 text-red-300'
                    : 'bg-gray-800 border-gray-600 text-gray-300 hover:border-purple-500'
          }`}
        >
          {dmxState === 'connected' ? 'DMX: ON' : dmxState === 'connecting' ? 'DMX...' : 'DMX Output'}
        </button>
        <button
          onClick={() => setDmxHelpOpen(true)}
          aria-label="DMX setup help"
          title="DMX setup help"
          className="ml-1 p-0.5 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-purple-500"
        >
          <HelpCircle size={14} />
        </button>
        <span className="ml-auto text-[10px] text-gray-600">
          {rig.length} fixtures{fetchError ? ' (fetch failed)' : projectName ? ' (live)' : ' (hardcoded)'}
          {screens.length > 0 ? ` · ${screens.length} screen${screens.length === 1 ? '' : 's'}` : ''}
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
          <MasterBusSampler
            masterLevelRef={masterLevelRef}
            masterLowLevelRef={masterLowLevelRef}
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
            masterLevelRef={masterLevelRef}
            masterLowLevelRef={masterLowLevelRef}
            dmxRef={dmxRef}
            dmxPatchesRef={dmxPatchesRef}
          />
          {rig.map((def) => (
            <Fixture key={def.id} def={def} stateRef={stateRef} />
          ))}
          {screens.map((s) => (
            <Screen key={s.id} def={s} />
          ))}
          <OrbitControls target={[0, 1, 0]} enableDamping />

          {/* Phase C — ray-marched volumetric fog. Beams illuminate
              atmospheric haze in 3D space; crossing beams brighten on
              intersection. This is currently the *only* visible-beam
              renderer (Phase A additive cones were removed in 5cc35cb),
              so disabling it leaves the scene without illumination.

              Perf: render the fog at half resolution and bilinearly
              upsample. Fog is inherently low-frequency so the visual
              cost is barely perceptible (slightly softer edges) while
              giving us roughly a 4x speedup. multisampling=0 because
              MSAA on a purely additive low-frequency pass is wasted
              GPU work. */}
          <EffectComposer resolutionScale={0.5} multisampling={0}>
            <VolumetricFog rigRef={rigRef} stateRef={stateRef} fogDensity={0.25} />
          </EffectComposer>
        </Canvas>
      </div>
      <DmxHelpModal
        open={dmxHelpOpen}
        onClose={() => setDmxHelpOpen(false)}
        webSerialSupported={webSerialSupported}
      />
    </div>
  )
}

function DmxHelpModal({
  open,
  onClose,
  webSerialSupported,
}: {
  open: boolean
  onClose: () => void
  webSerialSupported: boolean
}) {
  return (
    <Modal isOpen={open} onClose={onClose} title="DMX Output Setup" maxWidth="2xl">
      <div className="text-sm text-gray-200 space-y-5">
        {!webSerialSupported && (
          <div className="rounded border border-red-700 bg-red-950/40 px-3 py-2 text-red-200">
            <strong>WebSerial isn't available in this browser.</strong> The DMX
            Output button is disabled. WebSerial is a Chromium-only API —
            scenecraft talks directly to the dongle from the browser, no
            server-side proxy. <strong>Open this page in Chrome or Edge</strong>
            {' '}on a desktop OS (Windows / macOS / Linux) to enable it. Firefox,
            Safari, and most mobile browsers don't implement the API.
          </div>
        )}

        <section>
          <h3 className="font-semibold mb-1">1. Hardware</h3>
          <ul className="list-disc list-inside text-gray-300 space-y-0.5">
            <li>
              <strong>ENTTEC DMX USB Pro</strong> (FTDI vendor 0x0403, product
              0x6001). Other Widget-API-compatible dongles may work but aren't
              tested.
            </li>
            <li>
              A 3-pin or 5-pin XLR DMX cable from the dongle's <em>output</em>
              {' '}to the first fixture's <em>input</em>.
            </li>
            <li>
              For multiple fixtures, daisy-chain: each fixture's output goes
              into the next fixture's input. Terminate the last fixture if your
              run is long (&gt;30m) or noisy.
            </li>
          </ul>
        </section>

        <section>
          <h3 className="font-semibold mb-1">2. Fixture setup</h3>
          <ul className="list-disc list-inside text-gray-300 space-y-0.5">
            <li>
              Set each fixture's <strong>DMX address</strong> via its front
              panel. scenecraft auto-patches starting at address 1 and walks
              forward; the first par in the rig gets address 1, the next par
              gets the address after the previous fixture's channel block, and
              so on.
            </li>
            <li>
              Set the fixture's <strong>DMX mode</strong> to match the channel
              count scenecraft sends. Default expectation: <strong>6 channels</strong>
              {' '}per par (Master / R / G / B / Effects / Speed) and{' '}
              <strong>6 channels</strong> per moving head (Dimmer / R / G / B /
              Pan / Tilt, 8-bit). For the Rockville RockPar 50, that's the{' '}
              <code>6CH</code> mode.
            </li>
            <li>
              If your fixture's channel order doesn't match (e.g.{' '}
              <code>R / G / B / Dim</code> instead of <code>Dim / R / G / B</code>),
              colors will respond but be wrong. Per-fixture profile import is on
              the roadmap; until then, fixtures need to use the layouts above.
            </li>
          </ul>
        </section>

        <section>
          <h3 className="font-semibold mb-1">3. Browser requirements</h3>
          <ul className="list-disc list-inside text-gray-300 space-y-0.5">
            <li>
              <strong>Chrome or Edge</strong> on desktop. WebSerial is not
              available in Firefox, Safari, or most mobile browsers.
            </li>
            <li>
              Page must be served over <strong>HTTPS</strong> (or{' '}
              <code>http://localhost</code>). scenecraft already meets this in
              production.
            </li>
            <li>
              The first time you click <strong>DMX Output</strong>, Chrome shows
              a serial-port picker. Pick the FTDI USB-serial entry. Permission
              persists per origin until you revoke it.
            </li>
          </ul>
        </section>

        <section>
          <h3 className="font-semibold mb-1">4. Connecting</h3>
          <ol className="list-decimal list-inside text-gray-300 space-y-0.5">
            <li>Plug the dongle into USB and power on your fixtures.</li>
            <li>
              Click <strong>DMX Output</strong>. Chrome's serial picker will
              appear; pick the FTDI device.
            </li>
            <li>
              The button turns green when connected. Pick a scene (try{' '}
              <code>solid</code> first as a smoke test) — fixtures should
              respond immediately.
            </li>
            <li>
              Click the button again to disconnect cleanly. Closing the tab
              also disconnects, but the dongle holds the last frame for ~9
              seconds before going dark.
            </li>
          </ol>
        </section>

        <section>
          <h3 className="font-semibold mb-1">5. Troubleshooting</h3>
          <ul className="list-disc list-inside text-gray-300 space-y-0.5">
            <li>
              <strong>Button stays disabled:</strong> WebSerial isn't available
              — switch to Chrome or Edge.
            </li>
            <li>
              <strong>FTDI device doesn't appear in the picker:</strong> dongle
              isn't plugged in, or another app (QLC+, etc.) has the port open.
              Close other DMX software and replug.
            </li>
            <li>
              <strong>Connects but fixture doesn't respond:</strong> check DMX
              cable seating at both ends, fixture address, and that the fixture
              is in DMX mode (not standalone / sound-active).
            </li>
            <li>
              <strong>Wrong colors:</strong> fixture's channel order doesn't
              match scenecraft's expectation — see #2 above.
            </li>
            <li>
              <strong>Auto-effects firing on RockPar-style pars:</strong>{' '}
              scenecraft holds the Effects channel at 0 (no auto-effect). If
              you see chases/flashes scenecraft didn't request, the fixture may
              be in a different mode than expected.
            </li>
          </ul>
        </section>

        <div className="pt-2 flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
