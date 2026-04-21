# Task 119: Clip & Track Delete

**Milestone**: [M15](../../milestones/milestone-15-audio-clip-editing.md)
**Estimated Time**: 1.5-2 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Let users delete individual audio clips and entire audio tracks directly from the Timeline via a right-click context menu.

---

## Steps

### 1. Clip delete

- `AudioClipContextMenu.tsx` — new component, mirrors pattern of existing clip context menus.
- Right-click on an `AudioClipBlock` → opens menu with: "Delete clip".
- "Delete clip" → confirm (tiny inline dialog or just fire), then `postDeleteAudioClip(project, clip.id)`.
- New client helper in `audio-client.ts`: `postDeleteAudioClip`. Hits existing `/audio-clips/update` with `deleted_at = now` (backend soft-delete pattern).
- Also drops `audio_clip_links` rows for this clip; a new tiny backend route `POST /audio-clips/:id/delete` is cleanest — handles link cleanup atomically.

### 2. Track delete

- Right-click on the `AudioLane` header → menu with "Delete track…".
- If the track has clips: confirm dialog "Delete track + N clips? (undoable)".
- Call `postDeleteAudioTrack(project, trackId)` (new helper → existing `/audio-tracks/delete`).
- Backend `db.delete_audio_track` already cascade-soft-deletes clips on that track. Verify cascade is undo-group-wrapped.

### 3. Refresh

After either delete, call `refreshTimeline()` so `localAudioTracks` updates.

### 4. Undo coverage

Delete must participate in `undo_groups`. Audit: `db.update_audio_clip` and `db.delete_audio_track` — if not already wrapped, wrap them under an undo group.

### 5. Tests

- E2E: create clip → delete via context menu → assert absent from `GET /audio-tracks` response.
- E2E: create track with 2 clips → delete track → assert both clips soft-deleted.
- Undo restores clip/track.

---

## Verification

- [ ] Right-click a clip → "Delete clip" works, clip vanishes from timeline
- [ ] Right-click a lane header → "Delete track…" works with confirm when non-empty
- [ ] Undo restores the deletion
- [ ] Link rows cleaned up on clip delete

---

**Next Task**: [Task 120 — Track add/rename/reorder](task-120-track-add-rename-reorder.md)
