# Spec: generate_foley Plugin (Retroactive Black-Box)

> **🤖 Agent Directive**: This spec defines the observable behavior of the `generate-foley`
> plugin — both backend (scenecraft-engine) and frontend (scenecraft) halves — as built.
> It is a retroactive contract produced by black-box reading of the implementation and
> the upstream design / clarification docs. Use it as the executable TDD source of truth
> for regression tests and for any reviewer proofing the plugin's behavior.

**Namespace**: local
**Spec**: generate-foley-plugin
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive)

---

## Purpose

Capture the end-to-end black-box behavior of the `generate-foley` plugin — manifest
contributions, mode dispatch, in/out UX, v2fx pre-trim, Replicate provider delegation,
pool landing rules, panel rendering and drag payload, disconnect-survival, and sidecar
tables — so that every reasonable input has a predicted, testable outcome.

## Source

- **Mode**: `--from-design` with cross-reference to `--from-clar`
- **Design**: `/home/prmichaelsen/.acp/projects/scenecraft/agent/design/local.foley-generation-plugin.md`
- **Clarification**: `/home/prmichaelsen/.acp/projects/scenecraft/agent/clarifications/clarification-12-foley-generation-plugin.md`
- **Backend sources**:
  - `scenecraft-engine/src/scenecraft/plugins/generate_foley/plugin.yaml`
  - `scenecraft-engine/src/scenecraft/plugins/generate_foley/__init__.py`
  - `scenecraft-engine/src/scenecraft/plugins/generate_foley/generate_foley.py`
  - `scenecraft-engine/src/scenecraft/plugins/generate_foley/routes.py`
  - `scenecraft-engine/src/scenecraft/plugins/generate_foley/pretrim.py`
- **Frontend sources**:
  - `scenecraft/src/plugins/generate_foley/plugin.yaml`
  - `scenecraft/src/plugins/generate_foley/index.ts`
  - `scenecraft/src/plugins/generate_foley/types.ts`
  - `scenecraft/src/plugins/generate_foley/generate-foley-client.ts`
  - `scenecraft/src/plugins/generate_foley/FoleyGenerationsPanel.tsx`

---

## Scope

### In Scope

- Plugin manifest contributions on both halves (panel, chat tool, REST endpoints,
  variant kind color, providers, invariants, license).
- Selection-driven t2fx vs. v2fx mode dispatch (nothing selected → t2fx;
  transition + candidate → v2fx; transition without candidate → t2fx + warning banner).
- Playhead-driven `Set in` / `Set out` UX with most-recent-click-wins invalidation.
- Backend pre-trim of source video to `[in, out]` range (stream-copy fast-path,
  re-encode fallback).
- MMAudio dispatch via `plugin_api.providers.replicate` (model `zsxkib/mmaudio`).
- Output landing on `pool_segments` with `variant_kind='foley'`, `kind='generated'`,
  `derived_from` strong-ref (v2fx only), `context_entity_*` weak-ref.
- `FoleyGenerationsPanel` rendering: form, run history, per-generation card, drag
  handle emitting `application/x-scenecraft-stem` payload with `stem_type='foley'`.
- WS job lifecycle (`job_started`, `job_progress`, `job_completed`, `job_failed`) and
  disconnect-survival via `resume_in_flight` + provider `attach_polling`.
- Sidecar schema: `generate_foley__generations` + `generate_foley__tracks`.
- REST surface: `POST /run`, `GET /generations`, `POST /generations/:id/retry`.
- Chat tool `generate_foley` with elicitation gate.
- Duration bounds (1.0s – 30.0s) enforced at API + impl + pretrim boundaries.

### Out of Scope (Non-Goals)

- Multi-variant generation (`count > 1`) — rejected at API boundary.
- Marker-driven foley / fx-track hit-markers (infrastructure removed).
- Local GPU / CPU / Vast.ai inference paths.
- Auto-placement of foley onto tracks (drag-to-timeline is user-initiated only).
- Snap-to-hit-markers on drag (M7 concern, not plugin concern).
- License disclosure banner / commercial posture gating (multi-tenant concern).
- Migrating `generate-music` to a typed provider surface.
- Auto-creating a dedicated "Foley" audio track.

---

## Requirements

**R1. Plugin manifest — backend.** `plugin.yaml` declares `id: generate-foley`,
`providers: [replicate]`, REST endpoints (`/run` POST, `/generations` GET,
`/generations/:id/retry` POST), chat tool `generate_foley`, variant kind `foley→orange`,
invariants (`no-raw-db-access`, `survives-ws-disconnect`, `mvp-count-is-one`),
and duration bounds `min: 1.0, max: 30.0`.

**R2. Plugin manifest — frontend.** `plugin.yaml` declares the same `id`/`providers`,
a `panels` contribution (`id: foley-generations`, `title: Foley`,
`component: FoleyGenerationsPanel`, `registry: PanelRegistry`), chat tool
`generate_foley`, variant kind `foley→orange`, invariants (`no-raw-db-access`,
`survives-ws-disconnect`).

**R3. Activation.** Backend `activate(plugin_api, context)` registers the three REST
routes and triggers `resume_in_flight`. Frontend `activate(host, context)` registers
the panel (`foley_generations`, title `Foley`, `FoleyGenerationsPanel`) via
`host.registerPanel`.

**R4. Mode dispatch.** Mode is resolved from inputs (not a UI toggle):
- Frontend: `selectedTransition && selectedCandidateId` → `v2fx`; else `t2fx`.
- Backend `_resolve_mode`: explicit `mode` wins if `'t2fx'|'v2fx'`, else
  `source_candidate_id` set → `v2fx`, else `t2fx`.

**R5. Ambiguity banner.** When a transition is selected but no candidate is selected,
the panel displays a yellow warning banner and proceeds in `t2fx` mode.

