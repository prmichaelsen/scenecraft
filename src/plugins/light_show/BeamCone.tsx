/**
 * Additive-blended cone beam for a fixture. The cone geometry points along
 * local -Y (three.js convention for cones), with the apex at origin and
 * opening downward; parent transform rotates it to the fixture's aim.
 *
 * Shader does a soft radial falloff from center and a length-wise fade to
 * fake volumetric haze. Additive blending so overlapping beams brighten
 * rather than occlude — canonical DMX-visualizer look for MVP. Ray-marched
 * volumetric is a later polish.
 */

import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

interface BeamConeProps {
  color: [number, number, number]
  intensity: number
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
    // Radial fade from center: strongest along the cone axis, falling off
    // toward the outer edge of the cone. We fake this with a simple
    // distance-from-half function on the wrapped uv.
    float radial = 1.0 - abs(vUv.x - 0.5) * 2.0;     // 1 at center strip, 0 at seam
    radial = smoothstep(0.0, 1.0, radial);
    // Length-wise fade — full at apex, 0 at base (fixture side is bright)
    float lengthFade = 1.0 - vUv.y;
    float alpha = radial * lengthFade * uIntensity;
    gl_FragColor = vec4(uColor * uIntensity, alpha);
  }
`

export function BeamCone({
  color,
  intensity,
  length = 6,
  halfAngle = Math.PI / 12, // ~15° for moving heads / pars
}: BeamConeProps) {
  const matRef = useRef<THREE.ShaderMaterial>(null)

  // Cone geometry: apex at origin, base at -Y * length. Three.js default
  // cone has apex at +Y; we flip by translating + rotating.
  const geometry = useMemo(() => {
    const radius = Math.tan(halfAngle) * length
    const g = new THREE.ConeGeometry(radius, length, 32, 1, true)
    // Move apex to origin and orient along -Y. Default cone apex is at +Y/2.
    g.translate(0, -length / 2, 0)
    return g
  }, [length, halfAngle])

  // Three.js expects a Color object for shader uniforms when we want the
  // renderer to handle color-space conversion. Passing a Vector3 works too
  // but keeps things linear; we want that for additive blending to read right.
  const uniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Vector3(color[0], color[1], color[2]) },
      uIntensity: { value: intensity },
    }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Per-frame uniform updates driven by the fixture state. Updating here
  // avoids re-creating the material every frame when color/intensity change.
  useFrame(() => {
    if (!matRef.current) return
    ;(uniforms.uColor.value as THREE.Vector3).set(color[0], color[1], color[2])
    uniforms.uIntensity.value = intensity
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
