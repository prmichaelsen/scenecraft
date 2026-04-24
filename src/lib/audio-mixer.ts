/**
 * Real-time WebAudio mixer for the Timeline (M14 + M15 task 1).
 *
 * M15 migrates playback from `HTMLAudioElement` + `MediaElementAudioSourceNode`
 * to `AudioBufferSourceNode`. This is a prerequisite for offline rendering
 * (M15 task 2) because `OfflineAudioContext` cannot consume media-element
 * sources. The live graph must mirror whatever the offline renderer will use,
 * so both paths share a single source-node topology.
 *
 * Key properties of the new path:
 *  - Audio is fetched once and decoded to an `AudioBuffer`, then cached
 *    module-wide keyed by `source_path` so re-adding a clip (undo/redo, drag)
 *    does not re-decode.
 *  - `AudioBufferSourceNode` is SINGLE-USE: every start()/stop() cycle
 *    requires a fresh node. On seek/pause/resume we throw away the old node
 *    and build a new one from the cached buffer.
 *  - Scheduling is done on the AudioContext clock via
 *    `source.start(when, offset, duration)`, where `when` is derived from
 *    the playhead and `ctx.currentTime`. No more `.currentTime` tweaking.
 *  - Volume curves, analyser taps, master bus — unchanged. Those talk to
 *    `AudioNode` interfaces; the swap is upstream of them.
 *
 * Decode cache: MVP has no eviction. We track a simple counter + size in
 * debug logs. LRU eviction is deferred to a follow-up milestone.
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
  /** Jump the playhead; activate/deactivate clips. When `isPlaying`, also starts fresh source nodes. */
  seek(seconds: number): void
  /** A specific clip's data changed. Re-read + re-schedule if active. */
  updateClip(clipId: string): void
  /** A specific track's data changed (curve, muted, enabled). */
  updateTrack(trackId: string): void
  /** Full track list changed (add/remove/reorder). Rebuild graph from scratch. */
  rebuild(tracks: AudioTrack[]): void
  /** Per-track L/R AnalyserNode taps for stereo level metering. */
  getTrackAnalysers(trackId: string): { left: AnalyserNode; right: AnalyserNode } | null
  /** Master-bus stereo analyser taps. */
  getMasterAnalysers(): { left: AnalyserNode; right: AnalyserNode } | null
  /** Tear down all nodes; close AudioContext. */
  dispose(): void
}

/** Factory options. Used for test injection. */
export type AudioMixerOptions = {
  /** Override for tests / non-browser environments. Default: `new AudioContext({ latencyHint: 'playback' })`. */
  audioCtxFactory?: () => AudioContext
  /** Override for URL building in tests. Default: `scenecraftFileUrl(projectName, sourcePath)`. */
  sourceUrlFactory?: (projectName: string, sourcePath: string) => string
  /**
   * Override for fetching raw audio bytes. Default uses `fetch(url).arrayBuffer()`.
   * Tests can return pre-built buffers synchronously via a resolved promise.
   */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>
  /**
   * Override for decoding. Default delegates to `AudioContext.decodeAudioData`.
   * Tests can return a mock AudioBuffer. The mixer never inspects the buffer's
   * contents — only its identity and `.duration` matter at runtime.
   */
  decode?: (ctx: AudioContext, bytes: ArrayBuffer) => Promise<AudioBuffer>
}

type ClipNode = {
  clip: AudioClip
  /** Decoded audio buffer. Shared via the module-level cache keyed by source_path. */
  buffer: AudioBuffer | null
  /** Active buffer source node. Single-use; replaced on every start/stop cycle. */
  source: AudioBufferSourceNode | null
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
  /** L/R passive analyser taps post-trackGain, pre-master. */
  analyserL: AnalyserNode | null
  analyserR: AnalyserNode | null
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

const DEFAULT_FETCH_BYTES = async (url: string): Promise<ArrayBuffer> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`audio fetch ${url} → ${res.status}`)
  return res.arrayBuffer()
}

