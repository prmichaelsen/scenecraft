# Milestone 19: Light Show Scene Editor MVP

**Goal**: Ship the light_show plugin's scene authoring layer — a three-tier data model (scenes, placements, single-slot live override), a primitive catalog (`rotating_head` + `static_color` at MVP), a layered precedence evaluator, and three action-dispatched MCP tools (`scenes`, `scene_timeline`, `scene_live`). End-to-end success criterion: chat creates a rotating-head scene → places it on the main timeline 5-15s → user presses play → 3D preview renders the rotating-head animation; live override fires mid-play; deactivate; timeline resumes.
**Duration**: ~12h (~3 days at half-day pace)
**Dependencies**:
- light_show plugin already shipped: fixtures + screens + per-fixture overrides + WS broadcasts (M17 partial work)
- `LightShow3DPanel` wired with playhead + master-bus sampler + audio-reactive scenes (recently shipped)
- `useScenecraftSocket().connected` reconnect signal (existing)
- `plugin_api.broadcast_event`, `register_rest_endpoint`, `PluginHost.register_declared` (existing)
- No new npm or Python deps
**Status**: Not Started

---

## Overview

Implements the design at [`agent/design/local.light-show-scene-editor.md`](../design/local.light-show-scene-editor.md) and the implementation contract at [`agent/specs/local.light-show-scene-editor.md`](../specs/local.light-show-scene-editor.md). Decisions sourced from [`clarification-14`](../clarifications/clarification-14-light-show-scene-editor-mvp.md).

