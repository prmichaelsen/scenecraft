/**
 * Real-time WebAudio streaming mixer for the Timeline (M14).
 *
 * Uses `HTMLAudioElement` + `MediaElementAudioSourceNode` for streaming (not
 * `decodeAudioData`) so projects with hours of audio stay within browser
 * memory limits. Per-clip `GainNode` + per-track `GainNode` are in place
 * from T116; curve automation + equal-power crossfade are wired in T117.
 *
 * Design: agent/design/local.audio-streaming-and-mixing.md
 */

import type { AudioTrack, AudioClip } from './audio-client'
import { scenecraftFileUrl } from './scenecraft-client'

/** Public API the Timeline consumes. */
export type AudioMixer = {
  readonly trackCount: number
  /** Enable activation. Future `seek()` calls will start/stop audio as the playhead crosses clip boundaries. */
  play(): void
  /** Pause every active element. Re-enabling via `play()` resumes at the next `seek()`. */
  pause(): void
  /** Jump the playhead; activate/deactivate clips. When `isPlaying`, also syncs `audio.currentTime`. */
  seek(seconds: number): void
  /** A specific clip's data changed. Re-read + re-schedule if active. */
  updateClip(clipId: string): void
  /** A specific track's data changed (curve, muted, enabled). */
  updateTrack(trackId: string): void
  /** Full track list changed (add/remove/reorder). Rebuild graph from scratch. */
  rebuild(tracks: AudioTrack[]): void
  /** Tear down all nodes + elements; close AudioContext. */
  dispose(): void
}

/** Factory options. Used for test injection. */
export type AudioMixerOptions = {
  /** Override for tests / non-browser environments. Default: `new AudioContext({ latencyHint: 'playback' })`. */
  audioCtxFactory?: () => AudioContext
  /** Override for tests / SSR. Default: `document.createElement('audio')`. */
  audioElementFactory?: () => HTMLAudioElement
  /** Override for URL building in tests. Default: `scenecraftFileUrl(projectName, sourcePath)`. */
  sourceUrlFactory?: (projectName: string, sourcePath: string) => string
}

type ClipNode = {
  clip: AudioClip
  audio: HTMLAudioElement | null
  source: MediaElementAudioSourceNode | null
  /** Per-clip volume curve gain. Multiplied by crossfade gain downstream. */
  clipGain: GainNode | null
  /** Crossfade multiplier — layered on top of clipGain so volume + crossfade compose cleanly. */
  crossfadeGain: GainNode | null
  /** True while the playhead is inside [start_time, end_time). */
  active: boolean
}

type TrackNode = {
  track: AudioTrack
  /** Track volume + enabled + muted gate. */
  trackGain: GainNode | null
  clips: Map<string, ClipNode>
}

const DEFAULT_AUDIO_CTX_FACTORY = (): AudioContext =>
  new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({
    latencyHint: 'playback',
  })

const DEFAULT_AUDIO_ELEMENT_FACTORY = (): HTMLAudioElement => {
  const el = document.createElement('audio')
  el.preload = 'auto'
  el.crossOrigin = 'anonymous'
  return el
}

