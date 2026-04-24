/**
 * Additive-blended cone beam for a fixture. The cone geometry points along
 * local -Y (three.js convention for cones), with the apex at origin and
 * opening downward; parent transform rotates it to the fixture's aim.
 *
 * Shader does a soft radial falloff from center and a length-wise fade to
 * fake volumetric haze. Additive blending so overlapping beams brighten
 * rather than occlude — canonical DMX-visualizer look for MVP. Ray-marched
 * volumetric is a later polish.
 *
 * Reads the fixture's live state via the shared ``stateRef`` on each frame,
 * so per-frame color/intensity updates mutate shader uniforms directly
 * without triggering React re-renders.
 */

import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

import type { FixtureState } from './fixtures'

interface BeamConeProps {
  fixtureId: string
  stateRef: React.MutableRefObject<FixtureState[]>
  /** Beam length in meters (apex → base). */
  length?: number
  /** Half-angle at the base in radians. */
  halfAngle?: number
}

const BEAM_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const BEAM_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    // vUv.x sweeps around the cone; vUv.y goes from 0 (apex) to 1 (base).
    // Radial fade from cone axis: strongest at the seam-normal strip,
    // falling off around the circumference. With a seamed cone UV this
    // reads as a soft radial gradient from center.
    float radial = 1.0 - abs(vUv.x - 0.5) * 2.0;
    radial = smoothstep(0.0, 1.0, radial);
    // Length-wise fade — full at apex, 0 at base.
    float lengthFade = 1.0 - vUv.y;
    float alpha = radial * lengthFade * uIntensity;
    gl_FragColor = vec4(uColor * uIntensity, alpha);
  }
`

export function BeamCone({
  fixtureId,
  stateRef,
  length = 6,
  halfAngle = Math.PI / 12,
}: BeamConeProps) {
  const matRef = useRef<THREE.ShaderMaterial>(null!)

  const geometry = useMemo(() => {
    const radius = Math.tan(halfAngle) * length
    const g = new THREE.ConeGeometry(radius, length, 32, 1, true)
    // Three.js default cone has apex at +Y, base at -Y offset -length/2.
    // Translate so apex sits at origin and base points down along -Y.
    g.translate(0, -length / 2, 0)
    return g
  }, [length, halfAngle])

  const uniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Vector3(1, 1, 1) },
      uIntensity: { value: 0 },
    }),
    [],
  )

  useFrame(() => {
    if (!matRef.current) return
    const state = stateRef.current.find((s) => s.id === fixtureId)
    if (!state) return
    ;(uniforms.uColor.value as THREE.Vector3).set(state.color[0], state.color[1], state.color[2])
    uniforms.uIntensity.value = state.intensity
  })

  return (
    <mesh geometry={geometry}>
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={BEAM_VERTEX_SHADER}
        fragmentShader={BEAM_FRAGMENT_SHADER}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}
