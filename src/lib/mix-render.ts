/**
 * Offline mix renderer (M15 task 2).
 *
 * Produces PCM for a range of the timeline by building the SAME WebAudio
 * graph that the live mixer uses (`audio-mixer.ts`), but on an
 * `OfflineAudioContext`. This is the primitive that powers "Render Mix" —
 * the frontend sends the rendered WAV to the backend, which decides where
 * (the project pool, the chat, a subclip, etc.) the result lands.
 *
 * **Bit-identical parity with live playback is the north-star property**:
 *   live and offline share `mix-graph.ts` for crossfade curves, db-to-linear
 *   math, per-clip curve scheduling, per-track curve scheduling, and the
 *   solo/mute rules. The two builders wire the same topology:
 *
 *     source → clipGain → crossfadeGain → trackGain → masterGain → dest
 *
 * What's intentionally absent in the offline path:
 *   - Analyser taps (visualisation only; don't affect audio).
 *   - Lazy decode / activation bookkeeping (offline pre-schedules everything
 *     inside `startRendering()`).
 *
 * Clip window scheduling:
 *   For each clip that intersects `[startTimeS, endTimeS)`:
 *     - `whenInOffline   = max(0, clip.start_time - startTimeS)`
 *     - `sourceOffset    = effective_source_offset + max(0, startTimeS - clip.start_time) * rate`
 *     - `tlStart         = max(clip.start_time, startTimeS)`
 *     - `tlEnd           = min(clip.end_time,   endTimeS)`
 *     - `timelineDur     = tlEnd - tlStart`   (seconds of timeline covered)
 *     - `durationSource  = timelineDur * rate`  (how much source to read,
 *                                               since playbackRate scales read-speed)
 *
 * Curve anchor: the offline clock starts at 0 corresponding to
 * `startTimeS` on the timeline. So every curve `xSec` value is scheduled at
 * `xSec - startTimeS` on the offline clock. `paramAnchorTime = 0` on all
 * param scheduling calls — the shared scheduler in `mix-graph.ts` handles
 * this by receiving `playhead = startTimeS` and adding `(xSec - playhead)`.
 */

import type { AudioClip, AudioTrack } from './audio-client'
import { scenecraftFileUrl } from './scenecraft-client'
import {
  isTrackEffectivelyMuted,
  scheduleClipCurveOnParam,
  scheduleCrossfadeOnParams,
  scheduleTrackCurveOnParam,
} from './mix-graph'

// ── Public API ────────────────────────────────────────────────────────────

export interface MixRenderOptions {
  /** Timeline start (seconds). Clips ending at or before this are skipped. */
  startTimeS: number
  /** Timeline end (seconds, exclusive). Clips starting at or after this are skipped. */
  endTimeS: number
  /** Sample rate of the offline context (default 48000). */
  sampleRate?: number
  /** Channel count — 1 or 2 (default 2 / stereo). */
  channels?: number
  /** Project name; passed to `sourceUrlFactory` when fetching clips. */
  projectName: string

  // ── Test / injection hooks ──────────────────────────────────────────────
  /** Override the OfflineAudioContext constructor. */
  offlineCtxFactory?: (init: { numberOfChannels: number; length: number; sampleRate: number }) => OfflineAudioContext
  /** Override URL building (default: scenecraftFileUrl). */
  sourceUrlFactory?: (projectName: string, sourcePath: string) => string
  /** Override raw bytes fetch. */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>
  /** Override decode. */
  decode?: (ctx: BaseAudioContext, bytes: ArrayBuffer) => Promise<AudioBuffer>
  /**
   * Seed the decode cache with already-decoded buffers keyed by `source_path`.
   * The live mixer shares a process-wide decode cache; in production we pass
   * that cache in here so offline render never needs to re-fetch or re-decode
   * audio that the user has already been listening to.
   */
  bufferCache?: Map<string, AudioBuffer>
}

export interface MixRenderResult {
  /** Interleaved PCM. If stereo, `[L0, R0, L1, R1, ...]`; mono is `[S0, S1, ...]`. */
  pcm: Float32Array
  /** Channel count (1 or 2). */
  channels: number
  /** Sample rate in Hz. */
  sampleRate: number
  /** Duration in seconds = `endTimeS - startTimeS` (rounded to the context's frame count). */
  durationSeconds: number
}

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_SAMPLE_RATE = 48000
const DEFAULT_CHANNELS = 2

