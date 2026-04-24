/**
 * Volumetric ray-marched fog — Phase C of the light_show preview.
 *
 * Replaces (stacks on top of) the Phase A additive cones with a proper
 * per-pixel ray march through the scene. For each screen pixel we march
 * from the camera toward the fragment's world position, and at each step
 * we accumulate light contribution from every fixture whose cone contains
 * the step. Result: beams visibly illuminate atmospheric haze, crossing
 * beams brighten where they intersect, the whole scene reads as
 * "lights-in-fog-at-a-show" instead of "translucent ice cream cones."
 *
 * Implementation notes:
 *  - Uses ``postprocessing`` via ``@react-three/postprocessing``. One
 *    full-screen effect pass, added to the EffectComposer inside the
 *    Canvas.
 *  - Uniforms updated every frame from a shared ref so the render loop
 *    stays allocation-free. Fixture states (pos/aim/color/intensity/etc.)
 *    are read from LightShow3DPanel's stateRef + rig definition.
 *  - MAX_FIXTURES = 16 in the shader — dial up if we ever exceed that.
 *  - 48 ray-march steps, fog density 0.03, max ray length 40m. Tunable.
 *  - Contribution is additive (BlendFunction.ADD) so it stacks on the
 *    existing cone beams without replacing them — we get the physical
 *    beam + the volumetric atmosphere together.
 *
 * ── Future Phase C enhancements (documented, not implemented) ────────────
 *
 *  1. Henyey-Greenstein phase function — real atmospheric scattering has
 *     an angular dependency: looking "along" a beam (small angle between
 *     view ray and beam direction) makes it appear brighter than looking
 *     across it. Current shader treats all scatter directions equally
 *     (isotropic scattering) so beams read slightly flat. HG is a
 *     one-parameter model (``g`` in [-1, 1], positive = forward-scatter,
 *     values around 0.6-0.8 match typical stage haze) that multiplies
 *     each step's contribution by a phase factor. ~10 lines of shader,
 *     one extra dot(rayDir, aimDir) per fixture per step.
 *
 *  2. 3D noise fog density — currently ``density`` is a constant across
 *     the whole volume, which reads as uniform haze. Real haze has
 *     wispy pockets of denser and thinner regions that drift over time;
 *     sampling a low-frequency 3D noise (Perlin / simplex / curl) at
 *     each step position produces those wisps and makes beams feel
 *     alive. Can be procedural in-shader (no texture needed at low
 *     octaves) or a pre-baked 3D texture for richer noise. Animation
 *     via a uniform time offset and/or a slow XY wind drift. ~15-25
 *     lines of shader depending on noise implementation.
 *
 *  3. Per-fixture beam profile — currently every fixture shares the
 *     same ``coneLength`` and ``coneHalfAngle`` scalar uniforms. Real
 *     fixture types have different beam shapes: a moving-head BEAM
 *     fixture has a tight ~3° cone for sharp shafts, a wash has ~30°+
 *     for broad coverage, a laser is effectively cylindrical (zero
 *     half-angle), etc. Upgrade path: add per-fixture length + halfAngle
 *     uniform arrays (same shape as the existing position/aim arrays)
 *     populated from the fixture row; shader reads uFixtureLengths[j]
 *     and uFixtureHalfAngles[j] instead of the scalar uniforms. Also
 *     consider per-fixture ``beam_profile`` enum (par / spot / wash /
 *     beam / laser / strobe / blinder) with different attenuation
 *     curves along the cone axis — e.g. beam = sharp hotspot,
 *     wash = soft even falloff.
 *
 *  Other candidates worth considering when the time comes:
 *   - Depth-aware jitter (per-pixel temporal reprojection) for more
 *     stable noise across frames.
 *   - Half-res composite + bilinear upsample to reclaim GPU headroom
 *     for higher step counts on lower-end hardware.
 *   - In-beam gobo patterns (sample a 2D texture along the beam axis,
 *     multiply into the contribution) — gives you breakup, logos,
 *     leaves-on-forest-floor, etc.
 *   - Emission from screen panels contributing volumetric bounce light.
 */

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { Effect, BlendFunction, EffectAttribute } from 'postprocessing'

import type { FixtureDef, FixtureState } from './fixtures'

