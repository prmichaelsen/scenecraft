# Task 142: Replicate Provider Core

**Milestone**: [M18](../../milestones/milestone-18-foley-generation-plugin.md)
**Design Reference**: [`local.foley-generation-plugin.md`](../../design/local.foley-generation-plugin.md) — "Provider module: `plugin_api.providers.replicate`"
**Clarification**: [`clarification-12-foley-generation-plugin.md`](../../clarifications/clarification-12-foley-generation-plugin.md) — Item 5
**Estimated Time**: 6 hours
**Dependencies**: M16 `spend_ledger` table + `plugin_api.record_spend` helper (already landed)
**Status**: Not Started

---

## Objective

Introduce a typed per-provider namespace on `plugin_api` starting with `plugin_api.providers.replicate`. This module owns ALL Replicate-specific concerns (auth, HTTP, polling, backoff, spend_ledger, disconnect-survival, output download) so plugins only express model choice + input shape. Supersedes M16's generic `call_service('replicate', ...)` shim as the pattern for Replicate-backed plugins going forward.

---

## Context

M16 introduced `plugin_api.call_service(service_name, request)` — a string-keyed generic dispatcher. Every plugin using it duplicates auth, polling, backoff, and spend attribution. With a second paid-API plugin landing (foley), we generalize into a typed provider surface before the pattern calcifies. Future Replicate-backed plugins (video upscaling, inpainting, etc.) inherit the full lifecycle from this module.

Music-gen's eventual migration from `call_service('musicful', ...)` to `plugin_api.providers.musicful.*` is explicitly **out of scope** for this task and this milestone. This task lands the Replicate concrete implementation only.

---

## Steps

### 1. Module structure

Create `scenecraft-engine/src/scenecraft/plugin_api/providers/` with:

```
providers/
├── __init__.py         # re-exports Provider instances
├── _base.py            # shared types: ProviderResult, spend helpers
└── replicate.py        # ReplicateProvider + exception types
```

Update `plugin_api/__init__.py` to expose `providers` as an attribute:

```python
from scenecraft.plugin_api import providers
# plugin code: plugin_api.providers.replicate.run_prediction(...)
```

### 2. `ReplicateProvider.run_prediction` signature

```python
@dataclass
class PredictionResult:
    prediction_id: str
    status: Literal['succeeded', 'failed']
    output_paths: list[Path]   # downloaded files on local disk
    output_bytes: bytes | None # convenience: contents of output_paths[0] if single file
    raw: dict                  # full Replicate prediction payload
    spend_ledger_id: str       # row inserted on success

class ReplicateProvider:
    def run_prediction(
        self,
        *,
        model: str,                  # e.g. "zsxkib/mmaudio"
        input: dict,                 # model-specific input
        source: str,                 # plugin id for spend_ledger.source
        poll_interval: float = 5.0,
    ) -> PredictionResult:
        ...
```

### 3. Full lifecycle

`run_prediction` must:

1. **Auth check** — read `REPLICATE_API_TOKEN` from env; if missing raise `ReplicateNotConfigured` with message pointing to docs.
2. **Create prediction** — `POST https://api.replicate.com/v1/predictions` with `{version|model, input, webhook?}`; extract `prediction_id`.
3. **Poll loop** — `GET https://api.replicate.com/v1/predictions/:id` every `poll_interval` until status ∈ `{succeeded, failed, canceled}`.
4. **429 backoff** — on 429 response (creation OR polling), retry with backoff 1s → 2s → 4s → fail. Do NOT count backoff wait against poll interval.
5. **On success** — extract output URL(s) from `prediction.output`. Download each with 3× retry + exponential backoff (1s→2s→4s). If all retries exhaust, raise `ReplicateDownloadFailed` BUT still write spend_ledger (charge already happened).
6. **spend_ledger write** — via `plugin_api.record_spend(amount=1, unit='prediction', source=source, provider_ref=prediction_id)` — only on Replicate-reported success, regardless of download outcome.
7. **On failure** — raise `ReplicatePredictionFailed(prediction_id, error=prediction.error)`. Do NOT write spend_ledger.

