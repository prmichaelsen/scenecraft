# Task 127: Schema + Helpers

**Milestone**: [M16](../../milestones/milestone-16-music-generation-plugin.md)
**Spec**: `agent/specs/local.music-generation-plugin.md` — R7, R8, R9, R9a, R10, R11
**Estimated Time**: 3 hours
**Dependencies**: task-126 (for `api_keys` / auth context; `spend_ledger.api_key_id` FK targets it)
**Status**: Not Started

---

## Objective

Create the plugin-owned schema (`generate_music__generations` + `generate_music__tracks`), the core-owned `spend_ledger` table, and the core `pool_segments.context_entity_*` columns. Ship all required DB helpers via `plugin_api` with the R9a invariant (no raw DB handle exposed to plugins).

---

## Steps

### 1. Plugin-owned tables (exact DDL per spec § Interfaces)

Applied via `_ensure_schema` in `db.py`. Idempotent. Use `__` delimiter per R11. Full DDL in the spec; do not re-derive.

- `generate_music__generations`
- `generate_music__tracks`

### 2. Core-owned `spend_ledger` (in `server.db`, NOT `project.db`)

Full DDL in spec § `spend_ledger (core-owned)`. Includes `username` + `org` FKs, `api_key_id` nullable, `amount`/`unit`/`metadata`/`source` columns, three indexes.

Installed via `vcs/bootstrap.py::SERVER_DB_SCHEMA` since that's where `users`/`orgs` live.

### 3. Core `pool_segments` column additions

```sql
ALTER TABLE pool_segments ADD COLUMN context_entity_type TEXT;
ALTER TABLE pool_segments ADD COLUMN context_entity_id   TEXT;
```

`variant_kind` + `derived_from` already added by M13 audio-sync work; if M13 hasn't landed yet, copy those migrations here (spec R10 notes this dependency).

### 4. `plugin_api` helpers (Python)

All helpers live in `scenecraft-engine/src/scenecraft/plugin_api.py`. R9a invariant: plugin code never receives a raw DB connection.

**Exposed write helpers** (the enumerated set from R9a):

```python
def record_spend(*, plugin_id: str, username: str, org: str, amount: int, unit: str,
                 operation: str, job_ref: str | None = None,
                 metadata: dict | None = None, api_key_id: str | None = None,
                 source: str = 'local') -> str:
    """Insert a spend_ledger row. Host validates plugin_id matches caller's
    registered plugin id (trust boundary — plugins cannot attribute spend to
    a different plugin). Returns the ledger row id."""

def add_pool_segment(project_dir, *, kind: str, created_by: str, ...,
                     variant_kind: str | None = None,
                     context_entity_type: str | None = None,
                     context_entity_id: str | None = None,
                     generation_params: dict | None = None) -> str:
    """Insert a pool_segments row. Returns seg_id."""

def add_audio_candidate(project_dir, *, audio_clip_id: str, pool_segment_id: str) -> None:
def add_tr_candidate(project_dir, *, tr_id: str, pool_segment_id: str, source: str) -> None:
```

**Exposed read helpers** (already exist / extend as needed):

- `get_pool_segment(project_dir, seg_id)`
- `get_audio_clip(project_dir, clip_id)`
- `get_transition(project_dir, tr_id)`
- `get_active_auth_context()` — returns `{username, org, api_key_id}` from current request (set by middleware from task-126)

**Plugin-specific helpers** (for `generate_music` plugin only, live in its module, NOT in `plugin_api`):

- `create_generation(**params) -> generation_id` — INSERT into `generate_music__generations`
- `update_generation_status(generation_id, status, error=None)`
- `add_generation_track(generation_id, pool_segment_id, musicful_task_id, song_title, duration_seconds, cover_url)`
- `get_generations_for_entity(entity_type, entity_id)`

### 5. Trust boundary: plugin_id validation

Every `record_spend` call MUST verify the caller is the claimed plugin. Implementation sketch:

```python
# At plugin activation, host registers the module's canonical plugin_id.
# record_spend() checks the calling frame's module against that registration.
# If mismatch → raise PluginIdentityError.
```

See spec test `no-cross-plugin-ledger-writes`.

### 6. Static test for R9a

Add a one-shot test (can be a simple Python test or bash grep) verifying:

- `plugin_api` module does NOT export any name containing `conn`, `connection`, `get_connection`, `db`, `cursor`, `execute`, `session`
- `scenecraft/src/scenecraft/plugins/generate_music/*.py` does NOT import `scenecraft.db` directly (only `scenecraft.plugin_api`)

See spec test `plugin-api-exposes-no-raw-db-handle`.

### 7. Unit tests

- Schema applies cleanly on fresh `server.db` + `project.db`
- Schema applies cleanly on a pre-existing DB with M11/M13 state
- `record_spend` enforces plugin_id match
- `add_pool_segment` writes all columns including `context_entity_*`, `variant_kind`, `generation_params`
- Helpers round-trip every column
- `get_active_auth_context` returns `{username, org, api_key_id}` set by middleware; raises if called without an active request context

---

## Verification

- [ ] All four new tables present after schema init
- [ ] `pool_segments.context_entity_type` + `context_entity_id` columns present
- [ ] `plugin_api` exports only enumerated helpers (R9a structural test passes)
- [ ] `record_spend` rejects cross-plugin attribution attempts
- [ ] `plugins/generate_music/` does not import `scenecraft.db` directly
- [ ] Round-trip unit tests for all helpers pass
- [ ] Migrations idempotent (second `_ensure_schema` call is a no-op)

---

## Notes

- DDL is DDL — copy from the spec verbatim; the spec is the source of truth. Don't add columns not in the spec without a spec update.
- `generation_params` on `pool_segments` might already exist from earlier work. Check; if missing, add `ALTER TABLE pool_segments ADD COLUMN generation_params TEXT`.
- The M17 plugin-schema-and-lifecycle spike will later move this into a plugin-authored migration. For M16, all DDL ships via core `_ensure_schema` — we pre-name to the `__` convention so the future migration runner's prefix-enforcer accepts our tables unchanged.
