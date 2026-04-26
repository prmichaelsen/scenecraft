/**
 * WebSerial driver for ENTTEC DMX USB Pro (Widget API).
 *
 * Frame format (§4.2 of widget API spec):
 *   [START_OF_MSG(0x7E)] [LABEL] [DATA_LEN_LSB] [DATA_LEN_MSB] [DATA...] [END_OF_MSG(0xE7)]
 *
 * For "Output Only Send DMX Packet Request" (label 6):
 *   DATA = [START_CODE(0x00)] + [512 channel bytes]
 *   DATA_LEN = 513 (1 start code + 512 channels)
 *
 * Total frame: 1 + 1 + 2 + 513 + 1 = 518 bytes.
 */

const START_OF_MSG = 0x7e
const END_OF_MSG = 0xe7
const SEND_DMX_LABEL = 6
const DMX_CHANNELS = 512

// Transmit cadence on the USB side. DMX wire-level max is ~44Hz; this
// gives the dongle a steady ~30Hz feed which is responsive enough to
// look live and far below any throughput pressure.
const TX_INTERVAL_MS = 33

export type DMXOutputState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface EnttecProEvents {
  onStateChange?: (state: DMXOutputState) => void
  onError?: (error: string) => void
}

function buildDMXFrame(channels: Uint8Array): Uint8Array {
  const dataLen = 1 + DMX_CHANNELS // start code + 512
  const frame = new Uint8Array(1 + 1 + 2 + dataLen + 1)
  frame[0] = START_OF_MSG
  frame[1] = SEND_DMX_LABEL
  frame[2] = dataLen & 0xff        // LSB
  frame[3] = (dataLen >> 8) & 0xff  // MSB
  frame[4] = 0x00                   // DMX start code
  frame.set(channels.subarray(0, DMX_CHANNELS), 5)
  frame[5 + DMX_CHANNELS] = END_OF_MSG
  return frame
}

export class EnttecPro {
  private port: SerialPort | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private _state: DMXOutputState = 'disconnected'
  private events: EnttecProEvents
  // The latest universe state; ``send()`` mutates this, the transmit loop
  // reads it. Single-buffer-by-design: stale frames are useless on a
  // continuous protocol, so we only care about whatever's in here at the
  // moment the loop iterates.
  private lastFrame: Uint8Array = new Uint8Array(DMX_CHANNELS)
  // Set to ``true`` once ``connect()`` succeeds; the transmit loop runs
  // until this flips back to ``false`` (or until the writer is gone).
  private transmitting = false
  // The dedicated transmit loop's promise. Held so ``disconnect()`` can
  // wait for it to drain before tearing down the port.
  private transmitTask: Promise<void> | null = null

  constructor(events: EnttecProEvents = {}) {
    this.events = events
  }

  get state(): DMXOutputState {
    return this._state
  }

  get connected(): boolean {
    return this._state === 'connected'
  }

  private setState(s: DMXOutputState) {
    this._state = s
    this.events.onStateChange?.(s)
  }

  async connect(): Promise<void> {
    if (!('serial' in navigator)) {
      this.setState('error')
      this.events.onError?.('WebSerial not supported in this browser')
      return
    }

    try {
      this.setState('connecting')

      // ENTTEC Pro uses FTDI chip: vendor 0x0403, product 0x6001
      // requestPort shows a picker; filter narrows the list.
      this.port = await navigator.serial.requestPort({
        filters: [{ usbVendorId: 0x0403, usbProductId: 0x6001 }],
      })

      // ENTTEC Pro baud doesn't strictly matter (USB-serial framing is
      // handled by the widget firmware), but 115200 is the standard.
      await this.port.open({ baudRate: 115200 })

      if (!this.port.writable) {
        throw new Error('Port opened but writable stream is null')
      }

      this.writer = this.port.writable.getWriter()
      this.setState('connected')
      // Start the transmit loop. It runs until ``transmitting`` flips false
      // (disconnect) or a write throws (which sets state='error' and tears
      // down the port). Decoupled from the React frame loop so per-frame
      // calls to send() are O(1) memcpy and the dongle gets a steady stream
      // at TX_INTERVAL_MS instead of bursts at 60fps.
      this.transmitting = true
      this.transmitTask = this.transmitLoop()
    } catch (e) {
      this.setState('error')
      this.events.onError?.((e as Error).message)
      await this.cleanup()
    }
  }

  async disconnect(): Promise<void> {
    this.transmitting = false
    // Wait for the transmit loop to observe the flag and exit cleanly so
    // we don't tear down the writer while a write is in flight.
    if (this.transmitTask) {
      try { await this.transmitTask } catch { /* loop swallows its own errors */ }
      this.transmitTask = null
    }
    await this.cleanup()
    this.setState('disconnected')
  }

  /**
   * Update the universe state. Non-blocking; the dedicated transmit loop
   * picks up the latest ``lastFrame`` on its next iteration. DMX is a
   * continuous protocol — stale frames are meaningless — so we don't
   * bother queuing; we always TX the most recent state.
   *
   * Per-frame from useFrame at 60fps: O(1) memcpy. The actual write rate
   * to the dongle is throttled by the transmit loop to ~30Hz (33ms),
   * which is well under DMX's wire-level max (~44Hz) and decouples the
   * USB transmit cadence from React's render rate.
   */
  send(channels: Uint8Array): void {
    this.lastFrame.set(channels.subarray(0, DMX_CHANNELS))
  }

  private async transmitLoop(): Promise<void> {
    while (this.transmitting && this.writer) {
      const frame = buildDMXFrame(this.lastFrame)
      try {
        await this.writer.write(frame)
      } catch (e) {
        this.setState('error')
        this.events.onError?.(`Write failed: ${(e as Error).message}`)
        // cleanup() is called by disconnect or here; either way the loop
        // ends because writer becomes null.
        await this.cleanup()
        return
      }
      // Throttle to ~30Hz. DMX physical wire-level rate is ~44Hz max;
      // 33ms gives us headroom and matches typical pro-grade TX rates.
      await new Promise<void>((r) => setTimeout(r, TX_INTERVAL_MS))
    }
  }

  private async cleanup(): Promise<void> {
    try {
      this.writer?.releaseLock()
    } catch { /* ignore */ }
    this.writer = null
    try {
      await this.port?.close()
    } catch { /* ignore */ }
    this.port = null
  }
}
