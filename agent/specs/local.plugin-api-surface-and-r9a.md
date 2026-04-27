# Spec: plugin_api Surface and R9a Invariant

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive — documents existing implementation)

---

## Purpose

Define the exact observable behavior of the `scenecraft.plugin_api` facade: what is exported, what is explicitly NOT exported, how the R9a invariant ("plugins never touch raw DB") is (and is NOT) enforced, and what happens when a plugin deviates from the allowlist. This spec is retroactive — it encodes what the code **actually does** as of 2026-04-27, not what it should do.

## Source

- **Mode**: `--from-draft` (derived from audit-2 §1A + §2 + §3)
- **Primary code**: `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/plugin_api/__init__.py` (485 lines)
- **Reference**: `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/plugin_api/providers/__init__.py`, `providers/replicate.py` (scope: "providers namespace exists" only — `replicate.py` is its own spec target)
- **Audit**: `/home/prmichaelsen/.acp/projects/scenecraft/agent/reports/audit-2-architectural-deep-dive.md`

---

## Scope

**In-scope**:
- The `scenecraft.plugin_api` module: its `__all__`, its re-exports, its own helpers (`broadcast_event`, `extract_audio_as_wav`, `record_spend`, `call_service`, `register_rest_endpoint`).
- The R9a invariant: "plugins never touch raw DB" — what enforces it, what does not, what happens when violated.
- The `<plugin_id>__<table>` sidecar table naming convention.
- The `providers` subpackage boundary (as an exported namespace only — not the replicate implementation).

**Out-of-scope**:
- `plugin_api.providers.replicate` internals (separate spec: `local.replicate-provider`).
- `PluginHost` lifecycle, manifest parsing, operation/MCP-tool/REST registration mechanics (separate spec: `local.plugin-host-and-manifest`).
- The SQL schema of individual core tables and sidecar tables (separate spec: `local.pool-segments-and-variant-kind` etc.).
- The Musicful / OpenAI / ElevenLabs provider expansions (SERVICE_REGISTRY additions) — those land when the providers do.

---

## Requirements

