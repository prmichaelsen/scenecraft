# Audio Tracks and Audio Clips

**Concept**: Multi-track audio with video-transition-linked clips, dB-valued volume curves, and auto-routed insert flow  
**Created**: 2026-04-19  
**Status**: Design Specification  

---

## Overview

Scenecraft ships with DB and REST plumbing for `audio_tracks` and `audio_clips`, but the feature is orphaned from the UI and renderer — the app behaves as if there is one fixed audio file per project, mixed externally. This design lights up the missing half: multiple audio tracks, audio clips rendered on the timeline, auto-linked to the video transition they were generated from, positioned by a user-intent anchor, volume-automated with dB curves, and mixed down in the renderer.

It also formalises a companion schema `audio_clip_links` that associates audio clips with transitions without coupling their data models — the link carries a single user-intent offset; trim and positioning remain on the clip.

---

## Problem Statement

- Audio support exists as cold plumbing: no timeline UI, no insertion flow, no render-pipeline consumption, no relationship to video clips
- Every video transition generated via Veo arrives with an embedded audio stream that the editor throws away at render time — the value of that audio is never surfaced to the user
- Volume is stored as a linear scalar with no time variance and no dB semantics, diverging from how color grading is already automated (curves) and how professional NLEs model audio (dB)
- There is no model for linking a transition's audio back to the transition, so trim/move/delete operations on video don't carry audio with them
- The existing single-audio-file convention (project-level analysis audio) is incompatible with the idea of clips on tracks

---

## Solution

Multi-track audio with transition-linked clips, where:

- Multiple audio tracks coexist, with their ordinal (`display_order`) defining a stable slot that pairs against video track `z_order`
- Audio clips live on tracks, with their own trim (`source_offset` + `start_time`/`end_time`) and independent dB volume automation curves
- A dedicated `audio_clip_links(audio_clip_id, transition_id, offset)` table carries the relationship to a transition. `offset` is the user-intent anchor (where the clip sits relative to transition start); trim and curve data stay on the clip
- Inserting a video transition auto-extracts its embedded audio stream (ffmpeg) and creates a linked audio clip on the matching audio track, bumping/creating tracks as needed
- Transition move/trim/delete propagate to linked audio clips: move shifts them, start-trim slides them (preserving length), delete cascades
- Overlapping clips on the same audio track are allowed and auto-crossfaded (equal-power, derived at render time)
- Volume is a curve on both clips and tracks; clip curves use normalized clip time, track curves use absolute timeline seconds
- Renderer mixes down all tracks to a single stream in `narrative.py`; the legacy single-audio-file convention is deprecated

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Editor UI                                                  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Timeline                                              │  │
│  │                                                       │  │
│  │ ┌──────────────┐   video tracks desc by z_order      │  │
│  │ │  V z=3       │                                     │  │
│  │ │  V z=2  ▓▓   │  ▓▓ transition with linked audio    │  │
│  │ │  V z=1  ▓▓   │                                     │  │
│  │ │  ════════    │  separator                          │  │
│  │ │  A z=1  ░░   │  audio tracks asc (mirrored below)  │  │
│  │ │  A z=2       │  ░░ linked audio clip with curve    │  │
│  │ │  A z=3       │                                     │  │
│  │ └──────────────┘                                     │  │
│  └───────────────────────────────────────────────────────┘  │
│                        │                                    │
│                        ▼                                    │
├─────────────────────────────────────────────────────────────┤
│  Backend API                                                │
│  - POST /api/projects/:name/insert-pool-item (extended)     │
│      → ffmpeg extract audio stream                          │
│      → find video track's slot N                            │
│      → find/bump/create audio track at slot N               │
│      → create audio_clip + audio_clip_links row             │
│  - transition move/trim/delete → propagate to linked clips  │
│  - overlap on same audio track → noted (no storage change,  │
│    renderer derives crossfade)                              │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Renderer (narrative.py)                                    │
│  For each audio track:                                      │
│    evaluate track volume_curve (seconds-axis) → linear gain │
│    for each clip on this track:                             │
│      evaluate clip volume_curve (0..1 normalised)           │
│      detect overlap with neighbours → equal-power crossfade │
│      multiply samples by clip gain × track gain             │
│    sum into track mix                                       │
│  Sum all tracks → final audio                               │
│  Mux with final video (replaces legacy single audio file)   │
└─────────────────────────────────────────────────────────────┘
```

### Slot Pairing Rule

Video track with `z_order = N` pairs with audio track with `display_order = N`.

Visual layout (top to bottom in the timeline panel):
- video tracks, **sorted descending** by `z_order` (highest z on top — closer to viewer in the layering metaphor)
- separator bar
- audio tracks, **sorted ascending** by `display_order` (lowest at top of the audio section, immediately under the separator, descending from there)

So video z=1 and audio display_order=1 sit on opposite sides of the separator, touching it — slot 1 on top of the audio stack and bottom of the video stack.

When a transition is dropped onto video track slot N, the companion audio clip lands on audio track slot N. If no audio track at slot N exists, create one with `display_order = N`. If an audio clip already occupies the insert's time range on audio track N ("occupied" = time-range overlap, not just any clip present), bump the new clip to the next higher slot, recursing.

---

## Implementation

### Data Model

**New table — `audio_clip_links`**:

```sql
CREATE TABLE IF NOT EXISTS audio_clip_links (
  audio_clip_id TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  offset REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (audio_clip_id, transition_id)
);
CREATE INDEX idx_acl_transition ON audio_clip_links(transition_id);
CREATE INDEX idx_acl_audio_clip ON audio_clip_links(audio_clip_id);
```

- `offset` is the user-intent anchor, in seconds, relative to `transition.start_time`. `offset = -5` means "anchor this audio so it starts 5s before the transition begins".
- Role/label is deliberately not stored (skipped per clar-7 decision); can be added later.
- Multiple clips per transition (main + SFX + ambience) are natural — no uniqueness constraint beyond the composite PK.

**Changes to `audio_clips` (greenfield — no migration)**:

```sql
CREATE TABLE IF NOT EXISTS audio_clips (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  start_time REAL NOT NULL DEFAULT 0,       -- absolute timeline seconds
  end_time REAL NOT NULL DEFAULT 0,         -- absolute timeline seconds
  source_offset REAL NOT NULL DEFAULT 0,    -- source-file seconds (trim-in)
  volume_curve TEXT NOT NULL DEFAULT '[[0,0],[1,0]]',  -- JSON [[x_normalised, db], ...]
  muted INTEGER NOT NULL DEFAULT 0,
  remap TEXT NOT NULL DEFAULT '{"method":"linear","target_duration":0}',
  deleted_at TEXT
);
```

- `volume` → `volume_curve`. Curve is a JSON list of `[x, db]` pairs. `x` is normalized 0..1 over the clip's duration (consistent with existing color/transform curves). `db` is in decibels; 0 dB = unity gain. Default curve `[[0,0],[1,0]]` is a flat unity line.
- `muted` stays as an explicit flag so users can bypass without discarding their volume automation.

**Changes to `audio_tracks`**:

```sql
CREATE TABLE IF NOT EXISTS audio_tracks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Audio Track 1',
  display_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  hidden INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  volume_curve TEXT NOT NULL DEFAULT '[[0,0],[1,0]]'  -- JSON [[x_seconds, db], ...]
);
```

- Same `volume_curve` column, but the x-axis is **absolute timeline seconds** rather than normalised — tracks have no natural length, and normalising over project duration would drift when the project is extended. Renderer evaluates by sample timestamp.

### Invariant Table (transition/clip operations → linked-audio response)

| Operation                                                    | `link.offset` | `clip.source_offset` | `clip.start_time` | `clip.end_time` |
|--------------------------------------------------------------|---------------|----------------------|-------------------|-----------------|
| Transition moves by Δ                                        | unchanged     | unchanged            | +Δ                | +Δ              |
| Transition trimmed **end** by Δ                              | unchanged     | unchanged            | unchanged         | unchanged       |
| Transition trimmed **start** by Δ                            | unchanged     | unchanged            | +Δ                | +Δ              |
| User drags audio clip left/right by Δ                        | **+Δ**        | unchanged            | +Δ                | +Δ              |
| User trims audio clip start by Δ (ripple)                    | unchanged     | +Δ                   | +Δ                | unchanged       |
| User trims audio clip end by Δ                               | unchanged     | unchanged            | unchanged         | +Δ              |
| Transition deleted                                           | (row deleted) | (clip deleted)       | —                 | —               |

Trimming a transition's start "slides" the linked audio forward (length preserved, no source content lost), behaving like a transition move as seen from the clip. If the slide causes the clip to overlap a neighbour on the same audio track, the overlap region auto-crossfades at render time.

### Companion-Audio Discovery

On transition insert (drag from pool, Veo generation complete, any flow that creates a transition from a video file):

1. Probe the video source with `ffprobe` for an audio stream
2. If present: `ffmpeg -i <video> -vn -acodec copy <audio-sidecar>` (stream-copy into the project's audio staging dir; re-encode if container can't stream-copy)
3. Create an `audio_clips` row pointing at the extracted audio, with `start_time/end_time` matching the transition's span, `source_offset = 0`, default volume curve
4. Determine target audio track via slot routing (see below); create the track if missing
5. Insert `audio_clip_links` row with `offset = 0` (audio begins exactly at transition start)
6. If the video has no audio stream, skip step 3-5 silently — the transition is video-only

### Insert Routing

Given a video transition landing on video track `z_order = N`:

```
audio_tracks_sorted = sorted(audio_tracks, key=display_order)
target = first track where display_order == N
if not target:
    target = create_audio_track(display_order = N)
