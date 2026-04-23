# Spec: Music Generation Plugin

> **🤖 Agent Directive**: This is an implementation-ready specification. The Tests section is the executable contract — implementations translate each `#### Test:` into a test function in the target framework (pytest for backend, vitest for frontend). Every assertion is observable and language-agnostic.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-23
**Last Updated**: 2026-04-23
**Status**: Ready for Implementation

---

## Purpose

Specify the exact observable behavior of scenecraft's first paid generation plugin — `generate-music` — backed by the Musicful API (`https://api.musicful.ai`). The plugin produces AI-composed audio as pool_segments, exposes a panel for run history + kickoff, supports drag-to-timeline with purple styling, and wires a chat tool with elicitation. Ships as M16.

---

## Source

`--from-clarification agent/clarifications/clarification-10-musicful-music-generation-plugin.md` (Status: substantively complete; pending-decisions section resolved in chat rounds 1-5).

Forward-looking references:
- `agent/tasks/unassigned/task-spike-plugin-schemas-and-unified-jobs.md` (M17 follow-on)
- `agent/tasks/unassigned/task-dockview-dead-code-removal.md` (independent cleanup)
- `agent/tasks/unassigned/task-spike-auto-duck-plugin.md` (future plugin)

---

## Scope

### In Scope

- Backend plugin at `scenecraft-engine/src/scenecraft/plugins/generate_music/` with `plugin.yaml`, `__init__.py`, Musicful REST client, `generate_music.run` handler, polling worker.
- Frontend plugin at `scenecraft/src/plugins/generate-music/` with `plugin.yaml` mirror, panel + run form, WS client, drag-payload helper.
- Schema: new plugin-owned tables `generate_music__generations` + `generate_music__tracks`; new core-owned table `credit_ledger`; new core columns `pool_segments.context_entity_type` + `context_entity_id`.
- Actions: `auto` + `custom` only; other Musicful actions gated at dispatch.
- Output: MP3 only; written to `pool/segments/<uuid>.mp3`; registered as a `pool_segment` with `variant_kind='music'`, `created_by='plugin:generate-music'`.
- Context-aware candidate routing: generation binds to selected `audio_clip` or `transition` and writes the appropriate junction (`audio_candidates` or `tr_candidates`); no selection → free-floating in panel.
- Panel in `EditorPanelLayout`'s `PanelRegistry` with context-sensitive filtering, run cards, Reuse button, permanent credits counter.
- Chat tools: `generate_music` (write, elicitation-gated) + `get_music_credits` (read, free).
- Drag to timeline via existing `application/x-scenecraft-stem` payload; purple clip color via `variant_kind` lookup.
- Credit tracking via core `credit_ledger` table; `plugin_api.record_credit_spend()` helper.
- Failure handling: persistent failed-run card, Retry button, 429 exponential backoff.
- Missing API key → admin-oriented config-missing state; plugin still registers.
- Testing: mocked Musicful integration tests + one real-API smoke test gated on `MUSICFUL_API_KEY`.

### Out of Scope (Non-Goals)

See [Non-Goals](#non-goals).

---

## Requirements

Requirements are numbered and individually testable. Each test in the Tests section traces back to one or more requirement ids via `(covers Rn)`.

### Plugin identity & registration

- **R1**: Plugin id is `generate-music` (kebab-case). Backend package is `scenecraft-engine/src/scenecraft/plugins/generate_music/`. Frontend module is `scenecraft/src/plugins/generate-music/`.
- **R2**: Operation id is `generate-music.run`. Registered in both backend and frontend `PluginHost` static registries at server startup / editor entry.
- **R3**: The plugin's `plugin.yaml` (both frontend and backend mirrors) declares the operation, panel contribution, context-menu entries (none in MVP), `schema_version: 1`, and a forward-compat `contributes.invariants` block declaring the `MUSICFUL_API_KEY` requirement (the invariant harness doesn't exist in M16, but the manifest is declared so the harness picks it up once M17 lands).
- **R4**: If `MUSICFUL_API_KEY` env var is missing at activation, the plugin STILL registers; the panel shows a config-missing state and the chat tool returns an admin-oriented error message.

### Musicful action coverage

- **R5**: MVP exposes only `action='auto'` and `action='custom'` at the backend dispatch layer. Requests for `extend`, `concat`, `upload`, `upload_extend`, `artist_consistency` are rejected with an explicit "not supported in MVP" error.
- **R6**: `/v1/music/generate-lyrics`, `/v1/music/generate-vibe`, and `/v1/music/generate-mp4` are NOT called by the plugin. The plugin never produces lyric-video mp4s.

### Schema

