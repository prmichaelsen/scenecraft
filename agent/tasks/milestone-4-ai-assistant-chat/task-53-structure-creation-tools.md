# Task 53: Structure & Creation Tools

**Milestone**: [M4 - AI Assistant Chat](../../milestones/milestone-4-ai-assistant-chat.md)
**Design Reference**: [AI Assistant Chat](../../design/local.ai-assistant-chat.md)
**Estimated Time**: 5 hours
**Dependencies**: [Task 16: Tool Calling](task-16-tool-calling.md)
**Status**: Not Started

---

## Objective

Give Claude the ability to create new keyframes and perform generic updates on keyframes and transitions. Unlocks storyboarding from scratch and broader metadata edits (labels, tracks, sections, blend modes, opacity, tags, remap, action) without multiplying narrow tools.

Implements in `scenecraft-engine/src/scenecraft/chat.py` following the same pattern as the tools already added in commit `278063d` (sql_query + update_keyframe_prompt/timestamp + update_curve/transform_curve + delete/batch_delete).

---

## Scope

Three new tools:

1. **`add_keyframe`** — insert a new keyframe.
2. **`update_keyframe`** — generic field update (supersedes `update_keyframe_prompt` and `update_keyframe_timestamp` in general use; keep the specific tools too since they're already working — Claude will pick the narrowest applicable one).
3. **`update_transition`** — generic field update for transition metadata (not curves — those already have tools).

---

## Steps

### 1. `add_keyframe` Tool

**Tool definition** (in `chat.py` alongside other TOOLS):

```python
ADD_KEYFRAME_TOOL = {
    "name": "add_keyframe",
    "description": "Insert a new keyframe on the timeline. Auto-generated ID. Wrapped in an undo group.",
    "input_schema": {
        "type": "object",
        "properties": {
            "timestamp": {"type": "string", "description": "'m:ss', 'mm:ss.fff', or seconds as a string."},
            "prompt": {"type": "string", "description": "Prompt text for image generation."},
            "track_id": {"type": "string", "description": "Optional; defaults to 'track_1'."},
            "section": {"type": "string", "description": "Optional narrative section label."},
            "label": {"type": "string", "description": "Optional display label."},
        },
        "required": ["timestamp", "prompt"],
    },
}
```

**Handler**:
- Validate `timestamp` is a non-empty string.
- `kf_id = next_keyframe_id(project_dir)` (existing helper in `db.py`).
- `undo_begin(project_dir, f"Chat: add keyframe {kf_id}")`.
- `add_keyframe(project_dir, {"id": kf_id, "timestamp": ..., "prompt": ..., "track_id": track_id or "track_1", "section": section or "", "label": label or "", ...})`.
- Return `{keyframe_id, timestamp, prompt, track_id, section, label}`.

### 2. `update_keyframe` Tool (Generic)

**Tool definition**:

```python
UPDATE_KEYFRAME_TOOL = {
    "name": "update_keyframe",
    "description": "Update any subset of a keyframe's fields in one call. Wrapped in an undo group. Pass only the fields you want to change.",
    "input_schema": {
        "type": "object",
        "properties": {
            "keyframe_id": {"type": "string"},
            "timestamp": {"type": "string"},
            "prompt": {"type": "string"},
            "track_id": {"type": "string"},
            "section": {"type": "string"},
            "label": {"type": "string"},
            "label_color": {"type": "string", "description": "Hex color like '#ff8800'."},
            "blend_mode": {"type": "string", "description": "'normal', 'add', 'multiply', 'screen', 'overlay'."},
            "opacity": {"type": "number", "minimum": 0, "maximum": 1},
            "refinement_prompt": {"type": "string"},
        },
        "required": ["keyframe_id"],
    },
}
```

**Handler**:
- Validate keyframe exists via `get_keyframe`.
- Collect non-None fields from input (excluding `keyframe_id`); error if empty.
- `undo_begin(project_dir, f"Chat: update keyframe {kf_id}")`.
- `update_keyframe(project_dir, kf_id, **fields)`.
- Return `{keyframe_id, updated_fields: [...keys...], old_values: {...}}` — include old values so Claude can confirm the change.

### 3. `update_transition` Tool (Generic)

**Tool definition**:

```python
UPDATE_TRANSITION_TOOL = {
    "name": "update_transition",
    "description": "Update any subset of a transition's metadata fields (not curves — use update_curve/update_transform_curve for those). Wrapped in an undo group.",
    "input_schema": {
        "type": "object",
        "properties": {
            "transition_id": {"type": "string"},
            "duration_seconds": {"type": "number", "minimum": 0},
            "slots": {"type": "integer", "minimum": 1},
            "action": {"type": "string", "description": "'crossfade', 'cut', 'keep', etc."},
            "label": {"type": "string"},
            "label_color": {"type": "string"},
            "track_id": {"type": "string"},
            "tags": {"type": "array", "items": {"type": "string"}},
            "blend_mode": {"type": "string"},
            "opacity": {"type": "number"},
            "use_global_prompt": {"type": "boolean"},
            "include_section_desc": {"type": "boolean"},
            "hidden": {"type": "boolean"},
            "is_adjustment": {"type": "boolean"},
            "remap": {
                "type": "object",
                "properties": {
                    "method": {"type": "string", "enum": ["linear", "ease-in", "ease-out", "ease-in-out"]},
                    "target_duration": {"type": "number"},
                },
            },
        },
        "required": ["transition_id"],
    },
}
```

**Handler**:
- Validate transition exists via `get_transition`.
- Build kwargs from non-None input fields.
- `undo_begin(project_dir, f"Chat: update transition {tr_id}")`.
- `update_transition(project_dir, tr_id, **fields)` — the existing helper already handles JSON coercion for `tags`, `remap`, boolean-to-int flags.
- Return `{transition_id, updated_fields, old_values}`.

### 4. Register in `TOOLS` List

Append `ADD_KEYFRAME_TOOL`, `UPDATE_KEYFRAME_TOOL`, `UPDATE_TRANSITION_TOOL` to the module-level `TOOLS` list.

### 5. Update System Prompt

In `_build_system_prompt`, extend the tool list description:
- `add_keyframe` — insert a new keyframe.
- `update_keyframe` / `update_transition` — generic updates (label, track, section, blend mode, opacity, etc.).

Keep the existing narrow tools listed too (`update_keyframe_prompt`, `update_keyframe_timestamp`, `update_curve`, `update_transform_curve`) — Claude will pick whichever is narrowest for the task.

### 6. Tests

Add a Python script (pattern from earlier test sessions) that:
- Creates a fixture DB with keyframes and transitions.
- Calls each new tool via `_execute_tool`.
- Verifies DB state and that undo_groups rows were created.
- Tests error paths (missing required fields, keyframe/transition not found, empty update).

---

## Verification

- [ ] `add_keyframe` creates a new row with auto-generated `kf_*` ID
- [ ] `update_keyframe` updates arbitrary combinations of fields in one undo group
- [ ] `update_transition` updates metadata including `tags` (JSON) and `remap` (JSON) and boolean flags
- [ ] Missing/invalid IDs return `{"error": ...}` instead of raising
- [ ] Empty update (only `keyframe_id` passed, no fields) returns an error
- [ ] Each successful call produces exactly one `undo_groups` row
- [ ] System prompt mentions the new tools
- [ ] All existing tools (sql_query, delete_*, curve tools) still pass their tests