const DEFAULT_DECODE = (ctx: AudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> =>
  ctx.decodeAudioData(bytes)

/**
 * Module-level decode cache. Survives individual mixer instance disposal,
 * which is what we want: re-opening a project shouldn't force a re-decode.
 * MVP has no eviction — a long session on a large project will accumulate
 * AudioBuffers. LRU is a follow-up. The `size()` helper below powers the
 * debug log on each new decode.
 */
const decodeCache = new Map<string, AudioBuffer>()

/** Debug-only counters so developers can gauge cache pressure. */
const decodeStats = { decodes: 0, hits: 0 }

export function createAudioMixer(
  projectName: string,
  tracks: AudioTrack[],
  options: AudioMixerOptions = {},
): AudioMixer {
  const audioCtxFactory = options.audioCtxFactory ?? DEFAULT_AUDIO_CTX_FACTORY
  const sourceUrlFactory = options.sourceUrlFactory ?? scenecraftFileUrl
  const fetchBytes = options.fetchBytes ?? DEFAULT_FETCH_BYTES
  const decode = options.decode ?? DEFAULT_DECODE

  let audioCtx: AudioContext | null = null
  const trackMap = new Map<string, TrackNode>()
  /** In-flight decode promises so concurrent activations of the same clip
   *  don't fire duplicate fetches. Keyed by source_path. Resolves to the
   *  decoded buffer (also written into decodeCache). */
  const pendingDecodes = new Map<string, Promise<AudioBuffer>>()

  // Master bus — every track's trackGain feeds into masterGain, which feeds
  // both a stereo L/R analyser pair (for the transport-bar level meter) and
  // the destination.
  let masterGain: GainNode | null = null
  let masterSplitter: ChannelSplitterNode | null = null
  let masterAnalyserL: AnalyserNode | null = null
  let masterAnalyserR: AnalyserNode | null = null
  let isPlaying = false
  let lastPlayhead = 0
  let disposed = false

  const ANALYSER_FFT_SIZE = 1024

  const log = (msg: string): void => {
    if (typeof console !== 'undefined') console.debug(`[audio-mixer] ${msg}`)
  }

  /** Build a {left,right} pair of analysers fed from `source`. */
  const buildStereoAnalyserPair = (ctx: AudioContext, source: AudioNode): {
    splitter: ChannelSplitterNode
    left: AnalyserNode
    right: AnalyserNode
  } => {
    const splitter = ctx.createChannelSplitter(2)
    const left = ctx.createAnalyser()
    const right = ctx.createAnalyser()
    left.fftSize = ANALYSER_FFT_SIZE
    right.fftSize = ANALYSER_FFT_SIZE
    left.smoothingTimeConstant = 0
    right.smoothingTimeConstant = 0
    source.connect(splitter)
    splitter.connect(left, 0)
    splitter.connect(right, 1)
    return { splitter, left, right }
  }

  const ensureMasterGraph = (ctx: AudioContext): void => {
    if (masterGain) return
    masterGain = ctx.createGain()
    masterGain.gain.value = 1
    masterGain.channelCount = 2
    masterGain.channelCountMode = 'explicit'
    masterGain.channelInterpretation = 'speakers'
    const pair = buildStereoAnalyserPair(ctx, masterGain)
    masterSplitter = pair.splitter
    masterAnalyserL = pair.left
    masterAnalyserR = pair.right
    masterGain.connect(ctx.destination)
  }

  const ensureCtx = (): AudioContext => {
    if (!audioCtx) audioCtx = audioCtxFactory()
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {})
    }
    return audioCtx
  }

  /**
   * Kick off decode for a clip's source_path if not already cached / pending.
   * Returns the buffer promise. Callers set `clipNode.buffer` on resolution.
   */
  const decodeClipBuffer = (ctx: AudioContext, clipNode: ClipNode): Promise<AudioBuffer> => {
    const key = clipNode.clip.source_path
    const cached = decodeCache.get(key)
    if (cached) {
      decodeStats.hits++
      clipNode.buffer = cached
      return Promise.resolve(cached)
    }
    const existing = pendingDecodes.get(key)
    if (existing) return existing.then((buf) => { clipNode.buffer = buf; return buf })

    const url = sourceUrlFactory(projectName, clipNode.clip.source_path)
    const p = (async () => {
      const bytes = await fetchBytes(url)
      const buf = await decode(ctx, bytes)
      decodeCache.set(key, buf)
      decodeStats.decodes++
      log(`decoded ${key} — cache: ${decodeCache.size} buffers, ${decodeStats.decodes} total decodes, ${decodeStats.hits} hits`)
      return buf
    })()
    pendingDecodes.set(key, p)
    p.finally(() => pendingDecodes.delete(key))
    return p.then((buf) => { clipNode.buffer = buf; return buf })
  }

  /** Build the persistent per-clip chain (gains). Source node is built later,
   *  per activation. Connects into the track's gain if already present. */
  const buildClipGraph = (ctx: AudioContext, trackNode: TrackNode, clipNode: ClipNode): void => {
    if (clipNode.clipGain) return
    const clipGain = ctx.createGain()
    const crossfadeGain = ctx.createGain()
    clipGain.gain.value = clipNode.clip.muted ? 0 : 1
    crossfadeGain.gain.value = 1
    clipGain.connect(crossfadeGain)
    if (trackNode.trackGain) crossfadeGain.connect(trackNode.trackGain)
    clipNode.clipGain = clipGain
    clipNode.crossfadeGain = crossfadeGain

    // Kick off decode in the background. Fire-and-forget: activation either
    // finds the buffer already there, or awaits its own resolution.
    decodeClipBuffer(ctx, clipNode).catch((err) => {
      log(`decode failed for ${clipNode.clip.source_path}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const isTrackEffectivelyMuted = (trackNode: TrackNode): boolean => {
    if (trackNode.track.muted) return true
    const anySolo = [...trackMap.values()].some((tn) => tn.track.solo)
    if (anySolo && !trackNode.track.solo) return true
    return false
  }

  const buildTrackGraph = (ctx: AudioContext, trackNode: TrackNode): void => {
    if (trackNode.trackGain) return
    ensureMasterGraph(ctx)
    const trackGain = ctx.createGain()
    trackGain.gain.value = isTrackEffectivelyMuted(trackNode) ? 0 : 1
    trackGain.channelCount = 2
    trackGain.channelCountMode = 'explicit'
    trackGain.channelInterpretation = 'speakers'
    const pair = buildStereoAnalyserPair(ctx, trackGain)
    trackGain.connect(masterGain!)
    trackNode.trackGain = trackGain
    trackNode.analyserL = pair.left
    trackNode.analyserR = pair.right
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

  /** Stop and release the current source node on a clip. Safe to call when
   *  no source is attached. Does NOT touch `buffer` — that stays cached. */
  const stopClipSource = (clipNode: ClipNode): void => {
    if (clipNode.source) {
      try { clipNode.source.stop() } catch { /* already stopped */ }
      try { clipNode.source.disconnect() } catch { /* ignore */ }
      clipNode.source = null
    }
  }

  const tearDownClip = (clipNode: ClipNode): void => {
    stopClipSource(clipNode)
    try { clipNode.clipGain?.disconnect() } catch { /* ignore */ }
    try { clipNode.crossfadeGain?.disconnect() } catch { /* ignore */ }
    clipNode.clipGain = null
    clipNode.crossfadeGain = null
    // `buffer` ref is cleared too — the module-level cache still owns it,
    // so re-adding this clip will hit the cache and re-assign.
    clipNode.buffer = null
    clipNode.active = false
  }

  const tearDownTrack = (trackNode: TrackNode): void => {
    for (const clipNode of trackNode.clips.values()) tearDownClip(clipNode)
    try { trackNode.trackGain?.disconnect() } catch { /* ignore */ }
    try { trackNode.analyserL?.disconnect() } catch { /* ignore */ }
    try { trackNode.analyserR?.disconnect() } catch { /* ignore */ }
    trackNode.trackGain = null
    trackNode.analyserL = null
    trackNode.analyserR = null
  }

  const populateFromTracks = (nextTracks: AudioTrack[]): void => {
    for (const trackNode of trackMap.values()) tearDownTrack(trackNode)
    trackMap.clear()
    for (const t of nextTracks) {
      const trackNode: TrackNode = { track: t, trackGain: null, analyserL: null, analyserR: null, clips: new Map() }
      for (const c of (t.clips ?? [])) {
        trackNode.clips.set(c.id, {
          clip: c,
          buffer: null,
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

  /**
   * Activate a clip at the current playhead. Constructs a FRESH
   * AudioBufferSourceNode (they're single-use), wires it to the existing
   * clipGain → crossfadeGain → trackGain chain, and schedules start() at
   * an AudioContext time aligned with the playhead.
   *
   * If the buffer isn't decoded yet, schedules itself to run once the decode
   * resolves. `isPlaying` is re-checked at that time in case the user paused
   * while the decode was in flight.
   */
  const activateClip = (clipNode: ClipNode, playhead: number): void => {
    if (!audioCtx || !clipNode.clipGain) return

    // No buffer yet → wait for decode. The closure re-checks state on resolve.
    if (!clipNode.buffer) {
      decodeClipBuffer(audioCtx, clipNode).then(() => {
        if (disposed) return
        // State may have moved on. Only finish activation if we're still
        // inside the clip window at the current playhead.
        const insideNow = lastPlayhead >= clipNode.clip.start_time && lastPlayhead < clipNode.clip.end_time
        if (insideNow && !clipNode.active) activateClip(clipNode, lastPlayhead)
      }).catch(() => { /* logged in decode path */ })
      return
    }

    // Tear down any previous source (e.g. mid-playback updateClip path).
    stopClipSource(clipNode)

    const ctx = audioCtx
    const { start_time, end_time } = clipNode.clip
    const rate = clipNode.clip.playback_rate ?? 1
    const effOffset = clipNode.clip.effective_source_offset ?? clipNode.clip.source_offset
    const sourcePosition = Math.max(0, effOffset + (playhead - start_time) * rate)
    const remainingTimeline = Math.max(0, end_time - Math.max(playhead, start_time))
    // duration is in source-time, not timeline time, so scale by rate
    const durationSource = remainingTimeline * rate

    const src = ctx.createBufferSource()
    src.buffer = clipNode.buffer
    try {
      src.playbackRate.value = rate
      // `detune` could be used to mimic preservesPitch, but WebAudio's
      // BufferSourceNode has no native pitch-preservation. For the common
      // video-link case rate is near 1.0 so pitch drift is minimal.
      // TODO(M15 task N): wire a soundtouch/phase-vocoder shim if users
      // report unacceptable dialogue pitch on extreme remaps.
    } catch { /* older engines */ }

    src.connect(clipNode.clipGain)

    // Crossfade starts at 1 for an activation without overlap; crossfades
    // override this for same-track overlapping clips.
    if (clipNode.crossfadeGain) {
      clipNode.crossfadeGain.gain.cancelScheduledValues(ctx.currentTime)
      clipNode.crossfadeGain.gain.setValueAtTime(1, ctx.currentTime)
    }

    scheduleClipCurve(clipNode, playhead)

    const trackNode = findTrackNodeFor(clipNode)
    if (trackNode) {
      for (const incumbent of findOverlappingActiveClips(trackNode, clipNode)) {
        scheduleCrossfade(incumbent, clipNode, playhead)
      }
    }

    if (isPlaying) {
      // Schedule at the AudioContext clock. If playhead is before clip start
      // (activation ahead of time), delay start; otherwise play immediately
      // from mid-clip.
      const whenDelta = Math.max(0, start_time - playhead)
      const when = ctx.currentTime + whenDelta
      try {
        // `start(when, offset, duration)` — omit `duration` when the buffer
        // naturally ends first (source_offset + durationSource > buffer.duration).
        // The browser handles clamping. We still pass durationSource so the
        // node self-stops at the clip's end_time, sparing us a manual stop().
        const bufDur = clipNode.buffer.duration
        const effectiveDuration = Math.min(durationSource, Math.max(0, bufDur - sourcePosition))
        if (effectiveDuration > 0) {
          src.start(when, sourcePosition, effectiveDuration)
        } else {
          // Clip window is entirely past the end of the buffer — no-op.
        }
      } catch (err) {
        log(`start() failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    clipNode.source = src
    clipNode.active = true
  }

  const deactivateClip = (clipNode: ClipNode): void => {
    stopClipSource(clipNode)
    if (clipNode.clipGain && audioCtx) {
      clipNode.clipGain.gain.cancelScheduledValues(audioCtx.currentTime)
    }
    if (clipNode.crossfadeGain && audioCtx) {
      clipNode.crossfadeGain.gain.cancelScheduledValues(audioCtx.currentTime)
      clipNode.crossfadeGain.gain.setValueAtTime(1, audioCtx.currentTime)
    }
    clipNode.active = false
  }

  /**
   * Reconcile active/inactive state across all clips relative to `playhead`.
   * `hardSeek` means the user actually jumped the playhead — tear down and
   * rebuild any currently-active source nodes so they restart from the new
   * offset. For normal frame-by-frame ticks, leave running sources alone.
   */
  const reevaluateClips = (playhead: number, hardSeek: boolean): void => {
    for (const trackNode of trackMap.values()) {
      for (const clipNode of trackNode.clips.values()) {
        const { start_time, end_time } = clipNode.clip
        const inside = playhead >= start_time && playhead < end_time
        if (inside && !clipNode.active) {
          activateClip(clipNode, playhead)
        } else if (!inside && clipNode.active) {
          deactivateClip(clipNode)
        } else if (inside && clipNode.active && hardSeek) {
          // User scrubbed within the clip's window — single-use BufferSource
          // can't seek, so tear down and rebuild at the new offset.
          deactivateClip(clipNode)
          activateClip(clipNode, playhead)
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
      // Any currently-"active" clip nodes were paused mid-clip — they have
      // no live source. Treat play() as a hard seek so those get
      // reconstructed. hardSeek=true also triggers activate for clips that
      // weren't active yet.
      reevaluateClips(lastPlayhead, /* hardSeek */ true)
      log(`play() @${lastPlayhead.toFixed(3)}s`)
    },

    pause() {
      if (disposed) return
      isPlaying = false
      for (const trackNode of trackMap.values()) {
        for (const clipNode of trackNode.clips.values()) {
          if (clipNode.active) {
            stopClipSource(clipNode)
            // Leave `active = true` so the play() → reevaluate with hardSeek
            // knows to restart it. Actually no — that's fragile. Set to
            // false; play() treats any inside-clip as needing activation.
            clipNode.active = false
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
      if (crossedLargeGap) scheduleAllTrackCurves(seconds)
      reevaluateClips(seconds, /* hardSeek */ crossedLargeGap)
    },

    updateClip(clipId: string) {
      if (disposed) return
      for (const trackNode of trackMap.values()) {
        const clipNode = trackNode.clips.get(clipId)
        if (!clipNode) continue
        if (clipNode.active) scheduleClipCurve(clipNode, lastPlayhead)
        else if (clipNode.clipGain && audioCtx) {
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
      for (const tn of trackMap.values()) scheduleTrackCurve(tn, lastPlayhead)
      log(`updateTrack(${trackId})`)
    },

    rebuild(nextTracks: AudioTrack[]) {
      if (disposed) return
      populateFromTracks(nextTracks)
      if (audioCtx) {
        ensureGraph()
        scheduleAllTrackCurves(lastPlayhead)
        reevaluateClips(lastPlayhead, /* hardSeek */ true)
      }
      log(`rebuild(${nextTracks.length} tracks)`)
    },

    getTrackAnalysers(trackId: string) {
      const tn = trackMap.get(trackId)
      if (!tn?.analyserL || !tn.analyserR) return null
      return { left: tn.analyserL, right: tn.analyserR }
    },

    getMasterAnalysers() {
      if (!masterAnalyserL || !masterAnalyserR) return null
      return { left: masterAnalyserL, right: masterAnalyserR }
    },

    dispose() {
      if (disposed) return
      disposed = true
      isPlaying = false
      for (const trackNode of trackMap.values()) tearDownTrack(trackNode)
      trackMap.clear()
      try { masterGain?.disconnect() } catch { /* ignore */ }
      try { masterSplitter?.disconnect() } catch { /* ignore */ }
      try { masterAnalyserL?.disconnect() } catch { /* ignore */ }
      try { masterAnalyserR?.disconnect() } catch { /* ignore */ }
      masterGain = null
      masterSplitter = null
      masterAnalyserL = null
      masterAnalyserR = null
      if (audioCtx) {
        try { audioCtx.close() } catch { /* ignore */ }
        audioCtx = null
      }
    },
  }
}

/**
 * Test / debug helper: clear the module-level decode cache. Production code
 * should never call this — the cache is intentionally process-wide so that
 * swapping mixer instances (project switch, HMR) doesn't cost another decode.
 */
export function __clearDecodeCacheForTest(): void {
  decodeCache.clear()
  decodeStats.decodes = 0
  decodeStats.hits = 0
}
