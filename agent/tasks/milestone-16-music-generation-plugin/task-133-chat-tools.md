# Task 133: Chat Tools + Elicitation

**Milestone**: [M16](../../milestones/milestone-16-music-generation-plugin.md)
**Spec**: `agent/specs/local.music-generation-plugin.md` — R41-R46 (tool surface + elicitation)
**Estimated Time**: 3 hours
**Dependencies**: task-129 (run handler), task-130 (endpoints)
**Status**: Not Started

---

## Objective

Register two chat tools in `scenecraft-engine/src/scenecraft/chat.py`:

1. `generate_music` — write-path, elicitation-gated via `_DESTRUCTIVE_TOOL_PATTERNS`
2. `get_music_credits` — read-path, no elicitation

Explicitly NO `generate_lyrics` tool (per Q6.1 decision — Claude drafts lyrics inline).

---

## Steps

### 1. Tool definitions

Add to chat.py's tool list:

```python
GENERATE_MUSIC_TOOL = {
    "name": "generate_music",
    "description": (
        "Generate AI-composed music via Musicful. Returns a running generation "
        "that completes asynchronously. Costs credits. Requires user confirmation. "
        "Use action='auto' for 'describe a song, get a song'; action='custom' for "
        "user-supplied lyrics. Set instrumental=1 for scores/background music."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["auto", "custom"]},
            "style": {"type": "string"},
            "lyrics": {"type": "string"},
            "title": {"type": "string", "maxLength": 80},
            "instrumental": {"type": "integer", "enum": [0, 1]},
            "gender": {"type": "string", "enum": ["male", "female", ""]},
            "model": {"type": "string", "default": "MFV2.0"},
        },
        "required": ["action", "style"],
    },
}

GET_MUSIC_CREDITS_TOOL = {
    "name": "get_music_credits",
    "description": "Check remaining Musicful credits without consuming any. Free to call.",
    "input_schema": {"type": "object", "properties": {}, "required": []},
}
```

### 2. Destructive-pattern registration

Add `"generate_music"` to `_DESTRUCTIVE_TOOL_PATTERNS` (list already exists in chat.py, used by the elicitation gate shipped in M4 task-18).

### 3. Handler wiring

```python
def _tool_generate_music(args, context):
    # Elicitation was handled by the destructive-pattern gate BEFORE reaching this
    # handler; if the user declined, this is never invoked and the tool call is
    # returned with 'cancelled by user' error upstream.
    project_dir = context['project_dir']
    project_name = context['project_name']
    auth_context = context['auth']  # {username, org, api_key_id} from middleware

    result = generate_music.run(
        project_dir, project_name,
        action=args['action'],
        style=args['style'],
        lyrics=args.get('lyrics'),
        title=args.get('title'),
        instrumental=args.get('instrumental', 1),
        gender=args.get('gender'),
        model=args.get('model', 'MFV2.0'),
        entity_type=None,       # chat tool doesn't carry editor selection; null context
        entity_id=None,
        auth_context=auth_context,
    )
    if 'error' in result:
        return {'error': result['error']}
    return {
        'generation_id': result['generation_id'],
        'task_ids': result['task_ids'],
        'status': 'running',
    }


def _tool_get_music_credits(args, context):
    # No elicitation; read-only
    if not os.environ.get('MUSICFUL_API_KEY'):
        return {'credits': None, 'error': 'This plugin requires a Musicful API key. Please contact your administrator.'}
    info = musicful_get_key_info()
    return {'credits': info.get('key_music_counts', 0),
            'last_checked_at': datetime.utcnow().isoformat() + 'Z'}
```

### 4. Elicitation summary customization

`_format_destructive_summary` (the helper that builds the elicitation card payload, from M4 task-18) needs a case for `generate_music`. Summary shows:

- Action: Auto / Custom
- Style: the provided style
- Lyrics: truncated to ~100 chars with ellipsis if longer (R42, spec test `elicitation-summary-truncates-long-lyrics`)
- Model: MFV2.0
- Estimated cost: 2 credits (N tasks × 1 credit per task; Musicful typically returns 2 songs per call)
- Remaining balance: from cached credit count

Spec tests:
- `elicitation-accept-runs`
- `elicitation-decline-no-op`
- `elicitation-cost-reflects-balance`
- `elicitation-summary-truncates-long-lyrics`

### 5. Entity context from chat tool

Spec is explicit: chat tool invocation path carries NO editor selection (R13 covers the data shape; `entity_type/id` are null when the tool is called from chat). If we want chat-triggered generations to bind to a currently-selected entity, that's a future enhancement requiring the chat context to carry selection state. Out of M16 scope — document as a minor follow-up.

### 6. Tests

In `scenecraft-engine/tests/test_chat_generate_music_tool.py`:

- `generate-music-tool-elicitation-fires` — call tool → assistant receives an elicitation event first
- `elicitation-accept-calls-backend` — elicitation accepted → mock Musicful receives POST
- `elicitation-decline-skips-backend` — decline → mock receives zero requests; tool result is 'cancelled by user'
- `elicitation-summary-shape` — summary fields match spec (action, style, lyrics truncated, model, cost, balance)
- `get-music-credits-returns-balance` — mock Musicful `/get_api_key_info` returns 237 → tool returns `{credits: 237}`
- `get-music-credits-no-elicitation` — call tool → no elicitation event fires
- `get-music-credits-no-api-key` — env var unset → tool returns admin-error
- `generate-music-no-api-key` — env var unset → tool returns admin-error WITHOUT firing the elicitation (config check happens before elicitation)
- `no-generate-lyrics-tool-registered` — `generate_lyrics` is NOT in the exposed tool list

---

## Verification

- [ ] `generate_music` elicits; decline is a no-op; accept runs the backend
- [ ] `get_music_credits` is read-only; no elicitation; no ledger row
- [ ] No `generate_lyrics` tool exposed
- [ ] Elicitation summary truncates long lyrics
- [ ] Missing API key returns admin-error for both tools
- [ ] Tool return shapes match spec R41, R44

---

## Notes

- Scenecraft's chat tool registration pattern is well-established from M4 (tool-calling + destructive pattern + elicitation). Reuse those helpers; don't re-implement.
- If the chat-context → editor-selection bridge becomes a real ask, it's a small change: chat request carries `selection_context`, tool handler passes it to `generate_music.run`. Out of M16 but cheap to add later.
- Ensure the tool description mentions "scores/background music" for the `instrumental=1` case since that's the primary use case per Q1.3.