**R6. Playhead Set in / Set out.** `Set in` captures `currentTime` as `inSeconds`.
`Set out` captures `currentTime` as `outSeconds`. Most-recent-click-wins invalidation:
- `Set in` at time T where `outSeconds <= T` → clear `outSeconds`, set `inSeconds=T`.
- `Set out` at time T where `inSeconds >= T` → clear `inSeconds`, set `outSeconds=T`.
No silent swap. `Clear` resets both to null.

**R7. Selection-change clears range.** Changing `selectedTransition.id` or the selected
candidate clears both `inSeconds` and `outSeconds`.

**R8. Generate gate.** The Generate button is enabled iff
`mode === 't2fx'` OR
`mode === 'v2fx' && inSeconds !== null && outSeconds !== null && outSeconds > inSeconds && (outSeconds - inSeconds) <= 30`.
Otherwise disabled with a reason tooltip (`Set in-point`, `Set out-point`,
`Out must be > In`, `Range exceeds 30s limit`).

**R9. v2fx pre-trim.** For v2fx the backend resolves `source_candidate_id` to a pool
file path, invokes `pretrim.trim_to_range(source_path, in_seconds, out_seconds)`,
and passes the trimmed MP4 to MMAudio as a base64 `data:video/mp4;base64,…` URI
in the `video` input field. Duration falls out from the trimmed clip; the worker also
sets `input['duration'] = out - in` for bookkeeping.

**R10. Pretrim strategy.** `trim_to_range` first attempts stream-copy
(`ffmpeg -ss in -to out -i source -c copy -avoid_negative_ts make_zero dest`,
timeout 60s). On `CalledProcessError` it falls back to re-encode
(`ffmpeg -i source -ss in -to out -c:v libx264 -preset ultrafast -c:a aac dest`,
timeout 300s). Both failures raise `PretrimError`. Validation rejects
`out <= in`, negative `in`, `duration < 1.0s`, `duration > 30.0s`,
missing source file.

**R11. Replicate delegation.** Worker calls
`plugin_api.providers.replicate.run_prediction(model='zsxkib/mmaudio',
input={...}, source='generate-foley')`. Provider owns: `REPLICATE_API_TOKEN` lookup,
HTTP client, 429 exponential backoff (1s → 2s → 4s → fail), 5s polling,
disconnect-survival, `spend_ledger` write on Replicate `status='succeeded'`, and
output download with 3× retry.

**R12. Pool landing.** On success, worker copies the downloaded artifact to
`<project_dir>/pool/segments/<uuid><ext>` (default `.wav`), then calls
`plugin_api.add_pool_segment(project_dir, kind='generated',
created_by='plugin:generate-foley', pool_path=..., generation_params={provider:'replicate',
model:'zsxkib/mmaudio', prompt, cfg_strength, seed, mode}, byte_size=...)`.
Then `set_pool_segment_context(..., variant_kind='foley', context_entity_type=entity_type,
context_entity_id=entity_id)`. For v2fx only, `pool_segments.derived_from` is set to
the source `source_candidate_id` (pool_segment_id).

**R13. Sidecar: `generate_foley__generations`.** Schema matches design doc Item 7.
Columns: `id`, `created_at`, `created_by`, `mode` IN ('t2fx','v2fx'), `prompt`,
`duration_seconds`, `source_candidate_id`, `source_in_seconds`, `source_out_seconds`,
`model`, `negative_prompt`, `cfg_strength`, `seed`, `entity_type` IN ('transition') OR NULL,
`entity_id`, `variant_count` (DEFAULT 1), `status` IN ('pending','running','completed','failed'),
`error`, `started_at`, `completed_at`. Three indexes on status, (entity_type, entity_id),
and `__tracks.pool_segment_id`. `id` format: `fgen_<12-hex>`.

**R14. Sidecar: `generate_foley__tracks`.** Columns: `generation_id` (FK),
`pool_segment_id` (FK), `variant_index`, `replicate_prediction_id`,
`duration_seconds`, `spend_ledger_id`. PK `(generation_id, pool_segment_id)`.

**R15. Status transitions.** `pending → running → completed | failed`. `started_at`
set on `running`, `completed_at` set on terminal states. On failure, `error` is
populated with a user-visible message.

**R16. REST `POST /run` validation.** Rejects with `{error: …}`:
- `count != 1` → `"count must be 1 in MVP; multi-variant coming later"`.
- v2fx with missing `source_in_seconds`/`source_out_seconds` → explicit error.
- `source_out_seconds <= source_in_seconds` → explicit error.
- Range `> 30.0s` → explicit error.
- `duration_seconds` outside `[1.0, 30.0]` (t2fx) → explicit error.
- `entity_type` present and not `'transition'` → explicit error.
- Any `ValueError` from `impl.run` → `{error: str(e)}`.

**R17. REST `GET /generations`.** Returns `{generations: [...]}` filtered by optional
`entityType` and `entityId`, newest-first, `limit` default 200, clamped to `[1, 500]`.

**R18. REST `POST /generations/:id/retry`.** Looks up original generation; returns
`{error: "generation X not found", _status: 404}` if missing; returns
`{error: "generation X is still pending|running; wait..."}` if not terminal; otherwise
calls `impl.run` with the original generation's params, returning the new
`{generation_id, job_id, status, mode}`.

**R19. WS events.** On `/ws/jobs` the worker emits `job_started`, `job_progress`
(`detail: 'pretrim' | 'predicting' | 'downloading'`), `job_completed`
(`{generation_id, pool_segment_id}`), and `job_failed` (`{error}`).

**R20. Frontend REST client shapes.** `runFoleyGeneration`, `fetchFoleyGenerations`,
`retryFoleyGeneration` target the three endpoints exactly as declared; base URL from
`VITE_SCENECRAFT_API_URL` falling back to `http://localhost:8890`; query-string
encoding of `entityType`, `entityId`, `limit`.

