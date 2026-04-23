# Task Spike: Plugin-Contributed Schemas, Unified Jobs, and Lifecycle

**Milestone**: Unassigned (proposed M17 "Plugin Schema Contribution & Lifecycle")
**Design Reference**: Pending — this spike produces the design docs
**Estimated Time**: 2-3 days
**Dependencies**: None (pure investigation; no code changes yet)
**Status**: Not Started

---

## Objective

Investigate and design the plugin-lifecycle layer captured in clarification-10 Item 2.1 comment blocks. Produce two design documents that pin down the schema-contribution mechanism, unified-jobs table, and surrounding lifecycle concerns so a concrete implementation milestone can be planned.

---

## Context

Clarification-10 (Musicful Music-Generation Plugin) surfaced a cross-cutting initiative that's much bigger than the plugin it was asked about. Across several rounds of responses, the following requirements were pinned:

1. **Plugin-contributed SQL migrations** — plugins ship `migrations/` dirs with numbered up/down SQL; host applies them at activation.
2. **Prefix-scoped table creation** — delimiter is `__` (double underscore); plugins can only create tables matching `<plugin_id>__*`.
3. **Plugin id constraint** — kebab-case regex `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` (no consecutive hyphens, no numeric-only starts).
4. **Uninstall data-wipe prompt** — enumerate plugin-owned tables + rows on core tables, prompt user before DROP.
5. **Versioned upgrade/downgrade** — `plugin.yaml` declares `schema_version: N`; runner applies forward/rollback migrations.
6. **Actor attribution scheme** (Option A accepted) — `<actor_type>:<actor_id>` on existing `created_by` / `last_modified_by` columns; values like `user:alice`, `plugin:generate-music`, `system:import`.
7. **Unified `jobs` table** with type discriminator, fed by a `contributes.jobs` contribution point; supersedes today's per-plugin run tables (`audio_isolations`, `music_generations`) over time.

User accepted (in clarification-10): preemptive rename of M11/M16 tables to the `__` convention, consolidated follow-on plan, M17-scope dedicated milestone. This spike defines what M17 will actually ship.

See clarification-10-musicful-music-generation-plugin.md Q2.1 comment blocks for full context.

---

## Steps

### 1. Audit current scenecraft-engine DB + plugin state

Build a complete picture of what exists:

- Read `scenecraft-engine/src/scenecraft/db.py::_ensure_schema` (db.py:100+). List every core table, every `ALTER TABLE` migration, every index, every undo trigger. Note which tables already have `created_by` vs `last_modified_by`.
- Read `scenecraft-engine/src/scenecraft/ws_server.py` `JobManager` (lines 28-106). List every caller (`grep -rn "job_manager.create_job"`); map every `job_type` string in use today.
- Identify every existing plugin-style table: `audio_isolations`, `isolation_stems` (M11 task-100b, mid-ship), `checkpoints` (chat), `chat_messages.user_id`, plus any `created_by` free-text values in `pool_segments`.
- Document findings in the new design doc (step 5).

### 2. Research industry precedent

