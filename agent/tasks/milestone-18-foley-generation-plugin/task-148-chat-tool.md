# Task 148: generate_foley Chat Tool

**Milestone**: [M18](../../milestones/milestone-18-foley-generation-plugin.md)
**Design Reference**: [`local.foley-generation-plugin.md`](../../design/local.foley-generation-plugin.md) — "Chat tool surface"
**Clarification**: [`clarification-12-foley-generation-plugin.md`](../../clarifications/clarification-12-foley-generation-plugin.md) — Item 4
**Estimated Time**: 2 hours
**Dependencies**: task-145 (backend REST endpoint)
**Status**: Not Started

---

## Objective

Register a single unified `generate_foley` chat tool that dispatches to the backend REST `/run` endpoint via the existing chat tool surface (matches M16's `generate_music` pattern). Elicitation-gated because it costs money.

---

## Steps

### 1. Tool signature

```python
@chat_tool(destructive_patterns=['generate_foley'])
def generate_foley(
    prompt: str,
    duration: float | None = None,
    source_candidate_id: str | None = None,
    in_seconds: float | None = None,
    out_seconds: float | None = None,
    negative_prompt: str | None = None,
    cfg_strength: float | None = None,
    seed: int | None = None,
    count: int = 1,
) -> dict:
    """Generate a foley sound effect.

    Use one of two modes:
    - **Text-only (t2fx)**: provide `prompt` and optionally `duration` (default 2s).
      Do NOT pass source_candidate_id/in_seconds/out_seconds.
    - **Video-conditioned (v2fx)**: provide `source_candidate_id` and both
      `in_seconds`/`out_seconds` defining the range within the source clip.
      Duration is derived from (out - in). `prompt` is optional but steers the model.

    Costs one Replicate prediction (~$0.0xx). User must confirm via elicitation
    before generation proceeds.

    MVP enforces count==1. count>1 will be supported in a future version.
    """
    ...
```

### 2. Validation + dispatch

```python
def generate_foley(...) -> dict:
    # Validate
    if count != 1:
        raise ToolError('count must be 1 in MVP; multi-variant support coming in a future release')

    if source_candidate_id is not None:
        if in_seconds is None or out_seconds is None:
            raise ToolError('v2fx mode requires both in_seconds and out_seconds')
        if out_seconds <= in_seconds:
            raise ToolError('out_seconds must be greater than in_seconds')
        if (out_seconds - in_seconds) > 30:
            raise ToolError('range exceeds 30s ceiling')
        mode = 'v2fx'
    else:
        if in_seconds is not None or out_seconds is not None:
            raise ToolError('in_seconds/out_seconds require source_candidate_id')
        if duration is not None and not (1 <= duration <= 30):
            raise ToolError('duration must be between 1 and 30 seconds')
        mode = 't2fx'

    # Dispatch to backend REST
    response = backend.post('/plugins/generate-foley/run', {
        'prompt': prompt,
        'duration_seconds': duration if mode == 't2fx' else None,
        'source_candidate_id': source_candidate_id,
        'source_in_seconds': in_seconds,
        'source_out_seconds': out_seconds,
        'negative_prompt': negative_prompt,
        'cfg_strength': cfg_strength,
        'seed': seed,
        'entity_type': 'transition' if source_candidate_id else None,
        'entity_id': _resolve_transition_id_for_candidate(source_candidate_id) if source_candidate_id else None,
        'count': count,
    })

    return {
        'generation_id': response['generation_id'],
        'job_id': response['job_id'],
        'status': response['status'],
        'mode': mode,
    }
```

### 3. Destructive-tool registration

Add `generate_foley` to `_DESTRUCTIVE_TOOL_PATTERNS` in chat tool infrastructure (same list M16 used for `generate_music`):

```python
_DESTRUCTIVE_TOOL_PATTERNS = [
    'delete_*',
    'remove_*',
    'publish_*',
    'generate_music',
    'generate_foley',   # NEW
    # ...
]
```

Triggers the inline elicitation card with summary + Confirm/Cancel buttons. Decline → tool returns "cancelled by user" error.

### 4. Tool documentation string

The docstring above is shown to the LLM. Keep it complete and unambiguous — the LLM relies on it to decide how to call the tool. Specifically call out:
- Two distinct modes (t2fx vs. v2fx)
- When to provide `source_candidate_id` and when NOT to
- Range constraint (≤ 30s)
- Duration range (1–30s)
- Cost implication
- MVP count=1 enforcement

### 5. Registration

Register via the plugin's backend startup hook (follows M16 convention). Chat tool surface auto-discovers registered tools.

### 6. Tests

- t2fx happy path: `generate_foley(prompt='gunshot', duration=2)` → returns `{generation_id, job_id, status='pending', mode='t2fx'}`
- v2fx happy path: `generate_foley(prompt='door slam', source_candidate_id='trc_x', in_seconds=1.0, out_seconds=3.0)` → returns valid response, mode='v2fx'
- v2fx missing in/out → ToolError
- v2fx with `out <= in` → ToolError
- Range > 30s → ToolError
- Duration out of range (0.5 or 40) → ToolError
- `count=2` → ToolError
- Elicitation fires before backend call
- Decline elicitation → tool returns "cancelled by user" without calling backend

---

## Verification

- [ ] `generate_foley` tool registered and discoverable via chat surface
- [ ] Docstring complete and LLM-readable
- [ ] All validation errors raise `ToolError` with actionable messages
- [ ] Dispatches to `/plugins/generate-foley/run` correctly
- [ ] `_DESTRUCTIVE_TOOL_PATTERNS` includes `generate_foley`
- [ ] Elicitation card shows before invocation
- [ ] Declined elicitation no-ops cleanly
- [ ] Returns the right shape including `mode` derived from inputs

---

## Expected Output

```
scenecraft-engine/src/scenecraft/chat_tools/generate_foley.py   (new)
scenecraft-engine/src/scenecraft/chat_tools/destructive.py      (modified)

scenecraft-engine/tests/chat_tools/
└── test_generate_foley_tool.py                                 (new)
```

---

## Notes

- No companion tools in MVP (`list_foley_generations`, `retry_foley_generation`, `get_replicate_balance`) — all intentionally deferred; don't add them.
- The tool does NOT own the elicitation card UI — that's the existing chat infrastructure from M4 task-18.
- `_resolve_transition_id_for_candidate` looks up the `transition_id` from the `tr_candidates` table using the candidate's id.

---

**Next Task**: [task-149](task-149-orange-clip-styling.md) — Orange clip styling
