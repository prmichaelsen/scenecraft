# Task 84: Slot Routing + Linked-Audio Insert Endpoint

**Milestone**: [M9 - Audio Tracks and Audio Clips](../../milestones/milestone-9-audio-tracks-and-clips.md)  
**Design Reference**: [Audio Tracks and Audio Clips](../../design/local.audio-tracks-and-clips.md)  
**Estimated Time**: 5-7 hours  
**Dependencies**: Tasks 82 (schema), 83 (extract)  
**Status**: Not Started  

---

## Objective

Implement the slot-matching algorithm (video z_order N ↔ audio display_order N, bump on time-range overlap, create track when no slot fits) and extend the transition-insert path to create linked audio atomically.

---

## Context

Design doc sections "Slot Pairing Rule" and "Insert Routing" are canonical.

"Occupied" = at least one existing clip on the target audio track has `[start_time, end_time]` overlapping the new clip's range. Empty tracks or tracks with clips outside the range are valid targets.

---

## Steps

### 1. `src/scenecraft/audio/routing.py`

```python
def resolve_audio_track_for_insert(project_dir: Path, video_track_z: int,
                                   insert_start: float, insert_end: float) -> str:
    """Return an audio track ID, creating a track if none of the candidate
    slots is free. Never returns None."""
```

Algorithm:
1. Sort audio tracks by `display_order` ascending
2. `target = first track where display_order == video_track_z` (or None)
3. If no target: create an audio track with `display_order = video_track_z`, return its id
4. While any clip on `target` overlaps `[insert_start, insert_end]`:
   - `next = first track where display_order > target.display_order` (or None)
   - If no next: create track with `display_order = target.display_order + 1`, return its id
   - `target = next`
5. Return `target.id`

### 2. Extend transition-insert in `api_server.py`

The existing transition-insert path (pool drop, Veo completion, etc.) gains a post-step: after the transition row is created, if its source has an audio stream (via `probe_audio_stream`), extract, create `audio_clips` row, route via `resolve_audio_track_for_insert`, and insert `audio_clip_links` row with `offset = 0`.

Wrap transition insert + audio insert in a single transaction.

### 3. New endpoint: `POST /api/projects/:name/insert-linked-audio`

Used by the frontend drag/drop path when the dropped item is already known to have audio. Request body:

```json
{
  "transition_id": "tr_...",
  "source_video_path": "...",
  "video_track_z": 1,
  "start_time": 10.0,
  "end_time": 15.0
}
```

Response: `{ audio_clip_id, audio_track_id, audio_track_created: bool, link_offset: 0 }`

### 4. WebSocket broadcast

On successful linked-audio insert, broadcast `{ type: "audio_clip_linked", transition_id, audio_clip_id, audio_track_id }` so the frontend can update incrementally without a full refresh.

### 5. Tests

- Empty slot match: video z=1, no audio tracks → creates audio track with display_order=1
- Direct slot match: video z=2, audio display_order=2 exists and empty → uses it
- Overlap bump: target has clip at 10..20, insert at 15..25 → bumps to next slot
- Recursive bump: multiple tracks all occupied → creates new slot
- No audio stream → transition still created, no linked audio

---

## Verification

- [ ] `resolve_audio_track_for_insert` returns a valid track ID in all cases
- [ ] Empty audio tracks match directly
- [ ] Overlap-only bump works; non-overlapping clips don't trigger bump
- [ ] Auto-created tracks get correct `display_order`
- [ ] `POST /api/projects/:name/insert-linked-audio` returns expected shape
- [ ] WebSocket event fires on success
- [ ] Transaction rollback on failure leaves DB consistent

---

**Next Task**: [Task 85: Transition move/trim propagation](task-85-transition-propagation.md)