while overlap_in_range(target, clip.start_time, clip.end_time):
    next = first track where display_order > target.display_order
    if not next:
        next = create_audio_track(display_order = target.display_order + 1)
    target = next
insert clip on target
```

"Occupied" is defined by time-range overlap, not mere presence — tracks can have many clips if they don't collide in time.

### Overlap Handling & Crossfades

Overlapping clips on the same track are allowed and mixed together during render. Where they overlap in time, the renderer applies an **equal-power crossfade** (sqrt-curve) over the overlap region:

- left clip gain: `cos(t * π/2)` where `t` = 0..1 across the overlap
- right clip gain: `sin(t * π/2)`
- sum of squared gains = 1 throughout the overlap → constant perceived loudness

Crossfades are **derived at render time** from the overlap geometry — no separate table, no user-visible storage. Overlap duration = crossfade duration; users shape the fade by moving clips to lengthen/shorten overlap. A future enhancement can introduce per-crossfade curves if needed.

### Volume Curves

**Clip curve** (`audio_clips.volume_curve`):
- JSON `[[x, db], ...]` with `x` ∈ [0, 1] normalised over the clip's duration (`end_time - start_time`)
- Sampled by the renderer at each output sample: find surrounding points, interpolate dB linearly, convert to linear gain via `10^(db/20)`
- Default `[[0,0],[1,0]]` = flat 0 dB (unity)
- Stored/displayed range: −60 dB…+12 dB in the UI; no hard floor in storage (users can plot whatever they want)

**Track curve** (`audio_tracks.volume_curve`):
- Same JSON shape but `x` is absolute timeline seconds
- Multiplied into the final track mix after clip curves
- Default also `[[0,0],[1,0]]` = unity across all time (the `0..1` here is seconds, not normalised; a flat curve at 0 dB at any two x-values yields the same behaviour)

**Mute** (`muted`): when `muted = 1`, renderer forces gain to −Infinity (or sentinel −144 dB for safety) regardless of the curve. Separate from the curve so users don't lose their envelope when toggling mute.

### Render Pipeline (narrative.py)

Replace the legacy single-`audio_path` mux with a multi-track mixdown:

```python
def render_audio(project_dir, output_wav):
    audio_tracks = get_audio_tracks(project_dir, enabled=True, muted=False)
    # Prepare an empty stereo buffer of project duration at project sample rate
    master = np.zeros((2, total_samples), dtype=np.float32)
    for track in audio_tracks:
        track_buf = np.zeros_like(master)
        clips = get_audio_clips_for_track(project_dir, track.id)
        for clip in clips:
            samples = load_and_resample(clip.source_path, sr=project_sr,
                                        source_offset=clip.source_offset,
                                        duration=clip.end_time - clip.start_time)
            gain = evaluate_curve_db(clip.volume_curve, normalised=True,
                                     length=len(samples))
            samples *= db_to_linear(gain)
            if clip.muted:
                samples *= 0
            mix_into(track_buf, samples, start=time_to_sample(clip.start_time))
        # Apply track curve (seconds-axis) and mute
        track_gain = evaluate_curve_db(track.volume_curve, normalised=False,
                                       sample_times=np.arange(total_samples)/project_sr)
        track_buf *= db_to_linear(track_gain)
        if track.muted:
            track_buf *= 0
        master += track_buf
    # Apply equal-power crossfades derived from per-track overlap regions
    apply_equal_power_crossfades(master, audio_tracks)
    write_wav(output_wav, master, sr=project_sr)
    return output_wav
