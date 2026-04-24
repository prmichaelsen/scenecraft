# Milestone 16: Music Generation Plugin (BYO mode)

**Goal**: Ship scenecraft's first paid generation plugin — `generate-music` backed by the Musicful API — producing AI-composed music as pool_segments, with drag-to-timeline, purple clip styling, context-aware candidate routing, chat tools, and BYO-key configuration. The broker/cloud path (brokered-mode + scenecraft.online) is explicitly deferred.
**Duration**: ~1 week
**Dependencies**:
- M6 JWT auth + sessions (done) — extended by this milestone's auth-prereqs task
- M11 plugin scaffolding (task-101 landed; `PluginHost` + `plugin-api` exist)
- M13 schema additions to `pool_segments` (`variant_kind`, `derived_from`) — if M13 has not landed, M16 copies the migration for the columns it needs
**Status**: Not Started

---

## Overview

Implements the spec at `agent/specs/local.music-generation-plugin.md` (56 requirements, 37+ tests). Ships BYO-only — user enters `MUSICFUL_API_KEY` locally; plugin calls Musicful directly. The `plugin_api.call_service()` shim is built such that brokered-mode can be added later without touching plugin code.

Also lands:
- Core `spend_ledger` table in `server.db` — first consumer is music-gen, but future paid plugins (Veo, Replicate, ElevenLabs, OpenAI) reuse it unchanged via `amount`+`unit` columns.
- Core `api_keys` table + double-gate auth middleware (session + `X-Scenecraft-API-Key` header) — M16 introduces because the spec requires it; serves all future paid ops too.
- Core `pool_segments.context_entity_type` + `context_entity_id` columns for weak-context-provenance (distinct from M13's typed `derived_from`).

**Design references**:
- `agent/design/local.scenecraft-online-platform.md` — trust boundary + auth model that M16 implements the on-box half of
- `agent/specs/local.music-generation-plugin.md` — exact behavior contract

---

## Deliverables

### 1. Auth prerequisites (task-126)
- `api_keys` table on `server.db` with expiry, key_hash, issued_by, issued_at
- Password-change-on-first-login gate (`users.must_change_password`)
- Double-gate middleware: validates session + `X-Scenecraft-API-Key` header match
- Active-org resolution: header `X-Scenecraft-Org` → session `last_active_org` → single-org → HTTP 400
- Admin CLI for issuing / expiring keys

### 2. Schema + helpers (task-127)
- `generate_music__generations` + `generate_music__tracks` (plugin-owned)
- `spend_ledger` (core-owned in `server.db`) with `amount`/`unit`/`source`/`api_key_id`
- `pool_segments.context_entity_type` + `context_entity_id` columns
- `plugin_api.record_spend()` + core-write helpers (`add_pool_segment`, `add_audio_candidate`, `add_tr_candidate`)

### 3. plugin-api service routing shim (task-128)
- `plugin_api.call_service()` with BYO mode
- Reads per-service config (env var presence) to decide routing
- Broker path stubbed; returns clear error pointing to cloud milestone

### 4. Musicful client + backend plugin (task-129)
- `plugins/generate_music/client.py` — Musicful REST wrapper (`generate`, `tasks`, `get_api_key_info`, `generate_wav`)
- `plugins/generate_music/generate_music.py` — run handler + polling worker (box drives cadence; 5s interval; exponential backoff on 429)
- 429 retry logic (1s → 2s → 4s → fail)
- Download completed mp3 to `pool/segments/<uuid>.mp3`
- Partial-success handling (R20)

### 5. Backend REST + WS (task-130)
- `POST /api/projects/:project/plugins/generate-music/run`
- `GET /api/projects/:project/plugins/generate-music/generations?entityType=&entityId=`
- `POST /api/projects/:project/plugins/generate-music/generations/:id/retry`
- `GET /api/projects/:project/plugins/generate-music/credits`
- JobManager WS events (`job_started`, `job_progress`, `job_completed`, `job_failed`) on `/ws/jobs`

### 6. Frontend plugin module (task-131)
- `scenecraft/src/plugins/generate-music/plugin.yaml` (manifest mirror with `contributes.invariants`)
- `scenecraft/src/plugins/generate-music/client.ts` — REST helpers + WS subscription
- `scenecraft/src/plugins/generate-music/index.ts` — `activate(host)` + panel contribution

### 7. MusicGenerationsPanel (task-132)
- Plain React component registered in `EditorPanelLayout`'s `PanelRegistry` (NOT dockview)
- Form with all fields always rendered (action radio, style, lyrics, instrumental, gender, model, title, credits header)
- Run cards with status badges, context badges, Reuse + Retry buttons, drag handles on each track
- Context-aware filtering (selection → filter; "Show all" toggle)
- Permanent credits counter in header

### 8. Chat tools (task-133)
- `generate_music(action, style, lyrics?, instrumental?, title?, gender?, model?)` + elicitation gate via `_DESTRUCTIVE_TOOL_PATTERNS`
- `get_music_credits()` — free, no elicitation
- NO `generate_lyrics` tool

### 9. Drag-to-timeline + purple styling (task-134)
- Drag payload on track rows (`application/x-scenecraft-stem` with `stem_type='music'`)
- No auto-create of "Music" track; drop onto any existing lane
- Clip color map driven by `pool_segment.variant_kind` — purple for `'music'`, teal reserved for `'lipsync'` (M13), default blue otherwise

---

## Success Criteria

All 11 acceptance criteria from the spec must pass. Summary:

- [ ] Every requirement R1-R56 in the spec has at least one test covering it (all 37+ named tests pass)
- [ ] Schema changes apply cleanly on a fresh project AND on a project with existing M11/M13 schema state
- [ ] Panel renders, filters by selection, drags stems onto timeline
- [ ] Chat tool elicitation accepts + runs / declines + no-ops
- [ ] Missing API key → admin error; plugin still registers; UI discoverable
- [ ] Real-API smoke test (gated on env var) produces a completed generation
- [ ] `spend_ledger` row written exactly once per successful generation; zero on failure
- [ ] `plugin-api-exposes-no-raw-db-handle` structural test passes (R9a invariant)

---

## Out of Scope

Everything in the spec's Non-Goals section plus:
- Brokered mode (belongs to the scenecraft.online milestone, not M16)
- Core `credit_ledger` → `spend_ledger` existing-data migration (M16 is introducing `spend_ledger`, no existing data)
- Multi-provider support (Suno, Udio, etc.)
- Plugin invariant harness runtime (manifest declaration stays forward-compat; harness lands M17)

---

## Risks / Mitigations

| Risk | Mitigation |
|---|---|
| `spend_ledger` column choices regret-worthy once second paid plugin lands | Schema is unit-agnostic (`amount`+`unit`+`metadata` JSON); future plugins add their own unit string without migration. |
| Musicful API changes pricing mid-development | Spec uses `amount=<N successful tasks>` as the credit count, not a hardcoded value; real-API smoke test catches breakage. |
| Auth middleware breaks existing non-plugin endpoints | Scope the double-gate to paid-plugin routes only in the first pass; broader rollout is a separate decision. |
| Polling loop leaks on box restart | Generations in `status='pending'|'running'` are resumable — backend scans on startup and re-attaches polling workers (see task-129 notes). |
| M11 mid-ship collisions on `audio_candidates` writes | M11 explicitly reserved the table for future generated-audio; M16 is that future. Coordinate with anyone still on M11 tasks 102-104. |

---

## Tasks

1. [task-126: Auth layer prerequisites](../tasks/milestone-16-music-generation-plugin/task-126-auth-prereqs.md) — 4h
2. [task-127: Schema + helpers](../tasks/milestone-16-music-generation-plugin/task-127-schema-and-helpers.md) — 3h
3. [task-128: plugin-api service-routing shim](../tasks/milestone-16-music-generation-plugin/task-128-plugin-api-service-shim.md) — 2h
4. [task-129: Musicful client + backend plugin](../tasks/milestone-16-music-generation-plugin/task-129-musicful-client-and-worker.md) — 6h
5. [task-130: Backend REST + WS](../tasks/milestone-16-music-generation-plugin/task-130-backend-rest-and-ws.md) — 3h
6. [task-131: Frontend plugin module](../tasks/milestone-16-music-generation-plugin/task-131-frontend-plugin-module.md) — 3h
7. [task-132: MusicGenerationsPanel](../tasks/milestone-16-music-generation-plugin/task-132-music-generations-panel.md) — 6h
8. [task-133: Chat tools](../tasks/milestone-16-music-generation-plugin/task-133-chat-tools.md) — 3h
9. [task-134: Drag-to-timeline + purple styling](../tasks/milestone-16-music-generation-plugin/task-134-drag-and-purple-styling.md) — 2h

**Total**: ~32h
