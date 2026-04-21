# Milestone 15: Audio Clip Editing + Track Management

**Goal**: Fill the basic editing gaps left after M9 — users can delete, move, trim, drop-in, and manage audio tracks directly from the Timeline instead of only through side-effects of video edits or SQL.
**Duration**: ~2.5 weeks (20 hours dev)
**Dependencies**: M9 ✅ complete. Pairs well with M14 (playback) — this milestone is most valuable once editing is audible, but is independently useful.
**Status**: Not Started

---

## Overview

M9 delivered the audio data model, auto-linking on video drop, timeline lanes, waveforms, volume-curve editing, and the server mixdown. What's still missing is the direct-manipulation surface users expect from an NLE: deleting a clip or track by itself, moving a clip in time, trimming its edges, adding a new track, renaming an existing track, and dropping a plain audio file onto the timeline without going through a video drop.

This milestone also picks up the two polish items deferred from Task 89: cross-highlighting linked transition ↔ audio clips on selection, and an optimistic "generating audio…" ghost block during extraction.

Backend endpoints for most of these already exist from M9 (`/audio-tracks/add`, `/update`, `/delete`, `/reorder`; `/audio-clips/update` supports `startTime`/`endTime`). This milestone is primarily UI plumbing plus a small amount of glue for the unlinked-drop path.

---

## Deliverables

### 1. Clip & track delete
- Right-click context menu on an audio clip → "Delete clip". Soft-delete via `/audio-clips/update` with `deleted_at`, drops link row if present.
- Right-click on a lane header → "Delete track". Cascades to soft-delete clips on that track (backend already does this via `db.delete_audio_track`).
- Confirmation when the track has non-empty clips.

### 2. Track add / rename / reorder
- "+ Add audio track" affordance at the bottom of the audio section; POSTs `/audio-tracks/add`.
- Double-click the track header name to rename; commits on blur via `/audio-tracks/update`.
- Drag a track header up/down to reorder; POSTs `/audio-tracks/reorder` with the new `trackIds` order.
- Mute + enabled toggles live in the lane header (already partially scaffolded; make them clickable).

### 3. Clip body-drag move (same-track)
- Mouse-down on a clip body + drag → ghost follows cursor with snap to seconds/beats (inherits M10 patterns where possible).
- Commit via `/audio-clips/update` with the new `startTime`/`endTime` preserving clip length.
- Multi-clip selection + group move is a stretch goal; single-clip suffices for MVP.

### 4. Clip trim edges
- Mouse-down on the left/right 6-px hit zone of a clip → edge drag.
- Left-edge drag: adjusts `source_offset` and `start_time` together (shrinks from the start).
- Right-edge drag: adjusts `end_time` only.
- Clamp: can't trim past source duration; min clip length 100 ms.
- Commits via `/audio-clips/update` on mouse-up.

### 5. Drag/drop unlinked audio onto a lane
- Dragging an audio file from the Bin or OS onto an audio lane creates a new clip at the drop position on that track.
- Flow: import file → `pool_segments` row with `kind='audio'` (if new) → create `audio_clips` row with no `audio_clip_links` entry.
- No transition created, no link — this is the "music bed" / "SFX" path.

### 6. Cross-highlight on selection (deferred from Task 89)
- Selecting a transition adds a glow border to its linked audio clip(s).
- Selecting a linked audio clip adds a glow to its transition.
- Visual only; no new selection state required beyond reading `audio_clip_links`.

### 7. Optimistic extraction ghost (deferred from Task 89)
- On video drop / pool-video assign / duplicate, show a placeholder "generating audio…" block on the paired audio track at the expected `[start_time, end_time]`.
- Replaces the ghost with the real clip when the audio link result lands in the refreshed timeline data.
- If the video had no audio stream, the ghost disappears silently.

---

## Success Criteria