- VS Code extension manifest (`package.json` contributes) for schema/data-owning extensions: does it have this? (Answer: mostly no; extensions use their own storage; VS Code doesn't police the SQLite level.)
- Obsidian plugin manifest (`manifest.json`) + data persistence conventions.
- PostgreSQL extensions (`CREATE EXTENSION`, `pg_extension`) for prefix + lifecycle precedent.
- SQLite migration tools (`alembic`, `golang-migrate`, `knex migrations`) for up/down migration idioms.

Pick the 2-3 most relevant and write short "what we borrow / what we diverge on" notes in the design doc.

### 3. Design: plugin-contributed schemas + lifecycle

Write `agent/design/local.plugin-schemas-and-lifecycle.md`. Sections to cover:

- **Manifest shape** — exact `contributes.schema` block in `plugin.yaml` (migration dir, schema_version, optional DDL quirks).
- **Migration file convention** — naming (`v0001_init.sql`, `v0001_init.down.sql`), content rules, idempotency expectations, transaction wrapping.
- **Prefix enforcement** — tokenizer/parser strategy. Options: regex check on CREATE/ALTER/DROP statements (fast, lossy), or full SQL AST via `sqlparse` / `sqlglot` (slow, accurate). Recommend one based on tradeoffs.
- **Plugin id regex** — finalize: `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`; note edge cases (reserved words, length limits).
- **Lifecycle hooks** — install / activate / upgrade / downgrade / deactivate / uninstall. What runs at each phase.
- **Uninstall UX** — CLI prompt format + UI prompt format; row-count preview query; "keep data" vs "wipe data" outcomes.
- **Actor scheme migration** — how to backfill existing `created_by` / `last_modified_by` values to the `<actor_type>:<actor_id>` format (parse bare strings as `user:<raw>` unless in a known-system list).
- **Core-table retrofits** — adding `created_by` to `keyframes` / `transitions` / `effects` / `tracks`. Backfill `system:migration` for pre-existing rows.
- **Failure modes** — migration fails partway, plugin id collision, schema_version downgrade without rollback SQL, cross-plugin FK.
- **Security** — can migrations read/write core tables beyond their prefix? Short answer: SELECT yes on explicit allowlist (e.g., `pool_segments`); INSERT yes with `created_by = 'plugin:<id>'` enforcement; ALTER/DROP never.

### 4. Design: unified jobs table + contribution point

Write `agent/design/local.unified-jobs-and-contribution.md`. Sections:

- **Table schema** — `jobs(id, type, status, error, input_json, output_json, created_at, updated_at, actor)`. CHECK constraint on `type` enum? Or open-ended string validated at register-time?
- **Contribution point** — `contributes.jobs: [{ type, input_schema, output_schema, timeout_seconds?, concurrency_limit? }]` in `plugin.yaml`. Validated at plugin activation; host populates a `plugin_job_types` registry.
- **JobManager integration** — how `ws_server.JobManager` persists to `jobs` table; how existing in-memory callers (`chat_keyframe_candidates` etc.) migrate; whether the in-memory layer stays as a cache.
- **Migration path** — `audio_isolations` + `music_generations` under new model. Per the earlier analysis: keep per-plugin output junctions (`isolate_vocals__stems`, `generate_music__tracks`) but have the parent row live in the unified `jobs` table (accessed via view filters, or by reference from the plugin table's `job_id` column).
- **Relationship to schemas-and-lifecycle** — `jobs` is a *core* table; plugin-owned output junctions follow the prefix convention from the other doc.
- **WS event model** — unchanged (`job_started` / `job_progress` / `job_completed` / `job_failed`), but now backed by DB rows; crash recovery becomes possible.

### 4b. Design: plugin invariant harness (folded in per clarification-10 Q7.1)

Write `agent/design/local.plugin-invariants.md` OR include as a major chapter inside `local.plugin-schemas-and-lifecycle.md` (choose based on length — if >150 lines, split into its own doc). Sections:

- **Problem statement** — plugins have preconditions (API key present, network reachable, model file downloaded, disk space, etc.). Today each plugin handles this ad-hoc; we want a unified surface.
- **Manifest shape** — `contributes.invariants` in `plugin.yaml`:
  ```yaml
  contributes:
    invariants:
      - id: "musicful-api-key-present"
        description: "MUSICFUL_API_KEY environment variable must be set"
        check: "backend:generate_music.check_api_key"   # function returns bool + optional message
        severity: blocking                                # blocking | warning | info
        user_message: "This plugin requires a Musicful API key. Please contact your administrator."
        check_interval_seconds: 300                       # optional; default: only on activation
  ```
- **Evaluation cadence** — on plugin activation (always), on-demand (user clicks "Refresh status"), periodically (if `check_interval_seconds` set). Store last-check timestamp.
- **Unified logic layer** — core table `plugin_invariants(plugin_id, invariant_id, status, last_checked, message)`. Admin UI reads this for whole-system health view.
- **Severity handling**:
  - `blocking` → plugin registers but UI disabled; chat tools return the invariant's `user_message`; panel shows config-missing state.
  - `warning` → plugin runs; banner in the panel shows the warning; chat tools work normally but include a warning in responses.
  - `info` → collected for admin dashboard only, no user-facing impact.
- **Check function contract** — plugin exports a function that returns `{ passed: bool, message?: string }`. Host calls it; failures don't crash the plugin (caught + logged).
- **Scoping**: invariants attach to the plugin as a whole (not per-operation). Per-operation preconditions stay as inline checks in the handler.
- **Conditional invariants (multi-provider forward-look)** — a plugin like `generate-music` might eventually ship multiple providers (Musicful, Suno, Udio, etc.), each with its own API key. An invariant like "SUNO_API_KEY must be set" should only block when the user actually selects Suno as the provider — not at plugin activation when Musicful is the default. Design should accommodate conditional invariants via an `applies_when` field (e.g. `applies_when: "config.provider == 'suno'"` or similar), or punt to plugin-per-provider ("generate-music-musicful", "generate-music-suno") if that's cleaner. Decide in the design pass; until then, MVP invariants are unconditional.
- **Relationship to lifecycle** — invariants evaluated as part of plugin activation/upgrade hooks; failing a `blocking` invariant keeps the plugin registered but flagged.
- **Admin UI** — simple table: Plugin | Invariant | Status | Last Checked | Message. Actionable controls (re-check, suppress warning for 24h).
- **M16 use case** — `generate-music` plugin declares the Musicful API key invariant. Ships to prove the mechanism. Second provider (Suno et al.) is deferred, but the harness should NOT lock us out of multi-provider support.

### 5. Sketch M17 task breakdown

Based on the two designs, enumerate tasks that M17 should ship:

- Migration parser + prefix enforcer
- Migration runner + `plugin_schema_versions` table
- Lifecycle hooks (install/upgrade/downgrade/uninstall)
- CLI: `scenecraft plugin install|upgrade|downgrade|uninstall|list|status`
- Uninstall-prompt UI (frontend + CLI)
- Retroactive `created_by` column addition to keyframes/transitions/effects/tracks + backfill
- Retroactive table renames for M11/M16 (`audio_isolations` → `isolate_vocals__isolations`, etc.) — only if not already pre-named
- Actor-scheme value migration (`local` → `user:local`, etc.)
- Unified `jobs` table + `JobManager` DB-backed refactor
- Plugin invariant harness: manifest parser, check-runner, `plugin_invariants` table, severity-handling in UI
- Admin UI for invariant status (simple table view)
- Core `credit_ledger` table + `plugin_api.record_credit_spend()` helper (core-owned; plugins call into it)
- Docs + tests

Produce rough estimate (~1.5-2 weeks) and task ordering/dependency graph.

### 6. Register follow-on clarification (optional)

If the designs surface decisions that need user input before M17 can be planned, file `agent/clarifications/clarification-11-plugin-lifecycle.md` with those questions. Don't block on user — spike can complete without it; clarification-11 is for next-round refinement.

### 7. Update progress.yaml

Add M17 entry with estimated duration and the task list from step 5. Mark this spike as completed.

---

## Deliverables

- [ ] `agent/design/local.plugin-schemas-and-lifecycle.md` — complete design doc
- [ ] `agent/design/local.unified-jobs-and-contribution.md` — complete design doc
- [ ] M17 task breakdown with estimates
- [ ] (Optional) `agent/clarifications/clarification-11-plugin-lifecycle.md` if new questions surface
- [ ] progress.yaml updated with M17 entry

---

## Notes

- This is a *spike* — no implementation code. All output is documentation that another milestone executes against.
- The designs should be specific enough that someone (human or AI) can execute M17 tasks without re-researching.
- Keep the two design docs focused: schemas-and-lifecycle is the general mechanism; unified-jobs is a specific application of that mechanism. Cross-reference but don't merge.
- If during the spike we discover the unified-jobs approach is the wrong abstraction, that's a valid finding — document the alternative and park M17 scope accordingly.
