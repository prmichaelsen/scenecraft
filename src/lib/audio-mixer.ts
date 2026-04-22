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

import type { AudioTrack, AudioClip, CurvePoint } from './audio-client'
import { scenecraftFileUrl } from './scenecraft-client'
import { dbToLinear, sampleClipDbAtPlayhead, sampleTrackDbAtPlayhead } from './audio-curves'

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

const sortedCurvePoints = (curve: CurvePoint[] | null | undefined): CurvePoint[] => {
  if (!curve || curve.length === 0) return []
  return [...curve].sort((a, b) => a[0] - b[0])
}

const CROSSFADE_CURVE_LEN = 128

/** Precomputed cos(t·π/2) for 0 ≤ t ≤ 1 — equal-power fade-out side. */
const COS_CURVE = (() => {
  const arr = new Float32Array(CROSSFADE_CURVE_LEN)
  for (let i = 0; i < CROSSFADE_CURVE_LEN; i++) {
    const t = i / (CROSSFADE_CURVE_LEN - 1)
    arr[i] = Math.cos(t * Math.PI / 2)
  }
  return arr
})()

/** Precomputed sin(t·π/2) — equal-power fade-in side. */
const SIN_CURVE = (() => {
  const arr = new Float32Array(CROSSFADE_CURVE_LEN)
  for (let i = 0; i < CROSSFADE_CURVE_LEN; i++) {
    const t = i / (CROSSFADE_CURVE_LEN - 1)
    arr[i] = Math.sin(t * Math.PI / 2)
  }
  return arr
})()

const DEFAULT_AUDIO_CTX_FACTORY = (): AudioContext =>
  new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({
    latencyHint: 'playback',
  })

