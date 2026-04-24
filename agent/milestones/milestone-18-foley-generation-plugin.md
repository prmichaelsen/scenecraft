# Milestone 18: Foley Generation Plugin (Replicate BYO mode)

**Goal**: Ship scenecraft's second paid generation plugin — `generate-foley` backed by MMAudio via Replicate — producing AI-generated foley (sound effects) as pool_segments with both text-to-FX (t2fx) and video-to-FX (v2fx) support. Introduces the typed `plugin_api.providers.<provider>` namespace as the long-term successor to M16's generic `call_service()` shim. Orange clip styling, selection-driven mode, in/out range UX for v2fx, drag-to-audio-track.
**Duration**: ~3 weeks (~30h)
**Dependencies**:
- M6 JWT auth + sessions (done)
- M11 plugin scaffolding (`PluginHost` + `plugin-api` exist)
- M16 `spend_ledger` + `api_keys` tables + double-gate middleware — this milestone consumes both unchanged
- M13 `pool_segments.variant_kind` + `derived_from` columns — already present
- Replicate account + `REPLICATE_API_TOKEN` configured on the box
- `ffmpeg` available on the backend (already a beatlab dep)
**Status**: Not Started

---

## Overview

Implements the design at `agent/design/local.foley-generation-plugin.md` and the decisions in `agent/clarifications/clarification-12-foley-generation-plugin.md`. Ships BYO-only — user configures `REPLICATE_API_TOKEN` locally; plugin dispatches via the new `plugin_api.providers.replicate` typed provider module.

**Key architectural introductions**:
- `plugin_api.providers.replicate` — first concrete implementation of a typed per-provider surface; owns auth, HTTP, polling, backoff, spend_ledger, disconnect-survival, output download. Plugins supply model + input + source tag.
- Selection-driven mode dispatch (no UI radio) — nothing selected → t2fx; transition + tr_candidate → v2fx; transition alone → t2fx with warning banner.
- In/out range via playhead + Set-in/Set-out buttons, with most-recent-click-wins invalidation rule.
- Backend pre-trims source video to `[in, out]` before dispatching (cog forces `duration = video.duration_sec` otherwise).

**Design references**:
- `agent/design/local.foley-generation-plugin.md` — canonical architecture
- `agent/clarifications/clarification-12-foley-generation-plugin.md` — decision log + Q&A
- `agent/design/local.audio-isolation-plugin.md` — first-plugin reference
- `agent/milestones/milestone-16-music-generation-plugin.md` — closest sibling (paid-API plugin precedent)

---

## Deliverables

### 1. Replicate provider core (task-142)
- New `plugin_api/providers/` directory; `plugin_api.providers.replicate.ReplicateProvider`
- `run_prediction(*, model, input, source, poll_interval=5.0)` — full lifecycle: auth lookup, create prediction, 5s polling loop, 429 backoff (1s→2s→4s→fail), spend_ledger write on success, download output with 3× retry
- `get_balance() -> float | None` — Replicate account balance (provider-level, exposed for any future plugin)
- `attach_polling(prediction_id, source)` — server-start hook to reattach in-flight predictions
- Exception types: `ReplicateNotConfigured`, `ReplicatePredictionFailed`, `ReplicateDownloadFailed`
- Passes R9a invariant (no raw DB access; uses `plugin_api.record_spend`)

### 2. Foley schema + migrations (task-143)
- `generate_foley__generations` (plugin-owned in `project.db`) — mode, inputs, params, status, variant_count, entity ref
- `generate_foley__tracks` (plugin-owned junction) — 1:N generation→pool_segments with `variant_index` and `spend_ledger_id`
- Migration applies cleanly on a fresh project AND on projects with existing M13/M16 schema