const DEFAULT_OFFLINE_CTX_FACTORY = (init: {
  numberOfChannels: number
  length: number
  sampleRate: number
}): OfflineAudioContext => new OfflineAudioContext(init)

const DEFAULT_FETCH_BYTES = async (url: string): Promise<ArrayBuffer> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`audio fetch ${url} → ${res.status}`)
  return res.arrayBuffer()
}

const DEFAULT_DECODE = (ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> =>
  ctx.decodeAudioData(bytes)

// ── Graph builder ─────────────────────────────────────────────────────────

/**
 * Per-clip runtime handles we need to keep around long enough to schedule
 * start/stop + curves. Once rendering begins, WebAudio owns the nodes.
 */
interface OfflineClipHandle {
  clip: AudioClip
  clipGain: GainNode
  crossfadeGain: GainNode
  source: AudioBufferSourceNode
  /** Seconds of timeline the clip covers inside the render window. */
  timelineDuration: number
  /** Wall-time (offline clock, zero-origin) at which the source starts. */
  whenInOffline: number
}

interface OfflineTrackHandle {
  track: AudioTrack
  trackGain: GainNode
  clips: OfflineClipHandle[]
}

/**
 * Fetch + decode a single clip's buffer, consulting the shared cache.
 * Returns `null` if the clip's asset is unreachable — the caller should
 * drop the clip from the schedule rather than hard-fail the render.
 */
async function resolveClipBuffer(
  ctx: BaseAudioContext,
  clip: AudioClip,
  projectName: string,
  bufferCache: Map<string, AudioBuffer>,
  sourceUrlFactory: NonNullable<MixRenderOptions['sourceUrlFactory']>,
  fetchBytes: NonNullable<MixRenderOptions['fetchBytes']>,
  decode: NonNullable<MixRenderOptions['decode']>,
): Promise<AudioBuffer | null> {
  const key = clip.source_path
  const cached = bufferCache.get(key)
  if (cached) return cached
  try {
    const url = sourceUrlFactory(projectName, key)
    const bytes = await fetchBytes(url)
    const buf = await decode(ctx, bytes)
    bufferCache.set(key, buf)
    return buf
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn(`[mix-render] skipping clip ${clip.id} — decode failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }
}

/** Clips whose `[start_time, end_time)` overlaps `[startTimeS, endTimeS)`. */
function clipsInWindow(clips: readonly AudioClip[], startTimeS: number, endTimeS: number): AudioClip[] {
  return clips.filter((c) => c.end_time > startTimeS && c.start_time < endTimeS)
}

/** Same-track overlap pairs, for crossfade scheduling. */
function findOverlaps(clips: readonly AudioClip[]): Array<[AudioClip, AudioClip]> {
  const pairs: Array<[AudioClip, AudioClip]> = []
  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      const a = clips[i]
      const b = clips[j]
      const overlapStart = Math.max(a.start_time, b.start_time)
      const overlapEnd = Math.min(a.end_time, b.end_time)
      if (overlapEnd > overlapStart) {
        // Order: incumbent (earlier start) fades out; newcomer (later start) fades in.
        if (a.start_time <= b.start_time) pairs.push([a, b])
        else pairs.push([b, a])
      }
    }
  }
  return pairs
}

// ── Main entry point ──────────────────────────────────────────────────────

export async function renderMixToBuffer(
  tracks: readonly AudioTrack[],
  options: MixRenderOptions,
): Promise<MixRenderResult> {
  const {
    startTimeS,
    endTimeS,
    sampleRate = DEFAULT_SAMPLE_RATE,
    channels = DEFAULT_CHANNELS,
    projectName,
  } = options

  if (!(endTimeS > startTimeS)) {
    throw new Error(`renderMixToBuffer: endTimeS (${endTimeS}) must be > startTimeS (${startTimeS})`)
  }
  if (channels !== 1 && channels !== 2) {
    throw new Error(`renderMixToBuffer: channels must be 1 or 2, got ${channels}`)
  }

  const offlineCtxFactory = options.offlineCtxFactory ?? DEFAULT_OFFLINE_CTX_FACTORY
  const sourceUrlFactory = options.sourceUrlFactory ?? scenecraftFileUrl
  const fetchBytes = options.fetchBytes ?? DEFAULT_FETCH_BYTES
  const decode = options.decode ?? DEFAULT_DECODE
  const bufferCache = options.bufferCache ?? new Map<string, AudioBuffer>()

  const durationS = endTimeS - startTimeS
  const frames = Math.ceil(durationS * sampleRate)

  const ctx = offlineCtxFactory({ numberOfChannels: channels, length: frames, sampleRate })

  // Master bus — no analysers needed offline.
  const masterGain = ctx.createGain()
  masterGain.gain.value = 1
  masterGain.connect(ctx.destination)

  const trackHandles: OfflineTrackHandle[] = []
  const playhead = startTimeS
  const paramAnchorTime = 0 // offline clock origin corresponds to startTimeS on the timeline

  for (const track of tracks) {
    if (track.hidden) continue
    const windowClips = clipsInWindow(track.clips ?? [], startTimeS, endTimeS)
    if (windowClips.length === 0) continue

    const trackGain = ctx.createGain()
    trackGain.channelCount = 2
    trackGain.channelCountMode = 'explicit'
    trackGain.channelInterpretation = 'speakers'
    trackGain.connect(masterGain)

    const effectivelyMuted = isTrackEffectivelyMuted(track, tracks)
    scheduleTrackCurveOnParam(
      trackGain.gain,
      track,
      playhead,
      paramAnchorTime,
      effectivelyMuted,
    )

    const clipHandles: OfflineClipHandle[] = []

    for (const clip of windowClips) {
      const buf = await resolveClipBuffer(
        ctx,
        clip,
        projectName,
        bufferCache,
        sourceUrlFactory,
        fetchBytes,
        decode,
      )
      if (!buf) continue

      // Timeline window for this clip
      const tlStart = Math.max(clip.start_time, startTimeS)
      const tlEnd = Math.min(clip.end_time, endTimeS)
      const timelineDuration = Math.max(0, tlEnd - tlStart)
      if (timelineDuration <= 0) continue

      // Offline-clock scheduling
      const whenInOffline = Math.max(0, clip.start_time - startTimeS)

      // Source-read scheduling (same formula as live mixer's activateClip)
      const rate = clip.playback_rate ?? 1
      const effOffset = clip.effective_source_offset ?? clip.source_offset
      const sourceOffset = Math.max(0, effOffset + Math.max(0, startTimeS - clip.start_time) * rate)
      const durationSource = timelineDuration * rate
      const bufDur = buf.duration
      const effectiveDuration = Math.min(durationSource, Math.max(0, bufDur - sourceOffset))
      if (effectiveDuration <= 0) continue

      const clipGain = ctx.createGain()
      const crossfadeGain = ctx.createGain()
      crossfadeGain.gain.value = 1 // overwritten below if this clip overlaps another

      const source = ctx.createBufferSource()
      source.buffer = buf
      try {
        source.playbackRate.value = rate
      } catch {
        /* older engines */
      }

      source.connect(clipGain)
      clipGain.connect(crossfadeGain)
      crossfadeGain.connect(trackGain)

      // Clip-gain curve. `playhead` is startTimeS; the shared helper will
      // emit ramp points for every curve x > playhead, mapped onto the
      // offline clock via `paramAnchorTime + (xSec - playhead)`.
      scheduleClipCurveOnParam(clipGain.gain, clip, playhead, paramAnchorTime)

      // Actually kick off playback
      try {
        source.start(whenInOffline, sourceOffset, effectiveDuration)
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn(`[mix-render] source.start() failed for clip ${clip.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
        continue
      }

      clipHandles.push({
        clip,
        clipGain,
        crossfadeGain,
        source,
        timelineDuration,
        whenInOffline,
      })
    }

    // Crossfades — same-track overlaps. Done after all clip gains are set
    // so the setValueCurveAtTime calls clobber any prior value on the
    // crossfadeGain param.
    const overlaps = findOverlaps(clipHandles.map((h) => h.clip))
    for (const [incumbentClip, newcomerClip] of overlaps) {
      const incumbent = clipHandles.find((h) => h.clip === incumbentClip)
      const newcomer = clipHandles.find((h) => h.clip === newcomerClip)
      if (!incumbent || !newcomer) continue
      scheduleCrossfadeOnParams(
        incumbent.crossfadeGain.gain,
        newcomer.crossfadeGain.gain,
        incumbent.clip,
        newcomer.clip,
        playhead,
        paramAnchorTime,
      )
    }

    trackHandles.push({ track, trackGain, clips: clipHandles })
  }

  const rendered = await ctx.startRendering()

  // Extract PCM.
  let pcm: Float32Array
  if (channels === 1) {
    // Mono: return the single channel verbatim (copy so caller can't mutate
    // the AudioBuffer's internal storage).
    const mono = rendered.numberOfChannels > 0 ? rendered.getChannelData(0) : new Float32Array(frames)
    pcm = new Float32Array(mono.length)
    pcm.set(mono)
  } else {
    // Stereo: interleave L/R. If the rendered buffer has only one channel
    // (unusual but possible if mocked), duplicate it.
    const left = rendered.getChannelData(0)
    const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left
    const n = left.length
    pcm = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      pcm[i * 2] = left[i]
      pcm[i * 2 + 1] = right[i]
    }
  }

  return {
    pcm,
    channels,
    sampleRate,
    durationSeconds: frames / sampleRate,
  }
}