1. **R1 (allowlist surface)**: `scenecraft.plugin_api.__all__` is the authoritative list of names plugins may consume from the facade. Any identifier not in `__all__` is off-surface.
2. **R2 (no raw DB in surface)**: The module MUST NOT re-export any raw DB connection, cursor, or `get_db` callable. Only named DAL functions appear in `__all__`.
3. **R3 (R9a enforcement mechanism)**: The R9a invariant ("plugins never touch raw DB") is enforced by **convention only** — via `__all__` curation and by reviewer discipline. There is no import hook, no runtime allowlist check, no sys.modules audit, no process-boundary sandbox.
4. **R4 (direct import bypass succeeds)**: A plugin that writes `from scenecraft.db import get_db` (or any other scenecraft internal) is not blocked by the Python runtime. The import resolves and the plugin can execute arbitrary DB operations.
5. **R5 (pool DAL re-exports)**: The following pool-related DAL functions are re-exported: `add_pool_segment`, `get_pool_segment`, `set_pool_segment_context`.
6. **R6 (audio DAL re-exports)**: `get_audio_clips`, `add_audio_candidate`, `assign_audio_candidate`, `get_audio_clip_effective_path` are re-exported.
7. **R7 (music-generation DAL re-exports)**: `add_music_generation`, `update_music_generation_status`, `add_generation_track`, `get_music_generation`, `get_music_generations_for_entity`, `get_music_generation_tracks` are re-exported (M16).
8. **R8 (foley DAL re-exports)**: `add_foley_generation`, `update_foley_generation_status`, `add_foley_track`, `get_foley_generation`, `get_foley_generations_for_entity`, `get_foley_generation_tracks` are re-exported (M18).
9. **R9 (isolation DAL re-exports)**: `add_audio_isolation`, `update_audio_isolation_status`, `add_isolation_stem`, `get_isolations_for_entity`, `get_isolation_stems` are re-exported.
10. **R10 (light_show DAL re-exports)**: `list_light_show_fixtures`, `upsert_light_show_fixtures`, `reset_light_show_fixtures`, `remove_light_show_fixtures`, `list_light_show_overrides`, `set_light_show_overrides`, `clear_light_show_overrides`, `list_light_show_screens`, `upsert_light_show_screens`, `remove_light_show_screens`, `reset_light_show_screens`, `list_light_show_scenes`, `upsert_light_show_scenes`, `remove_light_show_scenes`, `list_light_show_placements`, `upsert_light_show_placements`, `remove_light_show_placements`, `get_light_show_live_override`, `activate_light_show_live_override`, `deactivate_light_show_live_override`, plus exceptions `BlockedByLiveError`, `BlockedByPlacementsError` are re-exported (M17, M19).
11. **R11 (transcribe DAL)**: Transcribe DAL functions (`add_transcription_run`, `get_transcription`, `list_transcriptions`, etc.) are re-exported from `plugin_api.__init__` per R42. The transcribe plugin accesses its sidecar tables (`transcribe__runs`, `transcribe__segments`) exclusively through these re-exports.
12. **R12 (shared candidate helper)**: `add_tr_candidate` is re-exported so both music and foley (and future transition-candidate-producing plugins) can share the tr-candidate junction.
13. **R13 (undo helper)**: `undo_begin` is re-exported.
14. **R14 (jobs)**: `job_manager` (the singleton from `scenecraft.ws_server`) is re-exported so plugins can `create_job` / `update_progress` / `complete_job` / `fail_job`.
15. **R15 (spend ledger)**: `record_spend` and `list_spend` are exposed. `record_spend` is the **ONLY** supported write path to `server.db.spend_ledger` per R9/R9a. `list_spend` is read-only. `find_root` is imported for internal use by `record_spend` but is **not** in `__all__`.
16. **R16 (spend attribution — stack-derived + idempotent)**: `record_spend` derives `plugin_id` from the caller's stack frame (matching `scenecraft.plugins.<id>`), NOT from a caller-supplied argument. The function is idempotent on `(plugin_id, source_external_id)`. See R41 for the full contract.
17. **R17 (spend unit-agnostic)**: `record_spend.amount` is an integer in the smallest atomic unit of `unit` (`credit` / `usd_micro` / `token` / `character` / `second`). Negative values represent refunds. No automatic unit conversion.
18. **R18 (spend auth placeholder)**: `record_spend` defaults `username=""`, `org=""`, `api_key_id=None` when not provided. Foreign-key enforcement against `users` / `orgs` / `api_keys` is NOT done at this layer (deferred to the auth milestone).
19. **R19 (spend requires root)**: `record_spend` calls `find_root()`; if no scenecraft root is discovered (no `SCENECRAFT_ROOT` env var and not inside a provisioned box), it raises `RuntimeError`.
20. **R20 (WS broadcast)**: `broadcast_event(plugin_id, event_type, project_name=None, payload=None)` emits a message with `type = f"{plugin_id}__{event_type}"`. The double-underscore namespacing mirrors the MCP-tool and sidecar-table conventions.
21. **R21 (WS broadcast routing)**: If env var `SCENECRAFT_REMOTE_BROADCAST_URL` is set, `broadcast_event` POSTs the message to `{url}/api/_internal/broadcast` (2.0s timeout) instead of calling `job_manager._broadcast` directly. When unset, it calls `job_manager._broadcast` in-process.
22. **R22 (WS broadcast best-effort)**: Both the remote-POST path and the in-process-broadcast path catch all exceptions and silently drop. `broadcast_event` MUST NEVER raise; a failed broadcast never fails the enclosing mutation.
23. **R23 (WS broadcast payload merge)**: When `payload` is provided, its keys are merged into the top-level message dict via `msg.update(payload)`. Plugin-supplied `type` or `projectName` keys in `payload` overwrite the built-in fields (last-writer-wins).
24. **R24 (REST registration)**: `register_rest_endpoint(path_regex, handler, *, method="POST", context=None)` installs the handler into `PluginHost._rest_routes_by_method[method.upper()][path_regex]` and returns a `Disposable`. When `context` is a `PluginContext`, the Disposable auto-appends to `context.subscriptions` for LIFO cleanup on deactivation.
25. **R25 (REST handler signature)**: For `POST`, the host passes `(project_dir, project_name, body)`; for `GET`, `(project_dir, project_name, query_dict)`. Other methods' calling conventions are not documented in `plugin_api`.
26. **R26 (REST disposal idempotency)**: The returned Disposable's `_dispose` checks `routes.get(path_regex) is handler` before deletion — if the slot was reused by another handler, dispose is a no-op.
27. **R27 (Disposable factory)**: `make_disposable(callable)` is re-exported from `scenecraft.plugin_host` for plugin teardown needs outside the `register_rest_endpoint` path.
28. **R28 (providers namespace)**: The `providers` submodule is importable as `plugin_api.providers` and exposed in `__all__`. It currently contains only `providers.replicate`.
29. **R29 (ffmpeg transcode)**: `extract_audio_as_wav(source_path, out_path, sample_rate=48000)` runs `ffmpeg -y -i <src> -ac 1 -ar <sr> <dst>` with a 60-second timeout. Raises `subprocess.CalledProcessError` on non-zero exit; `subprocess.TimeoutExpired` on timeout. Always mono, always PCM WAV.
30. **R30 (`call_service` legacy)**: `call_service(service, method, path, body, headers, query, timeout_seconds=30.0)` routes BYO HTTP through a registry. `SERVICE_REGISTRY` currently lists `"musicful"` only. Unknown services raise `ServiceConfigError`. This shim is **being superseded** by the typed `providers` namespace for Replicate-backed plugins; Musicful stays on `call_service` until it migrates.
31. **R31 (`call_service` BYO)**: If the `env_var` (e.g. `MUSICFUL_API_KEY`) is unset, `call_service` raises `ServiceConfigError`. Brokered mode (routing through scenecraft.online) is stubbed.
32. **R32 (`call_service` HTTP client fallback)**: Prefers `httpx` when importable; falls back to `urllib.request` when not. Feature parity is partial in the urllib fallback (stripped-down; see lines 410–450). Both paths raise `ServiceError(status, body)` on HTTP ≥ 400 and `ServiceTimeoutError` on timeout.
33. **R33 (`call_service` secret safety)**: The API key is read from env, added as a request header, and never written to the response `ServiceResponse` or `ServiceError`. Response body is parsed as JSON when `content-type` contains `application/json`, else returned as raw bytes.
34. **R34 (sidecar naming convention)**: Plugin-owned tables follow the `<plugin_id>__<table>` double-underscore prefix pattern (e.g. `generate_music__generations`, `light_show__fixtures`). This convention is documented and followed by every shipped plugin.
35. **R35 (sidecar naming unenforced)**: There is NO SQL `CHECK` constraint, no migration-time validator, and no runtime guard preventing a plugin (with raw DB access) from creating a table with a non-prefixed name or a name claiming another plugin's prefix.
36. **R36 (core table write via raw DB: undefined outcome)**: If a plugin obtains a raw DB handle and writes to a core table (e.g. `keyframes`, `transitions`, `pool_segments`), the Python runtime does not block it and there is no audit log or alarm. The scenecraft codebase assumes this does not happen. See **OQ-1**.
37. **R37 (spend_ledger attribution trust: undefined)**: Any in-process caller can invoke `record_spend(plugin_id="other_plugin", ...)` and the ledger records that attribution. There is no trust check. See **OQ-2**.
38. **R38 (no dynamic enforcement plan in surface)**: `plugin_api` does not implement, expose, or reference an import hook, audit log, or sandbox. The line-289 comment acknowledges "M17 adds a process-boundary check" as future work — the surface itself is silent on how future enforcement would be introduced.
39. **R39 (module import side effects)**: Importing `scenecraft.plugin_api` triggers: (a) a DAL re-export batch from `scenecraft.db`, (b) import of `scenecraft.ws_server.job_manager`, (c) import of `scenecraft.vcs.bootstrap` (for `record_spend`, `list_spend`, `find_root`), (d) import of the `providers` subpackage (which in turn imports `providers.replicate`). Any import-time failure in these chains raises at `plugin_api` import time.
40. **R40 (R9a CI enforcement)**: R9a is enforced by CI grep, not runtime. CI greps `src/scenecraft/plugins/*/` for `from scenecraft.db` and `import scenecraft.db` and fails the build on any hit. Today's allowlist: `generate_foley/generate_foley.py::_set_derived_from` (temporary, to be cleaned up post-spec). Wording: "plugins MUST NOT access `scenecraft.db` directly. Violation is detected by CI, not runtime."
41. **R41 (record_spend stack-frame-derived plugin_id + idempotent)**: `record_spend` derives `plugin_id` from the caller's module via stack inspection (matching `scenecraft.plugins.<id>`); raises `RuntimeError` if caller is not a plugin. The function is idempotent on `(plugin_id, source_external_id)` — if a row with that pair already exists, return the existing ledger entry id without inserting. Replicate always passes `prediction_id` as `source_external_id`, making `attach_polling` on a terminal prediction naturally safe. Replaces the earlier "TODO(M17)" in R16.
42. **R42 (transcribe DAL re-exports)**: `plugin_api.__all__` includes transcribe DAL functions: `add_transcription_run`, `get_transcription`, `list_transcriptions`, and siblings matching the music/foley/isolation pattern. Transcribe plugin accesses its sidecar tables through these re-exports — NOT raw DB.