**R21. Panel render contract.** `FoleyGenerationsPanel`:
- Shows mode badge (`Video-conditioned` / `Text-only`) based on selection.
- Shows ambiguity banner when transition selected but no candidate.
- Shows prompt textarea (required placeholder varies by mode; optional in v2fx).
- Shows duration preset group + 1–30s slider only in t2fx.
- Shows Set-in/Set-out/Clear buttons + in/out display only in v2fx.
- Advanced expander: negative_prompt (default `"music"`), cfg_strength (default 4.5,
  numeric 1–20 step 0.5), seed (text, blank = random).
- Generate button: orange when enabled, gray + disabled otherwise; label flips to
  `Generating...` during active submit.
- Run-history list of `GenerationListItem` cards: mode, prompt, duration, status icon,
  error text on failure.
- Completed rows expose one draggable tile per track: emits
  `application/x-scenecraft-stem` drag payload with
  `{pool_segment_id, pool_path, stem_type:'foley', variant_kind:'foley',
  duration_seconds}` and `effectAllowed='copy'`.
- Retry button shown for `completed` and `failed` rows.
- Fetches generations filtered by selected transition context; refreshes after
  generate-complete and retry-complete via `subscribeFoleyJob`.

**R22. Duration preset mapping.** `Burst=2s`, `Sequence=8s`, `Ambience=30s`, plus
`Custom`. Selecting a preset sets the slider value; moving the slider sets preset to
`Custom`.

**R23. Disconnect-survival.** On plugin activation (server start),
`resume_in_flight(project_dir)` scans `generate_foley__generations` rows with
`status IN ('pending','running')`. For each row with a `replicate_prediction_id` in
`__tracks`, spawns `_reattach_worker` which calls
`plugin_api.providers.replicate.attach_polling(prediction_id, source='generate-foley',
on_complete=cb)`. Rows with no prediction_id are marked `failed` with
`"server restart before prediction was created"`.

**R24. Reattach completion path.** When reattached polling completes successfully,
`_persist_output_to_pool_minimal` looks up the original generation row, reconstructs
metadata, writes pool segment + tracks row, marks generation `completed`. On download
or prediction failure, marks generation `failed` with appropriate error message;
spend is NOT double-recorded (attach_polling already did it on first success).

**R25. Chat tool.** `generate_foley(prompt, duration=None, source_candidate_id=None,
in_seconds=None, out_seconds=None, negative_prompt=None, cfg_strength=None,
seed=None, count=1)` — routes through `_DESTRUCTIVE_TOOL_PATTERNS` elicitation gate
because it costs money. Backend enforces `count == 1` (raises `ValueError`).

**R26. API-key precheck.** `check_api_key()` returns `{passed: True}` if
`REPLICATE_API_TOKEN` is in env, otherwise `{passed: False, message: "..."}` with
the Replicate tokens URL.

**R27. Cleanup on failure.** Worker `finally` block unlinks the pretrim temp file if
it was created.

**R28. Validation layering.** Impl-level `_validate` mirrors the REST validator and
adds:
- `t2fx` + `source_candidate_id` present → `ValueError`.
- `v2fx` missing `source_candidate_id` or in/out → `ValueError`.
- Variant count != 1 → `ValueError`.

---

## Interfaces / Data Shapes

### REST

```
POST   /api/projects/:project/plugins/generate-foley/run
        → body: GenerateFoleyRequest
        → res : GenerateFoleyResponse  (or {error})

GET    /api/projects/:project/plugins/generate-foley/generations
        ?entityType=transition&entityId=<id>&limit=<n>
        → res : {generations: GenerationListItem[]}

POST   /api/projects/:project/plugins/generate-foley/generations/:id/retry
        → res : GenerateFoleyResponse  (or {error, _status?})
```

### TypeScript request / response

```ts
type FoleyMode = 't2fx' | 'v2fx'

interface GenerateFoleyRequest {
  prompt?: string
  duration_seconds?: number            // t2fx: 1..30
  source_candidate_id?: string         // v2fx: pool_segment_id of tr_candidate
  source_in_seconds?: number           // v2fx required
  source_out_seconds?: number          // v2fx required
  negative_prompt?: string             // default 'music'
  cfg_strength?: number                // default 4.5
  seed?: number
  entity_type?: 'transition'
  entity_id?: string
  count?: number                       // MVP must be 1
}

interface GenerateFoleyResponse {
  generation_id: string                // 'fgen_<12hex>'
  job_id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  mode: FoleyMode
  error?: string
}
```

### WS drag payload

```json
{
  "pool_segment_id": "<id>",
  "pool_path": "pool/segments/<uuid>.wav",
  "stem_type": "foley",
  "variant_kind": "foley",
  "duration_seconds": <number>
}
```

MIME type: `application/x-scenecraft-stem`. `effectAllowed='copy'`.

### WS events (on `/ws/jobs`)

- `job_started`   — `{job_id, generation_id}`
- `job_progress`  — `{job_id, stage: 'pretrim' | 'predicting' | 'downloading'}`
- `job_completed` — `{job_id, generation_id, pool_segment_id}`
- `job_failed`    — `{job_id, generation_id, error}`

### SQL schemas