// ── WAV encoder ───────────────────────────────────────────────────────────

/**
 * Encode interleaved float PCM as a 16-bit PCM WAV file (RIFF / WAVE).
 * Produces a standard WAV with a 44-byte header followed by LE int16 samples.
 * Compatible with Python's `wave` stdlib module (which the backend uses to
 * validate uploads).
 *
 *     Offset  Len  Description
 *        0     4   'RIFF'
 *        4     4   chunk size (fileSize - 8)
 *        8     4   'WAVE'
 *       12     4   'fmt '
 *       16     4   16 (sub-chunk size, for PCM)
 *       20     2   1  (audio format, PCM)
 *       22     2   channels
 *       24     4   sample rate
 *       28     4   byte rate = sampleRate * channels * 2
 *       32     2   block align = channels * 2
 *       34     2   bits per sample = 16
 *       36     4   'data'
 *       40     4   data size = numSamples * 2
 *       44     N   int16 samples, LE, interleaved
 */
export function encodePCMToWav(
  pcm: Float32Array,
  sampleRate: number,
  channels: number,
): ArrayBuffer {
  if (channels !== 1 && channels !== 2) {
    throw new Error(`encodePCMToWav: channels must be 1 or 2, got ${channels}`)
  }
  const bytesPerSample = 2
  const numSamples = pcm.length // already interleaved
  const dataSize = numSamples * bytesPerSample
  const headerSize = 44
  const fileSize = headerSize + dataSize

  const buf = new ArrayBuffer(fileSize)
  const view = new DataView(buf)

  let p = 0
  const writeString = (s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i))
  }
  const writeUint32 = (v: number): void => { view.setUint32(p, v, /* LE */ true); p += 4 }
  const writeUint16 = (v: number): void => { view.setUint16(p, v, /* LE */ true); p += 2 }

  // RIFF chunk
  writeString('RIFF')
  writeUint32(fileSize - 8)
  writeString('WAVE')

  // fmt subchunk
  writeString('fmt ')
  writeUint32(16) // PCM fmt chunk size
  writeUint16(1) // PCM
  writeUint16(channels)
  writeUint32(sampleRate)
  writeUint32(sampleRate * channels * bytesPerSample) // byte rate
  writeUint16(channels * bytesPerSample) // block align
  writeUint16(16) // bits per sample

  // data subchunk
  writeString('data')
  writeUint32(dataSize)

  // Samples — clip to [-1, 1], quantize to int16, LE.
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    // Round-to-nearest, symmetric range uses 32767 — avoids clipping at
    // the positive edge on purely positive inputs. Python's `wave` reader
    // accepts this without complaint.
    const q = Math.round(s * 32767)
    view.setInt16(p, q, /* LE */ true)
    p += 2
  }

  return buf
}
