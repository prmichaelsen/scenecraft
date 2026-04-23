# Task 104b: Drag Stem → Timeline (Overwrite-with-Split)

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md) — Drag Stem → Timeline
**Estimated Time**: 5 hours
**Dependencies**: [Task 100b: isolations schema](task-100b-isolations-schema.md), [Task 102: Backend plugin](task-102-backend-plugin.md), [Task 104: AudioIsolationsPanel](task-104-audio-clip-panel.md)
**Status**: Not Started

---

## Objective

Accept `application/x-scenecraft-stem` drops on the timeline and materialize the stem as a real `audio_clip` with **overwrite-with-split** overlap semantics (DaVinci-style: dropped clip wins, overlapping existing clips are trimmed, consumed, or split). Single undo group per drop. Stems dropped on transitions are deferred to P2.

Implements in `scenecraft/src/components/editor/AudioLane.tsx` (frontend drop handler + overlap resolver) and `scenecraft-engine/src/scenecraft/api_server.py` (a new batched mutation endpoint, so the drop is one undo group).

---

## Steps

### 1. Backend: `POST /audio-clips/batch-ops`

One endpoint that applies a list of `audio_clip` mutations inside a single `undo_begin` group. Body:

```json
{
  "label": "Drop stem: vocal",
  "ops": [
    { "op": "trim",   "id": "audio_clip_...", "end_time": 12.4 },
    { "op": "split",  "id": "audio_clip_...", "at": 15.0, "new_id": "audio_clip_..." },
    { "op": "delete", "id": "audio_clip_..." },
    { "op": "insert", "clip": { "id": "...", "track_id": "...", "source_path": "pool/segments/...wav",
                                "start_time": 12.4, "end_time": 20.0 } }
  ]
}
```

Response: `{ success: true }` or `{ error }`. All ops run under `undo_begin(label)`; one undo entry. `_retry_on_locked` wraps.

Op semantics:
- `trim`: `UPDATE audio_clips SET start_time=?, end_time=? WHERE id=?` (pass only the field you want to change; null/undefined = no change).
- `split`: `UPDATE audio_clips SET end_time=? WHERE id=old_id` for the left half; `INSERT` a new row with `id=new_id`, cloned fields, `start_time=at`, preserving original `end_time`. `source_offset` of the right half = original `source_offset + (at − original_start_time)`.
- `delete`: soft-delete via `deleted_at=NOW()` (same pattern as existing delete paths).
- `insert`: `INSERT INTO audio_clips (...)` with the provided row.

Keep the endpoint's op validation strict: unknown op → `{error}`. No partial writes on error — wrap all ops in a transaction.

### 2. Backend tests for `/audio-clips/batch-ops`

`tests/test_audio_clip_batch_ops.py`:
- Trim only: row updated, one undo group, `audio_clips.end_time` reflects change
- Split: left row `end_time` updated, right row inserted with correct `source_offset`
- Mixed trim + insert + delete: all land, exactly one new undo_group
- Invalid op payload → 400, no writes applied
- Undo group round-trip: one undo → all ops reverted

### 3. Frontend: `resolveOverlapsWithSplit` (pure function)

Given `(droppedRange, existingClipsOnTrack)`, return an `ops` list following the design rules. Pure function → unit-testable without DOM.

```typescript
type Range = { start: number; end: number }
type ClipRow = { id: string; start_time: number; end_time: number; source_offset: number; /* …others passed through */ }

export function resolveOverlapsWithSplit(
  dropped: Range,
  existing: ClipRow[],
  genId: () => string,
): BatchOp[] {
  const ops: BatchOp[] = []
  for (const c of existing) {
    const overlap = !(c.end_time <= dropped.start || c.start_time >= dropped.end)
    if (!overlap) continue
    const coversLeft  = dropped.start <= c.start_time
    const coversRight = dropped.end   >= c.end_time
    if (coversLeft && coversRight) {
      ops.push({ op: 'delete', id: c.id })
    } else if (coversLeft) {
      ops.push({ op: 'trim', id: c.id, start_time: dropped.end, source_offset: c.source_offset + (dropped.end - c.start_time) })
    } else if (coversRight) {
      ops.push({ op: 'trim', id: c.id, end_time: dropped.start })
    } else {
      // dropped fits INSIDE existing → split: left retains old, right new
      const rightId = genId()
      ops.push({ op: 'trim',  id: c.id, end_time: dropped.start })
      ops.push({ op: 'insert', clip: {
        id: rightId, track_id: c.track_id, source_path: c.source_path,
        start_time: dropped.end, end_time: c.end_time,
        source_offset: c.source_offset + (dropped.end - c.start_time),
      } })
    }
  }
  return ops
}
```