const MAX_FIXTURES = 16

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uCameraPos;
uniform mat4 uInvViewProj;
uniform int uFixtureCount;
uniform vec3 uFixturePositions[${MAX_FIXTURES}];
uniform vec3 uFixtureAims[${MAX_FIXTURES}];
uniform vec3 uFixtureColors[${MAX_FIXTURES}];
uniform float uFixtureIntensities[${MAX_FIXTURES}];
uniform float uFixtureLengths[${MAX_FIXTURES}];
uniform float uFixtureHalfAngles[${MAX_FIXTURES}];
uniform float uFogDensity;
uniform float uMaxDistance;
uniform int uStepCount;

// Hash for dithered step offset — breaks up banding bands from finite step count.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  // Reconstruct the world-space position at this pixel's depth. If the
  // pixel is on background (depth == 1), the ray ends at uMaxDistance.
  float clipZ = depth * 2.0 - 1.0;
  vec4 clip = vec4(uv * 2.0 - 1.0, clipZ, 1.0);
  vec4 wp = uInvViewProj * clip;
  vec3 worldPos = wp.xyz / wp.w;

  vec3 rayOrigin = uCameraPos;
  vec3 rayVec = worldPos - rayOrigin;
  float sceneDist = length(rayVec);
  vec3 rayDir = rayVec / max(sceneDist, 0.0001);

  // Background pixels: depth ~ 1.0 produces huge sceneDist; clamp to
  // uMaxDistance so we still march a reasonable volume without wasting
  // steps on empty space far behind the stage.
  float maxDist = min(sceneDist, uMaxDistance);
  int steps = uStepCount;
  float dt = maxDist / float(steps);

  // Dither the starting offset per pixel so undersampled banding breaks
  // into grain instead of concentric rings. Noise scaled by one step.
  float jitter = hash21(gl_FragCoord.xy);

  vec3 accum = vec3(0.0);

  for (int i = 0; i < 128; i++) {          // 128 > any sane uStepCount
    if (i >= steps) break;
    float t = (float(i) + jitter) * dt;
    vec3 p = rayOrigin + rayDir * t;

    // Per-fixture contribution. Early-outs keep this cheap for fixtures
    // that the step doesn't intersect.
    for (int j = 0; j < ${MAX_FIXTURES}; j++) {
      if (j >= uFixtureCount) break;
      float intensity = uFixtureIntensities[j];
      if (intensity <= 0.001) continue;

      vec3 rel = p - uFixturePositions[j];
      vec3 aim = uFixtureAims[j];
      float along = dot(rel, aim);
      if (along < 0.0 || along > uFixtureLengths[j]) continue;

      float radial = length(rel - along * aim);
      float maxR = along * tan(uFixtureHalfAngles[j]);
      if (radial > maxR) continue;

      // Soft cone falloff (brightest along axis, darker at cone edge)
      // and length fade (brightest near fixture, fades with distance).
      float cone = 1.0 - (radial / max(maxR, 0.0001));
      cone = smoothstep(0.0, 1.0, cone);
      float lenFade = 1.0 - (along / uFixtureLengths[j]);
      lenFade *= lenFade;                  // quadratic falloff reads nicer

      // Scattering gain — real-world beams are bright because every
      // photon lights up every dust particle along the ray. We lean
      // into the punch here (16x boost over naive linear integration)
      // so the effect reads on a conventional monitor. Tunable later.
      float contrib = intensity * cone * lenFade * uFogDensity * dt * 16.0;
      accum += uFixtureColors[j] * contrib;
    }
  }

  // BlendFunction.ADD on the effect: the composer does
  //   final = inputColor + outputColor
  // We contribute pure additive light. Alpha is ignored by ADD blend
  // but set to match the accumulation magnitude so SCREEN/OVER would
  // also behave reasonably if someone switches the blend.
  outputColor = vec4(accum, clamp(length(accum), 0.0, 1.0));
}
`

class VolumetricFogEffectImpl extends Effect {
  public readonly cameraRef: { current: THREE.Camera | null }

  constructor() {
    const positions = Array.from({ length: MAX_FIXTURES }, () => new THREE.Vector3())
    const aims = Array.from({ length: MAX_FIXTURES }, () => new THREE.Vector3(0, -1, 0))
    const colors = Array.from({ length: MAX_FIXTURES }, () => new THREE.Vector3(1, 1, 1))

    // postprocessing's Effect constructor accepts ``uniforms`` typed as
    // ``Map<string, Uniform>``; three.js has started generifying Uniform,
    // so let TS infer the Map's value type from the entries rather than
    // explicitly annotating.
    const uniforms = new Map<string, THREE.Uniform<unknown>>([
      ['uCameraPos', new THREE.Uniform(new THREE.Vector3())],
      ['uInvViewProj', new THREE.Uniform(new THREE.Matrix4())],
      ['uFixtureCount', new THREE.Uniform(0)],
      ['uFixturePositions', new THREE.Uniform(positions)],
      ['uFixtureAims', new THREE.Uniform(aims)],
      ['uFixtureColors', new THREE.Uniform(colors)],
      ['uFixtureIntensities', new THREE.Uniform(new Float32Array(MAX_FIXTURES))],
      ['uFixtureLengths', new THREE.Uniform(new Float32Array(MAX_FIXTURES))],
      ['uFixtureHalfAngles', new THREE.Uniform(new Float32Array(MAX_FIXTURES))],
      ['uFogDensity', new THREE.Uniform(0.05)],
      ['uMaxDistance', new THREE.Uniform(40)],
      ['uStepCount', new THREE.Uniform(48)],
    ])

    super('VolumetricFog', FRAGMENT_SHADER, {
      blendFunction: BlendFunction.ADD,
      attributes: EffectAttribute.DEPTH,
      uniforms: uniforms as never,
    })

    this.cameraRef = { current: null }
  }

  /** Called by EffectPass once per frame before the shader runs. Updates
   *  camera-derived uniforms (position, inverse view-projection) so world
   *  reconstruction in the shader is correct each frame.
   *
   *  Fixture uniforms are not updated here — they're updated via
   *  ``updateFixtures`` below, called from the React layer's useFrame so
   *  we stay in sync with the rest of the r3f render loop. */
  override update(_renderer: THREE.WebGLRenderer, _inputBuffer: THREE.WebGLRenderTarget, _dt: number) {
    const camera = this.cameraRef.current
    if (!camera) return
    const cameraPos = (this.uniforms.get('uCameraPos') as THREE.Uniform).value as THREE.Vector3
    cameraPos.setFromMatrixPosition(camera.matrixWorld)
    const invVP = (this.uniforms.get('uInvViewProj') as THREE.Uniform).value as THREE.Matrix4
    invVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert()
  }

  /** Update per-fixture uniforms from the shared fixture state. Call this
   *  once per frame from the React layer's useFrame so the shader sees
   *  up-to-date intensity / color / pan / tilt values. */
  updateFixtures(
    rig: readonly FixtureDef[],
    states: readonly FixtureState[],
    cones: { length: number; halfAngle: number },
  ) {
    const count = Math.min(rig.length, MAX_FIXTURES)
    const positions = (this.uniforms.get('uFixturePositions') as THREE.Uniform).value as THREE.Vector3[]
    const aims = (this.uniforms.get('uFixtureAims') as THREE.Uniform).value as THREE.Vector3[]
    const colors = (this.uniforms.get('uFixtureColors') as THREE.Uniform).value as THREE.Vector3[]
    const intensities = (this.uniforms.get('uFixtureIntensities') as THREE.Uniform).value as Float32Array
    const lengths = (this.uniforms.get('uFixtureLengths') as THREE.Uniform).value as Float32Array
    const halfAngles = (this.uniforms.get('uFixtureHalfAngles') as THREE.Uniform).value as Float32Array

    for (let i = 0; i < count; i++) {
      const def = rig[i]
      const state = states.find((s) => s.id === def.id)
      if (!state) {
        intensities[i] = 0
        continue
      }

      positions[i].set(def.position[0], def.position[1], def.position[2])

      // Fixture's effective aim = base rotation + pan/tilt (for movers).
      // We bake rotation into a direction vector rather than passing Euler
      // angles — the shader does a cone containment test, not full
      // rigid-body transforms, so a single unit vector is all it needs.
      // Local aim axis is -Y (fixture bodies aim straight down before rotation);
      // rotate by the
      // fixture's (rotation_x + tilt) around X then (rotation_y + pan)
      // around Y, then rotation_z around Z, applied in XYZ order to
      // mirror three.js default Euler interpretation.
      const baseRotX = def.rotation[0]
      const baseRotY = def.rotation[1]
      const baseRotZ = def.rotation[2]
      const isMover = def.role === 'moving_head'
      const rx = baseRotX + (isMover ? state.tilt : 0)
      const ry = baseRotY + (isMover ? state.pan : 0)
      const rz = baseRotZ

      // Local -Y rotated by XYZ Euler (x, y, z).
      // Start: d = (0, -1, 0). Apply Rx, Ry, Rz in sequence.
      let dx = 0, dy = -1, dz = 0
      // Rx: y' = y cos - z sin, z' = y sin + z cos
      const cx = Math.cos(rx), sx = Math.sin(rx)
      ;[dy, dz] = [dy * cx - dz * sx, dy * sx + dz * cx]
      // Ry: x' = x cos + z sin, z' = -x sin + z cos
      const cy = Math.cos(ry), sy = Math.sin(ry)
      ;[dx, dz] = [dx * cy + dz * sy, -dx * sy + dz * cy]
      // Rz: x' = x cos - y sin, y' = x sin + y cos
      const cz = Math.cos(rz), sz = Math.sin(rz)
      ;[dx, dy] = [dx * cz - dy * sz, dx * sz + dy * cz]

      aims[i].set(dx, dy, dz).normalize()
      colors[i].set(state.color[0], state.color[1], state.color[2])
      intensities[i] = state.intensity
      lengths[i] = cones.length
      halfAngles[i] = cones.halfAngle
    }

    ;(this.uniforms.get('uFixtureCount') as THREE.Uniform).value = count
  }
}

// React wrapper. ``wrapEffect`` handles the forwardRef + the EffectPass
// plumbing; we just expose the underlying effect instance so the panel
// can call ``updateFixtures`` from its useFrame.

export interface VolumetricFogProps {
  rigRef: React.MutableRefObject<FixtureDef[]>
  stateRef: React.MutableRefObject<FixtureState[]>
  coneLength?: number
  coneHalfAngle?: number
  fogDensity?: number
  maxDistance?: number
  stepCount?: number
}

export function VolumetricFog({
  rigRef,
  stateRef,
  coneLength = 6,
  coneHalfAngle = Math.PI / 14,
  fogDensity = 0.25,
  maxDistance = 40,
  stepCount = 48,
}: VolumetricFogProps) {
  const effectRef = useRef<VolumetricFogEffectImpl | null>(null)
  const camera = useThree((s) => s.camera)

  // Lazy-create a single Effect instance. postprocessing expects its
  // own effects to be mounted once; letting React recreate it would be
  // expensive (new shader compile, program link).
  const effect = useMemo(() => new VolumetricFogEffectImpl(), [])
  effectRef.current = effect
  effect.cameraRef.current = camera

  // Keep tunable scalar uniforms in sync with props. Light mutations,
  // no allocation.
  useEffect(() => {
    ;(effect.uniforms.get('uFogDensity') as THREE.Uniform).value = fogDensity
    ;(effect.uniforms.get('uMaxDistance') as THREE.Uniform).value = maxDistance
    ;(effect.uniforms.get('uStepCount') as THREE.Uniform).value = stepCount
  }, [effect, fogDensity, maxDistance, stepCount])

  // Tick: pull latest fixture state into the shader uniforms. useFrame
  // runs inside the Canvas render loop so this stays in lockstep with
  // the rest of the scene. ``_state`` is the r3f context, unused here.
  const tickRef = useRef<() => void>(null!)
  tickRef.current = () => {
    effect.updateFixtures(rigRef.current, stateRef.current, {
      length: coneLength,
      halfAngle: coneHalfAngle,
    })
  }
  useFrameTick(tickRef)

  // postprocessing + r3f: render the effect as a <primitive> child of
  // <EffectComposer>. The composer wires it into its internal EffectPass
  // and calls update(renderer, buffer, dt) each frame before the shader.
  return <primitive object={effect} dispose={null} />
}

function useFrameTick(tickRef: React.RefObject<() => void>) {
  useFrame(() => {
    tickRef.current?.()
  })
}
