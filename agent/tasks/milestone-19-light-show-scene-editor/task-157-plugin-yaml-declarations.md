# Task 157: plugin.yaml MCP Tool Declarations

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — MCP Tool Input Schemas (under Interfaces)
**Estimated Time**: 0.5 hour
**Dependencies**: tasks 154, 155, 156 (handler functions exist)
**Status**: Not Started

---

## Objective

Declare the three new MCP tools (`scenes`, `scene_timeline`, `scene_live`) in `scenecraft-engine/src/scenecraft/plugins/light_show/plugin.yaml` so `PluginHost.register_declared` exposes them to chat.

---

## Steps

### 1. Append three tool entries to `plugin.yaml` after the existing `clear_overrides` entry

Use the canonical YAML from the spec's Interfaces > "MCP tool input schemas (plugin.yaml)" section verbatim. Each declaration includes:
- `id`, `description` (multi-line), `handler: "backend:tools_<name>"`
- For `scene_live`: `destructive: true`
- Full `input_schema` with action enum + per-action property blocks (scenes/placements/ids/filter/limit/offset/order_by/order/...)

### 2. Verify handler resolution

After adding, restart the backend and confirm the plugin manifest loads without error. The handler refs (`backend:tools_scenes`, `backend:tools_scene_timeline`, `backend:tools_scene_live`) must resolve against the `__all__` exports in `__init__.py`.

### 3. Self-introspection sanity

Call `scenes.list_primitives` from chat (or via direct MCP) — the response is the parsed catalog (task-152) wrapped as `{primitives: [...]}`.

---

## Verification

- [ ] Backend boots with no plugin manifest errors
- [ ] All three tools appear in the chat tool list as `light_show__scenes`, `light_show__scene_timeline`, `light_show__scene_live` (per the existing dot-vs-double-underscore convention in plugin.yaml)
- [ ] `scene_live` tool gets the destructive-confirmation gate at chat time (it carries `destructive: true`)
- [ ] Each tool's input_schema validates the documented action enum (passing an invalid action produces a tool error, not an exception)
- [ ] `scenes.list_primitives` returns the catalog content correctly

---

## Notes

- Convention: tool ids use dot notation internally (`light_show.scenes`); chat-tool names use double underscore (`light_show__scenes`) because Claude's tool-name regex forbids dots. The host handles the conversion.
- Don't change the existing fixtures / overrides / screens tool entries — they stay as-is.
