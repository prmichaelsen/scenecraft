/**
 * Maps FixtureState[] to a 512-byte DMX universe buffer.
 *
 * MVP channel layouts per fixture role (contiguous, starting at baseAddress):
 *
 *   role='par'   (6 channels — Rockville RockPar 50 6-ch mode and similar
 *                "Master/RGB/FX/Speed" pars; very common layout):
 *     ch+0: Master Dimmer (intensity * 255)
 *     ch+1: Red    (color[0] * 255)
 *     ch+2: Green  (color[1] * 255)
 *     ch+3: Blue   (color[2] * 255)
 *     ch+4: Effects macro — held at 0 (no auto-effect)
 *     ch+5: Speed         — held at 0 (irrelevant when Effects=0)
 *
 *   role='moving_head' (6 channels — guess MVP layout, real movers vary):
 *     ch+0: Dimmer
 *     ch+1: Red
 *     ch+2: Green
 *     ch+3: Blue
 *     ch+4: Pan  (radians → 0-255, mapped from -π..π → 0..255, 8-bit only)
 *     ch+5: Tilt (radians → 0-255, mapped from -π/2..π/2 → 0..255, 8-bit only)
 *
 * Pinning per-fixture profiles (to support fixtures that don't match these
 * defaults) lands with the OFL importer; this file is the smoke-test
 * shape and intentionally narrow.
 */

import type { FixtureDef, FixtureRole, FixtureState } from './fixtures'

const DMX_CHANNELS = 512

export interface DMXPatch {
  fixtureId: string
  role: FixtureRole    // determines channel-slot semantics in fixturesToDMX
  universe: number     // 1-based universe
  startAddress: number // 1-based DMX address
  channelCount: number // 6 for both par and moving_head by default; explicit override allowed
}

function defaultChannelCount(role: FixtureRole): number {
  // Both pars and moving_heads default to 6 channels with the layouts
  // documented at the top of this file. Override per-fixture via
  // FixtureDef.dmxChannelCount when a specific fixture takes more or fewer.
  return 6
}

/**
 * Build a DMX patch list for a rig.
 *
 * Two-pass algorithm honoring explicit pins:
 *   1. Pin pass: fixtures with ``dmxAddress`` set are placed first at their
 *      requested address. Their channel range is marked occupied so the
 *      auto-fill pass routes around them.
 *   2. Auto-fill pass: remaining fixtures get the next available run of
 *      consecutive addresses starting from 1, skipping any range that
 *      collides with a pinned fixture.
 *
 * Channel count comes from ``dmxChannelCount`` if set, else from the
 * role default (6 for moving_head, 4 for par). Pass overlap and
 * out-of-range pins are dropped silently — caller can spot them by
 * comparing fixture count to patch count.
 *
 * Universe defaults to 1 if not specified. The current ``fixturesToDMX``
 * + EnttecPro output path handles a single universe; multi-universe is
 * a follow-up and the universe field on patches is forward-compatible
 * for that.
 */
export function autoPatch(fixtures: readonly FixtureDef[]): DMXPatch[] {
  // Track occupancy per universe so multiple universes don't collide
  // with each other (and so that auto-fill correctly routes around pins).
  const occupied = new Map<number, Set<number>>()
  const reserve = (universe: number, start: number, count: number) => {
    let set = occupied.get(universe)
    if (!set) {
      set = new Set<number>()
      occupied.set(universe, set)
    }
    for (let i = 0; i < count; i++) set.add(start + i)
  }
  const fits = (universe: number, start: number, count: number): boolean => {
    if (start < 1 || start + count - 1 > DMX_CHANNELS) return false
    const set = occupied.get(universe)
    if (!set) return true
    for (let i = 0; i < count; i++) {
      if (set.has(start + i)) return false
    }
    return true
  }

  const patches: DMXPatch[] = []

  // Pass 1: explicit pins.
  for (const f of fixtures) {
    if (f.dmxAddress == null) continue
    const universe = f.dmxUniverse ?? 1
    const count = f.dmxChannelCount ?? defaultChannelCount(f.role)
    if (!fits(universe, f.dmxAddress, count)) {
      // Collision with another pin or out of range — skip; caller can
      // detect missing patch by comparing fixtures.length to patches.length.
      continue
    }
    patches.push({ fixtureId: f.id, role: f.role, universe, startAddress: f.dmxAddress, channelCount: count })
    reserve(universe, f.dmxAddress, count)
  }

  // Pass 2: auto-fill the unpinned fixtures into universe 1, walking
  // from address 1 forward and skipping over occupied ranges.
  let cursor = 1
  for (const f of fixtures) {
    if (f.dmxAddress != null) continue
    const universe = 1
    const count = f.dmxChannelCount ?? defaultChannelCount(f.role)
    let placed = false
    // Linear scan for the first range that fits. Cheap for our scale.
    for (let start = cursor; start + count - 1 <= DMX_CHANNELS; start++) {
      if (fits(universe, start, count)) {
        patches.push({ fixtureId: f.id, role: f.role, universe, startAddress: start, channelCount: count })
        reserve(universe, start, count)
        cursor = start + count
        placed = true
        break
      }
    }
    if (!placed) {
      // Universe 1 is full of pins — drop. Multi-universe support would
      // overflow into universe 2 here.
      continue
    }
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
      if (patch.role === 'moving_head') {
        // Moving head: slots 4-5 are 8-bit Pan/Tilt.
        buf[base + 4] = radiansTo255(s.pan, -Math.PI, Math.PI)
        buf[base + 5] = radiansTo255(s.tilt, -Math.PI / 2, Math.PI / 2)
      } else {
        // Par with 6+ channels: slots 4-5 are Effects macro / Speed
        // on every common 6-ch RGB par we've encountered. Hold both at
        // 0 so the fixture stays in normal (non-auto-effect) mode and
        // responds only to the dimmer + RGB we control directly.
        buf[base + 4] = 0
        buf[base + 5] = 0
      }
    }
  }

  return buf
}