const DEFAULT_AUDIO_ELEMENT_FACTORY = (): HTMLAudioElement => {
  const el = document.createElement('audio')
  // 'metadata' fetches just enough to know duration/dimensions — avoids
  // parallel full-file downloads across many clips. The element upgrades
  // to streaming playback on .play() anyway.
  el.preload = 'metadata'
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

  /**
   * DAW-style effective mute: a track is silent if it's explicitly muted, OR
   * if any OTHER track is solo'd and this one isn't. Multiple solos compose
   * (all solo'd tracks play, everything else is silent).
   */
  const isTrackEffectivelyMuted = (trackNode: TrackNode): boolean => {
    if (trackNode.track.muted) return true
    const anySolo = [...trackMap.values()].some((tn) => tn.track.solo)
    if (anySolo && !trackNode.track.solo) return true
    return false
  }

  const buildTrackGraph = (ctx: AudioContext, trackNode: TrackNode): void => {
    if (trackNode.trackGain) return
    const trackGain = ctx.createGain()
    trackGain.gain.value = isTrackEffectivelyMuted(trackNode) ? 0 : 1
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

  const scheduleClipCurve = (clipNode: ClipNode, playhead: number): void => {
    if (!clipNode.clipGain || !audioCtx) return
    const g = clipNode.clipGain.gain
    const ctxNow = audioCtx.currentTime
    g.cancelScheduledValues(ctxNow)

    if (clipNode.clip.muted) {
      g.setValueAtTime(0, ctxNow)
      return
    }

    // Anchor at current playhead's gain, then schedule future breakpoints
    const anchorDb = sampleClipDbAtPlayhead(clipNode.clip, playhead)
    g.setValueAtTime(dbToLinear(anchorDb), ctxNow)

    const { start_time, end_time } = clipNode.clip
    const span = Math.max(end_time - start_time, 1e-9)
    const pts = sortedCurvePoints(clipNode.clip.volume_curve)
    for (const [xNorm, db] of pts) {
      const xSec = start_time + xNorm * span
      if (xSec <= playhead) continue
      if (xSec > end_time) break
      const dtCtx = xSec - playhead
      g.linearRampToValueAtTime(dbToLinear(db), ctxNow + dtCtx)
    }
  }

  const scheduleTrackCurve = (trackNode: TrackNode, playhead: number): void => {
    if (!trackNode.trackGain || !audioCtx) return
    const g = trackNode.trackGain.gain
    const ctxNow = audioCtx.currentTime
    g.cancelScheduledValues(ctxNow)

    if (isTrackEffectivelyMuted(trackNode)) {
      g.setValueAtTime(0, ctxNow)
      return
    }

    const anchorDb = sampleTrackDbAtPlayhead(trackNode.track, playhead)
    g.setValueAtTime(dbToLinear(anchorDb), ctxNow)

    const pts = sortedCurvePoints(trackNode.track.volume_curve)
    for (const [xSec, db] of pts) {
      if (xSec <= playhead) continue
      const dtCtx = xSec - playhead
      g.linearRampToValueAtTime(dbToLinear(db), ctxNow + dtCtx)
    }
  }

  /**
   * Schedule equal-power crossfade on overlapping same-track clips.
   * `incumbent` is already active when `newcomer` becomes active and they
   * share a track — fade incumbent via cos, newcomer via sin, over the
   * overlap interval `[overlapStart, overlapEnd]`.
   */
  const scheduleCrossfade = (
    incumbent: ClipNode,
    newcomer: ClipNode,
    playhead: number,
  ): void => {
    if (!audioCtx || !incumbent.crossfadeGain || !newcomer.crossfadeGain) return
    const overlapStart = Math.max(incumbent.clip.start_time, newcomer.clip.start_time)
    const overlapEnd = Math.min(incumbent.clip.end_time, newcomer.clip.end_time)
    const duration = Math.max(0, overlapEnd - overlapStart)
    if (duration <= 0) return
    const ctxNow = audioCtx.currentTime
    const fadeStartCtx = ctxNow + Math.max(0, overlapStart - playhead)
    incumbent.crossfadeGain.gain.cancelScheduledValues(ctxNow)
    newcomer.crossfadeGain.gain.cancelScheduledValues(ctxNow)
    incumbent.crossfadeGain.gain.setValueCurveAtTime(COS_CURVE, fadeStartCtx, duration)
    newcomer.crossfadeGain.gain.setValueCurveAtTime(SIN_CURVE, fadeStartCtx, duration)
  }

  const findOverlappingActiveClips = (trackNode: TrackNode, target: ClipNode): ClipNode[] => {
    const overlap: ClipNode[] = []
    for (const other of trackNode.clips.values()) {
      if (other === target || !other.active) continue
      const start = Math.max(target.clip.start_time, other.clip.start_time)
      const end = Math.min(target.clip.end_time, other.clip.end_time)
      if (end > start) overlap.push(other)
    }
    return overlap
  }

  const findTrackNodeFor = (clipNode: ClipNode): TrackNode | null => {
    for (const t of trackMap.values()) {
      for (const c of t.clips.values()) if (c === clipNode) return t
    }
    return null
  }

  const activateClip = (clipNode: ClipNode, playhead: number): void => {
    if (!clipNode.audio) return
    const { start_time } = clipNode.clip
    const rate = clipNode.clip.playback_rate ?? 1
    const effOffset = clipNode.clip.effective_source_offset ?? clipNode.clip.source_offset
    const sourcePosition = Math.max(0, effOffset + (playhead - start_time) * rate)

    // playbackRate drives linear time remap on linked clips.
    // preservesPitch keeps dialogue natural at non-unity rates.
    try {
      clipNode.audio.playbackRate = rate
      // preservesPitch is widely supported but not in older TS lib types
      ;(clipNode.audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true
    } catch { /* older browser — ignore */ }

    try {
      clipNode.audio.currentTime = sourcePosition
    } catch { /* readyState may not allow — retry on loadedmetadata */ }

    // Reset crossfade gain before any new schedule lands
    if (clipNode.crossfadeGain && audioCtx) {
      clipNode.crossfadeGain.gain.cancelScheduledValues(audioCtx.currentTime)
      clipNode.crossfadeGain.gain.setValueAtTime(1, audioCtx.currentTime)
    }

    scheduleClipCurve(clipNode, playhead)

    // Equal-power crossfade against any currently-active clips on the same track
    const trackNode = findTrackNodeFor(clipNode)
    if (trackNode) {
      for (const incumbent of findOverlappingActiveClips(trackNode, clipNode)) {
        scheduleCrossfade(incumbent, clipNode, playhead)
      }
    }

    if (isPlaying) {
      clipNode.audio.play().catch(() => {
        // NotAllowedError / AbortError — swallow
      })
    }
    clipNode.active = true
  }

  const deactivateClip = (clipNode: ClipNode): void => {
    if (clipNode.audio) {
      try { clipNode.audio.pause() } catch { /* ignore */ }
    }
    if (clipNode.clipGain && audioCtx) {
      clipNode.clipGain.gain.cancelScheduledValues(audioCtx.currentTime)
    }
    if (clipNode.crossfadeGain && audioCtx) {
      clipNode.crossfadeGain.gain.cancelScheduledValues(audioCtx.currentTime)
      clipNode.crossfadeGain.gain.setValueAtTime(1, audioCtx.currentTime)
    }
    clipNode.active = false
  }

  const reevaluateClips = (playhead: number, hardSeek: boolean): void => {
    for (const trackNode of trackMap.values()) {
      for (const clipNode of trackNode.clips.values()) {
        const { start_time, end_time, source_offset } = clipNode.clip
        const effOffset = clipNode.clip.effective_source_offset ?? source_offset
        const rate = clipNode.clip.playback_rate ?? 1
        const inside = playhead >= start_time && playhead < end_time
        if (inside && !clipNode.active) {
          activateClip(clipNode, playhead)
        } else if (!inside && clipNode.active) {
          deactivateClip(clipNode)
        } else if (inside && clipNode.active && clipNode.audio) {
          // Already marked active. On a hard seek (scrub / jump), resync the
          // <audio> element's currentTime to honor the new playhead. During
          // normal frame-by-frame playback (hardSeek=false), leave the
          // streaming position alone to avoid audible hiccups.
          if (hardSeek) {
            const sourcePosition = Math.max(0, effOffset + (playhead - start_time) * rate)
            try { clipNode.audio.currentTime = sourcePosition } catch { /* ignore */ }
          }
          if (isPlaying && clipNode.audio.paused) {
            clipNode.audio.play().catch(() => { /* NotAllowedError — swallow */ })
          }
        }
      }
    }
  }

  const scheduleAllTrackCurves = (playhead: number): void => {
    for (const t of trackMap.values()) scheduleTrackCurve(t, playhead)
  }

  return {
    get trackCount() { return trackMap.size },

    play() {
      if (disposed) return
      isPlaying = true
      ensureGraph()
      scheduleAllTrackCurves(lastPlayhead)
      // Activate any clips already inside the playhead window. Force
      // currentTime resync — user pressed play expecting audio to start AT
      // the playhead, not from whatever position the <audio> element last
      // paused at.
      reevaluateClips(lastPlayhead, /* hardSeek */ true)
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
      const crossedLargeGap = Math.abs(seconds - lastPlayhead) > 0.05
      lastPlayhead = seconds
      if (!audioCtx) return
      // On a real seek (user scrubbing the playhead, not just a per-frame
      // tick), reschedule track curves and hard-resync each active clip's
      // <audio> element so it honors the new playhead. Small forward ticks
      // leave streaming position alone to avoid hiccups.
      if (crossedLargeGap) scheduleAllTrackCurves(seconds)
      reevaluateClips(seconds, /* hardSeek */ crossedLargeGap)
    },

    updateClip(clipId: string) {
      if (disposed) return
      for (const trackNode of trackMap.values()) {
        const clipNode = trackNode.clips.get(clipId)
        if (!clipNode) continue
        // Re-schedule this clip's curve + mute in place if it's active
        if (clipNode.active) scheduleClipCurve(clipNode, lastPlayhead)
        else if (clipNode.clipGain && audioCtx) {
          // For inactive clips, still apply mute so the next activation starts correct
          const ctxNow = audioCtx.currentTime
          clipNode.clipGain.gain.cancelScheduledValues(ctxNow)
          clipNode.clipGain.gain.setValueAtTime(clipNode.clip.muted ? 0 : 1, ctxNow)
        }
        log(`updateClip(${clipId})`)
        return
      }
    },

    updateTrack(trackId: string) {
      if (disposed) return
      const trackNode = trackMap.get(trackId)
      if (!trackNode) return
      // Toggling solo on any track changes the effective-mute of every other
      // track, so we always reschedule ALL track curves here. O(N_tracks)
      // is trivial; this keeps solo behavior correct without tracking which
      // field changed.
      for (const tn of trackMap.values()) scheduleTrackCurve(tn, lastPlayhead)
      log(`updateTrack(${trackId})`)
    },

    rebuild(nextTracks: AudioTrack[]) {
      if (disposed) return
      populateFromTracks(nextTracks)
      if (audioCtx) {
        ensureGraph()
        // Graph was torn down + re-built; any clip that was active before
        // rebuild is now at `active: false` with a fresh HTMLAudioElement.
        // Re-schedule track curves and re-activate the clips that sit under
        // the current playhead so mid-playback rebuilds (triggered by
        // refreshTimeline() after drags / trims / align-apply / etc.) don't
        // silently drop audio that should keep playing.
        scheduleAllTrackCurves(lastPlayhead)
        reevaluateClips(lastPlayhead, /* hardSeek */ true)
      }
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
