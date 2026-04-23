# Task 105: Chat Tool `isolate_vocals` + Elicitation Gate (Multi-Stem)

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md) — Chat Tool Wrapper
**Estimated Time**: 2 hours
**Dependencies**: [Task 102: Backend plugin](task-102-backend-plugin.md)
**Status**: Not Started

---

## Objective

Wrap the `isolate-vocals.run` operation as a chat tool so Claude can invoke it from conversation. Uses the existing elicitation flow (append `"isolate_"` to `_DESTRUCTIVE_TOOL_PATTERNS`). Return shape is multi-stem under a single `isolation_id`, matching the v2 design. Supports both `audio_clip` and `transition` entities.

Implements in `scenecraft-engine/src/scenecraft/chat.py`.

---

## Steps

### 1. Tool definition

Add to `chat.py` after the generation tools:

```python
ISOLATE_VOCALS_TOOL: dict = {
    "name": "isolate_vocals",
    "description": (
        "Separate a voice-over-noise audio source into vocal + background stems using "
        "DeepFilterNet3. Accepts an audio_clip or a transition as the source. Returns "
        "an audio_isolations run id with N stem pool_segment ids. Slow (~realtime on "
        "CPU). Requires user confirmation. Use `get_audio_clips` or sql_query on "
        "audio_clips / transitions to find entity ids first."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "entity_type": {"type": "string", "enum": ["audio_clip", "transition"]},
            "entity_id":   {"type": "string", "description": "ID of the source entity."},
            "range_mode":  {"type": "string", "enum": ["full", "subset"], "default": "full"},
            "trim_in":     {"type": "number", "description": "Required when range_mode='subset'."},
            "trim_out":    {"type": "number", "description": "Required when range_mode='subset'."},
        },
        "required": ["entity_type", "entity_id"],
    },
}
```

Add to the `TOOLS` list. Update the system prompt's tool roster.

### 2. Destructive pattern entry

```python
_DESTRUCTIVE_TOOL_PATTERNS: tuple[str, ...] = (
    ...existing...,
    "isolate_",   # future-proofs any isolate_* tools
)
```

### 3. Rich elicitation summary

In `_format_destructive_summary`:

```python
if tool_name == "isolate_vocals":
    from scenecraft.db import get_audio_clip, get_transition
    entity_type = input_dict.get("entity_type", "audio_clip")
    entity_id = input_dict.get("entity_id", "")
    range_mode = input_dict.get("range_mode", "full")
    trim_in = input_dict.get("trim_in")
    trim_out = input_dict.get("trim_out")

    if entity_type == "audio_clip":
        row = get_audio_clip(project_dir, entity_id)
        total = float(row.get("end_time", 0)) - float(row.get("start_time", 0)) if row else 0
        label = row.get("name") or row.get("track_id") or entity_id if row else entity_id
    elif entity_type == "transition":
        row = get_transition(project_dir, entity_id)
        total = float(row.get("duration_seconds", 0)) if row else 0
        label = row.get("label") or entity_id if row else entity_id
    else:
        row, total, label = None, 0, entity_id

    if not row:
        return f"Isolate vocals on {entity_type} {entity_id}?", [f"{entity_id} (NOT FOUND)"]

    active_dur = total if range_mode == "full" else max(0, (trim_out or total) - (trim_in or 0))
    eta_low = max(1, int(active_dur * 1.0))
    eta_high = max(2, int(active_dur * 2.0))

    items = [
        f"{entity_type}: {label} ({entity_id})",
        f"range: {range_mode}"
            + (f" {trim_in}s–{trim_out}s ({active_dur:.1f}s)" if range_mode == "subset" else f" ({active_dur:.1f}s)"),
        "model: DeepFilterNet3 (CPU)",
        "output: 2 stems — vocal + background (new pool_segments, grouped under one audio_isolations run)",
        f"~{eta_low}-{eta_high}s to complete",
    ]
    return f"Isolate vocals on {entity_type} {entity_id}?", items
```

Add `"isolate_vocals"` to the set of tool names that get the rich summary (alongside `generate_*`, `delete_*`, etc.).