---

## Interfaces / Data Shapes

### Exported names (`__all__`, 67 entries)

Grouped by category (names inside `__all__` verbatim):

**Providers namespace**: `providers`

**Pool DAL**: `add_pool_segment`, `get_pool_segment`, `set_pool_segment_context`

**Audio DAL**: `get_audio_clips`, `add_audio_candidate`, `assign_audio_candidate`, `get_audio_clip_effective_path`

**Music DAL (M16)**: `add_music_generation`, `update_music_generation_status`, `add_generation_track`, `get_music_generation`, `get_music_generations_for_entity`, `get_music_generation_tracks`

**Foley DAL (M18)**: `add_foley_generation`, `update_foley_generation_status`, `add_foley_track`, `get_foley_generation`, `get_foley_generations_for_entity`, `get_foley_generation_tracks`

**Isolation DAL**: `add_audio_isolation`, `update_audio_isolation_status`, `add_isolation_stem`, `get_isolations_for_entity`, `get_isolation_stems`

**Light-show DAL (M17/M19)**: `list_light_show_fixtures`, `upsert_light_show_fixtures`, `reset_light_show_fixtures`, `remove_light_show_fixtures`, `list_light_show_overrides`, `set_light_show_overrides`, `clear_light_show_overrides`, `list_light_show_screens`, `upsert_light_show_screens`, `remove_light_show_screens`, `reset_light_show_screens`, `list_light_show_scenes`, `upsert_light_show_scenes`, `remove_light_show_scenes`, `list_light_show_placements`, `upsert_light_show_placements`, `remove_light_show_placements`, `get_light_show_live_override`, `activate_light_show_live_override`, `deactivate_light_show_live_override`, `BlockedByLiveError`, `BlockedByPlacementsError`

**Transition-candidate helper**: `add_tr_candidate`

**Misc DAL**: `undo_begin`

**Jobs**: `job_manager`

**Spend**: `record_spend`, `list_spend`

**WS broadcast**: `broadcast_event`

**REST**: `register_rest_endpoint`

**Disposable factory**: `make_disposable`

**External-service shim (legacy)**: `call_service`, `ServiceResponse`, `ServiceError`, `ServiceConfigError`, `ServiceTimeoutError`

**Transcode helper**: `extract_audio_as_wav`

### Explicitly NOT exported

- `get_db` / raw SQLite connections / cursors
- `find_root` (imported internally by `record_spend`, never in `__all__`)
- `_record_spend_raw` (private alias of `scenecraft.vcs.bootstrap.record_spend`)
- Any schema-migration helper
- Any `PluginHost` class or method beyond `make_disposable`
- Transcribe plugin DAL (not re-exported here — see OQ-3)

### Signatures (plugin-owned helpers)

```python
def broadcast_event(
    plugin_id: str,
    event_type: str,
    *,
    project_name: str | None = None,
    payload: dict | None = None,
) -> None

def extract_audio_as_wav(
    source_path: Path,
    out_path: Path,
    sample_rate: int = 48000,
) -> Path

def record_spend(
    *,
    plugin_id: str,
    amount: int,
    unit: str,
    operation: str,
    username: str = "",
    org: str = "",
    api_key_id: str | None = None,
    job_ref: str | None = None,
    metadata: dict | None = None,
    source: str = "local",
) -> str  # returns ledger entry id

def call_service(
    *,
    service: str,
    method: str,
    path: str,
    body: dict | None = None,
    headers: dict | None = None,
    query: dict | None = None,
    timeout_seconds: float = 30.0,
) -> ServiceResponse

def register_rest_endpoint(
    path_regex: str,
    handler,
    *,
    method: str = "POST",
    context=None,
) -> Disposable
```

### `SERVICE_REGISTRY`

```python
SERVICE_REGISTRY: dict[str, tuple[str, str, str]] = {
    "musicful": ("https://api.musicful.ai", "MUSICFUL_API_KEY", "x-api-key"),
}
```

Tuple shape: `(base_url, env_var, auth_header_name)`.

### WS broadcast message shape