```

Cross-track mixdown is a straight sum. Final mux replaces the legacy audio path in `assemble_final`.

### Frontend

- **Timeline panel**: render audio tracks below the video section, in mirrored z-order per the slot-pairing diagram. Each lane shows the track name, mute/enable/expand controls, and the clips it holds.
- **Audio clip rendering**: block per clip with a waveform overlay. Waveform PCM is computed server-side on first request and cached as a compact float16 peak array; fetched once per clip id, rendered into a `<canvas>`. Waveform is in-scope for this milestone per clar-7.
- **Volume curve editor**: same component pattern as color-grading curves (reusable `CurveEditor` component). Shown in the clip's properties panel when an audio clip is selected; y-axis in dB, x-axis normalised 0..1.
- **Drag/drop insert**: extends the existing pool/insert-pool-item flow. When the payload is a video file with an audio stream, backend creates both the transition and the linked audio clip atomically.
- **Selection & linking UI**: follows existing selection model; a selected transition highlights its linked audio clip(s) and vice versa. Unlink/relink UI is out of scope for v1.

---

## Benefits

- **Unlocks video-carried audio**: every Veo generation stops discarding its audio stream and starts contributing to the project mix
- **Modelled like a real NLE**: dB values, volume curves, equal-power crossfades, mirrored track layout, ripple trim behaviour — users with Premiere/Resolve/Audition experience will find it familiar
- **Orthogonal concepts, clean data**: link offset (anchor) is independent of clip trim (source in/out) is independent of clip position (timeline). Operations touch exactly the fields they need to
- **Consistent with existing curve infra**: volume curves use the same JSON shape and evaluation code as color/transform curves, reducing implementation cost and keeping the editor uniform
- **Cascade semantics baked in**: deleting a transition takes its audio with it; moving or trimming a transition propagates cleanly via the invariant table

---

## Trade-offs

- **Scope**: ~8-12 tasks covering schema, backend insert routing and propagation, ffmpeg integration, renderer mixdown, timeline UI, waveforms, Veo auto-link, and crossfades. Mitigated by the greenfield carve-out (no migration of existing `audio_clips` rows).
- **Greenfield wipe**: existing `audio_clips` / `audio_tracks` data is discarded when the schema flips to `volume_curve`. Acceptable because the feature was never user-facing.
- **Track curve x-axis is seconds, clip curve x-axis is normalised**: mildly inconsistent but each choice matches the object's natural lifetime. Users editing curves in the properties panel see it labeled appropriately.
- **Derived crossfades**: simple but means crossfade shape is fixed (equal-power). Users wanting a custom fade would need to shape it with clip volume curves in the overlap region instead. Upgrade path: add an `audio_crossfades` table later if demand appears.
- **ffmpeg on the critical path**: insert flow gains an ffmpeg invocation. Acceptable — Veo generation is already a long async job; a few seconds of audio extraction fits inside its existing envelope. For drag/drop of external files, extraction runs async and the transition appears immediately; the audio clip fills in when ready.

---

## Dependencies

- Existing `audio_tracks` / `audio_clips` plumbing (API + DB — schema evolves in place)
- Existing curve evaluation utilities (`evaluateCurve`, `CurvePoint` types) — reused for volume curves
- `ffmpeg` / `ffprobe` — already on the render path, reused for audio extraction
- `wavesurfer.js` (already installed) — candidate for audio clip waveform rendering; may be replaced with a lighter custom canvas renderer for many-clip performance
- Properties panel infrastructure (for the curve editor) — the current color-grading curve editor pattern is the template

---

## Testing Strategy

- **Unit**: dB ↔ linear conversions, curve evaluation at arbitrary t (including out-of-bounds), equal-power gain sums to 1 across overlap
- **Unit**: slot-routing algorithm (empty tracks, occupied tracks, bump chain, auto-create)
- **Integration**: insert a transition from a pool video with audio → verify `audio_clips` + `audio_clip_links` rows exist and positions match
- **Integration**: insert a transition from a pool video WITHOUT audio → verify transition is created, no audio clip, no error surfaced
- **Integration**: move a transition → linked audio clip's `start_time`/`end_time` shift by the same Δ
- **Integration**: trim a transition's start → linked clip slides; overlap with neighbour triggers crossfade detection
- **Integration**: delete a transition → `audio_clip_links` and `audio_clips` rows cascade-deleted (soft or hard per existing convention)
- **Render**: multi-track project mixes down correctly, crossfades perceptually constant loudness, muted track contributes nothing, curve-volumed clip respects dB values at sample granularity
- **E2E**: user drops a Veo-generated video into the timeline → audio lane populates → playhead scrub plays mixed audio → export produces correctly mixed final video

---

## Migration Path

No migration — greenfield. The schema change to `audio_clips.volume_curve` is done via a table drop-and-recreate at the next DB init. The legacy project single-audio-file convention is deprecated; audio-intelligence analysis continues to produce its own artefacts but is no longer mixed into the final render. If analysis results need to participate in the mix, they can be imported as ordinary audio clips on a dedicated track.

---

## Key Design Decisions

### Link Model

| Decision | Choice | Rationale |
|---|---|---|
| Linkable entity | Transitions only | Keyframes are stills with no natural time span; tracks are containers. Transitions are the only thing with a time range that audio meaningfully attaches to. |
| Link storage | Dedicated `audio_clip_links` table | Many audio clips per transition (main + SFX + ambience). Nullable FK on `audio_clips` would couple the models and leave NULLs for unlinked clips. Link table keeps each side clean. |
| Role column | Skipped (no column) | Not needed in v1; free-form labels can be added later as either a column or a role column on the link. |
| Link anchor | Store `offset` on the link | `offset` is user-intent anchor, distinct from clip trim. Composes cleanly: effective audible position relative to transition = `link.offset + clip.source_offset`. |

### Track Routing & Layout

| Decision | Choice | Rationale |
|---|---|---|
| Slot identity | Existing `z_order` (video) and `display_order` (audio) | Already in the schema; serve as ordinals without needing a new column. |
| Pairing rule | Same numeric value | `video z=N ↔ audio display_order=N`. Insert on video track N lands on audio track N. |
| Bump behaviour | Time-range overlap triggers bump | "Occupied" means a clip would overlap in time; empty regions on the same track are fair game. |
| Auto-create display_order | Match source video's z_order | Keeps slot parity. A new audio track created for video z=3 gets display_order=3. |
| Visual layout | Video desc / audio asc around separator | Mirrors the stacking metaphor; paired slots touch the separator. |

### Lifecycle

| Decision | Choice | Rationale |
|---|---|---|
| Delete transition | Cascade-delete linked audio clips | Linked audio has no meaning without its anchor; explicit unlink is a future UI feature. |
| Move transition | Linked clips follow by Δ | Audio is anchored to the transition via offset; the transition "drags" its audio. |
| Trim transition start | Linked clips slide +Δ (length preserved) | Audio anchor moves with the transition start, but audio content is not destroyed. |
| Trim transition end | No change to linked clips | The transition's start didn't move; the audio anchor is unaffected. |
| Same-track overlap | Allowed, auto-crossfade | Matches Audition's default behaviour; simpler data model than rejecting inserts. |

### Volume Model

| Decision | Choice | Rationale |
|---|---|---|
| Value units | dB | Matches pro NLE convention; logarithmic perception of loudness makes dB the natural control. |
| Storage | Curve on both clips and tracks | User wants time-varying automation, same pattern as color grading. No separate scalar. |
| Clip curve axis | Normalised 0..1 over clip duration | Consistent with existing project curves; robust to clip trim. |
| Track curve axis | Absolute timeline seconds | Tracks have no natural length; normalising over project duration would drift when the project is extended. |
| Mute flag | Separate from curve | Users can toggle mute without discarding their volume envelope. |
| Default curve | `[[0,0],[1,0]]` (flat 0 dB) | Unity gain everywhere — the audible-equivalent default. |
| Mute sentinel | `-144` dB when muted (or `-Infinity` where representable) | Below the noise floor of 24-bit; inaudible without special casing `-Infinity` in math. |

### Companion Audio & Rendering

| Decision | Choice | Rationale |
|---|---|---|
| Audio source on insert | Extract from video via ffmpeg | Always works; doesn't depend on sidecar conventions; matches how the video's audio is bundled in Veo outputs. |
| Fallback if no audio stream | Silent skip (video-only transition) | Less friction than failing the insert; most users don't need every transition to have audio. |
| Default volume on auto-linked clip | Flat 0 dB curve | Unity gain; user mixes to taste from there. |
| Crossfade curve | Equal-power (sqrt) | Preserves perceived loudness across the overlap; standard in pro audio. |
| Crossfade storage | Derived at render | Overlap geometry is the source of truth; no separate table until users want curve control. |
| Legacy single-audio-file | Deprecated | Redundant with multi-track mixdown; kept only for audio-intelligence analysis which is separate from the render path. |
| Veo auto-link | Yes | Main value prop — every generation contributes its audio without user effort. |

---

## Future Considerations

- **Audio effects as curves** (reverb, echo, EQ, compression, …): same curve-editor pattern as volume and color grading. Stored per-clip as `effect_curves TEXT` (JSON) or in a sibling table. Each effect has its own parameter curve(s) — e.g. reverb wet/dry over time, echo feedback over time. Natural follow-up once curve-volume + mixdown infrastructure lands.
- **Unlink / relink UI**: manually detach an audio clip from a transition (keeping it on the timeline), or link an unlinked clip to a transition. Requires selection handles and keyboard shortcuts; kept out of v1 because the auto-link flow covers the common case.
- **Track curve in normalised project-time**: revisit if users find seconds-axis counterintuitive; could add a "normalise to project duration" toggle.
- **Per-crossfade curves**: if equal-power isn't enough, introduce `audio_crossfades` table to store per-overlap fade curves.
- **Waveform server rendering as a service**: centralise PCM peak computation and cache by `(source_path, source_offset, duration)` key; serve from a dedicated endpoint. Currently envisioned as computed inline on first fetch.
- **Audio clip routing to multiple tracks simultaneously**: currently each clip is on exactly one track; future sends/returns would allow duplicating a clip's signal across tracks for bussing.
- **Integration with audio-intelligence analysis**: treat the analysis audio as a clip on an "Analysis" track rather than a deprecated sidecar, so it can participate in the mix for preview purposes.

---

**Status**: Design Specification  
**Recommendation**: Implement as a milestone with ~8-12 tasks (schema, ffmpeg extract, insert endpoint + routing, transition propagation, cascade-delete, timeline UI, waveform rendering, curve editor, multi-track renderer, equal-power crossfade, Veo auto-link). Greenfield wipe of existing `audio_clips` data is acceptable.  
**Related Documents**: [clarification-7-audio-tracks-and-clips.md](../clarifications/clarification-7-audio-tracks-and-clips.md)