### 4. `attach_polling` for disconnect-survival

```python
def attach_polling(self, *, prediction_id: str, source: str,
                   on_complete: Callable[[PredictionResult], None]) -> None:
    """Resume polling for an in-flight prediction. Callback invoked when done.
    Used by plugin startup hooks to reattach after box restart."""
```

Does NOT re-create the prediction — only resumes polling an already-created one. Same backoff + download semantics as the tail half of `run_prediction`.

### 5. `get_balance`

```python
def get_balance(self) -> float | None:
    """Return Replicate account balance in USD. None if unavailable."""
```

Queries Replicate's account endpoint (check current API docs for the correct path — `/v1/account` is a reasonable starting point). Returns None on any error rather than raising — this is a status query, not a critical path.

### 6. Exception types

```python
class ReplicateError(Exception): ...
class ReplicateNotConfigured(ReplicateError): ...
class ReplicatePredictionFailed(ReplicateError):
    def __init__(self, prediction_id: str, error: str): ...
class ReplicateDownloadFailed(ReplicateError):
    def __init__(self, prediction_id: str, spend_ledger_id: str): ...
```

`ReplicateDownloadFailed` carries `spend_ledger_id` so callers can surface "you were charged, download failed" to the user.

### 7. Tests

- Missing env var → `ReplicateNotConfigured`
- Prediction succeeded, download ok → returns `PredictionResult`, `spend_ledger` has one row
- Prediction succeeded, download fails 3× → `ReplicateDownloadFailed`, `spend_ledger` STILL has one row
- Prediction failed (Replicate returned status='failed') → `ReplicatePredictionFailed`, NO `spend_ledger` row
- 429 on create → retries 1s/2s/4s, eventually succeeds
- 429 on all create retries → raises after 3rd attempt
- `attach_polling` resumes an in-flight prediction without re-creating it
- R9a structural test still passes (module does NOT import raw DB handles; uses `plugin_api.record_spend` only)

### 8. Verify no-raw-DB invariant

The provider writes to `spend_ledger` via `plugin_api.record_spend()` — NOT via direct SQL. This preserves the R9a invariant that's enforced by the structural test `plugin-api-exposes-no-raw-db-handle`.

---

## Verification

- [ ] `plugin_api.providers.replicate` module exists and is importable
- [ ] `run_prediction` handles auth, polling, 429 backoff, download retry, spend_ledger
- [ ] `attach_polling` resumes an in-flight prediction without re-creation
- [ ] `get_balance` returns None gracefully on any error (no raising)
- [ ] All six exception cases covered in tests above
- [ ] `plugin-api-exposes-no-raw-db-handle` invariant test still passes
- [ ] `ReplicateDownloadFailed` carries the `spend_ledger_id` of the already-recorded charge
- [ ] Real-API smoke test (gated on `REPLICATE_API_TOKEN`) generates a prediction successfully

---

## Expected Output

```
scenecraft-engine/src/scenecraft/plugin_api/
├── __init__.py                        (modified: re-exports providers)
└── providers/
    ├── __init__.py                    (new)
    ├── _base.py                       (new)
    └── replicate.py                   (new)

scenecraft-engine/tests/plugin_api/
└── test_replicate_provider.py         (new)
```

---

## Notes

- This task is intentionally scoped to ONLY the Replicate provider. Do not refactor M16's `call_service()` or music-gen in this task — separate milestone.
- `poll_interval` defaulted to 5s matches M16's Musicful cadence. Not tunable per-model in MVP.
- Download destination: use `tempfile.TemporaryDirectory` + a convention like `/tmp/scenecraft-replicate/{prediction_id}/{output_filename}` — plugin caller is responsible for persisting to pool.
- The provider does NOT write `pool_segments`. That's the plugin's job using `plugin_api.add_pool_segment`.

---

**Next Task**: [task-143](task-143-schema-and-migrations.md) — Foley schema + migrations
**Related Design Docs**: [`local.foley-generation-plugin.md`](../../design/local.foley-generation-plugin.md)