### 3. Backend plugin module (task-144)
- `scenecraft-engine/src/scenecraft/plugins/generate_foley/` — `__init__.py`, `generate_foley.py`, `pretrim.py`
- `run(job_id, request)` handler: validate → pre-trim (v2fx only) → `providers.replicate.run_prediction` → hash → `add_pool_segment` → insert `__tracks` row → emit WS events
- Pre-trim logic: `ffmpeg -ss <in> -to <out> -c copy` when keyframe-aligned, else re-encode; writes to tempdir
- Status transitions `pending → running → completed | failed` with download auto-retry (3× backoff) before declaring failure
- Startup scan of `generate_foley__generations WHERE status IN ('pending','running')` → `providers.replicate.attach_polling`

### 4. Backend REST + WS (task-145)
- `POST /api/projects/:project/plugins/generate-foley/run`
- `GET /api/projects/:project/plugins/generate-foley/generations?entityType=&entityId=`
- `POST /api/projects/:project/plugins/generate-foley/generations/:id/retry`
- JobManager WS events on `/ws/jobs`: `job_started`, `job_progress` (stage: `pretrim`/`predicting`/`downloading`), `job_completed`, `job_failed`

### 5. Frontend plugin module (task-146)
- `scenecraft/src/plugins/generate-foley/plugin.yaml` — manifest with contribution points; includes `license.upstream_models: [MMAudio CC-BY-NC 4.0]`
- `scenecraft/src/plugins/generate-foley/client.ts` — REST helpers + WS subscription
- `scenecraft/src/plugins/generate-foley/index.ts` — `activate(host)` + panel registration

### 6. FoleyGenerationsPanel (task-147)
- Plain React in `EditorPanelLayout`'s `PanelRegistry` (NOT dockview)
- Selection-aware: reads current transition + tr_candidate; renders warning banner when transition selected without candidate
- Kickoff form: prompt textarea, duration preset (Burst 2s / Sequence 8s / Ambience 30s) + slider 1–30s (hidden in v2fx), Set-in / Set-out / Clear buttons (v2fx only), negative_prompt, cfg_strength, seed, Generate button
- Set-in/Set-out state machine with most-recent-click-wins invalidation rule; range clears when candidate/transition selection changes
- Run cards: newest-first, per-generation status + mode badge + params summary + Retry button + drag handle on result pool_segment
- Drag payload `application/x-scenecraft-stem` with `stem_type='foley'`

### 7. Chat tool (task-148)
- `generate_foley(prompt, duration?, source_candidate_id?, in_seconds?, out_seconds?, negative_prompt?, cfg_strength?, seed?, count=1)` with elicitation gate via `_DESTRUCTIVE_TOOL_PATTERNS`
- MVP enforces `count == 1` (returns tool error if violated)
- NO companion tools (`list_foley_generations`, `retry_foley_generation`, `get_replicate_balance` — deferred)

### 8. Orange clip styling (task-149)
- Extend frontend's `variant_kind` → color map: `'foley'` → orange (hex TBD, complements existing purple/teal/blue)
- Applies everywhere clips render (Timeline, pool view, run cards)

---

## Success Criteria

- [ ] `plugin_api.providers.replicate.run_prediction` handles auth, polling, 429 backoff, spend_ledger, disconnect-survival with tests
- [ ] `generate_foley__generations` + `__tracks` schema applies cleanly on fresh + existing projects
- [ ] t2fx end-to-end: panel (no selection) → prompt + Burst duration → Generate → pool_segment with `variant_kind='foley'`, draggable to audio track
- [ ] v2fx end-to-end: panel (tr + candidate selected) → Set-in/Set-out → Generate → backend pre-trims → MMAudio returns synchronized foley → pool_segment with `derived_from` populated
- [ ] Transition-without-candidate warning banner shows; falls back to t2fx correctly
- [ ] Most-recent-click-wins rule for in/out: setting `out < in` clears `in`; setting `in > out` clears `out`
- [ ] Changing selection while range is set clears the range
- [ ] Clip color is orange in Timeline, pool view, and run cards
- [ ] Chat tool `generate_foley` triggers elicitation, runs on confirm, no-ops on decline
- [ ] Missing `REPLICATE_API_TOKEN` → plugin registers; panel shows "API key not configured" error banner; no crash
- [ ] Spend_ledger row written exactly once per successful prediction (amount=1, unit='prediction', source='generate_foley')
- [ ] R9a structural invariant (`plugin-api-exposes-no-raw-db-handle`) still passes
- [ ] Real-API smoke test (gated on env var) produces both a t2fx and a v2fx generation

