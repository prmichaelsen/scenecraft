# Task 135: Migration Contribution Point

**Milestone**: [M17 - Track Contribution Point and Light Show Plugin](../../milestones/milestone-17-track-contribution-point-and-light-show-plugin.md)
**Design Reference**: [local.track-contribution-point-and-light-show-plugin.md § Part 3](../../design/local.track-contribution-point-and-light-show-plugin.md)
**Estimated Time**: 4 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Add a `register_migration` primitive to the Python plugin system. Plugins declare versioned `up`/`down` migrations (SQL or Python); the host runs pending migrations at plugin activate, tracked in a `schema_migrations` meta table.

---

## Context

Today, plugin-owned tables (`generate_music__*`, `isolate_vocals__*`) are declared directly in core `db.py` — a scaffolding compromise explicitly noted in `plugin_api.py`. M17 introduces `light_show` which needs 9 plugin-owned tables plus seed data. Inlining all that in core `db.py` would keep accumulating debt. A real migration primitive solves the problem once.

Core-invariant R9a (no raw DB access from plugins) still applies; migrations get a cursor scoped to the project DB, but plugins cannot use it to mutate core schema beyond their declared migrations.

---

## Steps

### 1. Add `schema_migrations` meta table to `db.py`

In `scenecraft-engine/src/scenecraft/db.py` `_ensure_schema`, add:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  plugin_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plugin_id, version)
);
```

### 2. Add `register_migration` to `plugin_host.py`

Add a dataclass `MigrationDef` and a class-level `_migrations: dict[str, list[MigrationDef]]` keyed by `plugin_id`.

```python
@dataclass
class MigrationDef:
    plugin_id: str
    version: int
    up: str | list[str] | Callable[[sqlite3.Cursor], None]
    down: str | list[str] | Callable[[sqlite3.Cursor], None]
```

`PluginHost.register_migration(plugin_id, version, up, down, context)`:
- Validate version is positive int, unique per plugin_id in the registry
- Append to `_migrations[plugin_id]`, sorted by version
- Return a `Disposable` that removes the entry; push onto `context.subscriptions` if provided

### 3. Migration runner in `PluginHost.register`

After a plugin module's `activate()` returns, call `_apply_pending_migrations(plugin_id, cursor)`:
- Query `schema_migrations` for applied versions under `plugin_id`
- Derive plugin's declared max version from `_migrations[plugin_id]`
- If declared max > max applied: run pending `up` in ascending version order, each in a savepoint; record in `schema_migrations`
- If declared max < max applied: run pending `down` in descending order; remove from `schema_migrations`
- Raise on any migration exception; do NOT leave partial state

### 4. Expose via `plugin_api.py`

Re-export `register_migration`:

```python
def register_migration(
    *,
    plugin_id: str,
    version: int,
    up: str | list[str] | Callable,
    down: str | list[str] | Callable,
    context: PluginContext | None = None,
) -> Disposable:
    from scenecraft.plugin_host import PluginHost
    return PluginHost.register_migration(plugin_id, version, up, down, context)
```

Add `"register_migration"` to `__all__`.

### 5. Migration execution helpers

Private helper in `plugin_host.py`:

```python
def _run_migration_stmt(cursor, stmt):
    if isinstance(stmt, str):
        cursor.executescript(stmt)
    elif isinstance(stmt, list):
        for s in stmt:
            cursor.executescript(s)
    elif callable(stmt):
        stmt(cursor)
    else:
        raise TypeError(f"migration stmt must be str, list[str], or callable; got {type(stmt)}")
```

### 6. Add tests

`scenecraft-engine/tests/test_plugin_migrations.py`:
- Register a migration, apply up, assert `schema_migrations` has the row, assert DB state is as expected
- Register a second version, apply up, both present
- Deregister v2 (simulate plugin downgrade), assert v2 down ran and row removed
- SQL string form, list-of-SQL form, callable form — each tested
- Duplicate version per plugin rejected
- Exception in middle of up migration → entire chain rolls back; `schema_migrations` unchanged

---

## Verification

- [ ] `register_migration` appears in `plugin_host.py` and `plugin_api.py` `__all__`
- [ ] `schema_migrations` meta table created on project DB bootstrap
- [ ] Pending up migrations apply in ascending order at plugin activate
- [ ] Pending down migrations apply in descending order when plugin version drops
- [ ] All three migration content types (str, list[str], callable) work
- [ ] Idempotent: re-activating a plugin without version change applies no migrations
- [ ] Transactional: exception mid-chain rolls back, `schema_migrations` unchanged
- [ ] Unit tests pass; no regressions in existing plugin_host tests

---

## Key Design Decisions

### Migration shape

| Decision | Choice | Rationale |
|---|---|---|
| `up` and `down` required | Yes | Enables plugin downgrade; no one-way trips |
| Content types | SQL string / list of SQL / Python callable | Declarative dominant; callable for data reshaping |
| Tracking | `schema_migrations` meta table keyed `(plugin_id, version)` | Per-plugin, idempotent |
| Runtime | At plugin activate, before any REST/MCP registrations take effect | Ensures schema is ready when endpoints start handling requests |

---

## Notes

- The migration cursor is scoped to the project DB. Core table writes from plugin migrations are NOT allowlisted — if a plugin's migration tries to `ALTER` core `tracks`, it still violates R9a. Enforcement is social (code review) at M17; a harder boundary (e.g., migration cursor that blocks writes to `tracks`/`audio_tracks`/etc.) is future work.
- `generate_music` / `isolate_vocals` adoption of this primitive (moving their tables out of core `db.py`) is post-M17 cleanup.
- No YAML involvement. Migrations are declared imperatively in `activate()`, not in `plugin.yaml`.

---

**Next Task**: [task-136-tracks-schema-unification.md](./task-136-tracks-schema-unification.md)
**Related Design Docs**: [local.track-contribution-point-and-light-show-plugin.md](../../design/local.track-contribution-point-and-light-show-plugin.md)