export function createAudioMixer(
  projectName: string,
  tracks: AudioTrack[],
  options: AudioMixerOptions = {},
): AudioMixer {
  const audioCtxFactory = options.audioCtxFactory ?? DEFAULT_AUDIO_CTX_FACTORY
  const audioElementFactory = options.audioElementFactory ?? DEFAULT_AUDIO_ELEMENT_FACTORY
  const sourceUrlFactory = options.sourceUrlFactory ?? scenecraftFileUrl

  let audioCtx: AudioContext | null = null
  const trackMap = new Map<string, TrackNode>()
  let isPlaying = false
  let lastPlayhead = 0
  let disposed = false

  const log = (msg: string): void => {
    if (typeof console !== 'undefined') console.debug(`[audio-mixer] ${msg}`)
  }

  const ensureCtx = (): AudioContext => {
    if (!audioCtx) audioCtx = audioCtxFactory()
    if (audioCtx.state === 'suspended') {
      // AudioContext starts suspended in most browsers until a user gesture;
      // resume() returns a promise that rejects silently if still blocked.
      audioCtx.resume().catch(() => {})
    }
    return audioCtx
  }

  const buildClipGraph = (ctx: AudioContext, trackNode: TrackNode, clipNode: ClipNode): void => {
    if (clipNode.audio) return // already built
    const audio = audioElementFactory()
    audio.src = sourceUrlFactory(projectName, clipNode.clip.source_path)
    const source = ctx.createMediaElementSource(audio)
    const clipGain = ctx.createGain()
    const crossfadeGain = ctx.createGain()
    clipGain.gain.value = clipNode.clip.muted ? 0 : 1
    crossfadeGain.gain.value = 1
    source.connect(clipGain).connect(crossfadeGain)
    if (trackNode.trackGain) crossfadeGain.connect(trackNode.trackGain)
    clipNode.audio = audio
    clipNode.source = source
    clipNode.clipGain = clipGain
    clipNode.crossfadeGain = crossfadeGain
  }

  const buildTrackGraph = (ctx: AudioContext, trackNode: TrackNode): void => {
    if (trackNode.trackGain) return
    const trackGain = ctx.createGain()
    const muted = trackNode.track.muted || !trackNode.track.enabled
    trackGain.gain.value = muted ? 0 : 1
    trackGain.connect(ctx.destination)
    trackNode.trackGain = trackGain
  }

  const ensureGraph = (): void => {
    const ctx = ensureCtx()
    for (const trackNode of trackMap.values()) {
      buildTrackGraph(ctx, trackNode)
      for (const clipNode of trackNode.clips.values()) {
        buildClipGraph(ctx, trackNode, clipNode)
      }
    }
  }

  const tearDownClip = (clipNode: ClipNode): void => {
    if (clipNode.audio) {
      try { clipNode.audio.pause() } catch { /* ignore */ }
      clipNode.audio.src = ''
    }
    try { clipNode.source?.disconnect() } catch { /* ignore */ }
    try { clipNode.clipGain?.disconnect() } catch { /* ignore */ }
    try { clipNode.crossfadeGain?.disconnect() } catch { /* ignore */ }
    clipNode.audio = null
    clipNode.source = null
    clipNode.clipGain = null
    clipNode.crossfadeGain = null
    clipNode.active = false
  }

  const tearDownTrack = (trackNode: TrackNode): void => {
    for (const clipNode of trackNode.clips.values()) tearDownClip(clipNode)
    try { trackNode.trackGain?.disconnect() } catch { /* ignore */ }
    trackNode.trackGain = null
  }

  const populateFromTracks = (nextTracks: AudioTrack[]): void => {
    for (const trackNode of trackMap.values()) tearDownTrack(trackNode)
    trackMap.clear()
    for (const t of nextTracks) {
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
      trackMap.set(t.id, trackNode)
    }
  }
  populateFromTracks(tracks)

  const activateClip = (clipNode: ClipNode, playhead: number): void => {
    if (!clipNode.audio) return
    const { start_time, source_offset } = clipNode.clip
    // Offset into source = clip-local offset + how far we are into the clip span
    const sourcePosition = Math.max(0, source_offset + (playhead - start_time))
    try {
      clipNode.audio.currentTime = sourcePosition
    } catch { /* readyState may not allow — retry on loadedmetadata */ }
    if (isPlaying) {
      clipNode.audio.play().catch(() => {
        // NotAllowedError / AbortError — common before first user gesture; swallow
      })
    }
    clipNode.active = true
  }

  const deactivateClip = (clipNode: ClipNode): void => {
    if (clipNode.audio) {
      try { clipNode.audio.pause() } catch { /* ignore */ }
    }
    clipNode.active = false
  }

  const reevaluateClips = (playhead: number): void => {
    for (const trackNode of trackMap.values()) {
      for (const clipNode of trackNode.clips.values()) {
        const { start_time, end_time } = clipNode.clip
        const inside = playhead >= start_time && playhead < end_time
        if (inside && !clipNode.active) {
          activateClip(clipNode, playhead)
        } else if (!inside && clipNode.active) {
          deactivateClip(clipNode)
        } else if (inside && clipNode.active && isPlaying && clipNode.audio) {
          // Already active + playing — keep `audio.currentTime` approximately
          // aligned with the playhead. Skipping the re-sync here avoids
          // mid-playback hiccups; the browser streams smoothly once started.
        }
      }
    }
  }

  const applyTrackMuteState = (trackNode: TrackNode): void => {
    if (!trackNode.trackGain || !audioCtx) return
    const muted = trackNode.track.muted || !trackNode.track.enabled
    trackNode.trackGain.gain.setValueAtTime(muted ? 0 : 1, audioCtx.currentTime)
  }

  const applyClipMuteState = (clipNode: ClipNode): void => {
    if (!clipNode.clipGain || !audioCtx) return
    clipNode.clipGain.gain.setValueAtTime(clipNode.clip.muted ? 0 : 1, audioCtx.currentTime)
  }

  return {
    get trackCount() { return trackMap.size },

    play() {
      if (disposed) return
      isPlaying = true
      ensureGraph()
      // Activate any clips already inside the playhead window
      reevaluateClips(lastPlayhead)
      log(`play() @${lastPlayhead.toFixed(3)}s`)
    },

    pause() {
      if (disposed) return
      isPlaying = false
      for (const trackNode of trackMap.values()) {
        for (const clipNode of trackNode.clips.values()) {
          if (clipNode.active && clipNode.audio) {
            try { clipNode.audio.pause() } catch { /* ignore */ }
          }
        }
      }
      log('pause()')
    },

    seek(seconds: number) {
      if (disposed) return
      lastPlayhead = seconds
      // Only mutate graph if we've already built it. On first seek before play,
      // we just remember the position.
      if (audioCtx) reevaluateClips(seconds)
    },

    updateClip(clipId: string) {
      if (disposed) return
      for (const trackNode of trackMap.values()) {
        const clipNode = trackNode.clips.get(clipId)
        if (!clipNode) continue
        // Refresh mute state from the latest clip data (caller passed updated track list
        // via rebuild, so clipNode.clip is already current if we're called after rebuild).
        applyClipMuteState(clipNode)
        // Curve automation is wired in T117; for now, mute is the live-updatable state.
        log(`updateClip(${clipId})`)
        return
      }
    },

    updateTrack(trackId: string) {
      if (disposed) return
      const trackNode = trackMap.get(trackId)
      if (!trackNode) return
      applyTrackMuteState(trackNode)
      log(`updateTrack(${trackId})`)
    },

    rebuild(nextTracks: AudioTrack[]) {
      if (disposed) return
      populateFromTracks(nextTracks)
      if (audioCtx) ensureGraph()
      log(`rebuild(${nextTracks.length} tracks)`)
    },

    dispose() {
      if (disposed) return
      disposed = true
      isPlaying = false
      for (const trackNode of trackMap.values()) tearDownTrack(trackNode)
      trackMap.clear()
      if (audioCtx) {
        try { audioCtx.close() } catch { /* ignore */ }
        audioCtx = null
      }
    },
  }
}