```json
{
  "type": "<plugin_id>__<event_type>",
  "projectName": "<optional>",
  "...": "...payload keys..."
}
```

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | Plugin imports `add_pool_segment` from `plugin_api` | Import succeeds; callable is identical to `scenecraft.db.add_pool_segment` | `reexport-add-pool-segment-matches-dal` |
| 2 | Plugin reads `plugin_api.__all__` | Returns the documented 67-entry allowlist | `all-list-matches-documented-surface` |
| 3 | Plugin imports a name not in `__all__` (e.g. `find_root`) | Import succeeds (Python does not enforce `__all__`); name is still off-surface by convention | `non-all-name-still-importable` |
| 4 | Plugin does `from scenecraft.db import get_db` | Import succeeds; no runtime block; plugin obtains raw handle | `raw-db-import-not-blocked` |
| 5 | Plugin writes to a core table (e.g. `keyframes`) via raw handle | Blocked at CI grep, not runtime; build fails on `from scenecraft.db` imports | `ci-grep-blocks-raw-db-imports` (covers R40, OQ-1) |
| 6 | Plugin creates a new table named `bad_name` (no prefix) via raw DDL | Blocked by R40 CI grep (raw DB access required to issue DDL) | `ci-grep-blocks-raw-db-imports` (covers R40, OQ-1) |
| 7 | Plugin creates a table `other_plugin__evil` claiming another plugin's prefix | Blocked by R40 CI grep (raw DB required) | `ci-grep-blocks-raw-db-imports` (covers R40, OQ-1) |
| 8 | Plugin A attempts to spend as plugin B by passing `plugin_id="plugin_b"` | Ignored; `record_spend` derives `plugin_id` from caller's stack frame | `record-spend-plugin-id-derived-from-stack` (covers R41, OQ-2) |
| 9 | `record_spend` called outside a scenecraft root | Raises `RuntimeError` with message referencing `SCENECRAFT_ROOT` | `record-spend-no-root-raises` |
| 10 | `record_spend` called with negative amount | Recorded as-is (refund semantics) | `record-spend-negative-amount-allowed` |
| 11 | `broadcast_event(plugin_id, event_type)` with no env var | Calls `job_manager._broadcast(msg)` in-process with `type = "plugin_id__event_type"` | `broadcast-in-process-default` |
| 12 | `broadcast_event` with `SCENECRAFT_REMOTE_BROADCAST_URL` set | POSTs to `{url}/api/_internal/broadcast` with 2.0s timeout; does not call `job_manager` | `broadcast-remote-url-posts-http` |
| 13 | `broadcast_event` when WS infra is down / URL unreachable | Returns `None` silently; does NOT raise | `broadcast-failure-is-silent` |
| 14 | `broadcast_event(payload={"type": "override"})` | Plugin payload's `type` key overwrites built-in `type`; last-writer-wins | `broadcast-payload-overrides-builtin-keys` |
| 15 | `extract_audio_as_wav` on a valid input | Writes mono PCM WAV at requested sample rate; returns `out_path` | `extract-audio-happy-path` |
| 16 | `extract_audio_as_wav` when ffmpeg fails | Raises `subprocess.CalledProcessError` | `extract-audio-ffmpeg-error` |
| 17 | `extract_audio_as_wav` when transcoding exceeds 60s | Raises `subprocess.TimeoutExpired` | `extract-audio-timeout` |
| 18 | `call_service(service="musicful", ...)` with `MUSICFUL_API_KEY` set | Issues HTTP call with `x-api-key` header; returns `ServiceResponse` on 2xx | `call-service-byo-success` |
| 19 | `call_service` with unregistered service name | Raises `ServiceConfigError("Unknown service ...")` | `call-service-unknown-service` |
| 20 | `call_service` when required env var is unset | Raises `ServiceConfigError("<VAR> not set...")` | `call-service-missing-env-var` |
| 21 | `call_service` receives HTTP 5xx | Raises `ServiceError(status, body)` | `call-service-http-error` |
| 22 | `call_service` times out | Raises `ServiceTimeoutError` | `call-service-timeout` |
| 23 | `call_service` when `httpx` is not importable | Falls back to `urllib.request`; same exception contract | `call-service-urllib-fallback` |
| 24 | `call_service` on a JSON response | `ServiceResponse.body` is the parsed dict | `call-service-json-parsed` |
| 25 | `call_service` on a non-JSON response | `ServiceResponse.body` is raw bytes | `call-service-non-json-raw` |
| 26 | `register_rest_endpoint(path, handler)` with no context | Installs in `PluginHost._rest_routes_by_method["POST"][path]`; returns Disposable | `register-rest-default-post` |
| 27 | `register_rest_endpoint(..., method="GET", context=ctx)` | Installs in `"GET"` bucket; appends Disposable to `ctx.subscriptions` | `register-rest-get-with-context` |
| 28 | Disposable from `register_rest_endpoint` disposed twice | Second dispose is a no-op (slot check) | `register-rest-dispose-idempotent` |
| 29 | Disposable's slot was replaced by another handler before dispose | Dispose leaves the replacement intact | `register-rest-dispose-slot-reused-no-op` |
| 30 | `plugin_api.providers.replicate` import | Resolves; exposes the typed Replicate surface (scope: existence only here) | `providers-namespace-exposed` |
| 31 | Importing `scenecraft.plugin_api` | Triggers DAL + `ws_server` + `vcs.bootstrap` + `providers` subpackage imports | `import-side-effects` |
| 32 | `from scenecraft.plugin_api import *` used from a plugin | Binds exactly the names in `__all__` | `star-import-bounds-match-all` |
| 33 | Plugin's handler passed to `register_rest_endpoint` raises | `plugin_api` does not catch it; behavior depends on `PluginHost.dispatch_rest` (out of scope here) | `—` |
| 34 | Plugin accesses `plugin_api.find_root` | Succeeds at the Python level (symbol exists in module); off-surface per convention | `find-root-not-in-all-but-attribute-exists` |
| 35 | Plugin consumes transcribe DAL from `plugin_api` | Transcribe DAL names are in `__all__` and re-exported from `scenecraft.db` | `transcribe-dal-reexports-match-surface` (covers R42, OQ-3) |
| 36 | Future plugin creates sidecar table with correct prefix | Convention honored; no enforcement, no registration step | `sidecar-prefix-convention-documented` |
| 37 | `record_spend` called concurrently from two threads | Accepted-undefined per INV-1 (single-writer per user/project) | `no-internal-lock-on-record-spend` (covers OQ-4, INV-1) |
| 38 | `broadcast_event` called with `project_name=None` | `projectName` key is omitted from the message | `broadcast-project-name-omitted-when-none` |
| 39 | `record_spend` call does NOT log the amount/metadata at INFO level | `undefined` — logging behavior not specified in surface | → [OQ-5](#open-questions) |
| 40 | `call_service` call does NOT include the raw API key in `ServiceResponse.headers` | API key appears only in the outbound request headers; never in the response object returned to caller | `call-service-never-leaks-api-key` |

---

## Behavior

### Module load

1. Python imports `scenecraft.plugin_api`.
2. Line 23: re-export batch from `scenecraft.db`. Any DAL change in `db.py` propagates automatically on next import.
3. Line 80: `job_manager` bound from `scenecraft.ws_server`.
4. Line 83–87: `_record_spend_raw`, `list_spend`, `find_root` bound from `scenecraft.vcs.bootstrap`. Only `list_spend` and the wrapper `record_spend` land in `__all__`.
5. Line 95: `from scenecraft.plugin_api import providers` — eagerly imports the providers subpackage (which itself imports `providers.replicate`).
6. Line 169: `make_disposable` imported from `scenecraft.plugin_host`.
7. Module ready.

### `record_spend` (lines 259–309)

1. Validate root via `find_root()`. No root → `RuntimeError`.
2. **No trust-boundary check on `plugin_id`** — the TODO at line 290 acknowledges this; a stack-frame check was considered and rejected as fragile.
3. Delegate to `_record_spend_raw` (the bootstrap implementation) with all fields forwarded verbatim.
4. Return the ledger entry id.

### `broadcast_event` (lines 172–224)

1. Build `msg = {"type": f"{plugin_id}__{event_type}"}`.
2. If `project_name`: add `projectName`.
3. If `payload`: `msg.update(payload)` — payload keys can overwrite built-ins.
4. If env `SCENECRAFT_REMOTE_BROADCAST_URL` set: POST JSON to `{url}/api/_internal/broadcast` (2.0s timeout); swallow all exceptions; return.
5. Else: `job_manager._broadcast(msg)`; swallow all exceptions; return.

### `register_rest_endpoint` (lines 453–484)

1. `method_upper = method.upper()`.
2. Insert into `PluginHost._rest_routes_by_method[method_upper][path_regex] = handler`.
3. Build `_dispose` closure that deletes the slot ONLY if it still holds `handler`.
4. Wrap in `make_disposable(_dispose)`.
5. If `context` supplied: append Disposable to `context.subscriptions`.
6. Return the Disposable.

### `call_service` (lines 348–450)

1. Try to import `httpx`; on `ImportError` delegate to `_call_service_urllib` and return its result.
2. Lookup `service` in `SERVICE_REGISTRY` → `ServiceConfigError` if absent.
3. Read env var; empty → `ServiceConfigError`.
4. Build URL = `base_url + path`; merge `{auth_header: key, **headers}`.
5. `httpx.request(method, url, json=body, headers=..., params=query, timeout=...)`.
6. On `httpx.TimeoutException` → `ServiceTimeoutError`.
7. Parse body: JSON when `content-type` contains `application/json`, else raw bytes.
8. Status ≥ 400 → `ServiceError(status, parsed)`.
9. Else return `ServiceResponse(status, dict(headers), parsed)`.

### `extract_audio_as_wav` (lines 227–256)

1. `subprocess.run(["ffmpeg", "-y", "-i", src, "-ac", "1", "-ar", str(sr), dst], capture_output=True, check=True, timeout=60)`.
2. `check=True` → `CalledProcessError` on non-zero exit.
3. `timeout=60` → `TimeoutExpired` on overrun.
4. Return `out_path`.

### R9a invariant enforcement (the whole point)

**What enforces R9a**:
- `plugin_api.__all__` as a curated list.
- Module docstring: *"Per spec R9a (core-invariant): this module MUST NOT export any raw DB connection or cursor."*
- Reviewer discipline during PR review.

**What does NOT enforce R9a**:
- No `sys.meta_path` hook or import guard.
- No `__init_subclass__` / metaclass trick.
- No `audit` event (`sys.addaudithook`) listening for `sqlite3.connect` from plugin modules.
- No process boundary (plugins run in the engine process).
- No SQL-level CHECK on table names or column writes.
- No capability-object pattern (plugins receive raw module callables, not capability handles).

A plugin can, at any time, import `scenecraft.db` directly and perform arbitrary operations on the project SQLite. The only defense is code review.

---

## Acceptance Criteria

- [ ] Every name in `__all__` is reachable via `from scenecraft.plugin_api import <name>` without side-effectful failure.
- [ ] `get_db` is not in `__all__` and is not bound as a module attribute of `plugin_api`.
- [ ] `find_root` is bound as a module attribute (used internally) but NOT in `__all__`.
- [ ] `record_spend` without a scenecraft root raises `RuntimeError`.
- [ ] `broadcast_event` never raises under any failure mode (network error, JSON error, missing `job_manager`).
- [ ] `broadcast_event` routes to HTTP when `SCENECRAFT_REMOTE_BROADCAST_URL` is set; routes in-process otherwise.
- [ ] `call_service` raises `ServiceConfigError` for unknown service names and for missing env vars; never leaks the API key into returned objects.
- [ ] `extract_audio_as_wav` produces mono WAV at the requested sample rate via ffmpeg; respects the 60s timeout.
- [ ] `register_rest_endpoint` installs into the correct method bucket, returns a Disposable, and the Disposable is idempotent on repeated dispose.
- [ ] `plugin_api.providers.replicate` is importable (existence check only in this spec).
- [ ] R9a is documented in the module docstring; no runtime check exists — this is the intended M16/M17 state.
- [ ] `undefined` behaviors (OQ-1 through OQ-5) are not silently normalized into code — they remain open.

---

## Tests

### Base Cases

#### Test: reexport-add-pool-segment-matches-dal (covers R1, R5)

**Given**: `scenecraft.plugin_api` and `scenecraft.db` both import successfully.
**When**: the tester compares `scenecraft.plugin_api.add_pool_segment` to `scenecraft.db.add_pool_segment`.
**Then**:
- **identity**: the two references are the same object (re-export, not wrapper).
- **in-all**: the name appears in `scenecraft.plugin_api.__all__`.

#### Test: all-list-matches-documented-surface (covers R1, R2)

**Given**: `scenecraft.plugin_api` loaded.
**When**: read `__all__`.
**Then**:
- **no-raw-db**: no member of `__all__` is named `get_db`, `raw_db`, `db_connection`, or `sqlite_connection`.
- **expected-members**: `__all__` contains `providers`, `record_spend`, `list_spend`, `job_manager`, `broadcast_event`, `register_rest_endpoint`, `make_disposable`, `extract_audio_as_wav`, `call_service`, `ServiceResponse`, `ServiceError`, `ServiceConfigError`, `ServiceTimeoutError`, `add_pool_segment`, `get_pool_segment`, `set_pool_segment_context`, `add_audio_candidate`, `assign_audio_candidate`, `get_audio_clip_effective_path`, `get_audio_clips`, `add_audio_isolation`, `update_audio_isolation_status`, `add_isolation_stem`, `get_isolations_for_entity`, `get_isolation_stems`, `add_music_generation`, `update_music_generation_status`, `add_generation_track`, `get_music_generation`, `get_music_generations_for_entity`, `get_music_generation_tracks`, `add_foley_generation`, `update_foley_generation_status`, `add_foley_track`, `get_foley_generation`, `get_foley_generations_for_entity`, `get_foley_generation_tracks`, `add_tr_candidate`, `undo_begin`, all light_show DAL names per R10, and `BlockedByLiveError`, `BlockedByPlacementsError`.

#### Test: non-all-name-still-importable (covers R1, R3)

**Given**: Python's standard import system is in use.
**When**: `from scenecraft.plugin_api import find_root`.
**Then**:
- **succeeds**: no `ImportError`.
- **note**: the name exists as a module attribute (bound internally for `record_spend`) but is off-surface per convention.

#### Test: raw-db-import-not-blocked (covers R3, R4)

**Given**: a plugin module within the plugin_api surface convention.
**When**: the plugin executes `from scenecraft.db import get_db`.
**Then**:
- **import-succeeds**: no `ImportError`, `PermissionError`, or custom exception.
- **callable-obtained**: the resulting symbol is callable.
- **no-audit-log**: no log line is emitted warning about off-surface access (there is no import hook).

#### Test: record-spend-no-root-raises (covers R15, R19)

**Given**: no `SCENECRAFT_ROOT` env var and not inside a provisioned box (so `find_root()` returns `None`).
**When**: `record_spend(plugin_id="p", amount=1, unit="credit", operation="op")`.
**Then**:
- **runtime-error**: raises `RuntimeError`.
- **message-mentions-root**: error message contains the string `"scenecraft root"` or `"SCENECRAFT_ROOT"`.

#### Test: record-spend-negative-amount-allowed (covers R17)

**Given**: a valid scenecraft root.
**When**: `record_spend(plugin_id="p", amount=-5, unit="credit", operation="refund")`.
**Then**:
- **ledger-entry-created**: `_record_spend_raw` is invoked with `amount=-5`.
- **no-validation-error**: no exception raised at the `plugin_api` layer.

#### Test: broadcast-in-process-default (covers R20, R21)

**Given**: `SCENECRAFT_REMOTE_BROADCAST_URL` is unset.
**When**: `broadcast_event("lightshow", "fixture_patched", project_name="demo", payload={"n": 3})`.
**Then**:
- **type-namespaced**: the message passed to `job_manager._broadcast` has `type == "lightshow__fixture_patched"`.
- **project-included**: `projectName == "demo"`.
- **payload-merged**: `n == 3`.
- **no-http-call**: no outbound HTTP request is made.

#### Test: broadcast-remote-url-posts-http (covers R21)

**Given**: `SCENECRAFT_REMOTE_BROADCAST_URL = "https://engine.local"`.
**When**: `broadcast_event("p", "e")`.
**Then**:
- **post-issued**: a POST to `https://engine.local/api/_internal/broadcast` is attempted.
- **content-type-json**: request header `Content-Type: application/json`.
- **timeout-2s**: the urlopen call uses `timeout=2.0`.
- **job-manager-not-called**: `job_manager._broadcast` is NOT invoked.

#### Test: broadcast-failure-is-silent (covers R22)

**Given**: `SCENECRAFT_REMOTE_BROADCAST_URL` points to an unreachable host.
**When**: `broadcast_event("p", "e")`.
**Then**:
- **returns-none**: call returns `None`.
- **no-exception**: no exception propagates to the caller.

#### Test: broadcast-payload-overrides-builtin-keys (covers R23)

**Given**: `SCENECRAFT_REMOTE_BROADCAST_URL` unset.
**When**: `broadcast_event("p", "e", project_name="a", payload={"type": "hijacked", "projectName": "b"})`.
**Then**:
- **type-overwritten**: forwarded `msg["type"] == "hijacked"`.
- **project-overwritten**: forwarded `msg["projectName"] == "b"`.

#### Test: extract-audio-happy-path (covers R29)

**Given**: a valid input audio file readable by ffmpeg and a writable `out_path`.
**When**: `extract_audio_as_wav(src, dst, sample_rate=48000)`.
**Then**:
- **returns-out-path**: return value equals `dst`.
- **mono-wav**: resulting file is a mono PCM WAV at 48000 Hz.
- **ffmpeg-invoked**: `subprocess.run` was called with `["ffmpeg", "-y", "-i", str(src), "-ac", "1", "-ar", "48000", str(dst)]`.

#### Test: extract-audio-ffmpeg-error (covers R29)

**Given**: a malformed or missing source file.
**When**: `extract_audio_as_wav(src, dst)`.
**Then**:
- **raises-called-process-error**: raises `subprocess.CalledProcessError`.

#### Test: extract-audio-timeout (covers R29)

**Given**: a transcoding job that exceeds 60 seconds.
**When**: `extract_audio_as_wav(src, dst)`.
**Then**:
- **raises-timeout-expired**: raises `subprocess.TimeoutExpired`.

#### Test: call-service-byo-success (covers R30, R31)

**Given**: `MUSICFUL_API_KEY="k"`, a service stub returning HTTP 200 JSON.
**When**: `call_service(service="musicful", method="POST", path="/v1/generate", body={"prompt": "x"})`.
**Then**:
- **response-returned**: returns a `ServiceResponse`.
- **auth-header-set**: outbound request carried `x-api-key: k`.
- **body-parsed**: `response.body` is the parsed JSON dict.
- **status-echoed**: `response.status == 200`.

#### Test: call-service-unknown-service (covers R30)

**Given**: `SERVICE_REGISTRY` unchanged.
**When**: `call_service(service="nonexistent", method="GET", path="/")`.
**Then**:
- **config-error**: raises `ServiceConfigError`.
- **message-lists-registered**: error message includes the string `Unknown service`.

#### Test: call-service-missing-env-var (covers R31)

**Given**: `MUSICFUL_API_KEY` unset.
**When**: `call_service(service="musicful", method="GET", path="/")`.
**Then**:
- **config-error**: raises `ServiceConfigError`.
- **message-names-var**: error message contains `MUSICFUL_API_KEY`.

#### Test: call-service-http-error (covers R32)

**Given**: the remote returns HTTP 502.
**When**: `call_service(...)`.
**Then**:
- **service-error**: raises `ServiceError`.
- **status-preserved**: `ServiceError.status == 502`.
- **body-attached**: `ServiceError.body` is the parsed response body.

#### Test: call-service-timeout (covers R32)

**Given**: the remote does not respond within `timeout_seconds`.
**When**: `call_service(..., timeout_seconds=0.01)`.
**Then**:
- **timeout-error**: raises `ServiceTimeoutError`.

#### Test: register-rest-default-post (covers R24, R25)

**Given**: `PluginHost._rest_routes_by_method` is initially empty for POST.
**When**: `register_rest_endpoint("/my/route", handler)`.
**Then**:
- **installed-in-post**: `PluginHost._rest_routes_by_method["POST"]["/my/route"] is handler`.
- **disposable-returned**: return value has a `dispose()` method.

#### Test: register-rest-get-with-context (covers R24)

**Given**: a `PluginContext` with an empty `subscriptions` list.
**When**: `register_rest_endpoint("/r", h, method="GET", context=ctx)`.
**Then**:
- **installed-in-get**: the handler appears under the `"GET"` bucket.
- **subscription-appended**: `ctx.subscriptions[-1]` is the returned Disposable.

#### Test: register-rest-dispose-idempotent (covers R26)

**Given**: a Disposable returned from `register_rest_endpoint("/x", h)`.
**When**: `d.dispose(); d.dispose()`.
**Then**:
- **route-removed**: after first call, `"/x"` key is absent from the POST bucket.
- **no-exception-on-second**: second call does not raise.

#### Test: providers-namespace-exposed (covers R28)

**Given**: `plugin_api` imported.
**When**: access `plugin_api.providers.replicate`.
**Then**:
- **module-resolves**: resolves to a module object.
- **in-all**: `"providers"` is in `plugin_api.__all__`.

### Edge Cases

#### Test: register-rest-dispose-slot-reused-no-op (covers R26)

**Given**: `d1 = register_rest_endpoint("/x", h1)`; later `register_rest_endpoint("/x", h2)` replaces the slot without `d1.dispose()`.
**When**: `d1.dispose()`.
**Then**:
- **h2-preserved**: `PluginHost._rest_routes_by_method["POST"]["/x"] is h2`.
- **no-exception**: no error raised.

#### Test: call-service-urllib-fallback (covers R32)

**Given**: `httpx` import raises `ImportError` (monkeypatched).
**When**: `call_service(service="musicful", method="GET", path="/")` with valid env var.
**Then**:
- **urllib-used**: the urllib code path executes.
- **same-error-contract**: HTTP ≥ 400 yields `ServiceError`; timeout yields `ServiceTimeoutError`; unknown service yields `ServiceConfigError`.

#### Test: call-service-json-parsed (covers R32)

**Given**: remote returns `Content-Type: application/json; charset=utf-8` with body `{"ok": true}`.
**When**: `call_service(...)` succeeds.
**Then**:
- **body-is-dict**: `response.body == {"ok": True}`.

#### Test: call-service-non-json-raw (covers R32)

**Given**: remote returns `Content-Type: application/octet-stream` with raw bytes.
**When**: `call_service(...)` succeeds.
**Then**:
- **body-is-bytes**: `response.body` is a `bytes` object.

#### Test: call-service-never-leaks-api-key (covers R33)

**Given**: `MUSICFUL_API_KEY="secret-xyz"`.
**When**: `call_service(service="musicful", method="GET", path="/echo")` returns a `ServiceResponse`.
**Then**:
- **not-in-response-headers**: `response.headers` does not contain `"secret-xyz"` as any value.
- **not-in-body**: `response.body` (when a dict) does not contain `"secret-xyz"`.
- **not-logged**: no log record at any level contains the raw key string.

#### Test: broadcast-project-name-omitted-when-none (covers R20)

**Given**: `SCENECRAFT_REMOTE_BROADCAST_URL` unset.
**When**: `broadcast_event("p", "e")` (no `project_name`).
**Then**:
- **no-project-key**: the forwarded message dict does NOT contain a `projectName` key.

#### Test: import-side-effects (covers R39)

**Given**: `sys.modules` clean of scenecraft modules.
**When**: `import scenecraft.plugin_api`.
**Then**:
- **db-imported**: `scenecraft.db` now in `sys.modules`.
- **ws-server-imported**: `scenecraft.ws_server` now in `sys.modules`.
- **vcs-bootstrap-imported**: `scenecraft.vcs.bootstrap` now in `sys.modules`.
- **providers-imported**: `scenecraft.plugin_api.providers` now in `sys.modules`.
- **replicate-imported**: `scenecraft.plugin_api.providers.replicate` now in `sys.modules`.

#### Test: star-import-bounds-match-all (covers R1)

**Given**: a test module.
**When**: `from scenecraft.plugin_api import *`.
**Then**:
- **bound-names-equal-all**: the set of public names injected equals `set(scenecraft.plugin_api.__all__)`.

#### Test: find-root-not-in-all-but-attribute-exists (covers R15)

**Given**: `scenecraft.plugin_api` loaded.
**When**: inspect the module.
**Then**:
- **not-in-all**: `"find_root"` not in `__all__`.
- **attribute-exists**: `hasattr(scenecraft.plugin_api, "find_root")` is True (bound for internal `record_spend` use).

#### Test: ci-grep-blocks-raw-db-imports (covers R40, OQ-1)

**Given**: CI pipeline configuration.
**When**: a plugin source file under `src/scenecraft/plugins/*/` contains `from scenecraft.db` or `import scenecraft.db`.
**Then**:
- **ci-fails**: CI build fails with a message naming the offending file and line.
- **allowlist-honored**: `generate_foley/generate_foley.py::_set_derived_from` is explicitly allowlisted and does NOT fail CI.
- **no-runtime-check**: at runtime, the import still succeeds (no import hook installed).

#### Test: record-spend-plugin-id-derived-from-stack (covers R41, OQ-2)

**Given**: plugin code at `scenecraft.plugins.generate_foley.generate_foley` calls `record_spend(amount=1, unit="prediction", operation="x")` with NO `plugin_id` argument.
**When**: the call executes.
**Then**:
- **derived-from-frame**: stored ledger row has `plugin_id == "generate_foley"`.
- **caller-supplied-ignored**: if the caller additionally passes `plugin_id="other"`, the stack-derived value wins (or raises per spec — not trusted).
- **non-plugin-caller-raises**: calling `record_spend` from a module NOT under `scenecraft.plugins.*` raises `RuntimeError`.

#### Test: record-spend-idempotent-on-source-external-id (covers R41, INV-3)

**Given**: a valid scenecraft root; `record_spend(amount=1, ..., source_external_id="pred_abc")` has already inserted ledger row `sl_1`.
**When**: a second call with the same `(plugin_id, source_external_id="pred_abc")` is made.
**Then**:
- **returns-existing-id**: return value equals `"sl_1"`.
- **no-new-row**: the ledger has only one row for this pair.
- **safe-for-attach-polling**: replicate's `attach_polling` on a terminal prediction can call `record_spend` again without duplicate charging.

#### Test: transcribe-dal-reexports-match-surface (covers R42, OQ-3)

**Given**: `scenecraft.plugin_api` loaded.
**When**: inspect `__all__` and import transcribe DAL names.
**Then**:
- **in-all**: `"add_transcription_run"`, `"get_transcription"`, `"list_transcriptions"` are present in `__all__`.
- **identity**: each name is the same object as the corresponding `scenecraft.db.*` function.

#### Test: no-internal-lock-on-record-spend (covers OQ-4, INV-1)

**Given**: source inspection of `record_spend` in `scenecraft.plugin_api.__init__`.
**When**: static analysis.
**Then**:
- **no-lock-acquired**: the wrapper takes no `threading.Lock` / `asyncio.Lock` across the call.
- **single-writer-contract**: concurrent callers from the same user/project are explicitly undefined per INV-1.

#### Test: sidecar-prefix-convention-documented (covers R34, R35)

**Given**: every shipped plugin's sidecar tables.
**When**: enumerate table names created by `generate_music`, `generate_foley`, `transcribe`, `light_show`, `isolate_vocals` plugins.
**Then**:
- **prefix-pattern-honored**: each table name either matches `^<plugin_id>__` or is an explicitly-grandfathered historical name (`audio_isolations`, `isolation_stems`).
- **no-enforcement-exists**: there is no SQL `CHECK` constraint, migration validator, or runtime guard that would block a new table lacking the prefix.

---

## Non-Goals

- **Not** specifying a runtime enforcement mechanism for R9a. The current contract is "convention only"; future enforcement (import hook, process boundary, capability handles) is a separate milestone.
- **Not** specifying `providers.replicate` behavior. That is a separate spec (`local.replicate-provider`).
- **Not** specifying the schema of `spend_ledger` rows or the canonical-JSON hashing of commits. That is handled in `local.auth-jwt-api-keys-double-gate` and `local.vcs-object-store-commits-refs`.
- **Not** specifying sidecar-table schemas (each plugin owns its own migration).
- **Not** specifying `call_service` broker mode — stubbed until scenecraft.online ships.
- **Not** specifying concurrent-write semantics of `_record_spend_raw` (the underlying bootstrap implementation owns that contract).

---

## Open Questions

### Resolved

**OQ-1 (resolved)**: What should happen when a plugin writes to core tables or claims a foreign sidecar prefix via raw DB access? **Decision**: Per INV-2, R9a is enforced by CI grep over `src/scenecraft/plugins/*/` for `from scenecraft.db` and `import scenecraft.db`. CI failure blocks the build. Allowlist: `generate_foley/generate_foley.py::_set_derived_from` until cleaned up. Contract: "plugins MUST NOT access `scenecraft.db` directly. Violation is detected by CI, not runtime." **Tests**: `ci-grep-blocks-raw-db-imports`.

**OQ-2 (resolved)**: How should `record_spend` verify the caller's claimed `plugin_id`? **Decision**: Per INV-3, `record_spend` derives `plugin_id` from the caller's module via stack inspection (matching `scenecraft.plugins.<id>`); raises `RuntimeError` if caller is not a plugin. Also idempotent on `(plugin_id, source_external_id)`. The M17 TODO is resolved — no more caller-supplied `plugin_id` trust. **Tests**: `record-spend-plugin-id-derived-from-stack`, `record-spend-idempotent-on-source-external-id`.

**OQ-3 (resolved)**: How does the `transcribe` plugin reach its sidecar tables? **Decision**: Fix — add transcribe DAL functions (`add_transcription_run`, `get_transcription`, `list_transcriptions`, etc.) to `plugin_api.__all__`. Close by promoting them to first-class exports matching the music/foley/isolation pattern. **Tests**: `transcribe-dal-reexports-match-surface`.

**OQ-4 (resolved)**: Is `record_spend` thread-safe under concurrent callers? **Decision**: Accepted-undefined per INV-1 (single-writer per user/project). No lock taken at the `plugin_api` layer. **Tests**: `no-internal-lock-on-record-spend`.

### OQ-5: Does `record_spend` / `broadcast_event` / `call_service` emit log records containing sensitive payloads?

No logging behavior is specified in `plugin_api.__init__`. The `call_service` tests assume the API key is never logged, but there is no explicit assertion in code today. Row 39 and `call-service-never-leaks-api-key` depend on this being defined — but at the moment it is implicit.

---

## Related Artifacts

- **Audit**: `agent/reports/audit-2-architectural-deep-dive.md` (§1A, §2, §3)
- **Adjacent spec (downstream)**: `local.replicate-provider` (TODO — spec target #3 in audit-2 §5)
- **Adjacent spec (upstream)**: `local.plugin-host-and-manifest` (TODO — spec target #1)
- **Adjacent spec (sibling)**: `local.chat-tool-dispatch-and-elicitation` (TODO — spec target #4)
- **Memory notes**: `project_plugins_own_sidecar_tables.md`, `reference_python_plugin_system.md`, `project_operations_use_candidate_pattern.md`

---

**Namespace**: local
**Spec**: plugin-api-surface-and-r9a
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive)
