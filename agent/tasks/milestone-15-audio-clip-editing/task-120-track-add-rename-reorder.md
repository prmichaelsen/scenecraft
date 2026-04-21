# Task 120: Track Add / Rename / Reorder + Header Controls

**Milestone**: [M15](../../milestones/milestone-15-audio-clip-editing.md)
**Estimated Time**: 2-3 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Track management from the Timeline: add a new audio track, rename an existing one, reorder via drag, and make the lane-header mute + enabled toggles actually clickable.

---

## Steps

### 1. `AudioLaneHeader.tsx`

Extract the lane header from `AudioLane.tsx` into its own component. Contains:
- `A{N}` order label
- Track name (double-click to enter inline edit mode)
- Mute toggle (🔇)
- Enabled toggle (👁️)
- Drag handle for reorder

### 2. Add track

- "+ Add audio track" button at the bottom of the audio section in `Timeline.tsx`.
- Calls `postAddAudioTrack(project, { name: "Audio Track N+1" })` via new client helper.
- `refreshTimeline()` picks up the new track.

### 3. Rename

- Double-click the name → swap to `<input>` with the current name.
- On Enter / blur: `postUpdateAudioTrack(project, id, { name: newName })`.
- On Escape: revert.

### 4. Reorder

- Drag the header vertically; use the existing dockview / drag-reorder pattern from video tracks if present.
- Compute the new order on drop; POST `/audio-tracks/reorder` with the full `trackIds` array.
- Optimistic local reorder for snap-feel; revert on server error.

### 5. Mute + Enabled toggles

- Clickable icons in the header. Already have `track.muted` / `track.enabled` in state.
- Click → `postUpdateAudioTrack(project, id, { muted: !track.muted })` (or `enabled`).
- Propagate to the mixer via `mixer.updateTrack(id)` if M14 is in place; otherwise route invalidate.

### 6. Client helpers

Extend `audio-client.ts`:

```typescript
export function postAddAudioTrack(project, { name }): Promise<{ id: string }>
export function postDeleteAudioTrack(project, trackId): Promise<void>
export function postReorderAudioTracks(project, trackIds: string[]): Promise<void>
```

All three endpoints already exist backend-side.

### 7. Tests

- Component tests for the header: rename input behaviour, mute toggle click fires POST.
- E2E: add track → rename → reorder → mute → all persist across reload.

---

## Verification

- [ ] "+ Add track" button creates a new track at the next `display_order`
- [ ] Double-click rename works, commits on blur
- [ ] Drag reorder persists after refresh
- [ ] Mute + enabled toggles clickable and dim the lane accordingly

---

**Next Task**: [Task 121 — Clip body-drag move](task-121-clip-body-drag-move.md)
