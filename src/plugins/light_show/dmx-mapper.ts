/**
 * Maps FixtureState[] to a 512-byte DMX universe buffer.
 *
 * MVP channel layout per fixture (contiguous, starting at baseAddress):
 *   ch+0: Dimmer (intensity * 255)
 *   ch+1: Red    (color[0] * 255)
 *   ch+2: Green  (color[1] * 255)
 *   ch+3: Blue   (color[2] * 255)
 *   ch+4: Pan    (radians → 0-255, mapped from -π..π → 0..255)
 *   ch+5: Tilt   (radians → 0-255, mapped from -π/2..π/2 → 0..255)
 *
 * Channels per fixture: 6 for moving_head, 4 for par (no pan/tilt).
 */

import type { FixtureState } from './fixtures'

const DMX_CHANNELS = 512

export interface DMXPatch {
  fixtureId: string
  startAddress: number // 1-based DMX address
  channelCount: number // 4 (par) or 6 (moving_head)
}

export function autoPatch(fixtures: FixtureState[]): DMXPatch[] {
  const patches: DMXPatch[] = []
  let addr = 1
  for (const f of fixtures) {
    const count = f.role === 'moving_head' ? 6 : 4
    if (addr + count - 1 > DMX_CHANNELS) break
    patches.push({ fixtureId: f.id, startAddress: addr, channelCount: count })
    addr += count
  }
  return patches
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function radiansTo255(rad: number, min: number, max: number): number {
  const norm = (rad - min) / (max - min)
  return Math.round(clamp(norm, 0, 1) * 255)
}

export function fixturesToDMX(
  states: FixtureState[],
  patches: DMXPatch[],
): Uint8Array {
  const buf = new Uint8Array(DMX_CHANNELS)
  const stateMap = new Map(states.map((s) => [s.id, s]))

  for (const patch of patches) {
    const s = stateMap.get(patch.fixtureId)
    if (!s) continue

    const base = patch.startAddress - 1 // 0-indexed into buf
    if (base < 0 || base + patch.channelCount > DMX_CHANNELS) continue

    buf[base + 0] = Math.round(clamp(s.intensity, 0, 1) * 255)
    buf[base + 1] = Math.round(clamp(s.color[0], 0, 1) * 255)
    buf[base + 2] = Math.round(clamp(s.color[1], 0, 1) * 255)
    buf[base + 3] = Math.round(clamp(s.color[2], 0, 1) * 255)

    if (patch.channelCount >= 6) {
      buf[base + 4] = radiansTo255(s.pan, -Math.PI, Math.PI)
      buf[base + 5] = radiansTo255(s.tilt, -Math.PI / 2, Math.PI / 2)
    }
  }

  return buf
}
