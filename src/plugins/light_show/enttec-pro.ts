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
  private lastFrame: Uint8Array = new Uint8Array(DMX_CHANNELS)
  private sendPending = false

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
    } catch (e) {
      this.setState('error')
      this.events.onError?.((e as Error).message)
      await this.cleanup()
    }
  }

  async disconnect(): Promise<void> {
    await this.cleanup()
    this.setState('disconnected')
  }

  /**
   * Queue a DMX frame for output. Non-blocking — only the most recent
   * frame matters (DMX is a continuous protocol; stale frames are
   * meaningless). If a write is already in flight, the new values are
   * stored and sent when the current write completes.
   */
  send(channels: Uint8Array): void {
    this.lastFrame.set(channels.subarray(0, DMX_CHANNELS))
    if (!this.sendPending) {
      this.sendPending = true
      this.flush()
    }
  }

  private async flush(): Promise<void> {
    while (this.sendPending && this.writer) {
      this.sendPending = false
      const frame = buildDMXFrame(this.lastFrame)
      try {
        await this.writer.write(frame)
      } catch (e) {
        this.setState('error')
        this.events.onError?.(`Write failed: ${(e as Error).message}`)
        await this.cleanup()
        return
      }
      // If send() was called during the await, sendPending is true again
      // and we loop to send the latest values.
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
