# In-Editor Audio Streaming and Mixing

**Concept**: Real-time multi-track audio playback inside the Timeline via a WebAudio streaming mixer, mirroring the server-side mixdown.
**Created**: 2026-04-21
**Status**: Design Specification

---

## Overview

Scenecraft's server (Task 91, `audio/mixdown.py`) renders the full multi-track mix only at export time. While editing, the Timeline currently plays only the legacy single `audioFile` (beats track) via a plain `<audio>` element — users can't hear audio clips, volume curves, mute toggles, or equal-power crossfades until they export.

This document specifies an in-browser mixer that composes the same multi-track output the server renders, in real time, so editing becomes an audible loop. The design is shaped by the target use case: a 3-hour video with four audio tracks that span the full duration, and by WebAudio's actual behaviour at that scale.

---

## Problem Statement

Editing audio clips is currently blind:

- Dropping a clip, trimming it, adjusting its volume curve, toggling mute, or moving a clip across tracks has no audible feedback until a full render.
- The server mixdown exists but takes seconds-to-minutes to run; triggering it on each edit is not a viable authoring loop.
- The existing `AudioTrack` element plays one file — the beats track — and was never designed for the multi-track/multi-clip model introduced in M9.

We need an editor-side renderer that:

1. Mixes every enabled track's clips with clip volume curves, track volume curves, mute, and equal-power crossfade on same-track overlaps.
2. Tracks the playhead position, seeks instantly, and recomputes the schedule on edits without re-decoding audio.
3. Stays within browser memory limits for the worst-case project (3hr × 4 tracks, i.e. 12 hours of decoded stereo audio).
4. Produces output perceptually equivalent to the server mixdown so WYSIWYG editing holds.

---

## Solution

**Real-time WebAudio mixer, streaming via `HTMLAudioElement` + `MediaElementAudioSourceNode`.**

Rather than decoding every clip into an `AudioBuffer` up front — which is sample-accurate but blows the memory budget at our target project size — each clip gets its own `<audio>` element. The browser streams samples from disk on demand, buffering only a few seconds ahead. Each element is fed through a `MediaElementAudioSourceNode` into the WebAudio graph, where clip and track gain curves are applied via `GainNode` automation. The audio thread sums everything to the destination.

### Graph shape (per track)

```
       ┌───────────────────────────────────────┐
       │ Clip A: <audio> → MediaElementSource  │
       │  → clipGainA (curve-automated) ───┐   │
       │                                   │   │
       │ Clip B: <audio> → MediaElementSource │  (track)
       │  → clipGainB (curve-automated) ───┼──>GainNode──>(master mix)
       │                                   │   │
       │ Clip C: <audio> → MediaElementSource │
       │  → clipGainC (curve-automated) ───┘   │
       └───────────────────────────────────────┘
```

Master sum connects to `audioContext.destination`.

### Key design choices

1. **Streaming, not full decode.** At 48 kHz stereo float32, a 3-hour track decoded in memory is ~4.1 GB; four tracks ≈ 16 GB. The browser OOMs well before that. Streaming keeps memory bounded at a few tens of MB regardless of project length.
2. **WebAudio for gain, `<audio>` for samples.** `MediaElementAudioSourceNode` bridges the streaming element into the WebAudio graph so `GainNode.gain.setValueAtTime` / `linearRampToValueAtTime` still drive the dB curves at audio-thread precision.
3. **Clip scheduling is JS-driven, not sample-accurate.** Unlike `AudioBufferSourceNode.start(when)`, HTML media elements have no sample-accurate scheduler; we call `.play()` / `.pause()` + `.currentTime = …` as the playhead crosses each clip's boundary. This costs 10–30 ms of jitter at clip start (see Trade-offs).
4. **Curve evaluation reuses the same math as the server.** `scenecraft.audio.curves.evaluate_curve_db` in Python has a direct TypeScript twin that samples the curve at material points and schedules them as `AudioParam` automation events.
5. **Server mixdown remains canonical for export.** The in-editor mixer is an approximation (perceptually equivalent, not bit-identical). Export always goes through `render_project_audio` in the engine.

### What the mixer does NOT do (yet)

- **Sample-accurate stacking of short percussive hits** — fine for music beds, would need hybrid decode path for sound-design workflows (deferred).
- **Effects (EQ, compression, reverb)** — out of scope for M9; shape of the graph admits them later as per-clip or per-track insert chains.
- **Looped clips, pitched playback, time-stretch** — not in the schema today.

---

## Implementation

### Module layout

```
src/lib/audio-mixer.ts          ← the mixer module (new)
src/components/editor/
  Timeline.tsx                  ← replace legacy <AudioTrack> with useAudioMixer()
  EditorStateContext.tsx        ← (no changes; mixer is a leaf of Timeline)
```

### Public API

