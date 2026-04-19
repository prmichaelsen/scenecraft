# Task 56: Creative Generation Tools

**Milestone**: [M4 - AI Assistant Chat](../../milestones/milestone-4-ai-assistant-chat.md)
**Design Reference**: [AI Assistant Chat](../../design/local.ai-assistant-chat.md)
**Estimated Time**: 10 hours
**Dependencies**: [Task 53: Structure & Creation Tools](task-53-structure-creation-tools.md), [Task 17: Elicitation UI](task-17-elicitation-ui.md)
**Status**: Not Started

---

## Objective

Let Claude kick off image (Imagen) and video (Veo) candidate generation jobs and receive the output (pool_segment IDs + candidate rank) as a tool result once the job completes. This is the P1 creative-direction path — "generate 3 variants for this keyframe" / "try another take on this transition".

Generation jobs are **slow** (seconds to minutes) and **expensive**. Treat carefully.

Implements in `scenecraft-engine/src/scenecraft/chat.py` with cooperation from the existing `JobManager` in `ws_server.py`.

---

## Scope

Two new tools:

1. **`generate_keyframe_candidates(keyframe_id, count?, prompt_override?)`** — runs Imagen to produce N image candidates.
2. **`generate_transition_candidates(transition_id, count?, slot?)`** — runs Veo to produce N video candidates.

Both are asynchronous server-side jobs. The chat tool must **await** completion before returning to Claude — Claude needs the candidate IDs to reason about what to do next (e.g. "assign the second one").

---

## Design Notes

### Job model