Left-trim must advance `source_offset` to keep audio-sync correct; right-trim does not. This is the only non-obvious piece and must be covered by tests.

### 4. Frontend: `AudioLane.tsx` drop handler

```tsx
const onDragOver = (ev: React.DragEvent) => {
  if (ev.dataTransfer.types.includes('application/x-scenecraft-stem')) {
    ev.preventDefault()
    ev.dataTransfer.dropEffect = 'copy'
  }
}

const onDrop = async (ev: React.DragEvent) => {
  const raw = ev.dataTransfer.getData('application/x-scenecraft-stem')
  if (!raw) return
  const stem = JSON.parse(raw) as {
    pool_segment_id: string; pool_path: string; stem_type: 'vocal' | 'background'; duration_seconds: number
  }

  const cursorSec = pixelsToSeconds(ev.clientX, laneBounds, zoom, scrollX)
  const dropped = { start: cursorSec, end: cursorSec + stem.duration_seconds }

  const trackClips = audioClipsOnTrack(this.trackId)
  const ops = resolveOverlapsWithSplit(dropped, trackClips, () => newAudioClipId())

  const newClipId = newAudioClipId()
  ops.push({
    op: 'insert',
    clip: {
      id: newClipId,
      track_id: resolveTargetTrackId(ev),   // empty lane → create + use; existing → reuse
      source_path: stem.pool_path,
      start_time: dropped.start,
      end_time: dropped.end,
      source_offset: 0,
      name: `${sourceLabel} · ${stem.stem_type}`,
    }
  })

  await fetch(`${API_URL}/api/projects/${projectName}/audio-clips/batch-ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: `Drop ${stem.stem_type} stem`, ops }),
  })
  router.invalidate()
}
```

Empty lane → create a new `audio_track` before the insert. Reuse the existing helper (`create_audio_track` or equivalent) and thread the new `track_id` through.

### 5. Visual affordance during drag

- `onDragOver` over an audio lane → highlight lane border (amber for empty lane / blue for existing track).
- Ghost preview: render a semi-transparent box at the drop location showing the range the stem will occupy; update as mouse moves.
- On drag-end without drop, clear highlight.

These are polish but cheap — one state + one effect in `AudioLane`.

### 6. Drops on transitions (deferred)

Per design §Drag Stem → Timeline: dropping on a transition is P2. For MVP, reject the drop if the drop target is a transition (do nothing, clear ghost, don't call the endpoint).

### 7. Frontend tests

`src/components/editor/__tests__/resolveOverlapsWithSplit.test.ts`:
- Dropped fully covers existing → `delete`
- Dropped covers existing's LEFT edge → `trim` start_time forward; source_offset advanced correctly
- Dropped covers existing's RIGHT edge → `trim` end_time back; source_offset untouched
- Dropped fits INSIDE existing → split: `trim` left half + `insert` right half; right's source_offset correct
- No overlap → empty ops
- Multiple existing clips → correct ops per clip, stable ordering

`src/components/editor/__tests__/AudioLane-drop.test.tsx`:
- Drag stem onto empty lane → creates track → inserts clip
- Drag stem fully covering an existing clip → existing gets delete op; new clip inserted
- Drag stem into middle of a long clip → split op fires; two resulting clips round-trip
- Router invalidation fires after successful POST
- Drop on a transition does nothing (no POST, no state change)

---

## Verification

- [ ] `POST /audio-clips/batch-ops` endpoint exists; accepts the 4 op kinds; runs inside a single `undo_begin`
- [ ] `resolveOverlapsWithSplit` pure function correct for all 5 overlap cases (including no-overlap)
- [ ] Left-trim advances `source_offset`; right-trim does not; split's right half has correct `source_offset`
- [ ] `AudioLane.tsx` accepts `application/x-scenecraft-stem` drops
- [ ] Dropping onto an empty lane creates a new audio_track
- [ ] Dropping onto an existing track with overlap applies the correct combination of trim/split/delete
- [ ] One undo group per drop — single Ctrl+Z reverts the entire drop including new track + all trims/splits
- [ ] Drops on transitions do nothing in MVP (logged but not rejected visibly; no backend call)
- [ ] Drag-over highlight + ghost preview render; clear correctly on drag-leave / drag-end
- [ ] All frontend + backend tests pass