```typescript
export type AudioMixer = {
  /** Number of tracks currently scheduled. */
  trackCount: number
  /** Start playback from the current `currentTime`. Idempotent. */
  play(): void
  /** Pause. All playing clips stop; their currentTime is preserved. */
  pause(): void
  /** Jump the playhead. Cheap — re-evaluates which clips should be active. */
  seek(seconds: number): void
  /** A clip or track changed (curve, mute, start/end, source). Re-schedule that entity in place. */
  updateClip(clipId: string): void
  updateTrack(trackId: string): void
  /** The full track list changed (add/remove/reorder). Full rebuild. */
  rebuild(tracks: AudioTrack[]): void
  /** Tear down all audio elements + nodes. */
  dispose(): void
}

export function createAudioMixer(projectName: string, tracks: AudioTrack[]): AudioMixer
```

### Internal data

```typescript
type ClipNode = {
  clip: AudioClip
  audio: HTMLAudioElement          // src = scenecraftFileUrl(project, clip.source_path)
  source: MediaElementAudioSourceNode
  gain: GainNode                   // per-clip dB curve + clip.muted
  active: boolean                  // currently playing (playhead inside clip)
}

type TrackNode = {
  track: AudioTrack
  gain: GainNode                   // per-track dB curve + track.muted + !track.enabled
  clips: Map<string, ClipNode>
}
```

### Scheduling loop

