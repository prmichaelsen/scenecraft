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
  buildEffectChain,
  isTrackEffectivelyMuted,
  scheduleClipCurveOnParam,
  scheduleCrossfadeOnParams,
  scheduleTrackCurveOnParam,
} from './mix-graph'
import type { TrackEffect } from './audio-graph'

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
  /**
   * Master-bus effects. Wired in serial between the summed `masterGain` and
   * the offline destination — identical topology to the live mixer, so the
   * fidelity test stays bit-identical. Empty / omitted means no master fx.
   */
  masterEffects?: readonly TrackEffect[]
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
  const masterEffects = options.masterEffects ?? []

  const durationS = endTimeS - startTimeS
  const frames = Math.ceil(durationS * sampleRate)

  const ctx = offlineCtxFactory({ numberOfChannels: channels, length: frames, sampleRate })

  // Master bus — no analysers needed offline, but the fx chain matches live
  // topology so the two paths stay bit-identical. Empty masterEffects
  // produces a passthrough chain (two plain GainNodes at unity).
  const masterGain = ctx.createGain()
  masterGain.gain.value = 1
  const masterFxChain = buildEffectChain(ctx, masterEffects)
  masterGain.connect(masterFxChain.input)
  masterFxChain.output.connect(ctx.destination)

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
 * Supported WAV output bit depths.
 *
 *   16  — int16 PCM        (wFormatTag 0x0001)
 *   24  — int24 PCM        (wFormatTag 0x0001, 3 bytes/sample LE)
 *   32  — IEEE-754 float   (wFormatTag 0x0003, no quantization)
 *
 * 16-bit is the default so the existing `mix_render_request` path — which
 * calls `encodePCMToWav(pcm, sr, ch)` without the bit-depth arg — keeps its
 * byte-for-byte output. The 24/32 paths are used by the M-bounce-audio
 * `handleBounceAudioRequest` handler, where the chat agent picks the target
 * format.
 *
 * TODO (follow-up): when bouncing 24→16 from a chat prompt, dithering would
 * reduce quantization noise below the LSB. For now we quantize with plain
 * round-to-nearest; the artifact is inaudible on music content at -60 dBFS+.
 */
export type WavBitDepth = 16 | 24 | 32

/**
 * Encode interleaved float PCM as a WAV file (RIFF / WAVE) at the requested
 * bit depth. 16-bit is the default — matches the original signature used by
 * the mix-render round-trip.
 *
 * All three formats share the canonical 44-byte header layout:
 *
 *     Offset  Len  Description
 *        0     4   'RIFF'
 *        4     4   chunk size (fileSize - 8)
 *        8     4   'WAVE'
 *       12     4   'fmt '
 *       16     4   16 (sub-chunk size; we never emit extension chunks)
 *       20     2   wFormatTag — 0x0001 PCM or 0x0003 IEEE-float
 *       22     2   channels
 *       24     4   sample rate
 *       28     4   byte rate = sampleRate * channels * (bitDepth/8)
 *       32     2   block align = channels * (bitDepth/8)
 *       34     2   bits per sample = 16 | 24 | 32
 *       36     4   'data'
 *       40     4   data size = numSamples * (bitDepth/8)
 *       44     N   samples, LE, interleaved
 *
 * Compatible with Python's `wave` stdlib (16/24 PCM) and `soundfile`
 * (all three). The 24-bit path writes 3 bytes/sample packed little-endian
 * as required by the WAVE spec; 32-float writes raw IEEE-754 LE floats.
 */
export function encodePCMToWav(
  pcm: Float32Array,
  sampleRate: number,
  channels: number,
  bitDepth: WavBitDepth = 16,
): ArrayBuffer {
  if (channels !== 1 && channels !== 2) {
    throw new Error(`encodePCMToWav: channels must be 1 or 2, got ${channels}`)
  }
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) {
    throw new Error(`encodePCMToWav: bitDepth must be 16, 24, or 32, got ${bitDepth}`)
  }
  const bytesPerSample = bitDepth / 8
  const formatTag = bitDepth === 32 ? 0x0003 : 0x0001 // 0x0003 = IEEE_FLOAT
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
  writeUint32(16) // fmt chunk size
  writeUint16(formatTag)
  writeUint16(channels)
  writeUint32(sampleRate)
  writeUint32(sampleRate * channels * bytesPerSample) // byte rate
  writeUint16(channels * bytesPerSample) // block align
  writeUint16(bitDepth)

  // data subchunk
  writeString('data')
  writeUint32(dataSize)

  // Sample data.
  if (bitDepth === 16) {
    // int16 PCM, clip → quantize → LE.
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]))
      // Symmetric range uses 32767; Python's `wave` reader accepts it.
      const q = Math.round(s * 32767)
      view.setInt16(p, q, /* LE */ true)
      p += 2
    }
  } else if (bitDepth === 24) {
    // int24 PCM, packed 3 bytes LE (lowest byte first). DataView has no
    // setInt24, so we hand-pack each sample after clamping.
    const MAX_INT24 = 8388607 // 2^23 - 1
    const MIN_INT24 = -8388608 // -2^23
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]))
      let q = Math.round(s * MAX_INT24)
      if (q > MAX_INT24) q = MAX_INT24
      else if (q < MIN_INT24) q = MIN_INT24
      // Two's-complement 24-bit: negative values wrap into 0x800000..0xFFFFFF.
      const u = q < 0 ? q + 0x1000000 : q
      view.setUint8(p, u & 0xff)
      view.setUint8(p + 1, (u >> 8) & 0xff)
      view.setUint8(p + 2, (u >> 16) & 0xff)
      p += 3
    }
  } else {
    // 32-bit IEEE-754 float, raw (no quantization, no clipping).
    for (let i = 0; i < numSamples; i++) {
      view.setFloat32(p, pcm[i], /* LE */ true)
      p += 4
    }
  }

  return buf
}
