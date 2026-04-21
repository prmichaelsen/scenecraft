# Milestone 9: Audio Tracks and Audio Clips

**Goal**: Light up multi-track audio — schema, transition-linked clips, dB volume curves, waveform timeline UI, equal-power crossfades, and multi-track render mixdown  
**Duration**: 2-3 weeks  
**Dependencies**: None (greenfield schema change; existing audio_tracks/audio_clips plumbing is empty in practice)  
**Status**: Not Started  

---

## Overview

Audio plumbing currently exists at the DB and REST layer but is orphaned — no timeline UI, no render consumption, no linkage to video. This milestone lights it up end-to-end: multi-track audio on the timeline, audio clips auto-linked to the transition that produced them (extracted via ffmpeg from the video source), dB-valued volume curves that compose with clip trim, equal-power crossfades on same-track overlap, and multi-track mixdown replacing the legacy single-audio-file convention.

Design reference: [local.audio-tracks-and-clips.md](../design/local.audio-tracks-and-clips.md)  
Origin clarification: `clarification-7-audio-tracks-and-clips` (Completed)

---

## Deliverables

### 1. Schema (Greenfield)
- New `audio_clip_links(audio_clip_id, transition_id, offset)` table + indices
- `audio_clips.volume` → `audio_clips.volume_curve TEXT` (JSON dB curve, normalised 0..1 x-axis)
- `audio_tracks.volume_curve TEXT` (JSON dB curve, absolute seconds x-axis)
- `muted` flag retained on both tables
- Legacy single-audio-file convention deprecated (still used by audio-intelligence, no longer muxed into final render)

### 2. Backend Insert & Propagation
- ffmpeg-based audio-stream extraction on transition insert
- Insert endpoint that routes audio to the matching audio track slot (video z_order ↔ audio display_order), bumps on time-range overlap, creates tracks as needed
- Transition move/trim-start propagates to linked audio clips (length preserved)
- Cascade-delete on transition removal

### 3. Frontend Timeline UI
- Audio tracks rendered below video section, mirrored layout (video desc / audio asc around a separator)
- Audio clips as blocks with waveform overlay (peak-sampled, cached)
- Drag/drop insert creates linked audio automatically; selection cross-highlights video+audio

### 4. Volume Curve Editor
- Per-clip curve editor in properties panel, same component pattern as color-grading curves (y-axis dB, x-axis normalised 0..1)
- Per-track curve editor (y-axis dB, x-axis absolute timeline seconds)

### 5. Renderer
- Multi-track mixdown in `narrative.py` (dB→linear, per-sample curve eval, track sum)
- Equal-power crossfade derived at render time from same-track overlap regions
- Replaces legacy `_mux_audio` single-file path

### 6. Veo Auto-Link
- Veo generation flow creates the linked audio clip on successful completion

---

## Success Criteria

- [ ] Dropping a video transition onto the timeline creates both the transition and a linked audio clip on the paired audio track
- [ ] When the source video has no audio stream, the transition is created without an audio clip (no error)
- [ ] Moving a transition shifts its linked audio clips by the same delta
- [ ] Trimming a transition's start slides linked audio clips forward, preserving length
- [ ] Deleting a transition cascade-deletes its linked audio clips
- [ ] Two overlapping clips on the same audio track play with equal-power crossfade in both preview and final render
- [ ] Volume curve on a clip, drawn in the properties editor, is audibly applied during playback and matches the rendered output sample-for-sample
- [ ] Final export mixes all audio tracks (no longer a single passthrough file)
- [ ] Veo-generated transitions arrive with their audio already linked and on the timeline
- [ ] Waveforms render on all audio clips without perceptible timeline lag with ≥50 clips

---

## Key Files to Create

```
scenecraft-engine/src/scenecraft/
├── audio/
│   ├── __init__.py
│   ├── extract.py            # ffmpeg audio-stream extraction
│   ├── routing.py            # slot-match + bump + auto-create
│   ├── curves.py             # dB curve evaluation, db_to_linear helpers
│   └── mixdown.py            # multi-track sum + equal-power crossfade
├── render/narrative.py       # (modified) replace _mux_audio with multi-track mixdown

scenecraft/src/
├── components/editor/
│   ├── AudioLane.tsx         # per-track row with clips
│   ├── AudioClipBlock.tsx    # single-clip renderer with waveform
│   ├── AudioWaveform.tsx     # canvas-based waveform renderer
│   ├── VolumeCurveEditor.tsx # curve editor (reuses CurveEditor pattern)
│   └── Timeline.tsx          # (modified) audio lanes below video, mirrored
├── lib/
│   ├── audio-client.ts       # audio tracks/clips REST client
│   └── waveform-cache.ts     # peak-array fetch + IndexedDB cache
```

