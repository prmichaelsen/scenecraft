# Task 54: Editing Precision Tools

**Milestone**: [M4 - AI Assistant Chat](../../milestones/milestone-4-ai-assistant-chat.md)
**Design Reference**: [AI Assistant Chat](../../design/local.ai-assistant-chat.md)
**Estimated Time**: 6 hours
**Dependencies**: [Task 53: Structure & Creation Tools](task-53-structure-creation-tools.md)
**Status**: Not Started

---

## Objective

Add tools for fine-grained timeline editing: splitting a transition at a specific time, and assigning pool segments (images/videos) to keyframes and transitions.

Implements in `scenecraft-engine/src/scenecraft/chat.py`.

---

## Scope

Three new tools:

1. **`split_transition(transition_id, at_time)`** — divide a transition into two transitions at a time point, creating a new keyframe between them.
2. **`assign_keyframe_image(keyframe_id, pool_segment_id)`** — mark a pool_segment as the keyframe's selected image.
3. **`assign_pool_video(transition_id, pool_segment_id, slot?)`** — mark a pool_segment as the transition's selected video for a given slot.

---

## Steps

### 1. `split_transition` Tool

**Tool definition**:

```python
SPLIT_TRANSITION_TOOL = {
    "name": "split_transition",
    "description": (
        "Divide a transition into two transitions at the given time. Creates a new "
        "keyframe at the split point; the original transition becomes two shorter "
        "transitions (from → new_kf, new_kf → to). Wrapped in an undo group."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "transition_id": {"type": "string"},
            "at_time": {
                "type": "string",
                "description": "Absolute timeline time as 'm:ss' or 'mm:ss.fff' or seconds as a string. Must fall strictly between the transition's from and to keyframe timestamps.",
            },
            "new_keyframe_prompt": {
                "type": "string",
                "description": "Optional prompt for the inserted keyframe; defaults to empty.",
            },
        },
        "required": ["transition_id", "at_time"],
    },
}
```

**Handler**:
- Fetch transition → fetch `from_kf` and `to_kf` → fetch both keyframes.
- Parse `at_time` (reuse existing `_parse_timestamp` helper in scenecraft if present; otherwise convert 'm:ss[.fff]' → seconds here).
- Validate: `from_kf.ts < at_time < to_kf.ts`. If violated, error.
- `undo_begin(project_dir, f"Chat: split transition {tr_id} at {at_time}")`.
- Create new keyframe:
  - `new_kf_id = next_keyframe_id(project_dir)`.
  - `add_keyframe(project_dir, {"id": new_kf_id, "timestamp": at_time, "prompt": new_keyframe_prompt or "", "track_id": transition["track_id"], "section": "", ...})`.
- Create new transition (`tr_b`) going from `new_kf_id` → original `to_kf`:
  - `new_tr_id = next_transition_id(project_dir)`.
  - `add_transition(project_dir, {id: new_tr_id, from: new_kf_id, to: original_to_kf_id, duration_seconds: <recalc>, track_id: ..., slots: transition["slots"], action: transition["action"], ...})` — duplicate all relevant fields from the original transition so the two halves inherit style/curves.
- Update original transition (`tr_a`) to point to the new keyframe:
  - `update_transition(project_dir, tr_id, to=new_kf_id, duration_seconds=<recalc>)`.
- Return `{original_transition_id, new_keyframe_id, new_transition_id, split_time}`.

**Edge cases**:
- Transition already deleted → error.
- Time equal to or outside keyframe range → error with clear message.
- Original transition has candidates (`tr_candidates`) — don't try to duplicate those onto the new transition; user can regenerate. Document this in the tool description.

### 2. `assign_keyframe_image` Tool

**Tool definition**:

```python
ASSIGN_KEYFRAME_IMAGE_TOOL = {
    "name": "assign_keyframe_image",
    "description": (
        "Set the selected image candidate for a keyframe by pool_segment ID. "
        "The keyframe's candidates list must contain the referenced pool_segment. "
        "Wrapped in an undo group."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "keyframe_id": {"type": "string"},
            "pool_segment_id": {"type": "string"},
        },
        "required": ["keyframe_id", "pool_segment_id"],
    },
}
```

**Handler**:
- Fetch keyframe. Parse `candidates` (JSON array of `{pool_segment_id, ...}` or ID strings — check existing schema).
- Determine selected index: find position of `pool_segment_id` in `candidates`; if not found, error with list of valid IDs.
- `undo_begin(project_dir, f"Chat: assign image for {kf_id}")`.
- `update_keyframe(project_dir, kf_id, selected=<index>)`.
- Return `{keyframe_id, selected_index, pool_segment_id}`.

### 3. `assign_pool_video` Tool

**Tool definition**:

```python
ASSIGN_POOL_VIDEO_TOOL = {
    "name": "assign_pool_video",
    "description": (
        "Set the selected video candidate for a transition slot. The tr_candidates "
        "junction must have a row linking the transition, slot, and pool_segment. "
        "Wrapped in an undo group."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "transition_id": {"type": "string"},
            "pool_segment_id": {"type": "string"},
            "slot": {"type": "integer", "default": 0, "minimum": 0},
        },
        "required": ["transition_id", "pool_segment_id"],
    },
}
```

**Handler**:
- Verify transition exists and slot is valid (< transition.slots).
- Verify `tr_candidates` has a row for (transition_id, slot, pool_segment_id); if missing, error with the valid candidate IDs for that slot.
- `undo_begin(project_dir, f"Chat: assign video for {tr_id} slot {slot}")`.
- Read current `selected` (list[int|null]) and set `selected[slot] = <rank_index>` or `selected[slot] = pool_segment_id` — check how the frontend expects this; reuse logic from the existing `update-transition-candidates` endpoint in `api_server.py`.
- `update_transition(project_dir, tr_id, selected=selected)`.
- Return `{transition_id, slot, pool_segment_id}`.

### 4. Register Tools + Update System Prompt

- Add all three to `TOOLS`.
- Update system prompt:
  - "split_transition — divide a transition at a time point, inserting a new keyframe."
  - "assign_keyframe_image — pick which generated image is the selected one for a keyframe."
  - "assign_pool_video — pick which generated video is selected for a transition slot."

### 5. Tests

- `split_transition`: verify the original transition points to the new keyframe, the new transition goes from new_kf → original_to, durations sum correctly, all three mutations share one undo group.
- `assign_keyframe_image`: valid case works; invalid pool_segment_id returns error listing available candidates.
- `assign_pool_video`: valid case works; invalid slot / invalid pool_segment_id both return errors.

---

## Verification

- [ ] `split_transition` produces 2 transitions + 1 new keyframe + 1 undo group
- [ ] Split at invalid time (before from_kf or after to_kf) returns error
- [ ] `assign_keyframe_image` updates `selected` to the index of the chosen pool_segment
- [ ] Assigning a pool_segment not in the keyframe's candidates returns an error listing valid IDs
- [ ] `assign_pool_video` updates the correct slot in the `selected` JSON array
- [ ] Invalid slot (>= transition.slots) returns error
- [ ] All three tools wrap their mutations in a single undo group per call