---

## Out of Scope

- Marker-driven foley composition (hit-marker fx-track infra was removed) — **dropped**, not deferred
- Multi-variant generation (`count > 1`) — schema forward-looking; MVP enforces `count == 1`
- Local GPU / CPU inference paths — Replicate-only for MVP
- Migrating M16 music plugin from `call_service()` to `plugin_api.providers.musicful.*` — separate follow-up milestone
- User-facing license disclosure banner (MMAudio CC-BY-NC) — deferred until multi-tenant scenecraft.online lands
- Auto-creating a "Foley" audio track — drop onto any existing lane
- Snap-to-hit-markers on drag — inherited from M7 when it ships
- Companion chat tools (`list_foley_generations`, `retry_foley_generation`)
- `get_replicate_balance` as a plugin-level surface — belongs on `plugin_api.providers.replicate` (out of scope for chat tool MVP)

---

## Risks / Mitigations

| Risk | Mitigation |
|---|---|
| `plugin_api.providers.replicate` needs to serve other future Replicate-backed plugins; over-fitting to foley could regret | API is model-agnostic (`run_prediction(model=<string>, input=<dict>)`); foley-specific logic (pre-trim, variant_kind, sidecar) stays in the plugin. Validate with a second consumer before locking. |
| MMAudio quality cliff above ~12s could make Ambience preset (30s) unusable | 30s is product-side ceiling; can tighten to 15s if real-user QA flags. Slider already caps at 30s. |
| Replicate charges for failed downloads (prediction succeeded, we couldn't fetch) | 3× download retry with backoff; error message explicitly states "prediction charged, retry will re-charge" so user decides. |
| MMAudio cog overrides `duration` when video is present — surprise for v2fx callers | Pre-trim to `[in, out]` before sending. Cog sees exactly the duration we want. Tested on multiple input clip lengths. |
| CC-BY-NC license becomes an issue if scenecraft.online ever opens commercial access | HunyuanVideo-Foley (Apache 2.0) is a drop-in replacement; provider abstraction makes the switch one line. |
| Polling loop leaks on box restart | Generations with `status IN ('pending','running')` are resumable — startup scan reattaches polling via `providers.replicate.attach_polling`. |

---

## Tasks

1. [task-142: Replicate provider core](../tasks/milestone-18-foley-generation-plugin/task-142-replicate-provider.md) — 6h
2. [task-143: Foley schema + migrations](../tasks/milestone-18-foley-generation-plugin/task-143-schema-and-migrations.md) — 2h
3. [task-144: Backend plugin module](../tasks/milestone-18-foley-generation-plugin/task-144-backend-plugin-module.md) — 6h
4. [task-145: Backend REST + WS](../tasks/milestone-18-foley-generation-plugin/task-145-backend-rest-and-ws.md) — 3h
5. [task-146: Frontend plugin module](../tasks/milestone-18-foley-generation-plugin/task-146-frontend-plugin-module.md) — 3h
6. [task-147: FoleyGenerationsPanel](../tasks/milestone-18-foley-generation-plugin/task-147-foley-generations-panel.md) — 8h
7. [task-148: Chat tool](../tasks/milestone-18-foley-generation-plugin/task-148-chat-tool.md) — 2h
8. [task-149: Orange clip styling](../tasks/milestone-18-foley-generation-plugin/task-149-orange-clip-styling.md) — 1h

**Total**: ~31h
