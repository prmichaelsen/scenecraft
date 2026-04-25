# Task 154: `tools_scenes` MCP Handler

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — R4-R11; tests `scenes-list-*`, `scenes-set-*`, `scenes-remove-*`
**Estimated Time**: 1.5 hours
**Dependencies**: task-151 (DB helpers), task-152 (catalog YAML)
**Status**: Not Started

---

## Objective

Implement the `scenes` MCP tool as a single action-dispatched handler. Actions: `list | list_primitives | set | remove`. Calls plugin_api / DB helpers directly (no REST roundtrip). Bulk dispatch handled here in a single transaction.

---

## Steps

### 1. Add `tools_scenes(args, tool_context)` to `scenecraft-engine/src/scenecraft/plugins/light_show/__init__.py`

Dispatch on `args["action"]`:

**`list`**: Pass through filter + pagination args to `plugin_api.list_light_show_scenes(...)` per R5. Returns `{scenes, total, has_more}`. Sparse params (no merge with catalog).

**`list_primitives`**: Load catalog YAML once at module init (cached), return `{primitives: [...]}` verbatim per R4.

**`set`**: Bulk upsert per R6 with id-presence dispatch. Returns `{scenes: [...]}` containing only upserted rows (sparse, post-merge state). On any rejection (missing label/type on create, unknown id on update, unknown type, null on top-level, null params object), return error envelope with NO writes — atomic across the batch.

**`remove`**: Per R9-R10. Return `{scenes: [deleted_rows]}` on success, or `{error, blocked, blocked_by_live?}` on rejection. NO partial deletes.

### 2. Action validation

Unknown action → `{error: "unknown action <action>; expected one of list/list_primitives/set/remove"}` per R11.

### 3. Pagination defaults

- `limit` default 50, max 500 (clamp values >500 to 500); `offset` default 0
- `order_by` default `"updated_at"`; valid: `"created_at" | "updated_at" | "label"`
- `order` default `"desc"`; valid: `"asc" | "desc"`
- Invalid enum values → error envelope

### 4. WS broadcast

Mutating actions (`set`, `remove`) emit `light_show__changed` with `kind: "scenes"` via `_notify(project_name, "scenes")` (existing helper).

### 5. Add `"tools_scenes"` to `__all__` in `__init__.py`

So `PluginHost.register_declared` resolves the handler reference from `plugin.yaml`.

---

## Verification

Spec base tests covered (must pass):
- [ ] `scenes-list-primitives-returns-catalog-verbatim` (R4)
- [ ] `scenes-set-creates-new-with-server-uuid` (R5, R6)
- [ ] `scenes-set-rejects-create-without-label-or-type` (R6)
- [ ] `scenes-set-rejects-update-with-unknown-id` (R7)
- [ ] `scenes-set-partial-update-preserves-omitted` (R6)
- [ ] `scenes-set-null-deletes-param-key` (R6)
- [ ] `scenes-set-rejects-null-on-top-level` (R6)
- [ ] `scenes-set-rejects-null-params-object` (R6)
- [ ] `scenes-roundtrip-list-set-preserves-sparse` (R5, R6)
- [ ] `scenes-set-rejects-unknown-type` (R8)
- [ ] `scenes-remove-happy-path` (R9)
- [ ] `scenes-remove-rejects-when-placements-reference` (R9)
- [ ] `scenes-remove-rejects-when-live-override-holds` (R10)
- [ ] `scenes-list-default-pagination` (R5)
- [ ] `scenes-list-pagination-second-page` (R5)
- [ ] `scenes-list-filter-by-type` (R5)
- [ ] `scenes-list-filter-by-label-query-substring-case-insensitive` (R5)
- [ ] `scenes-list-filter-by-ids` (R5)
- [ ] `scenes-list-order-by-label-asc` (R5)
- [ ] `scenes-list-limit-clamped-to-max` (R5)
- [ ] `scenes-remove-returns-deleted-rows` (R9)

Edge tests covered:
- [ ] `scenes-remove-multiple-atomic-when-one-blocked` (R9)
- [ ] `unknown-action-returns-error-not-exception` (subset for `scenes`)
- [ ] `negative-no-broadcast-on-rejected-set` (subset for `scenes`)

---

## Notes

- The MCP tool calls plugin_api / DB helpers directly — does NOT go through REST. Bulk semantics are handled here in a single SQLite transaction.
- The frontend's `tsc` types for the response shape come from `light-show-client.ts` (task-159). Make sure the JSON shape matches what the client expects: `{scenes, total, has_more}` for list, `{scenes}` for mutating ops.