On `play()`, the mixer starts a `requestAnimationFrame`-level poll (or uses the Timeline's existing `currentTime` subscription, which is already rAF-driven):

```typescript
function tick(now: number) {
  for (const t of trackNodes.values()) {
    for (const c of t.clips.values()) {
      const inside = now >= c.clip.start_time && now < c.clip.end_time
      if (inside && !c.active) {
        c.audio.currentTime = (now - c.clip.start_time) + c.clip.source_offset
        c.audio.play().catch(() => {})  // may reject if paused by policy; harmless
        scheduleClipCurve(c, now)
        c.active = true
      } else if (!inside && c.active) {
        c.audio.pause()
        c.active = false
      }
    }
    scheduleTrackCurve(t, now)
  }
}
```

### Curve automation

The same dB curves stored in `audio_clips.volume_curve` (normalised x) and `audio_tracks.volume_curve` (seconds x) feed into `GainNode` automation. We sample the curve at its breakpoints (plus a couple of extra points for long linear segments) and emit:

```typescript
function scheduleClipCurve(c: ClipNode, playheadAtPlayStart: number) {
  const g = c.gain.gain
  g.cancelScheduledValues(audioCtx.currentTime)
  for (const [xNorm, db] of c.clip.volume_curve) {
    const xSeconds = c.clip.start_time + xNorm * (c.clip.end_time - c.clip.start_time)
    if (xSeconds < playheadAtPlayStart) continue
    const when = audioCtx.currentTime + (xSeconds - playheadAtPlayStart)
    g.linearRampToValueAtTime(dbToLinear(db), when)
  }
  if (c.clip.muted) g.setValueAtTime(0, audioCtx.currentTime)
}
```

Track curves are the same but with absolute-seconds x — no normalisation needed.

### Equal-power crossfade on overlap

The server mixdown handles overlap by `cos`/`sin` gain pairs. Client-side, when two clips on the same track overlap over `[a, b]`, we schedule on their respective `clipGain` nodes:

```typescript
// Fade out incumbent over overlap
incumbent.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + (b - now))
incumbent.gain.gain.setValueCurveAtTime(cosCurve, audioCtx.currentTime, b - a)
// Fade in newcomer over overlap
newcomer.gain.gain.setValueCurveAtTime(sinCurve, audioCtx.currentTime + (a - now), b - a)
```

`cosCurve`/`sinCurve` are precomputed `Float32Array` samples of `cos(t·π/2)` and `sin(t·π/2)`. These multiply on top of the volume curve.

### Timeline integration

`Timeline.tsx` currently mounts a single `<AudioTrack>` that wraps an `<audio>` for `data.audioFile`. Replace with a `useAudioMixer` hook:

```typescript
const mixer = useAudioMixer(data.projectName, localAudioTracks)

useEffect(() => { isPlaying ? mixer.play() : mixer.pause() }, [isPlaying])
useEffect(() => { mixer.seek(currentTime) }, [currentTime])
useEffect(() => { mixer.rebuild(localAudioTracks) }, [localAudioTracks])
```

The legacy `AudioTrack` stays behind a settings toggle for one release (beats-only preview), then is removed.

---

## Benefits

- **Live editing loop**: curve drags, mute toggles, cross-track moves are audible within the same frame. Task 90's curve editor suddenly becomes useful.
- **Memory bounded**: ~10-50 MB regardless of project length; suitable for 3hr × 4 track workflows and well beyond.
- **No new server round-trips per edit**: all mixing happens client-side on the audio thread.
- **Shared curve semantics**: client and server evaluate the same dB-curve contract, so perceived export matches perceived preview.
- **Incremental complexity**: graph topology (per-clip gain → per-track gain → destination) is the minimum needed today and admits effect inserts, sends, etc. later without redesign.

---

## Trade-offs

- **Clip-start jitter (~10-30 ms)**: `HTMLAudioElement.play()` is not sample-accurate. One-time offset at the moment a clip enters, **not** continuous drift or stutter. Inaudible for music beds and the 3hr × 4 track primary use case. If short-clip stacking is ever needed, add a hybrid path (see Future Considerations).
- **Not bit-identical to export**: curve sampling density and WebAudio's internal resampling differ from the server's `np.interp` + ffmpeg chain. Perceptual equivalence is the contract, not sample-identity.
- **Simultaneous element limits**: browsers cap concurrent `<audio>` elements (Chrome ~75, Firefox ~100, Safari lower on iOS). Primary use case is well under; very-many-small-clip projects would need a pool-and-recycle layer (deferred).
- **First-play gesture requirement**: `AudioContext` requires a user gesture to start on most browsers. Timeline already has play buttons that satisfy this; need to be sure the mixer is lazy-initialized on first play, not on mount.
- **Disk/network I/O**: streaming implies the browser seeks into each file on demand. Local-file URLs served by the scenecraft API support `Range` requests already (MP4/M4A), but worth verifying for WAV.

---

## Dependencies

- WebAudio API (universal in modern browsers).
- `HTMLAudioElement` + `MediaElementAudioSourceNode`.
- Existing `scenecraftFileUrl` helper for clip source paths.
- Existing `data.audioTracks` in `EditorData` (SSR-loaded, Task 87).
- No new npm packages.

---

## Testing Strategy

### Unit tests (pure TS, no browser)

- `dbToLinear` matches the Python reference: `-60 → 0.001`, `-6 → 0.501`, `0 → 1.0`, `+6 → 1.995`.
- Curve sampling: given `[[0, 0], [1, -6]]`, sample at x=0.5 should yield `-3 dB` (`≈ 0.707`).
- `scheduleClipCurve` emits the expected sequence of `linearRampToValueAtTime` calls for a given playhead position (mock `GainNode.gain`).

### Integration tests (jsdom + WebAudio mock)

- Two non-overlapping clips: mixer activates/deactivates each at the right playhead position.
- Muted clip: clipGain value stays at 0 regardless of curve.
- Seek past a clip: `pause()` called on any previously-active elements.
- Curve edit triggers `updateClip`: new schedule replaces the old, cancelScheduledValues was called first.

### Manual/perceptual

- Drag a curve point during playback — amplitude change audible within one frame.
- Toggle track mute — silence within one frame.
- Seek backwards — playback resumes correctly from the new position, no clips stuck playing from the old position.
- Compare export WAV against in-editor playback by ear for a 30 s passage.

---

## Migration Path

1. Ship `audio-mixer.ts` + unit tests (no UI change).
2. Add a feature flag (`localStorage.scenecraft_use_audio_mixer = '1'`) in Timeline that chooses between the legacy `<AudioTrack>` and the new mixer. Default off.
3. Dogfood with the 3hr × 4 track project; fix any issues surfaced.
4. Flip the flag default to on; keep legacy available for one release.
5. Remove `AudioTrack` + `data.audioFile` path once multi-track mixer is the default.

---

## Key Design Decisions

### Playback architecture

| Decision | Choice | Rationale |
|---|---|---|
| Mixing location | Client (browser WebAudio) | Server mixdown takes seconds-minutes; unsuitable for per-edit audible feedback. |
| Audio source | `HTMLAudioElement` + `MediaElementAudioSourceNode` | `decodeAudioData` path needs ~16 GB for 3hr × 4 tracks — browsers OOM. Streaming keeps memory bounded. |
| Gain stage | Per-clip `GainNode` → per-track `GainNode` → destination | Matches server mixdown topology; admits future effect inserts. |
| Curve automation | `linearRampToValueAtTime` from curve breakpoints | Same semantics as server's `np.interp`; AudioParam automation runs in the audio thread. |
| Source of truth for export | Server `render_project_audio` | Deterministic, reproducible, shareable. Client mixer is a live preview, not an export format. |

### Timing precision

| Decision | Choice | Rationale |
|---|---|---|
| Clip start timing | `audio.play()` + `audio.currentTime = …` at playhead-crossing | Sample-accurate scheduling only possible with full decode, which is infeasible at target scale. |
| Acceptable jitter | 10-30 ms at clip start, no continuous drift | Inaudible for music beds (primary use case). Lip-sync / beat-stacked hits would need a hybrid path. |
| Seek semantics | Full re-evaluation of "active clips" on every seek | Cheap (tens of clips); avoids stale scheduled automation. |

### Scope boundaries

| Decision | Choice | Rationale |
|---|---|---|
| Sample-accurate short clips | Deferred to a hybrid path (decode clips under a size threshold) | Not needed for M9's primary workflow; added complexity without user-visible payoff. |
| Effects (EQ, reverb, compression) | Out of scope | Graph topology supports per-clip/per-track inserts later; no schema or UI today. |
| Multi-output / headphone mix | Out of scope | Destination = single `AudioContext.destination`. |

---

## Future Considerations

- **Hybrid decode path**: for clips under ~10 s, decode into an `AudioBuffer` and schedule with `AudioBufferSourceNode.start(when)` for sample-accurate timing. Keeps the streaming path for long clips. Useful when lip-sync or percussive stacking becomes a workflow.
- **Effect insert chain**: between `clipGain` and `trackGain` (per-clip) or between `trackGain` and master (per-track). Requires new schema tables; see potential M12 plugin work.
- **AudioWorklet for custom DSP**: if we ever need non-WebAudio-native processing (e.g. loudness-normalisation, true-peak limiting in preview), AudioWorklet is the path.
- **Peak meters / headroom display**: tap the master and per-track `GainNode` outputs with `AnalyserNode` for VU-style meters in the Audio section header.
- **Loudness normalisation preview**: LUFS metering is a natural follow-up once meters land.
- **Server-preview parity harness**: a scripted A/B that renders the same 10 s passage through the client mixer and server mixdown, and FFT-compares — guards against drift in curve math.

### Audio time remapping

Today an audio clip's timeline span is a simple `[start_time, end_time]` window over the source at `source_offset`. Transitions can have a non-linear time remap (`transitions.remap`) that stretches/compresses their video over the output range; audio on the linked track plays at its source rate and desyncs under any non-linear remap. A fuller model:

- **Linked clips inherit their transition's remap.** When `audio_clip_links` exists, the mixdown reads the transition's remap and applies the same time warp to the audio samples (via phase-vocoder / sinc resample, or in preview via `playbackRate` + a small time-stretch approximation). Zero per-clip UI needed — the edit happens on the video side and audio follows.
- **Unlinked clips own their own remap.** For standalone music/SFX placed without a transition link, `audio_clips.remap` (already in the schema, currently `{method: "linear", target_duration: 0}`) gets a real curve editor analogous to the transition remap editor: x is source-time, y is output-time, diagonal is 1:1.
- **Unlinking carries the remap over.** If a user unlinks an audio clip from a transition whose remap was non-trivial, the clip's `audio_clips.remap` is populated from the transition's remap at unlink time. The clip keeps sounding the way it did before unlink. The user can reset to identity via the curve editor if that's not what they want.
- **Linked + per-clip remap is a precedence question.** The link's remap always wins while the link exists; `audio_clips.remap` is dormant. On unlink, dormancy ends and the clip's own remap takes over.

Implementation sketches:
- **Engine (`audio/mixdown.py`)**: before resampling a clip, if a link exists, fetch the transition's remap and use `np.interp` to map output-time → source-time sample-by-sample. Falls back to the clip's own remap for unlinked clips. Linear remap stays a fast path (`np.arange`).
- **Client mixer**: `HTMLAudioElement.playbackRate` handles constant-rate speedups/slowdowns (coarse, but adequate for preview). Non-linear remaps would fall back to "pre-render the warped clip" on the server for preview, keeping the editor loop snappy for the common linear case. Full client-side time-stretch is not worth the complexity.
- **Unlink hook**: `db.remove_audio_clip_link(clip_id, transition_id)` becomes a two-step operation — copy the transition's current `remap` into `audio_clips.remap`, then delete the link row. Idempotent: a second unlink (no link row) is a no-op.
- **UI**: the `AudioPropertiesPanel` already shows `remap: {method, target_duration}` as read-only metadata; add a "Time Remap" collapsible with the curve editor once unlinked-audio is a real workflow.

This is a coherent feature, not an immediate need — linked-to-transition is today's primary path and the audio follows the video implicitly via the shared timeline. Track it as a future milestone (M13 candidate) when unlinked music/SFX editing becomes a pressure point.

---

**Status**: Design Specification
**Recommendation**: Implement as a new milestone (M12: In-Editor Audio Playback), starting with the `audio-mixer.ts` module + unit tests, then Timeline wire-up behind a feature flag.
**Related Documents**:
- [`local.audio-tracks-and-clips.md`](local.audio-tracks-and-clips.md) — data model and server mixdown
- [`local.audio-sync.md`](local.audio-sync.md) — existing audio file playback for beats
- Task 91 (engine) — server-side mixdown implementation