See R13 / R14 and design doc Item 7 for authoritative DDL.

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | No transition selected, t2fx happy path | Generates foley to pool with `variant_kind='foley'`, no `derived_from`, no context stamping | `t2fx-generates-to-pool`, `pool-segment-variant-kind-foley`, `no-derived-from-on-t2fx` |
| 2 | Transition + candidate selected, v2fx happy path | Pre-trims source, uploads data URI, pool segment has `derived_from=source_candidate_id` and `context_entity_*` stamped | `v2fx-pretrim-and-generate`, `derived-from-set-on-v2fx`, `context-entity-stamped` |
| 3 | Transition selected but no candidate | Ambiguity banner shown; generate proceeds as t2fx | `ambiguity-banner-shown`, `falls-back-to-t2fx` |
| 4 | `Set in` then `Set out` with valid range | Range captured; Generate button enables | `set-in-then-set-out-enables-generate` |
| 5 | `Set out` at time before existing `in` | `in` cleared; `out` set to new time | `out-before-in-clears-in` |
| 6 | `Set in` at time after existing `out` | `out` cleared; `in` set to new time | `in-after-out-clears-out` |
| 7 | Selection changes while range is set | Both `in` and `out` cleared | `selection-change-clears-range` |
| 8 | Range exceeds 30s | Generate disabled with "Range exceeds 30s limit" tooltip; REST rejects with error | `range-over-30s-disabled-ui`, `range-over-30s-rest-rejects` |
| 9 | Replicate prediction fails (status=failed) | Generation marked `failed` with MMAudio error; spend NOT recorded; `job_failed` emitted | `replicate-prediction-failed`, `no-spend-on-prediction-failure` |
| 10 | Stream-copy pretrim fails, re-encode succeeds | Pre-trim completes via fallback; generation proceeds | `pretrim-reencode-fallback` |
| 11 | Both pretrim strategies fail | Generation marked `failed` with `PretrimError` message | `pretrim-both-fail` |
| 12 | Missing `REPLICATE_API_TOKEN` | `check_api_key` returns `{passed: false, ...}`; worker raises `ReplicateNotConfigured` → generation `failed` | `check-api-key-missing`, `no-token-fails-run` |
| 13 | Server restart with in-flight generation (prediction_id exists) | `resume_in_flight` reattaches polling; on completion row marked `completed`; spend not double-recorded | `resume-in-flight-reattaches`, `reattach-no-double-spend` |
| 14 | Server restart before prediction created | Row marked `failed` with `"server restart before prediction was created"` | `resume-in-flight-no-prediction` |
| 15 | `count > 1` submitted | REST returns `{error: "count must be 1 in MVP..."}`; impl raises `ValueError` | `count-gt-1-rejected` |
| 16 | `POST /retry` on pending/running generation | Returns `{error: "...still pending|running..."}`; no new run | `retry-still-running-rejected` |
| 17 | `POST /retry` on nonexistent id | Returns `{error: "...not found", _status: 404}` | `retry-not-found-404` |
| 18 | `GET /generations` with filters | Returns filtered list, newest-first, limit clamped to 1..500 | `list-filters-newest-first`, `list-limit-clamped` |
| 19 | Drag completed foley card | `dragstart` sets `application/x-scenecraft-stem` payload with `stem_type='foley'` and `effectAllowed='copy'` | `drag-payload-shape` |
| 20 | Duration preset selected | Slider value snaps to preset (`Burst=2`, `Sequence=8`, `Ambience=30`) | `preset-sets-slider` |
| 21 | Slider moved | Preset flips to `Custom` | `slider-flips-to-custom` |
| 22 | Pool segment written | Has `kind='generated'`, `created_by='plugin:generate-foley'`, `variant_kind='foley'`, `generation_params.provider='replicate'`, `generation_params.model='zsxkib/mmaudio'` | `pool-segment-canonical-fields` |
| 23 | v2fx with `out<=in` submitted to REST | `{error: "source_out_seconds must be > source_in_seconds"}` | `v2fx-out-le-in-rest-rejects` |
| 24 | t2fx with `source_candidate_id` passed to impl | `ValueError("t2fx mode must not include source_candidate_id")` | `t2fx-with-candidate-id-rejected` |
| 25 | `entity_type` other than `'transition'` | `{error: "entity_type must be 'transition'..."}` | `entity-type-non-transition-rejected` |
| 26 | Playhead at exactly the clip boundary when `Set in` | `undefined` | → [OQ-1](#open-questions) |
| 27 | User submits with `in` set but no `out` | `undefined` (UI gate blocks, but explicit REST path unspecified) | → [OQ-2](#open-questions) |
| 28 | v2fx source `tr_candidate` deleted between `Generate` click and pretrim | `undefined` | → [OQ-3](#open-questions) |
| 29 | Replicate succeeds, all 3 download retries fail | Generation `failed`, error states `"prediction charged, download failed. Retry will re-charge."`; spend IS recorded | `replicate-download-failed-3x` |
| 30 | Requested duration exceeds what MMAudio supports in practice (>12s Ambience) | `undefined` (accepted up to 30s; model quality not validated) | → [OQ-4](#open-questions) |
| 31 | Two concurrent `generate_foley` calls for same transition + candidate | `undefined` | → [OQ-5](#open-questions) |
| 32 | Foley drag-tile dropped onto a video track | `undefined` (drop rules live in core timeline, not plugin) | → [OQ-6](#open-questions) |
| 33 | Chat tool `generate_foley` invoked | Passes through destructive-tool elicitation gate before running | `chat-tool-elicitation-gate` |
| 34 | Cost estimate surfaced pre-submit | `undefined` (no pre-submit estimate; balance is a provider concern) | → [OQ-7](#open-questions) |
| 35 | Panel activation | Registers panel id `foley_generations`, title `Foley`, component `FoleyGenerationsPanel` | `frontend-activate-registers-panel` |
| 36 | Backend activation | Registers three REST regex routes and runs `resume_in_flight` | `backend-activate-registers-routes` |
| 37 | Pretrim temp file after failure | Unlinked in worker `finally` | `pretrim-tempfile-cleaned` |
| 38 | `variant_kind='foley'` color | Timeline renders clip in orange (from manifest `variantKinds`) | `foley-clip-color-orange` |

---

## Behavior

### Mode resolution
- **Frontend**: `mode = (selectedTransition && selectedCandidateId) ? 'v2fx' : 't2fx'`.
- **Backend**: `_resolve_mode(mode, source_candidate_id)` — explicit mode wins if valid;
  else inferred from `source_candidate_id`.

### Submit flow (happy path, t2fx)
1. User types prompt, picks preset (default Burst/2s) or drags slider.
2. Clicks Generate. Panel POSTs `GenerateFoleyRequest { duration_seconds: N, count: 1 }`.
3. Backend validates and calls `impl.run`.
4. `impl.run` inserts `generate_foley__generations` row `status='pending'`, creates a
   job, starts daemon worker thread, returns `{generation_id, job_id, status:'pending',
   mode:'t2fx'}`.
5. Worker sets `status='running'`, emits `job_progress detail='predicting'`, calls
   `providers.replicate.run_prediction(model='zsxkib/mmaudio', input={...}, source='generate-foley')`.
6. Provider polls Replicate every 5s, writes `spend_ledger` on `status='succeeded'`,
   downloads output.
7. Worker emits `job_progress detail='downloading'`, copies artifact to
   `pool/segments/<uuid>.wav`, inserts `pool_segments` row, stamps
   `variant_kind='foley'`, inserts `__tracks` row, marks generation `completed`,
   emits `job_completed`.
8. Panel `subscribeFoleyJob` callback refreshes the list; completed card shows a
   draggable tile.

### Submit flow (v2fx)
Between steps 3 and 5:
- 4a. Worker resolves `source_candidate_id` → pool file path.
- 4b. Emits `job_progress detail='pretrim'`.
- 4c. `pretrim.trim_to_range` runs stream-copy; on failure, re-encodes.
- 4d. Worker base64-encodes the trimmed MP4 and sets `input['video']` +
  `input['duration'] = out - in`.
- Rest proceeds as t2fx.
- Pool segment additionally gets `derived_from = source_candidate_id` and
  `context_entity_type = 'transition'`, `context_entity_id = transition_id`.

### In/Out UX
- `Set in` reads `useCurrentTime().currentTime` → `t`. If `outSeconds !== null && outSeconds <= t`, clears `outSeconds`. Sets `inSeconds = t`.
- `Set out` reads `t`. If `inSeconds !== null && inSeconds >= t`, clears `inSeconds`. Sets `outSeconds = t`.
- `Clear` sets both to null.
- Selection change (`selectedTransition.id` or `selectedCandidateId` changes) resets both.

### Failure handling
- `ReplicateNotConfigured` / `ReplicatePredictionFailed` / `ReplicateDownloadFailed` /
  `ReplicateError` / `Exception` → generation `status='failed'`, `error` populated,
  `completed_at` set, job marked failed.
- Pretrim temp file always cleaned up via `finally`.

### Disconnect-survival
- Plugin activate runs `resume_in_flight`.
- Rows with `status IN ('pending','running')` scanned; those with `replicate_prediction_id`
  get `attach_polling`; those without are force-failed.
- Provider's `attach_polling` avoids double-spending — spend ledger was written on
  first polling's `status='succeeded'`.

---

## Acceptance Criteria

- [ ] AC1. Backend and frontend `plugin.yaml` declare matching id, providers, variant kind, chat tool.
- [ ] AC2. `activate` on each half performs its documented registrations (R3).
- [ ] AC3. Submitting a t2fx request produces a `pool_segment` with the exact canonical fields in R12 and no `derived_from`.
- [ ] AC4. Submitting a v2fx request pre-trims the source via ffmpeg (stream-copy → re-encode fallback) and produces a `pool_segment` whose `derived_from` matches `source_candidate_id`.
- [ ] AC5. `generate_foley__generations` and `generate_foley__tracks` rows are written per R13/R14 with `id` of form `fgen_<12hex>`.
- [ ] AC6. Status transitions follow `pending→running→completed|failed`; `started_at` set on running; `completed_at` set on terminal.
- [ ] AC7. REST rejects every invalid input class listed in R16 with a user-readable `{error}`.
- [ ] AC8. `POST /generations/:id/retry` requires a terminal state; returns 404 shape for missing rows.
- [ ] AC9. `GET /generations` returns `{generations: [...]}` newest-first, filtered, limit-clamped.
- [ ] AC10. Panel renders mode-conditional form: slider only in t2fx; in/out controls only in v2fx.
- [ ] AC11. Ambiguity banner appears iff transition selected and candidate null.
- [ ] AC12. Most-recent-click-wins rule holds for Set-in/Set-out.
- [ ] AC13. Generate button gating matches R8 exactly, including tooltip text.
- [ ] AC14. Drag payload shape exactly matches R21 + drag payload schema.
- [ ] AC15. Variant kind `foley` renders orange in the timeline.
- [ ] AC16. Server restart reattaches polling for in-flight generations without duplicating spend_ledger rows (R23/R24).
- [ ] AC17. Chat tool `generate_foley` goes through the destructive-tool elicitation gate.
- [ ] AC18. `check_api_key` returns `{passed: true}` iff `REPLICATE_API_TOKEN` is set.
- [ ] AC19. Pretrim temp file is always unlinked in the worker `finally` block.
- [ ] AC20. Duration enforcement: range outside `[1.0, 30.0]` rejected at REST, impl, and pretrim layers.

---

## Tests

### Base Cases

#### Test: `t2fx-generates-to-pool` (covers R4, R11, R12)
**Given**: Valid project, `REPLICATE_API_TOKEN` set, nothing selected in editor, prompt `"door slam"`, duration_seconds=2.
**When**: `POST /run` is called.
**Then**:
- **status-code-200**: response includes `generation_id` of form `fgen_<12hex>`, `status='pending'`, `mode='t2fx'`.
- **gen-row-created**: a row exists in `generate_foley__generations` with `mode='t2fx'`, `status` eventually `'completed'`.
- **pool-segment-created**: exactly one `pool_segments` row is written with `kind='generated'`, `created_by='plugin:generate-foley'`.
- **track-row-created**: one `generate_foley__tracks` row links `generation_id → pool_segment_id` with `variant_index=0`.
- **ws-events-emitted**: `job_started`, `job_progress(predicting)`, `job_progress(downloading)`, `job_completed` are all emitted in order.

#### Test: `pool-segment-variant-kind-foley` (covers R12, R21)
**Given**: Completed t2fx generation.
**When**: Inspecting the resulting pool segment.
**Then**:
- **variant-kind-foley**: `pool_segments.variant_kind == 'foley'`.
- **generation-params**: `generation_params.provider == 'replicate'` AND `generation_params.model == 'zsxkib/mmaudio'`.

#### Test: `no-derived-from-on-t2fx` (covers R12)
**Given**: Completed t2fx generation.
**When**: Inspecting the pool segment.
**Then**:
- **derived-from-null**: `pool_segments.derived_from` is `NULL`.
- **context-entity-null**: both `context_entity_type` and `context_entity_id` are `NULL`.

#### Test: `v2fx-pretrim-and-generate` (covers R4, R9, R10)
**Given**: Transition selected with a candidate, `in=5.0`, `out=12.0`, valid source video.
**When**: `POST /run` is called.
**Then**:
- **pretrim-invoked**: `pretrim.trim_to_range` is called with `in_seconds=5.0, out_seconds=12.0`.
- **video-as-data-uri**: Replicate `input['video']` is a `data:video/mp4;base64,…` URI.
- **duration-matches-range**: `input['duration'] == 7.0`.
- **pool-segment-created**: on success a foley pool segment is written.

#### Test: `derived-from-set-on-v2fx` (covers R12)
**Given**: Completed v2fx generation with `source_candidate_id='ps_abc'`.
**When**: Inspecting the pool segment.
**Then**:
- **derived-from-matches**: `pool_segments.derived_from == 'ps_abc'`.

#### Test: `context-entity-stamped` (covers R12)
**Given**: Completed v2fx generation with `entity_type='transition'`, `entity_id='tr_xyz'`.
**When**: Inspecting the pool segment.
**Then**:
- **context-type**: `context_entity_type == 'transition'`.
- **context-id**: `context_entity_id == 'tr_xyz'`.

#### Test: `ambiguity-banner-shown` (covers R5)
**Given**: Transition selected but its `selected` candidate is null.
**When**: Panel renders.
**Then**:
- **banner-visible**: yellow warning element is present with text matching `/no candidate/i`.
- **mode-is-t2fx**: mode indicator says `Text-only`.

#### Test: `falls-back-to-t2fx` (covers R4, R5)
**Given**: Same as above, user clicks Generate.
**When**: Request is sent.
**Then**:
- **no-candidate-id-in-body**: `source_candidate_id` is absent.
- **no-entity-stamping**: `entity_type`/`entity_id` are absent.

#### Test: `set-in-then-set-out-enables-generate` (covers R6, R8)
**Given**: v2fx mode, `in=null`, `out=null`.
**When**: User positions playhead at t=5, clicks `Set in`, moves to t=12, clicks `Set out`.
**Then**:
- **in-captured**: `inSeconds==5`.
- **out-captured**: `outSeconds==12`.
- **generate-enabled**: Generate button is not disabled.

#### Test: `out-before-in-clears-in` (covers R6)
**Given**: `in=10`, `out=null`.
**When**: Playhead at t=4, user clicks `Set out`.
**Then**:
- **in-cleared**: `inSeconds==null`.
- **out-set**: `outSeconds==4`.

#### Test: `in-after-out-clears-out` (covers R6)
**Given**: `in=null`, `out=5`.
**When**: Playhead at t=9, user clicks `Set in`.
**Then**:
- **out-cleared**: `outSeconds==null`.
- **in-set**: `inSeconds==9`.

#### Test: `selection-change-clears-range` (covers R7)
**Given**: v2fx mode, `in=3`, `out=9`.
**When**: User selects a different transition OR a different candidate.
**Then**:
- **in-reset**: `inSeconds==null`.
- **out-reset**: `outSeconds==null`.

#### Test: `count-gt-1-rejected` (covers R16, R25)
**Given**: Any valid body with `count: 2`.
**When**: `POST /run`.
**Then**:
- **rest-error**: response is `{error: "count must be 1 in MVP; multi-variant coming later"}`.
- **no-gen-row**: no row is added to `generate_foley__generations`.

#### Test: `v2fx-out-le-in-rest-rejects` (covers R16)
**Given**: `source_in_seconds=10, source_out_seconds=10`.
**When**: `POST /run`.
**Then**:
- **error-message**: response `error` contains `"source_out_seconds must be >"`.

#### Test: `range-over-30s-rest-rejects` (covers R16)
**Given**: `source_in_seconds=0, source_out_seconds=31`.
**When**: `POST /run`.
**Then**:
- **error-message**: response `error` contains `"range exceeds 30"` (case-insensitive OK).

#### Test: `range-over-30s-disabled-ui` (covers R8)
**Given**: Panel v2fx, `in=0`, `out=31`.
**When**: Button is inspected.
**Then**:
- **button-disabled**: Generate button `disabled` is true.
- **tooltip-reason**: button `title` contains `"Range exceeds 30s limit"`.

#### Test: `chat-tool-elicitation-gate` (covers R25)
**Given**: Chat tool registry.
**When**: `generate_foley` is invoked.
**Then**:
- **elicitation-required**: the tool name matches `_DESTRUCTIVE_TOOL_PATTERNS`.

#### Test: `list-filters-newest-first` (covers R17)
**Given**: Multiple `generate_foley__generations` rows, two with `entity_id='tr_A'`, one with `tr_B`.
**When**: `GET /generations?entityType=transition&entityId=tr_A`.
**Then**:
- **count**: returned array has 2 entries.
- **order**: entries ordered by `created_at` descending.

#### Test: `retry-not-found-404` (covers R18)
**Given**: `id='fgen_missing'`.
**When**: `POST /generations/fgen_missing/retry`.
**Then**:
- **status-shape**: response is `{error: "generation fgen_missing not found", _status: 404}`.

#### Test: `retry-still-running-rejected` (covers R18)
**Given**: Existing row with `status='running'`.
**When**: Retry is called.
**Then**:
- **error-message**: response `error` contains `"still running"` (or `"still pending"`).
- **no-new-job**: no new `generate_foley__generations` row is created.

#### Test: `frontend-activate-registers-panel` (covers R3)
**Given**: Plugin module loaded.
**When**: `activate(host, context)` is called.
**Then**:
- **panel-registered**: `host.registerPanel` called with `{id:'foley_generations', title:'Foley', Component: FoleyGenerationsPanel}`.

#### Test: `backend-activate-registers-routes` (covers R3)
**Given**: Backend plugin module.
**When**: `activate(plugin_api, context)` is called.
**Then**:
- **three-routes**: `plugin_api.register_rest_endpoint` is called 3 times.
- **resume-invoked**: `resume_in_flight` is called exactly once.

#### Test: `drag-payload-shape` (covers R21)
**Given**: A completed generation card rendered.
**When**: User starts dragging the foley tile.
**Then**:
- **mime-type**: `dataTransfer.getData('application/x-scenecraft-stem')` yields JSON.
- **payload-fields**: JSON contains `pool_segment_id`, `pool_path`, `stem_type==='foley'`, `variant_kind==='foley'`, numeric `duration_seconds`.
- **effect-allowed**: `effectAllowed === 'copy'`.

#### Test: `foley-clip-color-orange` (covers R1, R2, R38)
**Given**: A timeline rendering an audio_clip whose `selected` points at a `variant_kind='foley'` pool segment.
**When**: The clip is painted.
**Then**:
- **color-class**: the rendered element's color class corresponds to "orange" per the manifest `variantKinds` mapping.

#### Test: `pool-segment-canonical-fields` (covers R12)
**Given**: Completed generation.
**When**: Pool segment row is read.
**Then**:
- **kind-generated**: `kind == 'generated'`.
- **created-by**: `created_by == 'plugin:generate-foley'`.
- **gen-params-provider**: `generation_params.provider == 'replicate'`.
- **gen-params-model**: `generation_params.model == 'zsxkib/mmaudio'`.
- **gen-params-mode**: `generation_params.mode` is `'t2fx'` or `'v2fx'`.

#### Test: `check-api-key-missing` (covers R26)
**Given**: `REPLICATE_API_TOKEN` unset.
**When**: `check_api_key()` is called.
**Then**:
- **passed-false**: `{passed: false}`.
- **message-has-url**: `message` contains `"replicate.com/account/api-tokens"`.

---

### Edge Cases

#### Test: `t2fx-with-candidate-id-rejected` (covers R28)
**Given**: `impl.run(mode='t2fx', source_candidate_id='ps_1')`.
**When**: Called.
**Then**:
- **value-error**: raises `ValueError` whose message contains `"t2fx mode must not include source_candidate_id"`.

#### Test: `entity-type-non-transition-rejected` (covers R16)
**Given**: Body with `entity_type='keyframe'`.
**When**: `POST /run`.
**Then**:
- **rest-error**: response `error` contains `"entity_type must be 'transition'"`.

#### Test: `pretrim-reencode-fallback` (covers R10)
**Given**: A source video where stream-copy fails (non-keyframe-aligned range).
**When**: `trim_to_range` runs.
**Then**:
- **stream-copy-attempted**: first ffmpeg subprocess call uses `-c copy`.
- **reencode-attempted**: after failure, second call uses `libx264 -preset ultrafast`.
- **output-exists**: returned path exists and is non-empty.

#### Test: `pretrim-both-fail` (covers R10, R11)
**Given**: Source path points to a corrupt file.
**When**: `trim_to_range` runs.
**Then**:
- **raises-pretrim-error**: raises `PretrimError`.
- **gen-status-failed**: owning generation ends up `status='failed'` with error reflecting ffmpeg.

#### Test: `replicate-prediction-failed` (covers R11, R15)
**Given**: Replicate returns `status='failed'`.
**When**: Worker receives the result.
**Then**:
- **gen-status-failed**: `generate_foley__generations.status == 'failed'`.
- **error-message**: `error` contains `"MMAudio prediction failed"`.
- **job-failed**: `job_failed` WS event is emitted.

#### Test: `no-spend-on-prediction-failure` (covers R11)
**Given**: Same as above.
**When**: Spend ledger is queried.
**Then**:
- **no-ledger-row**: no `spend_ledger` row exists for this generation.

#### Test: `replicate-download-failed-3x` (covers R11, R15, R27)
**Given**: Replicate returns `succeeded`; all 3 download attempts fail.
**When**: Worker handles the result.
**Then**:
- **gen-status-failed**: status `failed`.
- **error-message**: contains `"prediction charged"` AND `"download failed"` AND `"Retry will re-charge"`.
- **spend-recorded**: a `spend_ledger` row exists (Replicate billing event fired).

#### Test: `no-token-fails-run` (covers R26)
**Given**: `REPLICATE_API_TOKEN` unset, valid request submitted.
**When**: Worker runs.
**Then**:
- **gen-status-failed**: status `failed`.
- **error-message**: contains `"ReplicateNotConfigured"` or the provider's message.

#### Test: `resume-in-flight-reattaches` (covers R23)
**Given**: On server start, one row has `status='running'` and a `__tracks.replicate_prediction_id='pr_1'`.
**When**: `resume_in_flight(project_dir)` runs.
**Then**:
- **returns-id**: returns list containing that row's generation_id.
- **attach-polling-called**: `plugin_api.providers.replicate.attach_polling(prediction_id='pr_1', source='generate-foley', on_complete=...)` is invoked.

#### Test: `reattach-no-double-spend` (covers R24)
**Given**: Reattached prediction completes successfully; spend ledger already has a row.
**When**: Reattach `on_complete` runs.
**Then**:
- **single-ledger-row**: exactly one `spend_ledger` row exists for this prediction.
- **gen-status-completed**: `generate_foley__generations.status == 'completed'`.

#### Test: `resume-in-flight-no-prediction` (covers R23)
**Given**: Row `status='running'` with no `__tracks` row.
**When**: `resume_in_flight` runs.
**Then**:
- **gen-status-failed**: row marked `failed`.
- **error-message**: `"server restart before prediction was created"`.

#### Test: `preset-sets-slider` (covers R22)
**Given**: Panel in t2fx.
**When**: User clicks `Sequence`.
**Then**:
- **slider-value**: slider value equals `8`.

#### Test: `slider-flips-to-custom` (covers R22)
**Given**: Panel in t2fx with preset `Burst`.
**When**: User drags slider to `5`.
**Then**:
- **preset-custom**: `durationPreset === 'Custom'`.

#### Test: `list-limit-clamped` (covers R17)
**Given**: `GET /generations?limit=9999`.
**When**: Request handled.
**Then**:
- **limit-clamped**: underlying DB query uses `limit=500`.

#### Test: `pretrim-tempfile-cleaned` (covers R27)
**Given**: v2fx job fails post-pretrim (e.g., Replicate timeout).
**When**: Worker completes its `finally`.
**Then**:
- **temp-file-missing**: the pretrim temp file no longer exists on disk.

#### Test: `single-daemon-thread-per-run` (covers R15 negative)
**Given**: A single `impl.run` call.
**When**: Inspecting thread state.
**Then**:
- **one-worker-thread**: exactly one worker thread with name `foley-worker-<generation_id>` exists.
- **daemon-true**: thread is a daemon.

**Note on concurrency coverage**: The plugin is not known to coordinate concurrent same-entity generations; see [OQ-5](#open-questions). This test asserts the single-run invariant explicitly so any future concurrency change must update the spec.

---

## Non-Goals (Explicit)

- Concurrency coordination for same-entity generations (see OQ-5).
- Cost estimation before submit (see OQ-7).
- Drop-rules enforcement for foley tiles across track types (see OQ-6).
- Duration quality gating by content type (see OQ-4).
- In-only or out-only submission paths (see OQ-2).
- Frame-accurate clip-boundary behavior of Set-in/Set-out (see OQ-1).
- Recovery if the source candidate is deleted mid-job (see OQ-3).
- Multi-variant generation, hit-marker composition, auto-track creation, license
  disclosure banner, migration of `generate-music` to typed provider.

---

## Open Questions

**OQ-1. Playhead at exactly the clip boundary when `Set in`/`Set out`.**
What is the captured value when `currentTime` equals the clip's in-boundary or
out-boundary exactly? The code path has no boundary clamp; the captured value is
the raw `currentTime`. Unclear whether zero-duration or exact-boundary ranges
should be rejected earlier. Behavior marked `undefined`.

**OQ-2. In-point set, out-point null, submit attempted.**
The UI gate blocks submit; but REST-side behavior when a caller sends
`source_in_seconds` without `source_out_seconds` is "v2fx mode requires both" only if
a `source_candidate_id` is also passed. If the client bypasses the UI and sends
partial ranges without `source_candidate_id`, the request routes into t2fx and the
in-seconds value is silently ignored. Is that desired? Behavior marked `undefined`.

**OQ-3. v2fx with source candidate deleted mid-job.**
If `source_candidate_id` is deleted from the pool between `Generate` click and
pretrim resolution, `_resolve_candidate_source_path` raises `ValueError("candidate
… not found in pool")`. Whether the generation should then be `failed` with that
error string, or refunded, or retried is not codified. Behavior marked `undefined`.

**OQ-4. Foley duration beyond MMAudio's sweet spot.**
The product ceiling is 30s but MMAudio quality degrades past ~10–12s. Is there
an expected UI affordance or warning beyond 12s? Today there is none. Behavior
marked `undefined`.

**OQ-5. Concurrent generations for the same entity.**
Nothing prevents multiple simultaneous `generate_foley` calls for the same
transition + candidate pair. Each spawns its own daemon thread; outputs land as
separate pool segments. Whether this should serialize, dedupe, or cancel-newer
is unspecified. Behavior marked `undefined`.

**OQ-6. Foley drag-tile dropped onto a video track.**
Drop rules are owned by the core timeline, not the plugin. The drag payload has
`stem_type='foley'` and `variant_kind='foley'`; core decides whether a video track
rejects the drop or snaps it to the nearest audio track. Behavior marked `undefined`.

**OQ-7. Pre-submit cost estimate.**
No cost preview is surfaced before clicking Generate. `get_balance()` is a
provider-level concern and not wired to the panel. Whether a per-job estimate
(in USD or Replicate units) should render before submit is undecided. Behavior
marked `undefined`.

---

## Related Artifacts

- **Design**: `agent/design/local.foley-generation-plugin.md`
- **Clarification**: `agent/clarifications/clarification-12-foley-generation-plugin.md`
- **Precedent specs**:
  - `agent/specs/local.music-generation-plugin.md` (M16, text-only paid-API predecessor)
- **Related clarifications**:
  - `agent/clarifications/clarification-10-musicful-music-generation-plugin.md`
  - `agent/clarifications/clarification-8-audio-isolation-plugin.md`
- **Related designs**:
  - `agent/design/local.audio-isolation-plugin.md`
  - `agent/design/local.scenecraft-online-platform.md`
- **Future milestones**:
  - Migrate `generate-music` to `plugin_api.providers.musicful.*`
  - `stem_splitter` plugin unifying `isolate_vocals` with GPU 11-stem path

---

**Namespace**: local
**Spec**: generate-foley-plugin
**Version**: 1.0.0
**Status**: Active (retroactive)