Generation jobs already exist in the codebase (see `api_server.py`'s keyframe/transition generation endpoints — `/api/projects/:name/generate-keyframe-candidates` etc. — and the `JobManager` in `ws_server.py`). The current REST path kicks off a background job and returns a `job_id`; the frontend polls progress over the logs WebSocket.

For chat tools, we need the same kickoff logic but the caller (chat tool handler) awaits job completion via an asyncio mechanism rather than WS broadcast.

### Streaming progress to the chat UI

While the generation job runs, the chat should show live progress to the user (otherwise the UI looks frozen for a minute). Use a new WS event type:

```python
{
  "type": "tool_progress",
  "toolProgress": {
    "id": "<tool_use_id>",
    "phase": "generating" | "decoding" | "saving",
    "pct": 0..1,
    "message": "Generating 3 Imagen candidates..."
  }
}
```

Frontend extends `StreamingBlock.tool_use` to include an optional `progress` field and renders it inline in the badge (e.g. `⟳ generate_keyframe_candidates · 45%`).

### Cost gate (elicitation)

Generation costs real money. Even though the tools are technically non-destructive (they only ADD candidates), require an elicitation confirmation the **first time in a conversation** a generation tool is called — or when `count > 3`. This is a soft gate; add `_COST_GATED_TOOL_PATTERNS` alongside `_DESTRUCTIVE_TOOL_PATTERNS`.

Alternatively: gate every call (simpler). User can disable gating in settings later.

**Recommendation**: gate every call via the existing `_is_destructive` pattern — add `"generate_"` to the destructive patterns list. Summary shows: target keyframe/transition, count, estimated cost/time.

### Cancellation

If the user closes the chat connection or explicitly declines, the job should be cancelled via the existing `JobManager.cancel_job`. Wire `ws.wait_closed` + `asyncio.shield` around the job await so a disconnect cancels the job.

---

## Steps

### 1. Extract Job Helper

If the existing generation code is inline in the HTTP handler, extract a function:

```python
# in scenecraft/generation.py (new file)
async def run_keyframe_generation(project_dir, keyframe_id, count, prompt_override=None, progress_cb=None):
    """Run Imagen generation for a keyframe, awaiting completion.

    progress_cb: optional async function called with (phase, pct, message)."""
    ...
    return {"pool_segment_ids": [...], "candidates_added": N}
```

Same for `run_transition_generation`.

### 2. Tool Definitions

```python
GENERATE_KEYFRAME_CANDIDATES_TOOL = {
    "name": "generate_keyframe_candidates",
    "description": (
        "Generate image candidates for a keyframe using Imagen. Takes seconds to "
        "minutes. Consumes API credit — requires user confirmation. Returns the "
        "new pool_segment IDs and rank within the keyframe's candidates list."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "keyframe_id": {"type": "string"},
            "count": {"type": "integer", "minimum": 1, "maximum": 8, "default": 3},
            "prompt_override": {"type": "string", "description": "Optional; uses keyframe prompt if omitted."},
        },
        "required": ["keyframe_id"],
    },
}

GENERATE_TRANSITION_CANDIDATES_TOOL = {
    "name": "generate_transition_candidates",
    "description": (
        "Generate video candidates for a transition using Veo. Slow and expensive — "
        "requires user confirmation. Returns new pool_segment IDs."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "transition_id": {"type": "string"},
            "count": {"type": "integer", "minimum": 1, "maximum": 4, "default": 2},
            "slot": {"type": "integer", "default": 0, "minimum": 0},
        },
        "required": ["transition_id"],
    },
}
```

Register in `TOOLS`. Add `"generate_"` to `_DESTRUCTIVE_TOOL_PATTERNS` to trigger the elicitation flow.

### 3. Handlers

```python
async def _exec_generate_keyframe_candidates(project_dir, input_data, ws, tool_use_id):
    kf_id = input_data.get("keyframe_id")
    count = int(input_data.get("count") or 3)
    prompt_override = input_data.get("prompt_override")
    # Validate keyframe
    ...
    async def progress_cb(phase, pct, message):
        await ws.send(json.dumps({
            "type": "tool_progress",
            "toolProgress": {"id": tool_use_id, "phase": phase, "pct": pct, "message": message},
        }))
    result = await run_keyframe_generation(project_dir, kf_id, count, prompt_override, progress_cb)
    return {
        "keyframe_id": kf_id,
        "count_requested": count,
        "count_generated": result["candidates_added"],
        "pool_segment_ids": result["pool_segment_ids"],
    }
```

Because this needs the WS + tool_use_id, the dispatcher `_execute_tool` must be converted to async and take those params. Already a minor refactor — other handlers become `async def` no-ops returning immediately.

### 4. Enrich Elicitation Summary

In `_format_destructive_summary`, add cases for generation tools:
- `generate_keyframe_candidates`: keyframe ID, timestamp, prompt, count, estimated cost.
- `generate_transition_candidates`: transition ID, from/to keyframes, count, slot, estimated cost.

Cost estimate can be hardcoded per-tool (e.g. Imagen ≈ $0.04/image, Veo ≈ $0.50/video) or read from a config constant.

### 5. Frontend: Progress Rendering

In `ChatPanel.tsx`:
- Extend `StreamingBlock.tool_use` to carry `progress?: { phase, pct, message }`.
- On `tool_progress` WS event: update the matching block's `progress` field.
- `ToolCallBadge` (pending state): render `⟳ name · {pct}% · {message}` when progress is present.
- Clear progress on `tool_result`.

### 6. Frontend: Chat-Client Types

Add to `chat-client.ts` `ServerMessage`:

```ts
| { type: 'tool_progress'; toolProgress: { id: string; phase: string; pct: number; message: string } }
```

### 7. Cancellation Path

Wrap the `await run_*_generation(...)` call in `asyncio.shield` and register a cleanup that fires `JobManager.cancel_job(job_id)` if the WebSocket closes before completion. If the tool was declined in elicitation, never kick off the job in the first place.

### 8. Tests

- Mock the actual Imagen/Veo provider calls (they are network-heavy). Use a fake generator that returns fixture pool_segment IDs after a short `asyncio.sleep`.
- Verify `tool_progress` events flow over WS.
- Verify tool_result contains the generated pool_segment IDs and that they exist in the `pool_segments` table.
- Verify declining the elicitation prevents the job from starting.
- Verify WS close mid-job triggers job cancellation.

---

## Verification

- [ ] `generate_keyframe_candidates` triggers Imagen and waits for completion
- [ ] `generate_transition_candidates` triggers Veo and waits for completion
- [ ] Elicitation fires before every generation call with cost/count summary
- [ ] Declining elicitation aborts the generation before any API call
- [ ] `tool_progress` events stream while the job runs, frontend badge shows % progress
- [ ] Tool result contains new `pool_segment_ids` that Claude can immediately use with `assign_keyframe_image` / `assign_pool_video`
- [ ] WS disconnect mid-generation cancels the upstream job
- [ ] No duplicate generation jobs fire if Claude retries within the same turn
- [ ] API cost gate configurable via env var (defer: `CHAT_REQUIRE_GENERATION_CONFIRM=1` default)
