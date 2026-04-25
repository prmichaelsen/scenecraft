/**
 * Module-level singleton for the active AudioMixer.
 *
 * Lets code outside the Timeline dock panel (notably the light_show 3D
 * preview panel) tap the same WebAudio graph — specifically
 * ``getMasterAnalysers()`` — without prop-drilling through dockview layers.
 *
 * Mirrors the window-event pattern documented in ``useAudioMixer.ts`` at
 * MASTER_BUS_EFFECTS_CHANGED_EVENT: cross-panel coordination goes through
 * module-level refs / window events, not React context, because dockview
 * panels are siblings not descendants of a single provider.
 *
 * Lifecycle:
 *   - useAudioMixer calls setActiveAudioMixer(m) on mount.
 *   - useAudioMixer calls setActiveAudioMixer(null) on unmount / project swap.
 *   - Consumers read getActiveAudioMixer() per frame and tolerate null.
 */

import type { AudioMixer } from './audio-mixer'

let activeMixer: AudioMixer | null = null

export function setActiveAudioMixer(mixer: AudioMixer | null): void {
  activeMixer = mixer
}

export function getActiveAudioMixer(): AudioMixer | null {
  return activeMixer
}
