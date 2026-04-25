# Task 155: `tools_scene_timeline` MCP Handler

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — R12-R17; tests `scene-timeline-*`
**Estimated Time**: 1 hour
**Dependencies**: task-151 (DB helpers)
**Status**: Not Started

---

## Objective

Implement the `scene_timeline` MCP tool as a single action-dispatched handler. Actions: `list | set | remove`. Calls plugin_api / DB helpers directly. Atomic bulk dispatch.

---

## Steps

### 1. Add `tools_scene_timeline(args, tool_context)` to `__init__.py`

Dispatch on `args["action"]`:

**`list`**: Pass filter (ids, scene_id, time_range) + pagination (limit≤1000, offset, order_by ∈ {start_time, created_at}, order) to `plugin_api.list_light_show_placements(...)`. Returns `{placements, total, has_more}` per R12. `time_range` = `{start, end}` selects placements where `placement.start_time <= range.end AND placement.end_time >= range.start`.

**`set`**: Per R13-R15:
- Missing `id` on entry → INSERT with auto-uuid
- Present `id` → merge UPDATE
- `end_time <= start_time` → reject atomically with the spec'd error
- Unknown `scene_id` → reject atomically with the spec'd error
- Returns `{placements: [...]}` containing only upserted rows (auto-generated ids included; order matches input array)

**`remove`**: Per R16. Return `{placements: [deleted_rows]}`. Silently skip missing ids.

### 2. Action validation

Unknown action → `{error: "unknown action <action>; expected one of list/set/remove"}` per R17.

### 3. Defaults

- `limit` default 100, max 1000
- `order_by` default `"start_time"`; valid: `"start_time" | "created_at"`
- `order` default `"asc"`

### 4. WS broadcast

Mutating actions emit `light_show__changed` with `kind: "placements"` via `_notify(project_name, "placements")`.

### 5. Add `"tools_scene_timeline"` to `__all__`

---

## Verification

Spec base tests covered:
- [ ] `scene-timeline-set-inserts-with-auto-uuid` (R12, R13)
- [ ] `scene-timeline-set-rejects-end-before-start` (R14)
- [ ] `scene-timeline-set-rejects-unknown-scene-id` (R15)
- [ ] `scene-timeline-list-default-chronological` (R12)
- [ ] `scene-timeline-list-filter-time-range` (R12)
- [ ] `scene-timeline-list-filter-by-scene-id` (R12)
- [ ] `scene-timeline-set-returns-upserted-only` (R13)
- [ ] `scene-timeline-remove-returns-deleted-rows` (R16)

Edge tests covered:
- [ ] `unknown-action-returns-error-not-exception` (subset for `scene_timeline`)
- [ ] `negative-no-partial-placement-write-on-multi-invalid` (R14)

---

## Notes

- Time range overlap test: a placement `[5, 15]` overlaps query `[10, 20]` (yes), `[20, 30]` (no — placement.end=15 < range.start=20), `[0, 5]` (yes — boundary touch).
- Auto-uuid response correlation: callers correlate input position to output uuid by index in the returned array (caller's input order is preserved on output).