- **R7**: A new plugin-owned table `generate_music__generations` is created at schema init with the columns listed in [Interfaces / Data Shapes § `generate_music__generations`](#generate_music__generations).
- **R8**: A new plugin-owned table `generate_music__tracks` is created with the columns listed in [Interfaces § `generate_music__tracks`](#generate_music__tracks).
- **R9**: A new core-owned table `credit_ledger` is created with the columns listed in [Interfaces § `credit_ledger`](#credit_ledger). Plugins NEVER `INSERT INTO credit_ledger` directly; they use the `plugin_api.record_credit_spend()` helper only.
- **R10**: Two new columns are added to `pool_segments` via core migration: `context_entity_type TEXT NULL` and `context_entity_id TEXT NULL`. M13's existing `derived_from` column is UNTOUCHED (used only by lipsync variants per M13 design). The plugin writes `variant_kind='music'` (new enum value in a column M13 already added).
- **R11**: All plugin-owned table names MUST use the `<plugin_id_snake>__<name>` prefix convention (double underscore delimiter). Plugin id in `plugin.yaml` MUST match the regex `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` (no consecutive hyphens, no numeric-only starts).

### Generation flow — request & dispatch

- **R12**: Panel "Generate" button reads the current editor selection at click-time from `EditorStateContext` (`selectedAudioClipId` / `selectedTransitionId`). It passes `entity_type` + `entity_id` to the backend run endpoint; NULL if no selection.
- **R13**: Payload sent to Musicful is filtered by `action`:
  - `action='auto'` sends only: `style`, `instrumental`, `gender`, `model`, `action`.
  - `action='custom'` sends: `style`, `lyrics`, `title`, `instrumental`, `gender`, `model`, `action`.
  - When `instrumental=1`, `lyrics` is NOT sent regardless of whether the form field has a value.
  - Fields present in the form but not relevant to the action are NEVER sent (no silent server-side discard surprises).
- **R14**: A request to the backend run endpoint creates a `generate_music__generations` row with `status='pending'` BEFORE calling Musicful; updates to `status='running'` after the Musicful HTTP 200.
- **R15**: Each Musicful task id returned by `POST /v1/music/generate` is stored in `generate_music__generations.task_ids_json` (a JSON array).

### Polling & completion

- **R16**: A background worker polls `GET /v1/music/tasks?ids=<comma-joined task ids>` every 5 seconds until all tasks reach a terminal state (`status=completed` or `status=failed` per Musicful's response).
- **R17**: On Musicful rate-limit (HTTP 429), the worker retries with exponential backoff: 1s, 2s, 4s; if all three retries return 429, surface `status='failed'` with `error='rate_limit_exceeded'`. Every other HTTP error surfaces immediately (no retry) as `status='failed'`.
- **R18**: For every Musicful task that reaches `completed` status, the worker:
  - Downloads the `audio_url` to `pool/segments/<uuid>.mp3`.
  - Inserts a `pool_segments` row with `kind='generated'`, `created_by='plugin:generate-music'`, `variant_kind='music'`, `context_entity_type`/`context_entity_id` copied from the parent generation row, and `generation_params` JSON containing `{provider, model, action, style, lyrics, task_id, cover_url}`.
  - Inserts a `generate_music__tracks` row linking the generation to the new pool_segment.
- **R19**: After a successful generation (all tasks completed), the worker calls `plugin_api.record_credit_spend(plugin_id='generate-music', user_id=<triggering user>, credits=<N>, operation='generate-music.run', job_ref=<generation_id>)` and the `generate_music__generations` row transitions to `status='completed'`.
- **R20**: If at least one task fails and at least one succeeds (partial success), the generation row transitions to `status='completed'` with non-empty `error` describing the partial failure. Successful stems are still inserted and linked; failed stems are NOT inserted.
- **R21**: If ALL tasks fail, `status='failed'` with `error=<concatenated Musicful fail_reasons>`. NO pool_segments or `generate_music__tracks` rows are inserted. NO credit spend is recorded.

### Context-aware candidate routing

- **R22**: If the generation had `entity_type='audio_clip'`, for each successful pool_segment the worker additionally inserts `audio_candidates(audio_clip_id=<entity_id>, pool_segment_id=<new>)`.
- **R23**: If the generation had `entity_type='transition'`, for each successful pool_segment the worker additionally inserts `tr_candidates(tr_id=<entity_id>, pool_segment_id=<new>, source='generated')`.
- **R24**: If `entity_type` is NULL, NO candidate junction rows are written.
- **R25**: The audio_clip-linked-to-transition case writes ONLY `audio_candidates` (not `tr_candidates`); the explicit selection intent is "this clip," not "the transition behind this clip."

### Panel UX

- **R26**: `MusicGenerationsPanel` registers in `EditorPanelLayout`'s `PanelRegistry` with id `music-generations`, title `"Music Generations"`, and a React component. The panel is included in the default layout in the right-sidebar group.
- **R27**: Panel filter modes:
  - Selection is `audio_clip` → lists `generate_music__generations` rows where `entity_type='audio_clip' AND entity_id=<selected>`; header "Music for <clip name>".
  - Selection is `transition` → lists where `entity_type='transition' AND entity_id=<selected>`; header "Music for <transition label>".
  - No selection → lists ALL rows project-wide; header "Music Generations (all)".
  - A "Show all" toggle is always visible and overrides the filter.
- **R28**: Run cards display: timestamp, action, model, status badge (✓ completed / ⏳ running / ✗ failed), and — when `entity_type` is set — a context badge like `◉ clip: <name>` or `◉ tr: <label>`.
- **R29**: Each run card has a `⟳ Reuse` button. Clicking Reuse pre-fills the run form with the row's params (action, style, lyrics, title, instrumental, gender, model, entity_type, entity_id). Reuse does NOT auto-submit; the user clicks Generate.
- **R30**: When the user clicks Generate on a Reuse-prefilled form, a NEW `generate_music__generations` row is created with `reused_from=<original_id>`. The original row is not mutated.
- **R31**: Run form fields are ALL rendered from the start (Action radio, Style textarea, Lyrics textarea, Instrumental checkbox, Gender radio, Model select, Title input). No hide/grey based on state. Filtering happens at send time per R13.
- **R32**: Form defaults: Action=Auto, Instrumental=checked, all other fields empty/default.
- **R33**: When selection context exists, the form header reads `"Generating for <selected entity>"` and the Generate button binds to the current selection. A `Clear context` button switches to the no-context mode even when something is selected.
- **R34**: The panel header shows a permanent credits counter: `"N credits available"`, where N is the cached `key_music_counts` from Musicful. No toast-style low-credit warnings.
- **R35**: Credits are fetched:
  - Once per session on first panel open (from `GET /v1/get_api_key_info`).
  - Refreshed after each generation that reaches `status='completed'` or `status='failed'`.
  - Cache is in-memory only; refreshing the browser resets to "once per session" on next panel open.
- **R36**: When `key_music_counts <= 0`, the Generate button is disabled with the message `"Out of credits. Please contact your administrator"`. The panel + form still render normally otherwise.

### Drag to timeline

- **R37**: Each successfully generated track row in a run card has a drag handle. Starting a drag sets the HTML5 `dataTransfer` payload `application/x-scenecraft-stem` to a JSON string containing `{ pool_segment_id, stem_type: 'music', duration_seconds, pool_path, source_label }`.
- **R38**: `AudioLane.tsx`'s drop handler (existing, from task-104b) accepts the payload and creates an `audio_clip` on the target lane at cursor X. No auto-creation of a "Music" track; the user drops wherever.
- **R39**: The new `audio_clip`'s `name` is the Musicful `song_title` (user-editable via existing rename affordance).
- **R40**: Timeline renderer reads `pool_segment.variant_kind` for the audio clip's source segment. Clips with `variant_kind='music'` render with a purple color class; clips with `variant_kind='lipsync'` render with a teal color class; NULL renders with the default blue. The color map lives in `scenecraft/src/lib/audio-clip-styling.ts`.

### Chat tools

- **R41**: Tool `generate_music` is exposed with input schema `{action: enum<'auto'|'custom'>, style: string, lyrics?: string, instrumental?: 0|1, title?: string, gender?: 'male'|'female'|'', model?: string}`. Output: `{generation_id: string, task_ids: string[], status: 'running'}` synchronously on success.
- **R42**: Tool `generate_music` is added to `_DESTRUCTIVE_TOOL_PATTERNS` (via the `"generate_music"` prefix). Invocation fires the existing elicitation flow with summary: action, style, lyrics (truncated to ~100 chars), model, estimated cost (credits), remaining balance.
- **R43**: On elicitation decline, the tool returns a `"cancelled by user"` error and NO backend request is made.
- **R44**: Tool `get_music_credits` is exposed with empty input schema. Output: `{credits: number, last_checked_at: string}`. No elicitation.
- **R45**: Tool `generate_lyrics` is NOT exposed (users draft lyrics inline in chat).
- **R46**: The panel Run button does NOT fire chat-tool elicitation (inline form IS the confirmation). Chat-tool invocation path and panel-Run path share the same backend run endpoint but the elicitation gate only wraps chat.

### WebSocket events

- **R47**: Backend emits standard JobManager WS events on `/ws/jobs`:
  - `job_started` — `{jobId, jobType: 'generate_music', total, meta: {generationId, entityType, entityId}}`
  - `job_progress` — `{jobId, completed, total, detail}` emitted on each poll cycle (e.g. `detail='polling (2/3 tasks completed)'`).
  - `job_completed` — `{jobId, result: {generation_id, pool_segment_ids: string[]}}` when all tasks terminal.
  - `job_failed` — `{jobId, error: string}` when generation_row transitions to `status='failed'`.
- **R48**: Frontend panel subscribes to `/ws/jobs`. On `job_completed` or `job_failed` events matching `jobType='generate_music'`, the panel refetches its run list and refreshes the credits counter. No other frontend state mutation is driven by WS events (fire-and-forget).
- **R49**: If the WS connection drops mid-generation, the backend polling worker continues and the DB row reaches terminal state regardless. When the WS reconnects, the next panel refetch picks up the terminal row.

### Failure surfacing

- **R50**: Failed `generate_music__generations` rows appear in the panel as persistent `✗ failed` cards with the `error` string displayed and a `Retry` button.
- **R51**: The Retry button kicks off a new generation with the same params as the failed row (analog of Reuse for failures). New row has `reused_from=<failed_row.id>`. Failed row is NOT mutated.

### Secrets & admin

- **R52**: Backend reads `MUSICFUL_API_KEY` from `os.environ` exactly once at plugin activation. The value is held in the plugin module's scope; never logged, never returned in API responses, never included in any error message.
- **R53**: If `MUSICFUL_API_KEY` is missing at activation, the plugin still registers (panel + tool are visible) but the run endpoint + chat tool return the error string `"This plugin requires a Musicful API key. Please contact your administrator."` verbatim.
- **R54**: Credit ledger writes capture `user_id` from the current request's authenticated user; if there is no authenticated user, `user_id=''` (empty string).

### Testing

- **R55**: Integration tests run against a mock Musicful server that responds to `POST /v1/music/generate`, `GET /v1/music/tasks?ids=...`, `GET /v1/get_api_key_info`. The mock generates a deterministic ~2s fixture mp3 and deterministic task ids.
- **R56**: A single real-API smoke test is included, gated on `MUSICFUL_API_KEY` being set. When the env var is absent, the test is skipped (not failed). When present, the test generates the cheapest possible instrumental song and asserts the generation reaches `status='completed'`.

---

## Interfaces / Data Shapes

### `generate_music__generations`

```sql
CREATE TABLE generate_music__generations (
    id              TEXT PRIMARY KEY,                          -- UUID
    action          TEXT NOT NULL CHECK (action IN ('auto', 'custom')),
    model           TEXT NOT NULL,                              -- e.g. 'MFV2.0'
    style           TEXT,
    lyrics          TEXT,
    title           TEXT,
    instrumental    INTEGER NOT NULL CHECK (instrumental IN (0, 1)),
    gender          TEXT CHECK (gender IN ('male', 'female', '') OR gender IS NULL),
    singer_id       TEXT,                                       -- NULL in M16 (artist_consistency deferred)
    task_ids_json   TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    error           TEXT,
    entity_type     TEXT CHECK (entity_type IN ('audio_clip', 'transition') OR entity_type IS NULL),
    entity_id       TEXT,
    reused_from     TEXT REFERENCES generate_music__generations(id),
    created_by      TEXT NOT NULL DEFAULT '',                   -- 'plugin:generate-music'
    created_at      TEXT NOT NULL
);
CREATE INDEX idx_gm_gen_entity ON generate_music__generations(entity_type, entity_id);
CREATE INDEX idx_gm_gen_status ON generate_music__generations(status);
CREATE INDEX idx_gm_gen_created ON generate_music__generations(created_at);
```

### `generate_music__tracks`

```sql
CREATE TABLE generate_music__tracks (
    generation_id    TEXT NOT NULL REFERENCES generate_music__generations(id),
    pool_segment_id  TEXT NOT NULL REFERENCES pool_segments(id),
    musicful_task_id TEXT NOT NULL,
    song_title       TEXT,
    duration_seconds REAL,
    cover_url        TEXT,
    created_by       TEXT NOT NULL DEFAULT '',                  -- 'plugin:generate-music'
    PRIMARY KEY (generation_id, pool_segment_id)
);
CREATE INDEX idx_gm_tracks_pool ON generate_music__tracks(pool_segment_id);
```

### `credit_ledger` (core-owned)

```sql
CREATE TABLE credit_ledger (
    id         TEXT PRIMARY KEY,                                -- UUID
    plugin_id  TEXT NOT NULL,                                   -- 'generate-music' | ...
    user_id    TEXT NOT NULL,                                   -- bare id; '' if no auth context
    credits    INTEGER NOT NULL,                                -- negative on refund
    operation  TEXT NOT NULL,                                   -- 'generate-music.run'
    job_ref    TEXT,                                            -- optional back-ref to plugin run
    created_at TEXT NOT NULL
);
CREATE INDEX idx_ledger_user    ON credit_ledger(user_id, created_at);
CREATE INDEX idx_ledger_plugin  ON credit_ledger(plugin_id, created_at);
```

### `pool_segments` column additions (core)

```sql
ALTER TABLE pool_segments ADD COLUMN context_entity_type TEXT;
ALTER TABLE pool_segments ADD COLUMN context_entity_id   TEXT;
-- `variant_kind` and `derived_from` added by M13 audio-sync; NOT re-added here.
```

### `plugin.yaml` manifest shape (both repos)

```yaml
name: generate-music
version: 1.0.0
displayName: "Music Generation"
description: "AI-composed music and scores via Musicful."
publisher: scenecraft
license: MIT
schema_version: 1

activationEvents:
  - onCommand:generate-music.run

contributes:
  operations:
    - id: generate-music.run
      label: "Generate music"
      entityTypes: [audio_clip, transition, null]
      handler: "backend:generate_music.run"
      panel: "frontend:generate_music.MusicGenerationsPanel"

  # M16 declares this for forward-compat; harness lands in M17.
  invariants:
    - id: "musicful-api-key-present"
      description: "MUSICFUL_API_KEY environment variable must be set."
      check: "backend:generate_music.check_api_key"
      severity: blocking
      user_message: "This plugin requires a Musicful API key. Please contact your administrator."
```

### REST endpoints (backend, registered via `plugin_api.register_rest_endpoint`)

- `POST /api/projects/:project/plugins/generate-music/run` — body `{action, style?, lyrics?, title?, instrumental?, gender?, model?, entity_type?, entity_id?}`. Returns `{generation_id, task_ids, job_id}` or `{error}`.
- `GET /api/projects/:project/plugins/generate-music/generations?entityType=&entityId=` — list filtered by optional entity params. Returns `{generations: [...]}`.
- `POST /api/projects/:project/plugins/generate-music/generations/:id/retry` — create a new generation with the same params as `:id` and `reused_from=:id`. Returns `{generation_id, task_ids, job_id}`.
- `GET /api/projects/:project/plugins/generate-music/credits` — returns `{credits: number, last_checked_at: string}` from cached key-info response.

### Chat tool surface (backend `chat.py`)

```python
GENERATE_MUSIC_TOOL = {
    "name": "generate_music",
    "description": "Generate AI-composed music via Musicful. Costs credits. Requires user confirmation.",
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
    "description": "Check remaining Musicful credits without consuming any.",
    "input_schema": {"type": "object", "properties": {}, "required": []},
}
```

### Drag payload

```typescript
// application/x-scenecraft-stem
{
  pool_segment_id: string,
  stem_type: 'music',
  duration_seconds: number,
  pool_path: string,      // relative path under pool/segments/
  source_label: string    // song_title from Musicful
}
```

### WS event schema (unchanged; uses existing JobManager shape)

See R47 for the four event types and their payloads.

---

## Behavior

### Flow A — Generate from panel, no context

1. User opens panel. Panel calls `GET /credits`; shows "N credits available".
2. User fills Style, leaves other fields at defaults (Action=Auto, Instrumental=on).
3. User clicks Generate. Frontend POSTs to run endpoint with `{action: 'auto', style, instrumental: 1, model: 'MFV2.0', entity_type: null, entity_id: null}`.
4. Backend inserts `generate_music__generations` row with `status='pending'`.
5. Backend POSTs to Musicful `/v1/music/generate` with `{action: 'auto', style, instrumental: 1, model: 'MFV2.0', mv: 'MFV2.0'}` (NOT lyrics, title, gender — per R13).
6. Musicful returns `task_ids`. Backend updates row: `task_ids_json`, `status='running'`. Creates JobManager job; emits `job_started` WS event.
7. Worker polls `/v1/music/tasks?ids=...` every 5s.
8. Each poll that returns newly-completed tasks: worker downloads each mp3 to `pool/segments/<uuid>.mp3`, inserts `pool_segments` + `generate_music__tracks` rows, emits `job_progress`.
9. When all tasks terminal: worker calls `record_credit_spend`, updates generation row to `status='completed'`, emits `job_completed`.
10. Panel receives WS event; refetches run list; refetches credits; shows new run card with downloadable tracks.
11. User drags a track onto any audio lane; `AudioLane.tsx` drop handler creates `audio_clip`; clip renders purple.

### Flow B — Generate from panel, with audio_clip selected

Same as Flow A except:
- Step 3 payload includes `entity_type: 'audio_clip', entity_id: <selected id>`.
- Step 4 row has matching context columns.
- Step 8 pool_segments rows also get `context_entity_type='audio_clip', context_entity_id=<id>`; worker additionally inserts `audio_candidates(audio_clip_id, pool_segment_id)` for each.
- Panel (in context-filtered mode) shows ONLY this entity's generations.

### Flow C — Generate from chat tool

1. Claude calls `generate_music(...)`. Elicitation fires showing summary + cost + balance.
2. User clicks Accept. Same as Flow A steps 3+ from the backend's perspective; the tool returns `{generation_id, task_ids, status: 'running'}` immediately.
3. Chat is non-blocking: the assistant continues. The panel fills in as WS events arrive.
4. User clicks Decline. Tool returns `"cancelled by user"` error. No backend call made.

### Flow D — Retry a failed generation

1. User clicks `Retry` on a failed run card.
2. Frontend POSTs to `/generations/:id/retry`.
3. Backend reads the failed row's params, creates a new generation row with `reused_from=<failed_id>`, proceeds as Flow A from step 4.
4. Failed row is untouched.

### Flow E — Reuse a completed generation

1. User clicks `⟳ Reuse` on a completed run card.
2. Form is prefilled with row params. User optionally edits.
3. User clicks Generate. Backend creates a new row with `reused_from=<original_id>`; proceeds as Flow A.

### Flow F — Missing API key

1. Plugin activates. Env var absent. Activation completes; plugin is registered.
2. User opens panel. Panel shows "Generate" button disabled with caption `"This plugin requires a Musicful API key. Please contact your administrator."` in place of the form.
3. Credits counter shows `"—"` (no call made).
4. Chat tool invocation returns the same error string.

---

## Acceptance Criteria

- [ ] Every requirement R1-R56 has at least one test covering it.
- [ ] DB schema changes apply via `_ensure_schema` without errors on a fresh project AND on a project with pre-existing M11/M13 schema state.
- [ ] Running `POST /plugins/generate-music/run` with a valid payload and mocked Musicful returns a `generation_id` and leaves a terminal `generate_music__generations` row within the test's timeout.
- [ ] Panel UI: opening with no selection shows project-wide runs; selecting a transition filters to that transition's runs; "Show all" toggle overrides.
- [ ] Reuse and Retry buttons both create a new generation row with `reused_from` set; original rows are never mutated.
- [ ] Drag from panel onto an audio lane creates an `audio_clip` with the source pool_segment; the clip renders purple.
- [ ] Missing API key: plugin activates; panel shows admin-oriented error; no crash; chat tool returns the error string verbatim.
- [ ] Elicitation gate: Decline on `generate_music` does NOT make an HTTP call to Musicful.
- [ ] Real-API smoke (skipped without env var): produces a completed generation when `MUSICFUL_API_KEY` is set.
- [ ] Credit ledger row is written exactly once per successful generation; never on failed or partial-failure generations.
- [ ] `plugin_id`, `user_id`, `operation` are recorded in every ledger row.

---

## Tests

### Base Cases

The core behavior contract: happy path + primary bad paths + primary positive/negative assertions. A reader should understand normal operation from this subsection alone.

#### Test: generates-music-auto-no-context (covers R5, R12, R13, R14, R15, R16, R18, R19, R26, R35, R47)

**Given**:
- Mock Musicful returns task ids `['t1', 't2']` from `POST /v1/music/generate`; both reach `completed` with `audio_url` pointing to a fixture mp3 after one poll cycle.
- Project DB is fresh.
- Panel is open, no selection.
- Credits cached at 200.

**When**: User submits the form with `action='auto', style='dark cinematic synth', instrumental=1, model='MFV2.0'`.

**Then** (assertions):
- **status-pending-then-running**: A `generate_music__generations` row exists with `status='pending'` before the Musicful call, then `status='running'` after the Musicful HTTP 200.
- **status-completed**: Within one poll cycle after tasks complete, the row has `status='completed'` and `error IS NULL`.
- **task-ids-stored**: The row's `task_ids_json` parses to the list `['t1', 't2']`.
- **send-filtered-to-auto-fields**: The HTTP request body sent to Musicful contains keys `action, style, instrumental, model` only; does NOT contain `lyrics`, `title`, `gender`, `entity_type`, `entity_id`.
- **pool-segments-inserted**: Exactly 2 new rows in `pool_segments` with `kind='generated'`, `created_by='plugin:generate-music'`, `variant_kind='music'`, `context_entity_type IS NULL`, `context_entity_id IS NULL`.
- **tracks-linked**: Exactly 2 rows in `generate_music__tracks` with `generation_id` matching the new generation.
- **mp3-files-on-disk**: 2 new files in `pool/segments/` with extension `.mp3`.
- **no-candidate-rows**: Zero new rows in `audio_candidates` or `tr_candidates`.
- **credit-ledger-row**: Exactly 1 new row in `credit_ledger` with `plugin_id='generate-music'`, `operation='generate-music.run'`, `job_ref=<generation_id>`, positive `credits`.
- **job-started-emitted**: WS subscribers receive a `job_started` event with `jobType='generate_music'` and `meta.generationId=<id>`.
- **job-completed-emitted**: WS subscribers receive a `job_completed` event with `result.pool_segment_ids` of length 2.

#### Test: generates-music-custom-with-transition-context (covers R13, R22, R23, R25)

**Given**:
- A `transition` with id `tr-001` exists.
- Mock Musicful returns 1 task that completes.

**When**: User submits `action='custom', style='rock ballad', lyrics='line one\nline two', title='My Song', instrumental=0, gender='male'` with transition `tr-001` selected.

**Then**:
- **send-includes-lyrics-title-gender**: Musicful request body contains `lyrics, title, gender, style, action, instrumental=0, model`.
- **send-excludes-nothing-extra**: Musicful request body does NOT contain `entity_type` or `entity_id`.
- **generation-row-context**: `generate_music__generations` row has `entity_type='transition', entity_id='tr-001'`.
- **pool-segment-context-copied**: New `pool_segments` row has `context_entity_type='transition', context_entity_id='tr-001'`.
- **tr-candidates-written**: Exactly 1 new row in `tr_candidates(tr_id='tr-001', pool_segment_id=<new>, source='generated')`.
- **no-audio-candidates**: Zero new rows in `audio_candidates`.

#### Test: generates-music-with-audio-clip-context (covers R22, R25)

**Given**: An `audio_clip` with id `ac-7` exists, linked to transition `tr-x`.

**When**: User selects `ac-7` (the linked clip, not the transition), submits an `action='auto'` generation.

**Then**:
- **audio-candidates-written**: Exactly 1 new row in `audio_candidates(audio_clip_id='ac-7', pool_segment_id=<new>)`.
- **no-tr-candidates**: Zero new rows in `tr_candidates` (the link to `tr-x` is ignored; user selected the clip, not the transition).

#### Test: rejects-unsupported-action (covers R5)

**Given**: A valid request body otherwise.

**When**: User submits `action='extend'`.

**Then**:
- **http-400**: Backend returns HTTP 400 with an explicit error string mentioning "not supported in MVP".
- **no-musicful-call**: The mock Musicful server receives zero requests.
- **no-db-row**: No `generate_music__generations` row is created.
- **no-ledger-row**: No `credit_ledger` row is created.

#### Test: missing-api-key-admin-error (covers R4, R52, R53)

**Given**: `MUSICFUL_API_KEY` env var is unset at server startup.

**When**:
- (a) User opens the panel.
- (b) Claude calls `generate_music` tool.

**Then**:
- **plugin-registered**: `PluginHost.get_operation('generate-music.run')` returns a non-null handler.
- **panel-shows-admin-error**: The panel renders the form region replaced by the exact string `"This plugin requires a Musicful API key. Please contact your administrator."`.
- **run-button-disabled**: The Generate button is disabled (cannot submit).
- **chat-tool-returns-admin-error**: The `generate_music` tool returns an error with the exact message `"This plugin requires a Musicful API key. Please contact your administrator."`.
- **no-api-call-attempted**: Mock Musicful server receives zero requests.
- **no-key-in-logs**: The test-captured log output does NOT contain the string `"MUSICFUL_API_KEY"` as a value (and doesn't contain any key-like string).

#### Test: elicitation-decline-no-op (covers R42, R43)

**Given**: `generate_music` tool is invoked by the assistant with valid args.

**When**: User declines the elicitation.

**Then**:
- **no-musicful-call**: Mock Musicful server receives zero requests.
- **no-db-row**: No `generate_music__generations` row created.
- **no-ledger-row**: No `credit_ledger` row created.
- **tool-returns-cancelled**: The tool call result is a structured error with message containing `"cancelled by user"`.

#### Test: elicitation-accept-runs (covers R42)

**Given**: Same tool invocation.

**When**: User accepts the elicitation.

**Then**:
- **musicful-called-once**: Mock receives exactly 1 POST to `/v1/music/generate`.
- **tool-returns-running**: Tool returns `{generation_id: <string>, task_ids: <array>, status: 'running'}`.
- **db-row-created**: A `generate_music__generations` row exists with the returned `generation_id`.

#### Test: get-music-credits-no-elicitation (covers R44)

**Given**: Plugin activated with valid API key; mock returns `{key_music_counts: 237}`.

**When**: Claude calls `get_music_credits()`.

**Then**:
- **no-elicitation-fired**: No elicitation event is emitted.
- **returns-count**: Tool returns `{credits: 237, last_checked_at: <iso-timestamp>}`.
- **no-ledger-row**: No `credit_ledger` row is created (this is a read).

#### Test: panel-filters-to-context (covers R27, R28)

**Given**:
- 3 generations exist: two for transition `tr-A`, one project-wide (NULL context).
- User selects `tr-A` in the editor.

**When**: Panel renders.

**Then**:
- **shows-only-trA**: Panel lists exactly 2 run cards (both for `tr-A`).
- **header-reflects-context**: Panel header contains the substring `"Music for"`.
- **context-badge-on-cards**: Both rendered cards show a context badge starting with `◉`.
- **show-all-reveals-rest**: Clicking "Show all" changes the list to 3 cards; project-wide card has NO context badge.

#### Test: reuse-prefills-form (covers R29, R30)

**Given**: A completed generation with `action='custom', style='jazz', lyrics='twinkle', instrumental=0, gender='female'`.

**When**: User clicks `⟳ Reuse`.

**Then**:
- **form-prefilled**: Form fields show those exact values.
- **form-not-submitted**: No HTTP call to the run endpoint is made by the Reuse click alone.
- **on-generate-new-row**: Clicking Generate creates a new `generate_music__generations` row with `reused_from` equal to the original row's id.
- **original-unmutated**: The original row's `status`, `created_at`, and column values are unchanged.

#### Test: drag-payload-shape (covers R37, R38)

**Given**: A completed track row with pool_segment id `ps-123`, duration 172.3, title `"Neon Midnight"`, pool_path `segments/abc.mp3`.

**When**: User starts a drag on the row.

**Then**:
- **payload-mime**: `dataTransfer.types` includes `application/x-scenecraft-stem`.
- **payload-json**: The payload parses to `{pool_segment_id: 'ps-123', stem_type: 'music', duration_seconds: 172.3, pool_path: 'segments/abc.mp3', source_label: 'Neon Midnight'}`.

#### Test: drop-creates-audio-clip-no-auto-track (covers R38, R39, R40)

**Given**: An existing audio track `at-1` (arbitrary name). User drops a music stem at cursor X=10s.

**When**: Drop fires on `at-1`'s lane.

**Then**:
- **clip-inserted-on-at-1**: Exactly 1 new `audio_clip` on `at-1` starting at 10s.
- **clip-name-is-song-title**: New clip's `name` equals the `source_label` from the payload.
- **no-music-track-created**: No new `audio_track` with name `"Music"` is created (track count unchanged).
- **clip-color-purple**: The rendered clip's CSS class includes `"purple"` (verified via test selector or computed class).

#### Test: failed-generation-shows-retry (covers R21, R50, R51)

**Given**: Mock Musicful reports both tasks failed with `fail_reason='model_overloaded'`.

**When**: The polling worker processes the terminal state.

**Then**:
- **status-failed**: `generate_music__generations.status='failed'`, `error` contains `"model_overloaded"`.
- **no-pool-segments**: Zero new `pool_segments` rows for this generation.
- **no-tracks**: Zero `generate_music__tracks` rows.
- **no-ledger-row**: Zero new `credit_ledger` rows.
- **panel-shows-failed-card**: Panel refetch renders a card with `✗ failed`, the error text, and a `Retry` button.

**When** (continuation): User clicks Retry.

**Then**:
- **new-row-created**: A second `generate_music__generations` row is created with `reused_from` equal to the failed row's id.
- **failed-row-unmutated**: The original failed row still has `status='failed'` and the same `error` string.

#### Test: credits-displayed-and-refreshed (covers R34, R35)

**Given**: Mock `GET /v1/get_api_key_info` returns `{key_music_counts: 237}` initially, `{key_music_counts: 235}` after the next call.

**When**:
- (a) User opens the panel for the first time.
- (b) User completes a generation that consumes 2 credits.

**Then**:
- **initial-fetch-once**: Mock receives exactly 1 GET to `/v1/get_api_key_info` at panel open.
- **header-shows-237**: Panel header contains the string `"237"`.
- **post-run-refresh**: Mock receives a second GET after `job_completed` WS event.
- **header-updates-to-235**: Panel header updates to contain `"235"` within one render cycle of the second fetch.

#### Test: out-of-credits-blocks-generate (covers R36)

**Given**: Cached credits = 0.

**When**: Panel renders.

**Then**:
- **generate-disabled**: Generate button is disabled.
- **disabled-message**: The button's disabled tooltip/caption contains `"Out of credits. Please contact your administrator"`.
- **form-still-renders**: All form fields are still rendered (per R31).

### Edge Cases

Boundaries, unusual inputs, concurrency, idempotency, ordering, time-dependent behavior, resource exhaustion.

#### Test: rate-limit-retry-succeeds (covers R17)

**Given**: Mock `GET /v1/music/tasks` returns HTTP 429 on the first two calls, then `{completed}` on the third call. Backoff delays are test-controlled.

**When**: Polling worker runs.

**Then**:
- **three-attempts**: Mock receives exactly 3 GETs to `/v1/music/tasks`.
- **backoff-delays**: Intervals between attempts are approximately 1s, 2s (within 10% tolerance).
- **final-success**: Generation row transitions to `status='completed'`.
- **no-failure-logged**: No error string or failure event is surfaced for the transient 429s.

#### Test: rate-limit-exhausts-retries (covers R17)

**Given**: Mock returns HTTP 429 on every call.

**When**: Polling worker runs.

**Then**:
- **three-retries-then-fail**: Mock receives exactly 3 GETs, then no more.
- **status-failed**: `generate_music__generations.status='failed'`.
- **error-is-rate-limit**: `error='rate_limit_exceeded'`.
- **job-failed-emitted**: WS `job_failed` event fires with matching `jobId`.

#### Test: non-retriable-http-fails-immediately (covers R17)

**Given**: Mock `POST /v1/music/generate` returns HTTP 500.

**When**: Backend processes the request.

**Then**:
- **single-attempt**: Mock receives exactly 1 POST (no retry).
- **status-failed**: Generation row is `status='failed'` with `error` containing the HTTP status.
- **no-ledger-row**: No credit ledger entry.

#### Test: partial-success-one-of-two-tasks (covers R20)

**Given**: Mock returns task ids `['t1', 't2']`; `t1` completes successfully, `t2` fails with `fail_reason='timeout'`.

**When**: Polling worker processes both terminal states.

**Then**:
- **status-completed-with-error**: Generation row is `status='completed'` AND `error IS NOT NULL` (contains `"timeout"`).
- **one-pool-segment**: Exactly 1 new `pool_segments` row (for `t1`).
- **one-track**: Exactly 1 `generate_music__tracks` row linking the generation to the `t1` pool_segment.
- **no-orphan-track**: No `generate_music__tracks` row exists with a missing `pool_segment_id`.
- **ledger-row-for-success**: Exactly 1 `credit_ledger` row with `credits=1` (not 2).

#### Test: concurrent-generations-independent (covers R14, R16, R47)

**Given**: Two generations kicked off within 100ms of each other; each returns distinct task ids.

**When**: Both run to completion.

**Then**:
- **two-generation-rows**: Exactly 2 `generate_music__generations` rows.
- **distinct-pool-segments**: Each generation has its own pool_segment rows; no cross-contamination.
- **two-ledger-rows**: Exactly 2 `credit_ledger` rows, one per generation.
- **ws-events-distinguishable**: Both `job_completed` events fire with distinct `jobId`s.
- **no-db-deadlock**: Test completes within a reasonable timeout without sqlite lock errors.

#### Test: ws-disconnect-does-not-abort-polling (covers R49)

**Given**: A generation is running. WS connections for that session are closed.

**When**: Musicful tasks complete while WS is disconnected.

**Then**:
- **db-still-reaches-terminal**: Generation row is `status='completed'`.
- **pool-segments-still-written**: Pool_segments exist on disk and in DB.
- **ledger-still-written**: Ledger row exists.
- **on-reconnect-panel-refetch-catches-up**: After WS reconnects and panel refetches, the completed card appears without any backend recomputation.

#### Test: instrumental-1-drops-lyrics (covers R13)

**Given**: Form has `action='custom', style='foo', lyrics='xyz', instrumental=1`.

**When**: User submits.

**Then**:
- **lyrics-not-sent**: Musicful request body does NOT contain `lyrics`.
- **instrumental-sent-as-1**: Musicful request body contains `instrumental=1`.
- **db-row-records-state**: `generate_music__generations.lyrics='xyz'` (preserved for Reuse), `instrumental=1`.

#### Test: action-auto-ignores-lyrics-and-title (covers R13)

**Given**: Form has `action='auto', style='foo', lyrics='ignored', title='also ignored', instrumental=0`.

**When**: User submits.

**Then**:
- **lyrics-not-sent**: Musicful body excludes `lyrics`.
- **title-not-sent**: Musicful body excludes `title`.
- **style-sent**: Musicful body contains `style='foo'`.

#### Test: mid-form-deselect-clears-context (covers R33)

**Given**: User has `transition tr-X` selected and the form open with the "Generating for tr-X" header.

**When**: User clicks outside the transition (selection becomes null).

**Then**:
- **header-updates**: Form header updates to no longer contain `"Generating for"`.
- **clear-context-button-hidden**: The Clear context button is removed (no context to clear).
- **on-generate-no-entity**: If the user submits now, the request body has `entity_type: null, entity_id: null`.

#### Test: clear-context-button-overrides-selection (covers R33)

**Given**: User has audio_clip `ac-1` selected and form open.

**When**: User clicks Clear context, then submits.

**Then**:
- **payload-context-null**: Run endpoint receives `entity_type: null, entity_id: null` despite a selection being active.
- **no-candidate-rows-on-completion**: On success, no `audio_candidates` row is written.

#### Test: reuse-preserves-null-context (covers R29, R30)

**Given**: A completed generation with `entity_type=NULL, entity_id=NULL`.

**When**: User clicks Reuse, then Generate.

**Then**:
- **new-row-context-null**: New row has `entity_type=NULL, entity_id=NULL`.
- **reused-from-set**: New row's `reused_from` equals the original id.

#### Test: reuse-preserves-entity-context (covers R29, R30)

**Given**: A completed generation with `entity_type='audio_clip', entity_id='ac-99'`.

**When**: User clicks Reuse on this row. Editor selection has meanwhile changed to transition `tr-Z`.

**Then**:
- **prefill-uses-original-context**: Form state binds to `ac-99`, NOT to the currently-selected `tr-Z`.
- **on-submit-row-has-original-context**: New row has `entity_type='audio_clip', entity_id='ac-99'`.

#### Test: retry-of-failed-preserves-params (covers R51)

**Given**: Failed generation with `action='custom', style='blues', lyrics='lost love', title='T', instrumental=0, gender='female', entity_type='transition', entity_id='tr-42'`.

**When**: User clicks Retry.

**Then**:
- **new-row-has-all-params**: New row's params match the failed row's params (except `id`, `created_at`, `status`, `error`, `reused_from`).
- **new-row-reused-from-failed**: `reused_from` equals the failed row's id.
- **failed-row-unchanged**: Failed row's fields are unchanged.

#### Test: plugin-id-rejects-invalid-kebab (covers R11)

**Given**: A `plugin.yaml` with `name: 'generate--music'` (consecutive hyphens).

**When**: Plugin host attempts to load the plugin.

**Then**:
- **registration-rejected**: `PluginHost.register` raises an error mentioning the id regex.
- **no-tables-created**: No `generate__music__...` tables appear in the schema.

#### Test: table-name-prefix-enforced (covers R11)

**Given**: A test migration attempts `CREATE TABLE music_generations (...)` (no prefix) from the generate-music plugin context.

**When**: Migration runner processes it.

**Then**:
- **migration-rejected**: Runner raises an error mentioning the prefix violation.
- **db-unchanged**: No new table exists.

NOTE: The migration runner is M17 scope; this test lives in the M17 spike's test plan but is referenced here because M16's DDL must already comply with the convention to pass the future runner's validation.

#### Test: created-by-actor-scheme-values (covers R18, R19, no-regression)

**Given**: A successful generation triggered by a request with `user_id='alice'`.

**When**: Generation completes.

**Then**:
- **pool-segments-created-by**: New `pool_segments.created_by` equals the string `"plugin:generate-music"` exactly.
- **ledger-user-id**: `credit_ledger.user_id='alice'` (bare id, NOT prefixed — per R54's separation from the actor scheme).
- **ledger-plugin-id**: `credit_ledger.plugin_id='generate-music'` (bare kebab id).

#### Test: no-auth-context-records-empty-user (covers R54)

**Given**: A run-endpoint call with no authenticated user (e.g. server tooling).

**When**: Generation completes.

**Then**:
- **ledger-user-empty**: `credit_ledger.user_id=''` (empty string).
- **no-null-fk-error**: Insert succeeds despite empty string.

#### Test: duplicate-task-id-idempotent-poll (covers R16)

**Given**: Mock returns the same task id twice in consecutive `GET /tasks` responses (unusual but possible under Musicful eventual consistency).

**When**: Worker processes both responses.

**Then**:
- **single-pool-segment**: Exactly 1 new `pool_segments` row (not 2).
- **single-track**: Exactly 1 `generate_music__tracks` row.
- **no-duplicate-ledger**: 1 `credit_ledger` row, not 2.

#### Test: very-long-style-accepted (covers R13)

**Given**: `style` is a 4000-character string (within Musicful's 5000 limit for MFV2.0).

**When**: User submits.

**Then**:
- **accepted**: Generation reaches `status='completed'`.
- **style-preserved**: `generate_music__generations.style` equals the full 4000-char input.

#### Test: style-over-limit-rejected (covers R5)

**Given**: `style` is 6000 characters.

**When**: User submits.

**Then**:
- **http-400**: Backend returns HTTP 400 with an explicit limit-exceeded error.
- **no-musicful-call**: Mock receives zero requests.

#### Test: empty-style-rejected (covers R5)

**Given**: `style=''`.

**When**: User submits.

**Then**:
- **http-400**: Backend rejects with a required-field error.

#### Test: no-pools-leaks-on-download-failure (covers R18)

**Given**: Musicful task completes with `audio_url` pointing to a URL that returns HTTP 404 on download.

**When**: Worker attempts download.

**Then**:
- **status-failed**: Generation row ends in `status='failed'`.
- **no-partial-file-left**: No orphan file in `pool/segments/` from the failed download.
- **no-pool-segment-row**: No `pool_segments` row is created for the failed download.
- **no-ledger-row**: No credit ledger entry.

#### Test: panel-context-filter-reacts-to-selection-change (covers R27)

**Given**: Panel is open; no selection. 3 generations visible.

**When**: User selects `transition tr-A` in the editor.

**Then**:
- **panel-refilters-within-one-render**: Panel updates to show only tr-A's generations within 1 render cycle.
- **no-backend-call**: No new HTTP request to `/generations` (filtering happens client-side against the cached list).

NOTE: If M16 implements server-side filtering instead of client-side, relax this assertion to "at most one HTTP request to /generations with the new filter."

#### Test: drag-payload-ignored-on-non-audio-lane (covers R38)

**Given**: Drag starts on a music stem; user attempts to drop on the video track (not an audio lane).

**When**: Drop event fires on video track.

**Then**:
- **no-audio-clip-created**: No new `audio_clip` row.
- **no-video-clip-created**: No new video clip row (music payload is not a video).
- **drop-rejected-visually**: The drop target does not show an acceptance cursor.

#### Test: two-music-drops-allowed-on-same-track (covers R38)

**Given**: An audio track with 1 existing music clip.

**When**: User drops a second music stem at a non-overlapping position on the same track.

**Then**:
- **both-clips-exist**: 2 music clips on the track.
- **both-purple**: Both render with purple styling.
- **no-track-auto-created**: No new "Music" track is created.

#### Test: no-api-key-in-error-responses (covers R52)

**Given**: A generation fails in any way.

**When**: Error response is returned.

**Then**:
- **no-key-in-error-body**: The error response string does NOT contain the actual API key value.
- **no-key-in-ws-events**: No WS event payload contains the key.
- **no-key-in-logs**: Test-captured logs do not contain the key value.

#### Test: no-mutation-of-completed-rows-on-reuse (covers R30)

**Given**: Completed generation with known row fields.

**When**: User clicks Reuse, fills, submits 3 times in succession (creating 3 new child rows).

**Then**:
- **original-row-unchanged**: Original row's every field is byte-identical before and after.
- **three-children**: 3 new rows exist, each with `reused_from` equal to the original id.

#### Test: elicitation-cost-reflects-balance (covers R42)

**Given**: Cached balance is 5 credits; call costs 2 credits.

**When**: Chat tool elicitation fires.

**Then**:
- **summary-shows-cost**: Elicitation summary contains `"~2"` credits (or exact cost).
- **summary-shows-balance**: Elicitation summary contains `"5"` or `"5 credits"`.

#### Test: elicitation-summary-truncates-long-lyrics (covers R42)

**Given**: `lyrics` field is 2000 characters long.

**When**: Chat tool elicitation fires.

**Then**:
- **lyrics-truncated**: Elicitation summary contains the first ~100 characters of lyrics followed by an ellipsis `…`.
- **no-full-lyrics-in-summary**: Full 2000-char lyrics do NOT appear verbatim in the elicitation payload.

#### Test: no-cross-plugin-ledger-writes (covers R9)

**Given**: Plugin `generate-music` attempts to call `plugin_api.record_credit_spend(plugin_id='isolate-vocals', user_id='...', credits=1, operation='isolate-vocals.run')`.

**When**: The call is made.

**Then**:
- **call-rejected**: Helper raises an error about plugin-id mismatch.
- **no-ledger-row**: No new `credit_ledger` row.

#### Test: singleton-polling-worker-per-generation (covers R16, negative-concurrency)

**Given**: A generation is running with an active polling worker.

**When**: The same generation_id is (incorrectly) triggered for polling a second time.

**Then**:
- **no-duplicate-musicful-calls**: Mock does not receive duplicate `/tasks` calls for the same ids in the same 5s window.
- **no-duplicate-ledger-on-completion**: Only 1 ledger row after completion.

#### Test: default-form-values (covers R32)

**Given**: A freshly opened panel, never used before.

**When**: Form renders.

**Then**:
- **action-auto**: Action radio is set to `Auto`.
- **instrumental-checked**: Instrumental checkbox is checked.
- **style-empty**: Style textarea is empty.
- **all-other-fields-default**: Lyrics, Title, Gender, Model are at their respective empty/default values.

#### Test: synchronous-backend-no-hidden-concurrency (covers R14-R19, negative)

**Given**: Code review note — the backend plugin's public API is synchronous (the request thread returns immediately with `{generation_id, task_ids}`; background polling runs on a worker thread, not an asyncio loop; no hidden event queues or cron jobs).

**When**: (This is a structural assertion, not a runtime test. Test is a grep or AST check.)

**Then**:
- **no-asyncio-in-plugin**: `generate_music` plugin module contains no `import asyncio` at module scope (aside from optional use inside the shared JobManager, which is tested separately).
- **no-hidden-cron**: No scheduled-task registration in the plugin (e.g. no APScheduler/celery-beat/cron decorators).

This test exists to lock in the simple execution model. If a future change adds async or scheduled tasks, this test fails — forcing the spec to be updated alongside the code.

---

## Non-Goals

The following are explicitly out of scope for M16 and MUST NOT be implemented:

- **WAV output or conversion UI** (Q5.1 answer `n`). `/v1/music/generate-wav` is not called.
- **Auto-creation of a "Music" audio track** on drop (Q5.2 answer `n`). Users drop on whatever track they want.
- **Auto-ducking** the music track relative to dialogue tracks (Q5.3 answer `n`). Captured as a separate spike: `task-spike-auto-duck-plugin.md`.
- **`generate_lyrics` chat tool** (Q6.1 answer). Lyrics are brainstormed inline in chat when needed.
- **Musicful actions beyond `auto` + `custom`**: `extend`, `concat`, `upload`, `upload_extend`, `artist_consistency` are not exposed.
- **`/v1/music/generate-vibe`** and the `singer_id` concept (Q1.3 answer `P2`).
- **`/v1/music/generate-mp4`** lyric-video render (Q1.3 answer).
- **Organization-level credit tracking / billing aggregation** (Q4.1 followup). Ledger captures `user_id` only; org joins are a reporting concern for later.
- **Command palette entry** (Q3.2 answer "defer"). Requires whole-system command-palette design first.
- **Timeline empty-space right-click** entry for "Generate music…" (Q3.2 answer "lean").
- **Soft-warning toast at low credits** (Q4.1 answer `P2`). Permanent panel-header counter replaces it.
- **Plugin invariant harness** (Q7.1 answer `fold`). Captured in `task-spike-plugin-schemas-and-unified-jobs.md` as Step 4b. M16 plugin's `contributes.invariants` manifest declaration is forward-compat documentation only.
- **Plugin lifecycle system** (install/upgrade/downgrade/uninstall/migration runner). Captured in the same M17 spike. M16 schema ships via core `_ensure_schema` for now.
- **Multi-provider support** (Suno, Udio, etc.). Deferred with a forward-constraint note in the invariant-harness spike section: conditional invariants MUST be designable.
- **Per-project API keys**. Env var is per-box only.
- **Retroactive rename of M11 tables** (`audio_isolations` → `isolate_vocals__isolations`). Addressed in M11's own work or via the M17 rename task.
- **Dockview cleanup** (dead `EditorLayout.tsx`). Captured as `task-dockview-dead-code-removal.md` — independent of M16.

---

## Open Questions

Unresolved items that should be pinned before implementation begins:

1. **Credit cost per generation** — The spec assumes 1 credit per task (so a 2-track `auto` generation = 2 credits). Musicful's actual pricing model per action/model may differ. Needs a confirmation pass with live API docs or support; implementers should read `key_music_counts` deltas against known-cost calls during integration to calibrate.
2. **pool_segments.kind value for music output** — Spec says `kind='generated'`. Is this the right enum value, or does scenecraft want a new `kind='music'`? Decided implicitly based on M11 precedent (`kind='generated'` used for isolation stems), but not explicitly answered in the clarification.
3. **Panel filtering: client-side vs server-side** — Spec's default test assumes client-side filtering (no extra HTTP on selection change). Server-side filtering is also acceptable and might be preferred for large projects. Implementer choice; flag in PR.
4. **WS `job_progress` cadence** — Spec says "every poll cycle." For a 5s polling interval, that's 1 WS event every 5s — fine. If implementer reduces polling to 1s, the cascade of WS events may flood clients. Cap frontend to 1 event per 2s minimum OR emit `job_progress` only on state change (not every poll).
5. **Selection context captured on Generate click: value vs. ref** — Spec says "reads selection at click-time." What if the selection changed between form focus and click (race window)? Confirm: the value captured is the click-time snapshot, not a ref. Low-probability edge case; test `mid-form-deselect-clears-context` covers the deselect case but not rapid-reselect. Decide if worth a test.
6. **Credit ledger schema ownership** — `credit_ledger` is a core table landing in M16 to support M16's first paid plugin. The M17 spike will formalize the `plugin_api.record_credit_spend()` helper API. Pin the helper signature now or evolve it in M17? Recommendation: freeze now to what M16 ships; M17 can add fields as `NULL`-by-default.
7. **Purple-color definition** — Spec says "purple color class." Which exact tailwind class? (`purple-500`, `violet-400`?) Implementer picks; should match scenecraft's existing palette conventions.

---

## Key Design Decisions

Carried forward from clarification-10 answers (rounds 1-5). This is the settled decision-log; scope questions or behavior questions not listed here remain genuine open questions above.

### Plugin identity & scope

- **Generic plugin, score-biased defaults** (Q1.3 clarified). Plugin name/DB/code stays `music_*`; defaults favor scoring (instrumental on, action=auto) but all capabilities remain.
- **Actions: `auto` + `custom` only in MVP** (Q1.2). Other five actions are implementable but gated at dispatch.
- **No `generate_lyrics` tool** (Q6.1). Claude drafts lyrics inline in chat.

### Schema

- **Table naming: `<plugin_id_snake>__<name>` convention** with `__` delimiter (clarification-10 lifecycle block). Enforced at migration parse time once M17 ships; pre-adopted in M16.
- **Credit tracking: core `credit_ledger` table** (Q4.1 correction). Plugins never own credit columns; they write via `plugin_api.record_credit_spend()`.
- **Plugins cannot ALTER core tables** (Q4.1 correction). But core engineering can add core tables/columns in service of a plugin feature (e.g. `credit_ledger`, `pool_segments.context_entity_*`).
- **Actor attribution: `<actor_type>:<actor_id>`** (Q2.1 Option A accepted). Reuses existing `created_by`/`last_modified_by` columns; pool_segments write `plugin:generate-music`.

### Context and provenance

- **Context-aware candidate routing** (Q2.1). Audio_clip selected → `audio_candidates` junction; transition selected → `tr_candidates` junction; null → no junction.
- **Option Y for derived_from** (Q2.2). Leave M13's `derived_from` typed + pure; add new `context_entity_type`+`context_entity_id` columns on `pool_segments` for M16's weaker context-provenance relationship.
- **`variant_kind='music'`** (Q2.2). Reuses M13's column; new enum value.

### UX

- **Custom `PanelLayout`, NOT dockview** (Q3.1 corrected research). `EditorLayout.tsx` is dead code; `EditorPanelLayout` + `@/components/panel-layout/` is the active system.
- **Context-aware panel filter** (Q3.1 corrected). Panel filters to selection when entity selected; "Show all" toggle always available.
- **All form fields always rendered** (Q1.3 expose-all). No hide/grey; filter by action at request time.
- **No auto-track on drop; purple styling via variant_kind** (Q5.2). Layering multi-music tracks is a user workflow.
- **Reuse button; failed runs retryable** (Q2.1 follow-up, user added "do not skip reused_from").
- **Permanent credits counter in panel header** (Q4.1 followup). Replaces toast-style warnings.
- **Admin-oriented error messages** for missing API key + out-of-credits (Q4.1, Q7.1).

### Chat surface

- **`generate_music` + `get_music_credits` tools only** (Q6.1). `generate_music` elicitation-gated via `_DESTRUCTIVE_TOOL_PATTERNS`; `get_music_credits` free.
- **Fire-and-forget return shape** (Q6.2). Tool returns `{generation_id, task_ids, status: 'running'}` immediately; WS drives panel update.

### Infrastructure

- **Per-box API key** (Q4.1). Env var `MUSICFUL_API_KEY`.
- **Plugin registers even when key missing** (Q7.1 (A)). UI stays discoverable; clear admin-oriented error.
- **Plugin manifest declares invariant forward-compat** (Q7.1 fold). Harness doesn't run in M16; `contributes.invariants` is documentation until M17.

---

## Related Artifacts

- **Source clarification**: `agent/clarifications/clarification-10-musicful-music-generation-plugin.md`
- **Prior-plugin precedents**:
  - `agent/clarifications/clarification-8-audio-isolation-plugin.md`
  - `agent/clarifications/clarification-9-audio-isolation-stems-and-panel.md`
  - `agent/design/local.audio-isolation-plugin.md`
  - `agent/milestones/milestone-11-audio-isolation-plugin.md`
- **Adjacent-plugin design**: `agent/design/local.audio-sync.md` (M13 lipsync — establishes `derived_from` and `variant_kind`)
- **Infrastructure used**:
  - `scenecraft-engine/src/scenecraft/ws_server.py` — `JobManager` + WS event broadcast
  - `scenecraft-engine/src/scenecraft/db.py` — schema + `_ensure_schema`
  - `scenecraft/src/components/panel-layout/` — custom panel system (the real one)
  - `scenecraft/src/components/editor/EditorPanelLayout.tsx` — active layout
  - `scenecraft/src/components/editor/AudioLane.tsx` — drop handler (task-104b)
- **Follow-on spikes**:
  - `agent/tasks/unassigned/task-spike-plugin-schemas-and-unified-jobs.md` — M17 scope (lifecycle, unified jobs, invariants)
  - `agent/tasks/unassigned/task-spike-auto-duck-plugin.md` — second plugin
  - `agent/tasks/unassigned/task-dockview-dead-code-removal.md` — independent cleanup

---

**Namespace**: local
**Spec**: music-generation-plugin
**Version**: 1.0.0
**Created**: 2026-04-23
**Last Updated**: 2026-04-23
**Status**: Ready for Implementation
**Compatibility**: scenecraft engine (current) + scenecraft frontend (current)
**Author**: generated from clarification-10 via @acp.spec --from-clar