---

## Tasks

1. [Task 82: Schema migration (greenfield)](../tasks/milestone-9-audio-tracks-and-clips/task-82-schema-migration.md) — `audio_clip_links` + `volume_curve` on clips/tracks
2. [Task 83: Audio-stream extract](../tasks/milestone-9-audio-tracks-and-clips/task-83-audio-extract.md) — ffmpeg helper + probe, staging dir
3. [Task 84: Slot routing + insert endpoint](../tasks/milestone-9-audio-tracks-and-clips/task-84-insert-routing.md) — bump/create logic, linked-insert API
4. [Task 85: Transition move/trim propagation](../tasks/milestone-9-audio-tracks-and-clips/task-85-transition-propagation.md) — delta math + invariant-table behaviour
5. [Task 86: Cascade delete](../tasks/milestone-9-audio-tracks-and-clips/task-86-cascade-delete.md) — transition delete → linked audio removal
6. [Task 87: Timeline audio lanes + mirrored layout](../tasks/milestone-9-audio-tracks-and-clips/task-87-timeline-audio-lanes.md) — AudioLane component, sort rules
7. [Task 88: Audio clip block + waveform rendering](../tasks/milestone-9-audio-tracks-and-clips/task-88-clip-block-waveform.md) — canvas renderer + peak cache
8. [Task 89: Drag/drop insert + auto-link UI](../tasks/milestone-9-audio-tracks-and-clips/task-89-drag-drop-insert.md) — frontend counterpart of task 84
9. [Task 90: Volume curve editor (clips + tracks)](../tasks/milestone-9-audio-tracks-and-clips/task-90-volume-curve-editor.md) — reuse CurveEditor pattern, dB axis
10. [Task 91: Multi-track mixdown + equal-power crossfade](../tasks/milestone-9-audio-tracks-and-clips/task-91-mixdown-renderer.md) — replace `_mux_audio`
11. [Task 92: Veo auto-link integration](../tasks/milestone-9-audio-tracks-and-clips/task-92-veo-auto-link.md) — post-generation hook

---

## Environment Variables

No new environment variables required. Uses existing ffmpeg/ffprobe on PATH.

---

## Testing Requirements

- [ ] Unit tests for dB↔linear conversion and curve evaluation (including out-of-bounds t, edge-case points)
- [ ] Unit tests for slot routing (empty, occupied, bump chain, auto-create)
- [ ] Unit tests for equal-power crossfade gain sum ≈ 1 across overlap
- [ ] Integration test: insert transition with audio → verify rows in `audio_clips` + `audio_clip_links`
- [ ] Integration test: insert transition without audio → transition created, no audio rows
- [ ] Integration test: move/trim/delete transition → linked audio behaves per invariant table
- [ ] Renderer test: two overlapping clips produce perceptually constant loudness across overlap
- [ ] Renderer test: muted track contributes zero; muted clip contributes zero
- [ ] E2E: drop Veo-generated `.mp4` into timeline → audio lane populates → export plays mixed audio

---

## Documentation Requirements

- [ ] Design document [local.audio-tracks-and-clips.md](../design/local.audio-tracks-and-clips.md) already created
- [ ] Update AGENT.md / README.md with multi-track audio notes where relevant
- [ ] Inline JSDoc on `VolumeCurveEditor`, `AudioWaveform`, `AudioLane` components

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation Strategy |
|------|--------|-------------|---------------------|
| ffmpeg extraction latency on insert | Medium | Medium | Run async; transition appears immediately, audio clip fills in on completion via WS event |
| Waveform rendering slow at many clips | Medium | Medium | Cache peak arrays (float16) in IndexedDB; lazy-compute on first fetch; skip draw when clip width < 16 px |
| Greenfield wipe loses user data | Low | Low | `audio_clips` has no user-facing rows today — confirmed orphan at milestone start |
| Curve x-axis asymmetry (clip normalised / track seconds) confuses users | Low | Medium | Clear axis labels in the curve editor UI; documented in design doc |
| Crossfade derived-at-render diverges from preview playback | Medium | Medium | Same equal-power code path used in both; unit-test with identical sample sequences |
| Task number collision with a parallel agent | Low | High | Starts at Task 82 to avoid 71-81 in use by concurrent planning |

---

**Next Milestone**: TBD  
**Blockers**: None  
**Notes**: Tasks are roughly ordered by dependency but several can parallelise (82 blocks 83-86; 83-86 block 87-89 in some cases; 87-89 and 90-91 can parallelise once data layer is in). Design doc [local.audio-tracks-and-clips.md](../design/local.audio-tracks-and-clips.md) holds the canonical invariant table and schema details.  