**Scope intentionally narrow**: just enough to test pre-programmed rotating-head animation on the main timeline. Compositions, modulation matrix, crossfade, multi-layer merge, more primitives, scene editor panel, GDTF/MVR — all deferred (documented in design's Future Considerations).

**Why this is a separate milestone from M17**: M17 ("Track Contribution Point and Light Show Plugin") covers the broader architectural shift (track contribution point, full scene DSL, schema migration). The scene editor MVP is a focused, independently-shippable subset that validates the data model and tool surface before the bigger M17 pieces land.

**Source-of-truth contract**: the spec (51 requirements, 66 tests across base + edge cases). Each task below cites the requirements + tests it covers.

---

## Deliverables

### Backend (scenecraft-engine)

#### 1. Schema + DB helpers (task-151)
- `_ensure_schema` in `db.py` adds `light_show__scenes`, `light_show__scene_placements`, `light_show__live_override` per R1-R3
- 9 helpers: `list/upsert/remove_light_show_scenes`, `list/upsert/remove_light_show_placements`, `get/activate/deactivate_light_show_live_override`
- Sparse params storage; CHECK constraint on `light_show__live_override.id = 'current'` and the inline-vs-scene-id mutual exclusion
- Re-export all helpers from `plugin_api.py` (R30)

#### 2. Primitives catalog YAML (task-152)
- `scenecraft-engine/src/scenecraft/plugins/light_show/primitives_catalog.yaml`
- Two entries: `rotating_head`, `static_color` per defaults locked in clarification-14 Q 5.1 / 5.2
- Backend loads via `yaml.safe_load`; frontend reads via Vite import

#### 3. REST endpoints (task-153)
- Conventional REST per the spec's REST table (NOT collapsed action endpoints):
  - `GET /scenes`, `POST /scenes`, `GET/PATCH/DELETE /scenes/:id`
  - `GET /placements`, `POST /placements`, `GET/PATCH/DELETE /placements/:id`
  - `GET /live`, `PUT /live`, `DELETE /live`
  - `GET /primitives`
- List query params: `?type=&label_query=&ids=&limit=&offset=&order_by=&order=` (scenes); `?scene_id=&time_start=&time_end=&...` (placements)
- 409 Conflict on blocked DELETE (referenced by placements / live override)
- PATCH bodies = RFC 7396 merge-patch (null deletes per-key in params)
- WS `light_show__changed` events with new `kind` values: `"scenes" | "placements" | "live"` (R29)

#### 4. `tools_scenes` MCP handler (task-154)
- Action dispatch on `list | list_primitives | set | remove`
- `list`: filter (ids/type/label_query) + pagination (limit≤500, offset, order_by, order); returns `{scenes, total, has_more}` with sparse params per R5
- `list_primitives`: returns parsed YAML catalog verbatim per R4
- `set`: id-presence dispatch — missing id → CREATE with server UUID; present id → UPDATE with merge-patch on params (null deletes per-key); rejects null on top-level fields and on the params object itself; rejects unknown type; atomic all-or-nothing on multi-entry batches
- `remove`: rejects when blocked by placements (R9) or live override (R10), returning `{error, blocked, blocked_by_live?}`; on success returns deleted rows only

#### 5. `tools_scene_timeline` MCP handler (task-155)
- Action dispatch on `list | set | remove`
- `list`: filter (ids/scene_id/time_range overlap) + pagination; returns `{placements, total, has_more}`
- `set`: missing id → INSERT with server UUID; present id → merge UPDATE; rejects `end_time <= start_time` (R14); rejects unknown `scene_id` (R15); atomic
- `remove`: deletes by ids; silently skips missing; returns deleted rows only (R16)

#### 6. `tools_scene_live` MCP handler (task-156)
- Action dispatch on `activate | deactivate | status`
- `activate`: accepts `scene_id` OR inline `scene` (NEVER both — R18); rejects unknown scene_id / unknown primitive type; replaces existing override silently (R21); `save_as` persists inline scene with that label and a fresh server UUID (R22), returns the new `scene_id` in response
- `deactivate`: sets `deactivation_started_at = now`; updates `fade_out_sec`; row physically deleted by frontend evaluator after fade completes (R47)
- `status`: returns `{active, scene_id?, label?, activated_at?, fade_in_sec?, fade_out_sec?, deactivation_started_at?}`

#### 7. plugin.yaml declarations (task-157)
- Three new MCP tool entries with full input_schema per the spec's MCP Tool Input Schemas section
- `scenes`: `list/list_primitives/set/remove` with optional filter+pagination object on the action input
- `scene_timeline`: `list/set/remove` with placement filter object
- `scene_live`: `activate/deactivate/status` with `scene_id | scene + save_as + fade_*` input

#### 8. Backend tests (task-158)
- pytest covering: CRUD roundtrip per table, partial-upsert + null-delete + atomic-rejection semantics, reference-blocking on remove, LIVE_OVERRIDE persistence across restart, WS broadcast `kind` correctness, primitive catalog YAML parses to expected shape
- Targeted at the spec's Base + Edge tests for backend (~30 tests in scope; non-frontend ones)

### Frontend (scenecraft)

#### 9. Client + types (task-159)
- `src/plugins/light_show/light-show-client.ts` — types `SceneRow / SceneUpsert / PlacementRow / PlacementUpsert / LiveOverrideRow / PrimitiveCatalogEntry` + fetchers for each REST endpoint
- Sparse `params` round-trip safety preserved (no merge-on-list)

#### 10. Primitives module (task-160)
- `src/plugins/light_show/primitives.ts`
- `applyRotatingHead(sceneTime, states, params, context)` per R32-R37 (sinusoidal pan/tilt with role filter)
- `applyStaticColor(sceneTime, states, params, context)` per R38 (intensity + color; respects role filter)
- `PRIMITIVE_REGISTRY: Record<string, PrimitiveApplyFn>`; module-init assertion that registry keys ⟷ catalog ids match (R31)
- Catalog imported from the YAML file (Vite `?raw` + `js-yaml`, OR fetched via `/primitives` at boot — pick one, document)

#### 11. Layered evaluator (task-161)
- `src/plugins/light_show/scene-evaluator.ts`
- `evaluateLayeredScene(args)` per R39-R48: live > placement > fallback precedence; sparse-merge with catalog defaults at apply-time (R40a); deterministic scene-local time from playhead (R40); fade envelope intensity-only (R42-R47); auto-deletes live override when fade-out completes (R47)
- Returns `{activeLayer, label}` for the diagnostic bar

#### 12. Panel integration + manual verification (task-162)
- `LightShow3DPanel.tsx` — fetch scenes/placements/live on mount; subscribe to `light_show__changed` (kinds `scenes`/`placements`/`live`); refetch on `useScenecraftSocket().connected` false→true transition (R49 — NO periodic polling)
- Diagnostic bar shows `LIVE: <label>`, `TIMELINE: <label>`, or `FALLBACK: <label>` (R50)
- Existing dropdown fallback preserved (R41 transitional)
- Manual E2E: chat creates rotating_head scene → places 5-15s → press play → animation renders; live override fires mid-play; deactivate; timeline resumes
- `tsc --noEmit` clean across the light_show module

---

## Success Criteria

- [ ] All three new tables created on schema migration; existing project DBs pick them up automatically
- [ ] All 51 spec requirements implemented (R1-R50, R40a)
- [ ] Backend pytest passes for in-scope spec tests (~30 base/edge tests)
- [ ] Frontend `tsc --noEmit` clean in `src/plugins/light_show/`
- [ ] Manual E2E: rotating-head animation renders at the placed time range, scrubs deterministically, is overridden by live activate, resumes on deactivate
- [ ] Live override persists across backend restart
- [ ] Diagnostic bar shows the active layer label correctly across all three states
- [ ] No periodic polling (verified by network inspector — only mount-fetch + WS-event-driven refetch + reconnect-refetch observed)

---

## Out of Scope (deferred)

Per [clarification-14](../clarifications/clarification-14-light-show-scene-editor-mvp.md) and design's Future Considerations:

- Compositions / sequences (multi-primitive bundles)
- Modulation matrix / effect curves on params (`{source, mapper}` shape)
- Crossfade between placements (multi-layer / fade-overlap exception / explicit crossfade)
- Merge modes beyond single-winner `display_order`
- Waveform `shape` param on `rotating_head`
- More primitives (`strobe`, `chase`, `fade`, `breathe`, `circle`, `figure_eight`, etc.)
- Per-project vs. global scene library
- Scene library export / import
- Priority stack for live overrides
- Real DMX output protocols (Art-Net, sACN, OLA) — separate post-M17 milestone
- Scene Editor Panel with decoupled preview — future milestone
- Industry-standard format interop (GDTF, MVR, MA3 phasers/cues, etc.) — adapter-based, separate work

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Sparse param storage + evaluator-time merge introduces edge cases | Medium | Low | Spec R40a explicitly defines merge resolution; tests cover the default-fallback + undefined-when-no-default cases |
| WS reconnect-refetch not actually catching missed mutations | Medium | Low | Test `panel-refetches-on-ws-reconnect` exercises the false→true transition with a backend mutation in the disconnect window |
| Primitive registry / catalog drift | High | Low | Frontend module-init assertion fires loudly on mismatch (R31 + edge-case test) |
| Live override persistence semantics unclear at boot | Medium | Low | Spec R28 + test `live-override-persists-across-restart` |
| YAML catalog parse fails on backend or frontend | High | Low | Both sides use canonical libraries (`yaml.safe_load`, `js-yaml`); test asserts structural equality between parsed catalog and tool response |
| `null`-delete on params accidentally applied to top-level fields | Low | Low | Spec R6 explicitly rejects `null` on top-level NOT NULL columns + test |

---

**Next Milestone**: TBD. Likely candidates: M20 = Scene Editor Panel (decoupled preview), or fold scene-editor extensions back into M17 once the foundation is here.
**Blockers**: None.
**Notes**:
- Milestone is additive; no existing behavior breaks. The dropdown scene fallback is preserved as transitional (R41) — removed when the future Scene Editor Panel ships.
- Light_show plugin's existing fixtures / screens / overrides surfaces are unchanged.
- This milestone supersedes [clarification-14 Q 6.3](../clarifications/clarification-14-light-show-scene-editor-mvp.md) on scene id semantics — server-assigned UUID, not chat-chosen string. Design + spec are the live truth; clarification stays as historical record.
