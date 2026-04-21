# Task 87: Timeline Audio Lanes + Mirrored Layout

**Milestone**: [M9 - Audio Tracks and Audio Clips](../../milestones/milestone-9-audio-tracks-and-clips.md)  
**Design Reference**: [Audio Tracks and Audio Clips](../../design/local.audio-tracks-and-clips.md)  
**Estimated Time**: 5-7 hours  
**Dependencies**: Task 82 (schema) — ideally after 84 so there's data to render  
**Status**: Not Started  

---

## Objective

Render audio tracks below the video section in the timeline, using the mirrored sort rule: video tracks descending by `z_order`, audio tracks ascending by `display_order`, with a separator between. Each audio lane shows the track name, mute/enable controls, and its audio clips.

---

## Context

Design doc sections "Slot Pairing Rule" and "Frontend" are canonical. Current Timeline.tsx renders video tracks only.

---

## Steps

### 1. Create `AudioLane.tsx`

Per-audio-track row component. Renders:
- Track header (name, mute button, enable toggle, display_order)
- Clip container — horizontal area showing `AudioClipBlock` children at their `start_time` / `end_time` positions (task 88 creates the block component)
- Uses existing pixels-per-second scale from the Timeline context

### 2. Extend `Timeline.tsx`

Between the video tracks area and the ruler/footer, insert:
- Visible separator bar (1-2 px, distinct colour)
- Audio tracks rendered with `display_order` ascending (inverse of video)
- Same vertical scroll container as video so they pan together
- Each lane responds to the same pixels-per-second scale

Sort video tracks descending by `z_order` (unchanged, confirm), sort audio tracks ascending by `display_order`.

### 3. Track-header controls

- **Mute toggle**: optimistic local state + POST `/api/projects/:name/audio-tracks/update`
- **Enable/hidden**: same
- **Name edit**: inline double-click, blur commits
- Context menu (right-click): "Add audio track above/below", "Delete track", "Rename", "Show/hide"

### 4. Empty-state

When no audio tracks exist, show a thin placeholder row with "Drop a clip to create an audio track" and no separator (cleaner than showing an empty audio section).

### 5. Fetch & subscribe

- `fetchAudioTracks(project)` on mount
- WebSocket subscription to `audio_tracks_updated`, `audio_clips_shifted`, `audio_clip_linked` — refresh as needed (incremental updates, not full reload)

### 6. Tests

- Render with 3 video tracks + 2 audio tracks → video ordered z3, z2, z1; separator; audio ordered display_order 1, 2
- Add audio track → renders in correct position
- Mute toggle round-trips to server

---

## Verification

- [ ] Video tracks render descending by z_order (no regression)
- [ ] Audio section renders below video, separated visually
- [ ] Audio tracks render ascending by display_order
- [ ] Mute/enable controls functional
- [ ] Empty audio state shows a helpful hint
- [ ] WebSocket events update the UI without full reload

---

**Next Task**: [Task 88: Clip block + waveform](task-88-clip-block-waveform.md)
