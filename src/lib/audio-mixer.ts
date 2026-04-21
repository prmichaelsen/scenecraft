/**
 * Real-time WebAudio streaming mixer for the Timeline (M14).
 *
 * This file contains the skeleton: types + factory + a no-op implementation
 * that logs method calls. Task 116 fills in the WebAudio graph and streaming
 * source management; Task 117 adds curve automation and equal-power crossfade.
 *
 * Design: agent/design/local.audio-streaming-and-mixing.md
 */

import type { AudioTrack, AudioClip } from './audio-client'

/** Public API the Timeline consumes. */
export type AudioMixer = {
  /** Number of tracks currently known to the mixer. */
  readonly trackCount: number
  /** Begin playback from the current playhead. Idempotent. */
  play(): void
  /** Pause every active element. State preserved. */
  pause(): void
  /** Jump the playhead; re-evaluate active clips. */
  seek(seconds: number): void
  /**
   * A specific clip's data changed (curve, muted, start/end, source). Re-schedule
   * its automation in place without restart if possible.
   */
  updateClip(clipId: string): void
  /** A specific track's data changed (curve, muted, enabled, name). */
  updateTrack(trackId: string): void
  /** Full track list changed (add/remove/reorder). Rebuild graph. */
  rebuild(tracks: AudioTrack[]): void
  /** Tear down all nodes + elements; release AudioContext. */
  dispose(): void
}

/** Per-clip internal state. WebAudio nodes are created lazily in Task 116. */
export type ClipNode = {
  clip: AudioClip
  /** Lazily allocated — null until first play. */
  audio: HTMLAudioElement | null
  source: MediaElementAudioSourceNode | null
  /** Volume curve gain (driven by clip curve + muted). */
  clipGain: GainNode | null
  /** Crossfade multiplier — separate from clipGain so we can layer without recomputing curves. */
  crossfadeGain: GainNode | null
  /** True while the playhead is inside [start_time, end_time). */
  active: boolean
}

/** Per-track internal state. */
export type TrackNode = {
  track: AudioTrack
  /** Track volume curve + muted + enabled gate. */
  trackGain: GainNode | null
  clips: Map<string, ClipNode>
}

/** Factory. Returned object has the full public API; skeleton implementation logs + no-ops. */
export function createAudioMixer(projectName: string, tracks: AudioTrack[]): AudioMixer {
  const state = {
    projectName,
    tracks: new Map<string, TrackNode>(),
    disposed: false,
  }

  const buildInitial = (initTracks: AudioTrack[]) => {
    state.tracks.clear()
    for (const t of initTracks) {
      const trackNode: TrackNode = { track: t, trackGain: null, clips: new Map() }
      for (const c of (t.clips ?? [])) {
        trackNode.clips.set(c.id, {
          clip: c,
          audio: null,
          source: null,
          clipGain: null,
          crossfadeGain: null,
          active: false,
        })
      }
      state.tracks.set(t.id, trackNode)
    }
  }
  buildInitial(tracks)

  const noop = (msg: string) => {
    if (state.disposed) return
    if (typeof console !== 'undefined') console.debug(`[audio-mixer] ${msg}`)
  }

  return {
    get trackCount() { return state.tracks.size },
    play() { noop('play() — WebAudio graph not yet wired (T116)') },
    pause() { noop('pause()') },
    seek(seconds: number) { noop(`seek(${seconds})`) },
    updateClip(clipId: string) { noop(`updateClip(${clipId})`) },
    updateTrack(trackId: string) { noop(`updateTrack(${trackId})`) },
    rebuild(nextTracks: AudioTrack[]) {
      if (state.disposed) return
      buildInitial(nextTracks)
      noop(`rebuild(${nextTracks.length} tracks)`)
    },
    dispose() {
      state.disposed = true
      state.tracks.clear()
    },
  }
}
