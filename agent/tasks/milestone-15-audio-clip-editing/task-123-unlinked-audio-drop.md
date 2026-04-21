# Task 123: Drag/Drop Unlinked Audio File onto a Lane

**Milestone**: [M15](../../milestones/milestone-15-audio-clip-editing.md)
**Estimated Time**: 3-5 hours
**Dependencies**: Task 120 (track management) recommended
**Status**: Not Started

---

## Objective

Let users drag an audio file from the Bin (or directly from the OS) onto an audio lane and have it appear as a new, unlinked clip at the drop position. This is the "music bed" / "SFX" path — no transition created, no link row.

---

## Context

M9's auto-link path creates audio clips as side-effects of video drops. For standalone music/SFX the user needs a way to place audio directly. The `audio_clips` schema already supports this — we just need the drop gesture + a small atomic endpoint.

---

## Steps

### 1. Bin: make audio files draggable

In `BinPanel.tsx`, items with `kind='audio'` need a `draggable` attribute and a dataTransfer payload that includes the `pool_segment_id` (if already imported) or the source `poolPath`.

### 2. `AudioLane`: drop target

Add `onDragOver` + `onDrop` handlers on the lane div. Convert the cursor x to timeline seconds via `pxPerSec`:

```typescript
onDrop={(e) => {
  const rect = e.currentTarget.getBoundingClientRect()
  const x = e.clientX - rect.left + scrollLeft
  const dropTime = x / pxPerSec
  const payload = JSON.parse(e.dataTransfer.getData('application/json'))
  createUnlinkedAudioClip(track.id, payload.poolSegmentId, dropTime)
}}
```

### 3. Backend: `POST /api/projects/:name/audio-clips/add-from-pool`

New endpoint that, given `{ trackId, poolSegmentId, startTime }`:
1. Looks up the pool_segment, asserts `kind='audio'`, reads its `duration_seconds`.
2. Creates an `audio_clips` row with `source_path = pool_segment.poolPath`, `start_time = startTime`, `end_time = startTime + duration`, `source_offset = 0`.
3. Does NOT create any link row.

Returns `{ id: string }`.

For OS drop (not from Bin): first import the file via the existing upload pipeline (or reuse `/import` if it exists), get back a `pool_segment_id`, then call this endpoint. Two-phase.

### 4. Client helper

```typescript
export function postAddAudioClipFromPool(
  project: string,
  { trackId, poolSegmentId, startTime }: { trackId: string; poolSegmentId: string; startTime: number }
): Promise<{ id: string }>
```

### 5. Test on the target project

Drag a music bed onto A1 → appears at the drop position as a new clip. Play (if M14 is in) — hear it.

### 6. Tests

- Unit: backend endpoint with fake pool_segment → clip row has expected fields + no link row.
- E2E: drop audio file from Bin → new clip on the chosen lane.
- Fail case: drop non-audio pool_segment → 400 "expected kind=audio".

---

## Verification

- [ ] Audio files in the Bin are draggable
- [ ] Drop on an audio lane creates a clip at the drop position
- [ ] No transition or link row created
- [ ] Duration matches source
- [ ] OS drag-and-drop also works (imports first, then places)

---

**Next Task**: [Task 124 — Cross-highlight linked](task-124-cross-highlight-linked.md)