### 4. Executor dispatch

In `_execute_tool`:

```python
if name == "isolate_vocals":
    entity_type = input_data.get("entity_type", "audio_clip")
    entity_id = input_data.get("entity_id", "")
    if not entity_id:
        return {"error": "missing entity_id"}, True
    if entity_type not in ("audio_clip", "transition"):
        return {"error": f"unsupported entity_type: {entity_type}"}, True

    from scenecraft.plugin_host import PluginHost
    op = PluginHost.get_operation("isolate-vocals.run")
    if op is None:
        return {"error": "isolate-vocals plugin not registered"}, True

    kickoff = op.handler(entity_type, entity_id, {
        "project_dir": project_dir,
        "project_name": project_name or "",
        "range_mode": input_data.get("range_mode", "full"),
        "trim_in": input_data.get("trim_in"),
        "trim_out": input_data.get("trim_out"),
    })
    if "error" in kickoff:
        return kickoff, True
    if ws is None or tool_use_id is None:
        return {"error": "isolate_vocals requires ws context"}, True
    return await _await_generation_job(ws, tool_use_id, project_name or "", kickoff["job_id"])
```

`_await_generation_job` already handles polling + streaming `tool_progress` + returning on terminal. The completion payload's `result` dict flows back to the model as the tool result — it contains `{isolation_id, stems: [{stem_type, pool_segment_id, pool_path}, ...]}` per task 102.

### 5. System prompt update

Append to the tool roster:

```
  • isolate_vocals — separate an audio source into vocal + background stems (DFN3 + residual);
    returns a new audio_isolations run id with 2 stem pool_segment ids.
    Works on audio_clip or transition. Slow (~realtime CPU). User-confirmed.
```

### 6. Tests

Extend the chat tool test suite:

- `_is_destructive("isolate_vocals")` returns True
- `_format_destructive_summary("isolate_vocals", {...}, project_dir)` renders the rich items for:
  - audio_clip present, full range
  - audio_clip present, subset range → active_dur matches (trim_out − trim_in)
  - transition present, full range
  - missing entity → "(NOT FOUND)" item
- `_execute_tool(name="isolate_vocals", ...)` with mocked `PluginHost.get_operation`:
  - Kickoff `{isolation_id, job_id}` → `_await_generation_job` returns on completion with `{isolation_id, stems: [...]}`
  - Kickoff `{error}` surfaces as `(error, True)`
  - No PluginHost registration → "plugin not registered" error
  - Invalid entity_type → error without touching the plugin
- Elicitation flow:
  - Decline → `{error: "cancelled by user"}`, plugin never invoked
  - Accept → plugin kickoff fires

### 7. Smoke test (manual, end-to-end)

Once M11 is complete:
1. Import a short audio clip (≤30s).
2. In chat: "Isolate vocals on audio_clip_xxx."
3. Verify elicitation card shows entity label, range, model, stem output summary, ETA.
4. Accept → progress ticks through in the chat stream.
5. Tool result includes `isolation_id` + 2 stems.
6. Assistant can reference the new stems in follow-up messages.
7. Open AudioIsolationsPanel on the same clip → the new run appears.

---

## Verification

- [ ] `ISOLATE_VOCALS_TOOL` defined; in `TOOLS` list; input schema supports `range_mode`/`trim_in`/`trim_out`
- [ ] `"isolate_"` in `_DESTRUCTIVE_TOOL_PATTERNS`; `_is_destructive("isolate_vocals")` is True
- [ ] `_format_destructive_summary` renders rich multi-stem preview incl. active range + ETA
- [ ] `"isolate_vocals"` included in the rich-summary tool set
- [ ] `_execute_tool` routes through `PluginHost.get_operation("isolate-vocals.run")` and awaits the job
- [ ] Tool result shape is `{isolation_id, stems: [...]}`, not single-candidate
- [ ] System prompt mentions the tool with a one-liner
- [ ] All existing chat-tool tests still pass
- [ ] New tests pass (destructive class, summary variants, execute paths, plugin-not-registered, elicitation decline)
- [ ] End-to-end chat smoke test works
