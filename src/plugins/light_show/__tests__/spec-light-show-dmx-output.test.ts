/**
 * Vitest coverage for the light-show-dmx-output spec.
 *
 * Tests the ENTTEC DMX USB Pro WebSerial driver (enttec-pro.ts),
 * the DMX mapper (dmx-mapper.ts), and the dmx-ref singleton (dmx-ref.ts).
 *
 * WebSerial is mocked — navigator.serial is replaced with a fake
 * requestPort/Port/WritableStream that records writes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EnttecPro } from '../enttec-pro'
import type { DMXOutputState } from '../enttec-pro'
import { autoPatch, fixturesToDMX } from '../dmx-mapper'
import type { DMXPatch } from '../dmx-mapper'
import {
  getActiveDmx,
  setActiveDmx,
  getDmxState,
  setDmxState,
  subscribeDmx,
} from '../dmx-ref'
import type { FixtureDef, FixtureState } from '../fixtures'

// ---------------------------------------------------------------------------
// WebSerial mock
// ---------------------------------------------------------------------------

interface MockWriter {
  write: ReturnType<typeof vi.fn>
  releaseLock: ReturnType<typeof vi.fn>
  closed: Promise<undefined>
}

interface MockPort {
  open: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  writable: { getWriter: () => MockWriter } | null
}

function createMockWriter(): MockWriter {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn(),
    closed: Promise.resolve(undefined),
  }
}

function createMockPort(writer?: MockWriter): { port: MockPort; writer: MockWriter } {
  const w = writer ?? createMockWriter()
  const port: MockPort = {
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    writable: { getWriter: () => w },
  }
  return { port, writer: w }
}

function installWebSerial(port?: MockPort) {
  const p = port ?? createMockPort().port
  const serial = {
    requestPort: vi.fn().mockResolvedValue(p),
  }
  Object.defineProperty(navigator, 'serial', {
    value: serial,
    writable: true,
    configurable: true,
  })
  return { serial, port: p }
}

function removeWebSerial() {
  // Remove serial from navigator
  if ('serial' in navigator) {
    Object.defineProperty(navigator, 'serial', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    // Also delete it so 'serial' in navigator === false
    delete (navigator as any).serial
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFixture(overrides: Partial<FixtureDef> & { id: string; role: FixtureDef['role'] }): FixtureDef {
  return {
    label: overrides.id,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    ...overrides,
  }
}

function makeState(overrides: Partial<FixtureState> & { id: string; role: FixtureState['role'] }): FixtureState {
  return {
    intensity: 0,
    color: [0, 0, 0],
    pan: 0,
    tilt: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  removeWebSerial()
  // Reset dmx-ref singleton state
  setActiveDmx(null)
  setDmxState('disconnected')
})

afterEach(() => {
  vi.restoreAllMocks()
  removeWebSerial()
})

// ===========================================================================
// EnttecPro — connection flow
// ===========================================================================

describe('EnttecPro connection flow', () => {
  // covers R1, R2, R3, R4
  it('connect-happy-path: connects through WebSerial picker and starts transmit loop', async () => {

    const { port: mockPort, writer: mockWriter } = createMockPort()
    const { serial } = installWebSerial(mockPort)

    const stateChanges: DMXOutputState[] = []
    const pro = new EnttecPro({
      onStateChange: (s) => stateChanges.push(s),
    })

    await pro.connect()

    // R2: state transitions through connecting -> connected
    expect(stateChanges).toEqual(['connecting', 'connected'])

    // R3: picker filter is FTDI VID/PID
    expect(serial.requestPort).toHaveBeenCalledWith({
      filters: [{ usbVendorId: 0x0403, usbProductId: 0x6001 }],
    })

    // R4: port opened at 115200 baud
    expect(mockPort.open).toHaveBeenCalledWith({ baudRate: 115200 })

    // R4: connected is true
    expect(pro.connected).toBe(true)

    // R4: transmit loop started - writer should receive a write within 100ms
    await new Promise((r) => setTimeout(r, 100))
    expect(mockWriter.write).toHaveBeenCalled()

    // Cleanup
    await pro.disconnect()
  })

  // covers R1
  it('connect-rejects-no-webserial: sets error state when WebSerial absent', async () => {
    removeWebSerial()

    let errorMsg = ''
    const pro = new EnttecPro({
      onError: (msg) => { errorMsg = msg },
    })

    // Should not throw
    await pro.connect()

    expect(pro.state).toBe('error')
    expect(errorMsg).toBe('WebSerial not supported in this browser')
    expect(pro.connected).toBe(false)
  })

  // covers R5
  it('connect-user-cancels-picker: handles picker cancellation gracefully', async () => {
    const notFoundError = new DOMException('No port selected', 'NotFoundError')
    const serial = {
      requestPort: vi.fn().mockRejectedValue(notFoundError),
    }
    Object.defineProperty(navigator, 'serial', {
      value: serial,
      writable: true,
      configurable: true,
    })

    let errorMsg = ''
    const pro = new EnttecPro({
      onError: (msg) => { errorMsg = msg },
    })

    // Should not throw
    await pro.connect()

    expect(pro.state).toBe('error')
    expect(errorMsg).toBeTruthy()
    expect(pro.connected).toBe(false)
  })
})

// ===========================================================================
// EnttecPro — send + transmit loop
// ===========================================================================

describe('EnttecPro transmit loop + frame coalescing', () => {
  // covers R7
  it('send-is-nonblocking: send() returns synchronously without USB writes', async () => {

    const { port: mockPort, writer: mockWriter } = createMockPort()
    installWebSerial(mockPort)

    const pro = new EnttecPro()
    await pro.connect()

    // Reset write count from the transmit loop's initial iteration
    const writesBeforeBurst = mockWriter.write.mock.calls.length

    const buf = new Uint8Array(512)
    const results: any[] = []
    for (let i = 0; i < 1000; i++) {
      results.push(pro.send(buf))
    }

    // Each call returns undefined (not a Promise)
    expect(results.every((r) => r === undefined)).toBe(true)

    // No additional USB writes during the synchronous burst
    // (the loop is async and can't interleave with our synchronous loop)
    const writesAfterBurst = mockWriter.write.mock.calls.length
    expect(writesAfterBurst - writesBeforeBurst).toBeLessThanOrEqual(1)

    await pro.disconnect()
  })

  // covers R8
  it('transmit-loop-coalesces-latest-wins: latest frame wins at transmit cadence', async () => {

    const { port: mockPort, writer: mockWriter } = createMockPort()
    installWebSerial(mockPort)

    const pro = new EnttecPro()
    await pro.connect()

    mockWriter.write.mockClear()

    // Let the transmit loop run for ~500ms with sends every 16ms
    const start = Date.now()
    while (Date.now() - start < 500) {
      const frame = new Uint8Array(512)
      frame[0] = (Date.now() - start) & 0xff
      pro.send(frame)
      await new Promise((r) => setTimeout(r, 16))
    }

    // The code uses TX_INTERVAL_MS = 33ms (30Hz). Over 500ms, expect ~15 writes.
    const writeCount = mockWriter.write.mock.calls.length
    expect(writeCount).toBeGreaterThan(5)
    expect(writeCount).toBeLessThan(40)

    await pro.disconnect()
  }, 10000)

  // covers R6
  it('frame-layout-518-bytes: DMX frame is exactly 518 bytes with correct header/footer', async () => {

    const { port: mockPort, writer: mockWriter } = createMockPort()
    installWebSerial(mockPort)

    const pro = new EnttecPro()
    await pro.connect()

    const channels = new Uint8Array(512)
    channels[0] = 0xab
    channels[511] = 0xcd
    pro.send(channels)

    // Let the transmit loop fire
    await new Promise((r) => setTimeout(r, 100))

    // Find a write that contains our data
    const writes: Uint8Array[] = mockWriter.write.mock.calls.map((c: any[]) => c[0])
    const frame = writes.find((w) => w.length === 518 && w[5] === 0xab)
    expect(frame).toBeDefined()

    // Header
    expect(frame![0]).toBe(0x7e) // START_OF_MSG
    expect(frame![1]).toBe(0x06) // SEND_DMX_LABEL
    expect(frame![2]).toBe(0x01) // LSB of 513
    expect(frame![3]).toBe(0x02) // MSB of 513
    expect(frame![4]).toBe(0x00) // DMX start code

    // Channel data
    expect(frame![5]).toBe(0xab)
    expect(frame![516]).toBe(0xcd)

    // Terminator
    expect(frame![517]).toBe(0xe7) // END_OF_MSG

    // Total length
    expect(frame!.length).toBe(518)

    await pro.disconnect()
  })
})

// ===========================================================================
// EnttecPro — disconnect handling
// ===========================================================================

describe('EnttecPro disconnect handling', () => {
  // covers R29
  it('disconnect-awaits-transmit-task: awaits in-flight write before releasing', async () => {

    let resolveWrite: (() => void) | null = null
    const slowWriter = createMockWriter()
    slowWriter.write.mockImplementation(() => new Promise<void>((r) => { resolveWrite = r }))

    const { port: mockPort } = createMockPort(slowWriter)
    installWebSerial(mockPort)

    const pro = new EnttecPro()
    await pro.connect()

    // Start disconnect while a write is in flight
    const disconnectPromise = pro.disconnect()

    // Give a moment for disconnect to start waiting
    await new Promise((r) => setTimeout(r, 10))

    // Resolve the pending write so the loop can exit
    if (resolveWrite) resolveWrite()

    await disconnectPromise

    expect(pro.state).toBe('disconnected')
  })

  // covers R30, R31
  it('disconnect-is-idempotent: safe to call when already disconnected', async () => {
    const pro = new EnttecPro()

    // Already disconnected from construction
    expect(pro.state).toBe('disconnected')

    // Both calls should resolve without throwing
    await pro.disconnect()
    await pro.disconnect()

    expect(pro.state).toBe('disconnected')
  })

  // covers R9
  it('write-failure-tears-down: write error sets error state and exits loop', async () => {

    let callCount = 0
    const failingWriter = createMockWriter()
    failingWriter.write.mockImplementation(() => {
      callCount++
      if (callCount >= 3) return Promise.reject(new Error('USB device disconnected'))
      return Promise.resolve()
    })

    const { port: mockPort } = createMockPort(failingWriter)
    installWebSerial(mockPort)

    let errorMsg = ''
    const pro = new EnttecPro({
      onError: (msg) => { errorMsg = msg },
    })

    await pro.connect()

    // Wait for the loop to hit the failure (3 iterations * ~33ms + margin)
    await new Promise((r) => setTimeout(r, 300))

    expect(pro.state).toBe('error')
    expect(errorMsg).toMatch(/^Write failed: /)

    // No further writes after failure
    const writesAtError = failingWriter.write.mock.calls.length
    await new Promise((r) => setTimeout(r, 200))
    expect(failingWriter.write.mock.calls.length).toBe(writesAtError)

    // Disconnect after error should be safe
    await pro.disconnect()
  })
})

// ===========================================================================
// autoPatch
// ===========================================================================

describe('autoPatch', () => {
  // covers R12, R13
  it('autopatch-honors-explicit-pin: respects dmxAddress and defaults to 6 channels', () => {
    const fixture = makeFixture({
      id: 'mh_1',
      role: 'moving_head',
      dmxAddress: 10,
    })

    const patches = autoPatch([fixture])

    expect(patches.length).toBe(1)
    expect(patches[0]).toEqual({
      fixtureId: 'mh_1',
      role: 'moving_head',
      universe: 1,
      startAddress: 10,
      channelCount: 6,
    })
  })

  // covers R12, R16
  it('autopatch-autofills-from-address-1: assigns contiguous blocks starting at 1', () => {
    const fixtures = [
      makeFixture({ id: 'f1', role: 'moving_head' }),
      makeFixture({ id: 'f2', role: 'par' }),
      makeFixture({ id: 'f3', role: 'moving_head' }),
      makeFixture({ id: 'f4', role: 'par' }),
    ]

    const patches = autoPatch(fixtures)

    expect(patches.length).toBe(4)
    expect(patches.map((p) => p.startAddress)).toEqual([1, 7, 13, 19])
  })

  // covers R14
  it('autopatch-drops-overlapping-pin: drops second pin when ranges overlap', () => {
    const fixtures = [
      makeFixture({ id: 'f1', role: 'par', dmxAddress: 1 }),
      makeFixture({ id: 'f2', role: 'par', dmxAddress: 1 }),
    ]

    const patches = autoPatch(fixtures)

    expect(patches.length).toBe(1)
    expect(patches[0].fixtureId).toBe('f1')
  })

  // covers R15
  it('autopatch-drops-out-of-range-pin: drops pin that extends past channel 512', () => {
    const fixture = makeFixture({
      id: 'f1',
      role: 'par',
      dmxAddress: 510,
      dmxChannelCount: 6,
    })

    const patches = autoPatch([fixture])

    expect(patches.length).toBe(0)
  })

  // covers R15
  it('autopatch-drops-negative-address: drops pin with startAddress < 1', () => {
    const fixture = makeFixture({
      id: 'f1',
      role: 'par',
      dmxAddress: 0,
    })

    const patches = autoPatch([fixture])

    expect(patches.length).toBe(0)
  })

  // covers R16
  it('autopatch-drops-when-universe-full: drops unpinned fixtures when no room', () => {
    // Create 85 pinned fixtures filling 510 channels (85 * 6 = 510)
    const pinned: FixtureDef[] = []
    for (let i = 0; i < 85; i++) {
      pinned.push(makeFixture({
        id: `pin_${i}`,
        role: 'par',
        dmxAddress: i * 6 + 1,
      }))
    }
    // Two unpinned fixtures that won't fit (only 2 channels left, need 6 each)
    const unpinned = [
      makeFixture({ id: 'auto_1', role: 'par' }),
      makeFixture({ id: 'auto_2', role: 'par' }),
    ]

    const patches = autoPatch([...pinned, ...unpinned])

    // Only pinned fixtures survive
    expect(patches.length).toBe(85)
    expect(patches.every((p) => p.fixtureId.startsWith('pin_'))).toBe(true)
  })

  // covers R12 — auto-fill routes around pinned fixtures
  it('autopatch-autofill-routes-around-pins: auto-fill skips pinned ranges', () => {
    const fixtures = [
      makeFixture({ id: 'pinned', role: 'par', dmxAddress: 1 }), // takes 1-6
      makeFixture({ id: 'auto1', role: 'par' }), // should get 7-12
    ]

    const patches = autoPatch(fixtures)

    expect(patches.length).toBe(2)
    expect(patches[0].startAddress).toBe(1) // pinned
    expect(patches[1].startAddress).toBe(7) // auto-filled after pin
  })
})

// ===========================================================================
// fixturesToDMX
// ===========================================================================

describe('fixturesToDMX', () => {
  // covers R17, R19, R20, R22
  it('fixtures-to-dmx-par-layout: par maps dimmer/RGB/effects/speed correctly', () => {
    const patch: DMXPatch = {
      fixtureId: 'p1',
      role: 'par',
      universe: 1,
      startAddress: 1,
      channelCount: 6,
    }
    const state = makeState({
      id: 'p1',
      role: 'par',
      intensity: 0.5,
      color: [1, 0, 0],
    })

    const buf = fixturesToDMX([state], [patch])

    // R17: returns 512 bytes
    expect(buf.length).toBe(512)

    // R19: dimmer = round(0.5 * 255) = 128
    expect(buf[0]).toBe(128)

    // R20: RGB
    expect(buf[1]).toBe(255) // red
    expect(buf[2]).toBe(0)   // green
    expect(buf[3]).toBe(0)   // blue

    // R22: effects = 0, speed = 0
    expect(buf[4]).toBe(0)
    expect(buf[5]).toBe(0)

    // Rest is zeros
    for (let i = 6; i < 512; i++) {
      expect(buf[i]).toBe(0)
    }
  })

  // covers R21
  it('fixtures-to-dmx-mover-pan-tilt-center: pan=0/tilt=0 maps to 128', () => {
    const patch: DMXPatch = {
      fixtureId: 'mh1',
      role: 'moving_head',
      universe: 1,
      startAddress: 1,
      channelCount: 6,
    }
    const state = makeState({
      id: 'mh1',
      role: 'moving_head',
      intensity: 1,
      color: [1, 1, 1],
      pan: 0,
      tilt: 0,
    })

    const buf = fixturesToDMX([state], [patch])

    // Pan center: (0 - (-PI)) / (2*PI) * 255 = 0.5 * 255 = 127.5 -> 128
    expect(buf[4]).toBe(128)
    // Tilt center: (0 - (-PI/2)) / (PI) * 255 = 0.5 * 255 = 127.5 -> 128
    expect(buf[5]).toBe(128)
  })

  // covers R21
  it('fixtures-to-dmx-mover-saturates: pan=PI/tilt=PI/2 maps to 255', () => {
    const patch: DMXPatch = {
      fixtureId: 'mh1',
      role: 'moving_head',
      universe: 1,
      startAddress: 1,
      channelCount: 6,
    }
    const state = makeState({
      id: 'mh1',
      role: 'moving_head',
      intensity: 1,
      color: [1, 1, 1],
      pan: Math.PI,
      tilt: Math.PI / 2,
    })

    const buf = fixturesToDMX([state], [patch])

    expect(buf[4]).toBe(255) // pan max
    expect(buf[5]).toBe(255) // tilt max
  })

  // covers R19, R21
  it('fixtures-to-dmx-clamps-out-of-range: values beyond range are clamped', () => {
    const patch: DMXPatch = {
      fixtureId: 'mh1',
      role: 'moving_head',
      universe: 1,
      startAddress: 1,
      channelCount: 6,
    }
    const state = makeState({
      id: 'mh1',
      role: 'moving_head',
      intensity: 1.5,
      color: [-0.2, 2.0, 0.5],
      pan: 2 * Math.PI,
    })

    const buf = fixturesToDMX([state], [patch])

    // R19: dimmer clamped to 255
    expect(buf[0]).toBe(255)
    // R20: red clamped low to 0
    expect(buf[1]).toBe(0)
    // R20: green clamped high to 255
    expect(buf[2]).toBe(255)
    // R21: pan saturated high to 255
    expect(buf[4]).toBe(255)
  })

  // covers R18
  it('fixtures-to-dmx-missing-state-leaves-zeros: unmatched patch stays zero', () => {
    const patch: DMXPatch = {
      fixtureId: 'ghost',
      role: 'par',
      universe: 1,
      startAddress: 1,
      channelCount: 6,
    }

    const buf = fixturesToDMX([], [patch])

    for (let i = 0; i < 512; i++) {
      expect(buf[i]).toBe(0)
    }
  })

  // covers R23
  it('fixtures-to-dmx-skips-out-of-bounds-patch: patch past channel 512 is skipped', () => {
    const patch: DMXPatch = {
      fixtureId: 'f1',
      role: 'par',
      universe: 1,
      startAddress: 510,
      channelCount: 6,
    }
    const state = makeState({
      id: 'f1',
      role: 'par',
      intensity: 1,
      color: [1, 0, 0],
    })

    const buf = fixturesToDMX([state], [patch])

    // Should be skipped entirely - bytes 509-511 remain 0
    expect(buf[509]).toBe(0)
    expect(buf[510]).toBe(0)
    expect(buf[511]).toBe(0)
    expect(buf.length).toBe(512)
  })

  // covers R22
  it('fixtures-to-dmx-oversized-channel-count: par with 12ch has slots 4-5 zero, 6-11 zero', () => {
    const patch: DMXPatch = {
      fixtureId: 'p1',
      role: 'par',
      universe: 1,
      startAddress: 1,
      channelCount: 12,
    }
    const state = makeState({
      id: 'p1',
      role: 'par',
      intensity: 1,
      color: [1, 0, 0],
    })

    const buf = fixturesToDMX([state], [patch])

    // Dimmer + RGB written
    expect(buf[0]).toBe(255)
    expect(buf[1]).toBe(255)
    expect(buf[2]).toBe(0)
    expect(buf[3]).toBe(0)

    // Slots 4-5 held at 0
    expect(buf[4]).toBe(0)
    expect(buf[5]).toBe(0)

    // Slots 6-11 stay 0 (not addressed by today's layout)
    for (let i = 6; i < 12; i++) {
      expect(buf[i]).toBe(0)
    }
  })

  // covers R17 — multiple fixtures at different addresses
  it('fixtures-to-dmx-multiple-fixtures: multiple patches write to correct offsets', () => {
    const patches: DMXPatch[] = [
      { fixtureId: 'p1', role: 'par', universe: 1, startAddress: 1, channelCount: 6 },
      { fixtureId: 'p2', role: 'par', universe: 1, startAddress: 7, channelCount: 6 },
    ]
    const states = [
      makeState({ id: 'p1', role: 'par', intensity: 1, color: [1, 0, 0] }),
      makeState({ id: 'p2', role: 'par', intensity: 0.5, color: [0, 1, 0] }),
    ]

    const buf = fixturesToDMX(states, patches)

    // First fixture at base 0
    expect(buf[0]).toBe(255) // p1 dimmer
    expect(buf[1]).toBe(255) // p1 red

    // Second fixture at base 6
    expect(buf[6]).toBe(128) // p2 dimmer
    expect(buf[7]).toBe(0)   // p2 red
    expect(buf[8]).toBe(255) // p2 green
  })

  // covers R21 — moving head at min pan/tilt
  it('fixtures-to-dmx-mover-min-values: pan=-PI/tilt=-PI/2 maps to 0', () => {
    const patch: DMXPatch = {
      fixtureId: 'mh1',
      role: 'moving_head',
      universe: 1,
      startAddress: 1,
      channelCount: 6,
    }
    const state = makeState({
      id: 'mh1',
      role: 'moving_head',
      intensity: 1,
      color: [1, 1, 1],
      pan: -Math.PI,
      tilt: -Math.PI / 2,
    })

    const buf = fixturesToDMX([state], [patch])

    expect(buf[4]).toBe(0) // pan min
    expect(buf[5]).toBe(0) // tilt min
  })
})

// ===========================================================================
// dmx-ref singleton
// ===========================================================================

describe('dmx-ref singleton', () => {
  let unsubs: (() => void)[] = []

  afterEach(() => {
    // Clean up any subscribers registered during the test
    unsubs.forEach((u) => u())
    unsubs = []
  })

  // covers R24, R25, R26
  it('subscribe-notifies-all: all subscribers notified on setDmxState', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    const cb3 = vi.fn()

    unsubs.push(subscribeDmx(cb1))
    unsubs.push(subscribeDmx(cb2))
    unsubs.push(subscribeDmx(cb3))

    setDmxState('connected')

    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
    expect(cb3).toHaveBeenCalledTimes(1)
    expect(getDmxState()).toBe('connected')
  })

  // covers R26
  it('unsubscribe-removes-one: unsubscribed callback is not notified', () => {
    const cbA = vi.fn()
    const cbB = vi.fn()

    const unsubA = subscribeDmx(cbA)
    unsubs.push(subscribeDmx(cbB))

    // Unsubscribe A
    unsubA()

    // Trigger notification
    setActiveDmx(null)

    expect(cbA).toHaveBeenCalledTimes(0)
    expect(cbB).toHaveBeenCalledTimes(1)
  })

  // covers R24
  it('setActiveDmx-notifies-subscribers: subscribers notified on instance change', () => {
    const cb = vi.fn()
    unsubs.push(subscribeDmx(cb))

    const mockPro = {} as any
    setActiveDmx(mockPro)

    expect(cb).toHaveBeenCalledTimes(1)
    expect(getActiveDmx()).toBe(mockPro)
  })

  // covers R24
  it('getActiveDmx-returns-null-by-default', () => {
    expect(getActiveDmx()).toBeNull()
  })
})

// ===========================================================================
// EnttecPro — state machine edge cases
// ===========================================================================

describe('EnttecPro state machine', () => {
  // covers R5 — port.open throws
  it('connect-open-failure: handles port.open rejection', async () => {

    const mockWriter = createMockWriter()
    const mockPort: MockPort = {
      open: vi.fn().mockRejectedValue(new Error('Access denied')),
      close: vi.fn().mockResolvedValue(undefined),
      writable: { getWriter: () => mockWriter },
    }
    installWebSerial(mockPort)

    let errorMsg = ''
    const pro = new EnttecPro({
      onError: (msg) => { errorMsg = msg },
    })

    await pro.connect()

    expect(pro.state).toBe('error')
    expect(errorMsg).toBe('Access denied')
    expect(pro.connected).toBe(false)
  })

  // covers R5 — port.writable is null
  it('connect-writable-null: handles null writable stream', async () => {

    const mockPort: MockPort = {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      writable: null,
    }
    installWebSerial(mockPort)

    let errorMsg = ''
    const pro = new EnttecPro({
      onError: (msg) => { errorMsg = msg },
    })

    await pro.connect()

    expect(pro.state).toBe('error')
    expect(errorMsg).toBeTruthy()
    expect(pro.connected).toBe(false)
  })

  // covers R10 — DMX_CHANNELS = 512
  it('universe-is-512-channels: fixturesToDMX returns exactly 512 bytes', () => {
    const buf = fixturesToDMX([], [])
    expect(buf.length).toBe(512)
    // All zeros when no patches
    for (let i = 0; i < 512; i++) {
      expect(buf[i]).toBe(0)
    }
  })
})
