# Task 92: Veo Auto-Link Integration

**Milestone**: [M9 - Audio Tracks and Audio Clips](../../milestones/milestone-9-audio-tracks-and-clips.md)  
**Design Reference**: [Audio Tracks and Audio Clips](../../design/local.audio-tracks-and-clips.md)  
**Estimated Time**: 2-3 hours  
**Dependencies**: Tasks 83 (extract), 84 (insert routing)  
**Status**: Not Started  

---

## Objective

When a Veo video generation completes and is selected/attached to a transition, automatically extract its audio stream and create a linked audio clip. This is the "main value prop" of the auto-link system — every Veo output contributes its audio to the mix without manual effort.

---

## Context

Veo outputs are `.mp4` files that always contain an audio stream. The existing generation flow currently drops the audio at render time; this task wires it into the audio track system.

---

## Steps

### 1. Locate the Veo completion hook

Find the code path that handles Veo job completion and attaches the video to a transition — likely in the Veo generator or the transition-select path when `image_model == "veo"`. The hook runs server-side when the video is staged into `selected_transitions/`.

### 2. Call the linked-audio insert

After the transition's video path is set:
1. Call `probe_audio_stream(video_path)` — should always find an audio stream for Veo output
2. Call the same path as Task 84 (extract → route → create clip → create link row)
3. Broadcast the WS event

If probe returns None (unexpected for Veo), log a warning and continue — treat as a video-only transition.

### 3. Race conditions

If the user is concurrently dragging a clip onto the same audio track while Veo completes, the insert routing's overlap-bump logic handles the collision — both clips get valid slots.

### 4. Tests

- Veo generation completes → `audio_clip_links` row exists for the transition
- Veo audio clip lands on audio track `display_order = video_track_z`
- If the paired audio track already has overlapping content, bumps to next slot
- WS event fires; frontend picks up the new clip

---

## Verification

- [ ] Veo completion reliably creates a linked audio clip
- [ ] Audio track slot pairing matches video track z_order
- [ ] Overlap-bump works when target is occupied
- [ ] Frontend updates without a full refresh

---

**Next Task**: None — end of M9

**Milestone Completion**: After this task, verify the full flow end-to-end with a real Veo generation: the video appears on its video track, audio appears on the paired audio track with a waveform, volume curve editor works, and final export mixes the audio correctly.
