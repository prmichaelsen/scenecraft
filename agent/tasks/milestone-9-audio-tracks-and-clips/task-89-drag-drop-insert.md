# Task 89: Drag/Drop Insert + Auto-Link UI

**Milestone**: [M9 - Audio Tracks and Audio Clips](../../milestones/milestone-9-audio-tracks-and-clips.md)  
**Design Reference**: [Audio Tracks and Audio Clips](../../design/local.audio-tracks-and-clips.md)  
**Estimated Time**: 5-7 hours  
**Dependencies**: Tasks 84 (insert routing), 87 (lane), 88 (clip block)  
**Status**: Not Started  

---

## Objective

Extend the existing drag/drop-onto-timeline flow so dropping a video transition creates both the transition and a linked audio clip automatically, with the audio appearing on the paired audio track per the slot rule.

---

## Context

Current `BinPanel` / `Timeline` drag-drop creates transitions only. This task wires the client side to the backend route from Task 84.

---

## Steps

### 1. Detect drag payload with audio

When the user drags an item from the pool/bin onto the timeline, read the cached metadata: does the video have an audio stream? (Metadata is populated by the existing `/api/projects/:name/pool/*` listings; extend if not.)

### 2. Call the linked-insert endpoint

After the transition is created, invoke `POST /api/projects/:name/insert-linked-audio` (Task 84). The server extracts audio, creates the clip, routes to a track, returns the new IDs.

Client handles the response:
- If `audio_track_created` → re-fetch `audio_tracks` (or merge from the WS event)
- Append the new clip to the appropriate lane via local state update

### 3. Optimistic UI

Show a "generating audio…" ghost block on the paired audio track immediately on drop, replaced by the real clip when the extract completes (WS event). If no audio stream, the ghost disappears silently.

### 4. Veo generation flow (hand-off to Task 92)

Task 89 handles user-initiated drops. Task 92 handles Veo auto-link.

### 5. Cross-highlight on selection

Selecting a transition highlights its linked audio clips (border glow). Selecting an audio clip highlights its transition. Implementation: extend the selection store to understand link relations and add a visual highlight style.

### 6. Tests

- Drop video with audio → transition + linked audio appear on correct tracks
- Drop video without audio → only transition, no error, no ghost lingering
- Drop creates new audio track when needed
- Selection cross-highlighting works both directions

---

## Verification

- [ ] Dropping a video transition shows a ghost audio block immediately
- [ ] Ghost resolves to a real waveform block after extraction completes
- [ ] Videos without audio don't leave a lingering ghost
- [ ] Newly-created audio tracks appear in the lane stack at correct `display_order`
- [ ] Click a transition → linked audio clip(s) highlighted; click audio → transition highlighted

---

**Next Task**: [Task 90: Volume curve editor](task-90-volume-curve-editor.md)
