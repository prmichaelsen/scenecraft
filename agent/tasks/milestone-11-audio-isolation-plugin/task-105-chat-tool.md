# Task 105: Chat Tool `isolate_vocals` + Elicitation Gate

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md)
**Estimated Time**: 2 hours
**Dependencies**: [Task 102: Backend plugin](task-102-backend-plugin.md)
**Status**: Not Started

---

## Objective

Wrap the isolate-vocals operation as a chat tool so Claude can invoke it from conversation. Auto-gate via the existing elicitation flow (add `"isolate_"` to `_DESTRUCTIVE_TOOL_PATTERNS`).

Implements in `scenecraft-engine/src/scenecraft/chat.py`.

---

## Steps

### 1. Tool definition

Add to `chat.py` after `GENERATE_TRANSITION_CANDIDATES_TOOL`:

```python
ISOLATE_VOCALS_TOOL: dict = {
    "name": "isolate_vocals",
    "description": (
        "Strip background noise (chatter, wind, HVAC, hiss) from an audio clip "
        "using DeepFilterNet3. Appends a new audio candidate and auto-selects it — "
        "the original stays available for A/B. Slow (~realtime on CPU). Requires "
        "user confirmation. Use `get_audio_clips` (or sql_query on the audio_clips "
        "table) to find clip IDs first."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "entity_type": {"type": "string", "enum": ["audio_clip"]},
            "entity_id":   {"type": "string", "description": "ID of the audio clip."},
        },
        "required": ["entity_type", "entity_id"],
    },
}
```

Add to the `TOOLS` list. Update the system prompt's tool list to mention it.

### 2. Destructive pattern entry

Add `"isolate_"` to `_DESTRUCTIVE_TOOL_PATTERNS`. This makes elicitation fire automatically for any future `isolate_*` tools too (future-proofing).

```python
_DESTRUCTIVE_TOOL_PATTERNS: tuple[str, ...] = (
    "delete",
    "remove",
    "destroy",
    "drop",
    "publish",
    "retract",
    "revise",
    "moderate",
    "restore_checkpoint",
    "batch_delete",
    "generate_",
    "isolate_",   # <--- new
)
```

### 3. Rich elicitation summary

Add to `_format_destructive_summary`:

```python
if tool_name == "isolate_vocals":
    from scenecraft.db import get_audio_clip
    clip_id = input_dict.get("entity_id", "")
    clip = get_audio_clip(project_dir, clip_id)
    if not clip:
        return f"Isolate vocals on {clip_id}?", [f"{clip_id} (NOT FOUND)"]
    dur = float(clip.get("end_time", 0)) - float(clip.get("start_time", 0))
    track_name = clip.get("track_name", "") or clip.get("track_id", "")
    eta_low = max(1, int(dur * 1.0))
    eta_high = max(2, int(dur * 2.0))
    items = [
        f"{clip_id} · track: {track_name} · {dur:.1f}s",
        f"model: DeepFilterNet3 (CPU)",
        f"~{eta_low}-{eta_high}s to complete",
    ]
    return f"Isolate vocals on {clip_id}?", items
```

And add `"isolate_vocals"` to the set of tool names that get the rich summary:

```python
if project_dir is not None and tool_name in {
    "delete_keyframe", "delete_transition",
    "batch_delete_keyframes", "batch_delete_transitions",
    "generate_keyframe_candidates", "generate_transition_candidates",
    "restore_checkpoint",
    "isolate_vocals",   # <--- new
}:
```

### 4. Executor dispatch

In `_execute_tool`, add:

```python
if name == "isolate_vocals":
    entity_type = input_data.get("entity_type", "audio_clip")
    entity_id = input_data.get("entity_id", "")
    if not entity_id:
        return {"error": "missing entity_id"}, True

    # Call the plugin handler directly through PluginHost — same path the REST
    # endpoint uses, so chat and UI produce identical results.
    from scenecraft.plugin_host import PluginHost
    op = PluginHost.get_operation("isolate-vocals.run")
    if op is None:
        return {"error": "isolate-vocals plugin not registered"}, True
    kickoff = op.handler(entity_type, entity_id, {
        "project_dir": project_dir,
        "project_name": project_name or "",
    })
    if "error" in kickoff:
        return kickoff, True
    if ws is None or tool_use_id is None:
        return {"error": "isolate_vocals requires ws context"}, True
    # Reuse the existing polling helper — same shape as generate_* tools
    return await _await_generation_job(ws, tool_use_id, project_name or "", kickoff["job_id"])
```

`_await_generation_job` already does exactly what we need (poll, stream `tool_progress`, return on terminal state). No changes needed there.

### 5. System prompt update

Add a line to the system prompt's tool list:

```
  • isolate_vocals — remove background noise from an audio clip using DeepFilterNet3;
    appends a new audio candidate and auto-selects it. Slow (~realtime CPU). User-confirmed.
```

### 6. Tests

Add to `chat.py` test suite (same pattern as existing tool tests):

- `_is_destructive("isolate_vocals")` returns True
- `_format_destructive_summary("isolate_vocals", {"entity_id": "ac_123"}, project_dir)` returns a message + items with duration / ETA / model name
- Missing clip → "(NOT FOUND)" in items
- `_execute_tool(name="isolate_vocals", ...)` with a mocked `PluginHost.get_operation` that returns a fake op:
  - Kickoff returns `{job_id, ...}` → `_await_generation_job` polls → returns `{audio_clip_id, pool_segment_id}` on completion
  - Kickoff returns `{error}` → surfaces as `(result, True)`
  - No PluginHost registration → returns "plugin not registered" error
- Elicitation flow (same harness used for `generate_*` tools):
  - Declining the elicitation produces `{error: "cancelled by user"}` and the plugin is never invoked
  - Accepting triggers the plugin call

### 7. Chat integration smoke test

Manually verify (once M11 is complete):
- In the chat: "Clean up the wind noise in audio clip {id}"
- Claude calls `isolate_vocals(entity_type="audio_clip", entity_id="...")`
- Elicitation card shows: target clip, model, ETA
- User accepts → progress badge updates in the chat stream
- Tool result shows the new pool_segment_id
- Assistant message references the new candidate

---

## Verification

- [ ] `ISOLATE_VOCALS_TOOL` is defined and in the `TOOLS` list
- [ ] `"isolate_"` added to `_DESTRUCTIVE_TOOL_PATTERNS`
- [ ] `_is_destructive("isolate_vocals")` is True
- [ ] `_format_destructive_summary` produces a rich preview with duration/ETA/model
- [ ] `_execute_tool` dispatches to `PluginHost.get_operation("isolate-vocals.run")` and awaits the job
- [ ] System prompt mentions the new tool
- [ ] All existing chat tool tests still pass
- [ ] New tests pass:
  - Destructive pattern classification
  - Elicitation summary for found/missing clips
  - Successful execution path (mocked plugin handler)
  - Plugin-not-registered path returns a clear error
  - Elicitation decline leaves state unchanged
- [ ] End-to-end manual test with a real chat session works