- [ ] Delete a clip from its right-click menu → gone from the timeline, link row cleared; undo restores it.
- [ ] Delete a track with clips → confirmation, then both vanish; undo restores both.
- [ ] Add a new audio track via the "+" button → appears immediately under existing tracks at the next `display_order`.
- [ ] Rename a track by double-clicking its header; blur commits.
- [ ] Drag a track header to a new vertical position → reorder persists after refresh.
- [ ] Body-drag a clip → follows cursor, snaps to seconds by default, commits new position on release.
- [ ] Edge-drag a clip → resizes with correct source-offset handling; can't trim below 100 ms or past source.
- [ ] Drop an audio file onto a lane (from Bin) → new clip appears on that lane at the drop position; no transition created.
- [ ] Click a transition → its linked audio clip has a visible highlight border.
- [ ] Drop a video onto a transition → an optimistic audio ghost appears and resolves to the real clip within ~2 s.
- [ ] All edits undoable via the existing `undo_groups` infrastructure.

---

## Key Files to Create / Modify

**New**:
- `src/components/editor/AudioLaneHeader.tsx` — header with mute/enabled toggles, rename, context menu
- `src/components/editor/AudioClipContextMenu.tsx` — right-click menu for clips
- Hooks: `useAudioClipDrag.ts`, `useAudioClipTrim.ts`

**Modified**:
- `src/components/editor/AudioLane.tsx` — drag+trim hit zones, drop target, context menu, cross-highlight
- `src/components/editor/Timeline.tsx` — "+ Add track" button, cross-highlight plumbing, ghost overlay
- `src/lib/audio-client.ts` — `postAddAudioTrack`, `postDeleteAudioTrack`, `postReorderAudioTracks`, `postDeleteAudioClip`
- `scenecraft-engine/src/scenecraft/api_server.py` — if any endpoint is missing for the unlinked-drop flow; otherwise reuse
- `src/components/editor/BinPanel.tsx` — drag-source support for audio files onto the timeline

---

## Risks

- **Move/trim undo coverage**: M9's propagation was hooked at `db.update_keyframe`. Audio-clip direct edits go through `db.update_audio_clip`, which should already participate in `undo_groups` from the M7 schema, but verify once clip edits start landing.
- **Overlap semantics on move**: moving a clip to overlap an existing one on the same track is fine (equal-power crossfade handles it at render time) but the UI should make the overlap visible.
- **Unlinked-drop import flow**: the Bin's audio import path may not exist yet in the right shape — may need a tiny backend `POST /audio-clips/add-from-file` that creates the `pool_segments` entry + `audio_clips` row atomically, to keep the UI simple.
- **Feature ordering**: If M14 ships first, users can hear their edits. If M15 ships first, edits are still blind. Either order works; recommend parallel tracks if engineering bandwidth allows.

---

## Out of Scope

- Sample-accurate audio scrubbing (playhead drag → audible audio) — depends on M14.
- Copy mode on clip drag (alt+drag to duplicate) — can fold in later, follows M10 pattern.
- Cross-track clip move — included via drop-on-other-lane gesture; full multi-select cross-track parity with video M10 is a stretch goal.
- Audio effects, filters, sends — separate milestone.

---

## Tasks

- [Task 119](../tasks/milestone-15-audio-clip-editing/task-119-clip-and-track-delete.md) — Clip & track delete via right-click context menu (2h)
- [Task 120](../tasks/milestone-15-audio-clip-editing/task-120-track-add-rename-reorder.md) — Track add / rename / reorder + mute/enabled header toggles (3h)
- [Task 121](../tasks/milestone-15-audio-clip-editing/task-121-clip-body-drag-move.md) — Clip body-drag move (same-track, snap-to-second) (4h)
- [Task 122](../tasks/milestone-15-audio-clip-editing/task-122-clip-trim-edges.md) — Clip trim edges (left adjusts offset+start, right adjusts end) (3h)
- [Task 123](../tasks/milestone-15-audio-clip-editing/task-123-unlinked-audio-drop.md) — Drag/drop unlinked audio file onto a lane (4h)
- [Task 124](../tasks/milestone-15-audio-clip-editing/task-124-cross-highlight-linked.md) — Cross-highlight linked transition ↔ audio on selection (2h)
- [Task 125](../tasks/milestone-15-audio-clip-editing/task-125-extraction-ghost.md) — Optimistic extraction ghost during video drop / auto-link (2h)

---

**Status**: Not Started
**Next Task**: Task 119 — Clip & track delete
