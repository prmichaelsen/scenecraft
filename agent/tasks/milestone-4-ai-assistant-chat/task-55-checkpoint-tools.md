# Task 55: Checkpoint Tools

**Milestone**: [M4 - AI Assistant Chat](../../milestones/milestone-4-ai-assistant-chat.md)
**Design Reference**: [AI Assistant Chat](../../design/local.ai-assistant-chat.md)
**Estimated Time**: 4 hours
**Dependencies**: [Task 16: Tool Calling](task-16-tool-calling.md)
**Status**: Not Started

---

## Objective

Give Claude the ability to create named save points and restore them. Primary use case: Claude self-gates before a risky batch operation ("I'm about to restyle 30 transitions — let me checkpoint first"), and users can ask Claude to roll back a session.

Implements in `scenecraft-engine/src/scenecraft/chat.py`, reusing the existing checkpoint machinery in `api_server.py` (search for `project.db.checkpoint-*` and `checkpoints.yaml`).

---

## Scope

Two new tools:

1. **`checkpoint(name?)`** — non-destructive. Copies `project.db` → `project.db.checkpoint-{timestamp}` and adds an entry to `checkpoints.yaml`.
2. **`restore_checkpoint(filename)`** — destructive. Replaces `project.db` with a checkpoint snapshot. Requires elicitation confirmation.

List-checkpoints is already covered by `sql_query` for checkpoint metadata OR a targeted filesystem walk — decide during implementation. Current API has a GET endpoint at `/api/projects/:name/checkpoints`; the implementation can call the same code path internally.

---

## Steps

### 1. `checkpoint` Tool

**Tool definition**:

```python
CHECKPOINT_TOOL = {
    "name": "checkpoint",
    "description": (
        "Create a named restore point by copying the project database. Non-destructive. "
        "The resulting checkpoint file can be listed in the Checkpoints panel and "
        "restored later. Call this before a risky batch of mutations."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Human-readable label for the checkpoint (optional).",
            },
        },
    },
}
```

**Handler**:
- Locate the existing checkpoint-creation code in `api_server.py` (search for `_handle_create_checkpoint` or similar). Extract into a helper function in `scenecraft/db.py` or `scenecraft/checkpoints.py` if one doesn't already exist; call that helper from both the REST handler and the chat tool.
- Steps inside the helper (if writing fresh):
  - Close any open DB connection for the project (to avoid copying WAL mid-write) — reuse `close_db`.
  - Generate a filename: `project.db.checkpoint-{YYYYMMDD-HHMMSS}`.
  - `shutil.copyfile(project_dir / "project.db", project_dir / filename)`.
  - Append `{"filename": filename, "name": name or "", "created_at": iso_ts}` to `checkpoints.yaml`.
  - Reopen the connection.
- Return `{filename, name, created_at}`.

No `undo_begin` — checkpoint creation is not a DB mutation.

### 2. `restore_checkpoint` Tool

**Tool definition**:

```python
RESTORE_CHECKPOINT_TOOL = {
    "name": "restore_checkpoint",
    "description": (
        "Replace the current project database with a checkpoint snapshot. DESTRUCTIVE — "
        "all uncheckpointed changes since that point will be lost. Use "
        "sql_query with `checkpoints.yaml` (or ask the user to inspect the "
        "Checkpoints panel) to find the filename first. Requires user confirmation."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "filename": {
                "type": "string",
                "description": "Checkpoint filename, e.g. 'project.db.checkpoint-20260418-140530'.",
            },
        },
        "required": ["filename"],
    },
}
```

**Handler**:
- The existing `_is_destructive` helper matches substrings. `"restore_checkpoint"` is already explicitly listed in `_DESTRUCTIVE_TOOL_PATTERNS`, so the elicitation gate already fires for this tool. No change needed.
- Validate the checkpoint file exists in `project_dir`.
- Extract the equivalent of `_handle_restore_checkpoint` from `api_server.py` into a helper; call it.
  - Close connections, copy checkpoint → `project.db`, reopen, trigger any necessary cache invalidation.
- Return `{restored_from: filename, restored_at: iso_ts}`.

### 3. Enrich Elicitation Summary

Extend `_format_destructive_summary` in `chat.py` to handle `restore_checkpoint`:
- Read the checkpoint entry from `checkpoints.yaml` (filename, name, created_at).
- Compute how many chat/DB mutations have occurred since the checkpoint (optional, but useful — count rows in `undo_groups` with timestamp > checkpoint's `created_at`).
- Summary line: `{name or filename} · created {created_at} · {N} mutations will be lost`.

### 4. Register Tools + Update System Prompt

- Add `CHECKPOINT_TOOL` and `RESTORE_CHECKPOINT_TOOL` to `TOOLS`.
- System prompt update:
  - "checkpoint(name?) — create a non-destructive restore point before a batch of risky edits."
  - "restore_checkpoint(filename) — roll back to a checkpoint (destructive, user-confirmed)."

### 5. Tests

- `checkpoint` creates the file and a `checkpoints.yaml` entry, does NOT create an undo_group.
- `restore_checkpoint` with a missing filename returns an error.
- `restore_checkpoint` with a valid filename replaces `project.db` and the changes are visible (verify by inserting a row pre-checkpoint, deleting it post-checkpoint, then restoring and verifying the row is back).
- `_is_destructive("restore_checkpoint")` still returns True.
- Destructive summary renders the checkpoint name + timestamp.

---

## Verification

- [ ] `checkpoint` creates a copy of `project.db` in the project directory
- [ ] `checkpoints.yaml` receives a new entry with name, filename, created_at
- [ ] `checkpoint` is NOT destructive (no elicitation fires)
- [ ] `restore_checkpoint` fires an elicitation card with summary and mutation-loss estimate
- [ ] On "accept", DB state matches the checkpoint snapshot
- [ ] On "decline", DB is untouched and the tool returns `{"error": "cancelled by user"}`
- [ ] Missing/invalid checkpoint filename returns a clear error
- [ ] No sqlite3 "database is locked" errors when the DB connection is reopened
