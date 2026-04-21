# Task 85: Transition Move/Trim Propagation to Linked Audio

**Milestone**: [M9 - Audio Tracks and Audio Clips](../../milestones/milestone-9-audio-tracks-and-clips.md)  
**Design Reference**: [Audio Tracks and Audio Clips](../../design/local.audio-tracks-and-clips.md)  
**Estimated Time**: 4-5 hours  
**Dependencies**: Task 84 (routing/insert)  
**Status**: Not Started  

---

## Objective

When a transition moves or its start is trimmed, apply the corresponding delta to its linked audio clips per the design's invariant table, preserving length. Trimming the transition's end does nothing to audio.

---

## Context

Invariant table (design doc) is canonical. Summary:

- **Move transition by Δ**: linked clips' `start_time += Δ`, `end_time += Δ` (link.offset and source_offset unchanged)
- **Trim transition start by Δ**: same as move (linked clips slide forward)
- **Trim transition end**: no effect on audio

Bonus: after propagation, if a moved clip now overlaps another clip on the same track, the overlap is allowed (equal-power crossfade derived at render — Task 91).

---

## Steps

### 1. Hook into existing transition update endpoint

Find the POST/PATCH path that mutates `transitions.start_time` / `duration_seconds` in `api_server.py`. After the transition update, compute Δ and call:

```python
def propagate_transition_move(project_dir: Path, transition_id: str, delta: float):
    """Shift every linked audio clip's start_time/end_time by delta."""
```

Trim-start case: the transition's start moves forward by Δ (same sign as move), so the propagation is the same formula.

Trim-end case: nothing to do.

### 2. Transaction boundary

Wrap transition update + linked-clip shifts in one transaction. Existing undo-group infrastructure should apply — verify by checking an undo-group wrapper exists around transition updates and extend it to cover linked-audio shifts.

### 3. WebSocket broadcast

`{ type: "audio_clips_shifted", transition_id, delta, affected_clip_ids: [...] }` so the frontend can animate without a full refresh.

### 4. Tests

- Move transition by +5s → linked audio clips' start_time and end_time +5
- Trim transition start by +2s → same behaviour (clips shift +2)
- Trim transition end by -3s → linked audio unchanged
- Transition with no links → no-op
- Multiple linked clips → all shift by same delta

---

## Verification

- [ ] Move-by-delta propagates cleanly to all linked audio clips
- [ ] Trim-start propagates identically
- [ ] Trim-end does not touch audio
- [ ] All operations undo/redo correctly
- [ ] WebSocket event describes affected clips
- [ ] Tests pass

---

**Next Task**: [Task 86: Cascade delete](task-86-cascade-delete.md)
