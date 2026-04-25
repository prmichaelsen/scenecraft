# Task 156: `tools_scene_live` MCP Handler

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — R18-R27; tests `scene-live-*`, `live-override-persists-across-restart`
**Estimated Time**: 1 hour
**Dependencies**: task-151 (DB helpers + UUID generation), task-152 (catalog for inline-type validation)
**Status**: Not Started

---

## Objective

Implement the `scene_live` MCP tool as a single action-dispatched handler. Actions: `activate | deactivate | status`. Owns the single-slot live override semantics: scene_id-or-inline mutual exclusion, save_as label-driven scene creation, replace-on-active-activate, deactivation timestamp set (physical row deletion happens in frontend evaluator after fade — task-161).

---

## Steps

### 1. Add `tools_scene_live(args, tool_context)` to `__init__.py`

Dispatch on `args["action"]`:

**`activate`**: Per R18-R23:
- Reject if BOTH `scene_id` AND `scene` (inline) are provided → `{error: "provide scene_id OR scene, not both"}`
- Reject if NEITHER is provided → `{error: "provide scene_id or scene"}`
- If `scene_id` present: validate exists → reject `{error: "unknown scene_id: <id>"}` if not
- If inline `scene` present: validate `scene.type` against catalog → reject `{error: "unknown primitive type: <type>"}` if not
- If `save_as` present:
  - With inline scene: persist `{label: save_as, type: scene.type, params: scene.params}` to `light_show__scenes` with new uuid; the override row references that new scene_id
  - With `scene_id` (no inline): reject `{error: "save_as requires inline scene"}`
- Replaces existing override silently (no error if one is already active per R21)
- `label` default: scene's label (library) or `"directive"` (inline)
- `fade_in_sec` default: 0
- Sets `activated_at = now`; clears `deactivation_started_at` to NULL
- Returns `{active: true, scene_id, label, activated_at, fade_in_sec, fade_out_sec, deactivation_started_at: null}` (R22 — response surfaces `scene_id` for save_as path)

**`deactivate`**: Per R24-R25:
- If no override active → `{active: false}` no-op (R25)
- Otherwise: set `deactivation_started_at = now`; update `fade_out_sec` from arg (default 0); return `{active: true, scene_id, ..., deactivation_started_at: <iso>}` so chat sees fade is in progress
- Physical deletion of the row happens in the frontend evaluator when fade completes (task-161 calls `DELETE /live` on the backend at that moment)

**`status`**: Per R26. Returns `{active: false}` or `{active: true, scene_id?, label, activated_at, fade_in_sec, fade_out_sec, deactivation_started_at?}`. Read-only.

### 2. Action validation

Unknown action → `{error: "unknown action <action>; expected one of activate/deactivate/status"}` per R27.

### 3. WS broadcast

Mutating actions (`activate`, `deactivate`) emit `light_show__changed` with `kind: "live"` via `_notify(project_name, "live")`.

### 4. Add `"tools_scene_live"` to `__all__`

### 5. plugin.yaml `destructive: true` flag

The `scene_live` tool entry in plugin.yaml gets `destructive: true` (already noted in spec MCP schema section) since `activate` can replace an active cue and `deactivate` releases state. Confirmation gating handled by the existing `_DESTRUCTIVE_TOOL_PATTERNS` mechanism.

---

## Verification

Spec base tests covered:
- [ ] `scene-live-activate-by-scene-id` (R18, R19, R21, R26)
- [ ] `scene-live-activate-with-inline-scene` (R18, R20, R22)
- [ ] `scene-live-activate-rejects-both-forms` (R18)
- [ ] `scene-live-activate-save-as-persists` (R22)
- [ ] `scene-live-activate-replaces-existing` (R21)
- [ ] `scene-live-deactivate-no-op-when-inactive` (R25)
- [ ] `live-override-persists-across-restart` (R28) — DB row survives engine restart

Edge tests covered:
- [ ] `unknown-action-returns-error-not-exception` (subset for `scene_live`)
- [ ] activate with `save_as` + `scene_id` (no inline) → `{error: "save_as requires inline scene"}` (R23)

---

## Notes

- Persistence: the `light_show__live_override` row in SQLite survives engine restart per R28. On restart, `GET /live` returns the persisted state and the frontend evaluator resumes rendering it.
- `inline_params_json` storage: same sparse-JSON convention as scene library rows. Inline scenes that get `save_as`'d carry their sparse params verbatim into the new library row.
- The deactivation flow is split: backend marks `deactivation_started_at` here; frontend evaluator runs the fade envelope and then issues `DELETE /live` (which physically removes the row) when fade reaches zero. This avoids polling on the backend and keeps fade semantics where animation lives (frontend).
