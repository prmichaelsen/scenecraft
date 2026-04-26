/**
 * Module-level singleton for the active DMX output (EnttecPro instance).
 *
 * The light_show 3D panel can be unmounted and remounted by its parent dock
 * layout in response to unrelated state changes (e.g., the audio mixer
 * rebuilding when timeline tracks change). If the EnttecPro lived in a
 * useRef inside the panel, every remount would orphan the running
 * connection — its transmitLoop would still be alive but no new send()
 * calls would reach it from the new SceneRunner, and the dongle would
 * receive a stuck frame until the writer eventually errored.
 *
 * Hoisting the instance here decouples the connection's lifetime from the
 * panel's component lifecycle. The panel mounts → reads the singleton, sees
 * the connection is alive, attaches per-frame send() calls. The panel
 * unmounts → the singleton keeps holding the EnttecPro and its transmit
 * loop continues with whatever was the last sent frame. Panel remounts →
 * picks up where it left off.
 *
 * Mirrors the pattern in ``audio-mixer-ref.ts`` — same reasoning, different
 * subsystem.
 *
 * Lifecycle:
 *   - User clicks "DMX Output" → ``setActiveDmx(new EnttecPro())`` →
 *     subscribers notified → panel UI flips to green.
 *   - User clicks again to disconnect → ``setActiveDmx(null)`` after
 *     ``await dmx.disconnect()`` → subscribers notified.
 *   - Panel mount/unmount: subscribers manage their own lifecycle; the
 *     singleton persists across both.
 */

import type { EnttecPro, DMXOutputState } from './enttec-pro'

let activeDmx: EnttecPro | null = null
let cachedState: DMXOutputState = 'disconnected'
const subscribers = new Set<() => void>()

function notifySubscribers(): void {
  for (const cb of subscribers) cb()
}

/** Read the current EnttecPro instance, or null when disconnected. */
export function getActiveDmx(): EnttecPro | null {
  return activeDmx
}

/** Replace the active EnttecPro. Pass ``null`` to clear after disconnect. */
export function setActiveDmx(dmx: EnttecPro | null): void {
  activeDmx = dmx
  notifySubscribers()
}

/** Read the cached state for ``useSyncExternalStore`` snapshots. */
export function getDmxState(): DMXOutputState {
  return cachedState
}

/** Update cached state from EnttecPro's ``onStateChange`` callback. Called
 *  whenever the underlying connection transitions (connecting → connected →
 *  error → disconnected). Notifies subscribers so React UIs re-read. */
export function setDmxState(state: DMXOutputState): void {
  cachedState = state
  notifySubscribers()
}

/** Subscribe to singleton changes (instance set/cleared, or state changed).
 *  Returns an unsubscribe function. Designed for ``useSyncExternalStore``. */
export function subscribeDmx(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}
