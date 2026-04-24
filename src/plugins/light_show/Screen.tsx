/**
 * light_show Screen — a flat video panel in the 3D preview.
 *
 * MVP behavior: every screen renders the same scenecraft main-timeline
 * frame preview. We reuse the shared PreviewViewport surface via
 * usePreview().previewRef.current.getActiveSurface(), which hands back
 * whichever element currently has the live frame:
 *   - HTMLVideoElement while the timeline is playing (auto-advancing),
 *   - HTMLCanvasElement while paused/scrubbing (updated by PreviewViewport's
 *     JPEG blit path).
 *
 * We keep one THREE.Texture per Screen and swap its `source.data` to the
 * active surface each frame. THREE notices the source change and re-uploads.
 * Per-screen timelines are a deliberate post-MVP follow-up.
 */

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

import { usePreview } from '@/components/editor/PreviewContext'

import type { ScreenRow } from './light-show-client'

function rowToMatrix(row: ScreenRow): {
  position: [number, number, number]
  rotation: [number, number, number]
  size: [number, number]
} {
  return {
    position: [row.position_x, row.position_y, row.position_z],
    rotation: [row.rotation_x, row.rotation_y, row.rotation_z],
    size: [row.width, row.height],
  }
}

export function Screen({ def }: { def: ScreenRow }) {
  const { previewRef } = usePreview()
  const meshRef = useRef<THREE.Mesh>(null!)
  const lastSurfaceRef = useRef<HTMLCanvasElement | HTMLVideoElement | null>(null)

  // Texture is created synchronously so the material has a valid `map`
  // on first render. useMemo keeps it stable across re-renders; the
  // companion useEffect disposes on unmount.
  const texture = useMemo(() => {
    const tex = new THREE.Texture()
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    return tex
  }, [])

  useEffect(() => () => texture.dispose(), [texture])

  // Per-frame: fetch the active surface and make sure the texture points at
  // it. If the surface has changed (play/pause swap), swap the texture's
  // image source. needsUpdate=true forces a GPU re-upload.
  useFrame(() => {
    const surface = previewRef.current?.getActiveSurface() ?? null

    if (surface !== lastSurfaceRef.current) {
      lastSurfaceRef.current = surface
      // THREE.Texture's `image` is the source for uploads. Works for both
      // HTMLCanvasElement and HTMLVideoElement.
      texture.image = surface ?? (undefined as unknown as TexImageSource)
    }

    if (surface) {
      // Upload the latest pixels regardless of whether the reference changed —
      // canvas blits + playing video both mutate pixels without swapping refs.
      texture.needsUpdate = true
    }
  })

  const m = rowToMatrix(def)
  return (
    <mesh ref={meshRef} position={m.position} rotation={m.rotation}>
      <planeGeometry args={[m.size[0], m.size[1]]} />
      <meshBasicMaterial map={texture} toneMapped={false} side={THREE.DoubleSide} />
    </mesh>
  )
}
