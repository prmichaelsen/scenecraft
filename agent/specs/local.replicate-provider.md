# Spec: Replicate Typed Provider (`plugin_api.providers.replicate`)

> **Status**: Retroactive — documents the as-built behavior of `scenecraft.plugin_api.providers.replicate` in scenecraft-engine. Flagged `undefined` rows indicate behaviors the source code does not resolve.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive)

---

## Purpose

Define the observable contract of the Replicate typed provider: a plugin-facing facade that owns Replicate auth, HTTP, polling, rate-limit/download backoff, spend-ledger attribution, and disconnect-survival for ML predictions — without violating R9a (no raw DB access from plugins).

## Source

- **Mode**: `--from-draft` (retroactive, derived from source code)
- **Primary source file**: `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/plugin_api/providers/replicate.py`
- **Package init**: `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/plugin_api/providers/__init__.py`
- **Reference usage**: `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/plugins/generate_foley/generate_foley.py`
- **Architectural context**: `agent/reports/audit-2-architectural-deep-dive.md` §1A unit #10

## Scope

**In scope**:
- Public surface: `run_prediction`, `attach_polling`, `get_balance`, `PredictionResult`
- Exception hierarchy: `ReplicateError`, `ReplicateNotConfigured`, `ReplicatePredictionFailed`, `ReplicateDownloadFailed`
- `REPLICATE_API_TOKEN` environment lookup (per-call, not cached)
- Polling loop: 5s default interval, terminal states `{succeeded, failed, canceled}`
- HTTP 429 rate-limit backoff (3 attempts: 1s → 2s → 4s → raise)
- Output download with 3-attempt retry + backoff
- Spend-ledger attribution via `plugin_api.record_spend` (R9a-compliant)
- Disconnect-survival: `attach_polling` resumes polling on an existing prediction id
- `PredictionResult.output_bytes` convenience property
- Version resolution shorthand (`owner/model`, `owner/model:version`, bare hash)
- Local `Path` input rejection in `_sanitize_input_for_json`

**Out of scope** (separate specs):
- `generate_foley` plugin behavior (pretrim, v2fx vs t2fx flow, pool persistence)
- `spend_ledger` schema itself (covered in auth/vcs spec)
- Other typed providers (`musicful`, `elevenlabs`, etc.)
- The broader `plugin_api` allowlist / R9a enforcement mechanism
- Replicate's `/v1/files` upload endpoint (this shim does NOT auto-upload)

---

## Requirements

1. **R1**: `run_prediction` MUST create a prediction via `POST /v1/predictions`, poll it to a terminal state, record spend on success, download outputs with retry, and return a `PredictionResult`.
2. **R2**: `REPLICATE_API_TOKEN` MUST be read from the environment on every HTTP call. If unset at call time, MUST raise `ReplicateNotConfigured` (a subclass of `ReplicateError`).
3. **R3**: HTTP `Authorization: Bearer <token>` and `Content-Type: application/json` headers MUST be sent on every Replicate API call.
4. **R4**: On HTTP 429 from Replicate API, requests MUST retry up to 3 times with backoff `(1.0, 2.0, 4.0)` seconds. A 4th consecutive 429 MUST raise `ReplicateError`.
5. **R5**: On httpx transport errors (`httpx.HTTPError`) during API calls, requests MUST retry with the same 3-attempt backoff schedule; final failure raises `ReplicateError` wrapping the underlying error.
6. **R6**: On any non-429 response with `status_code >= 400`, the call MUST raise `ReplicateError(f"POST/GET {path} returned {status_code}: {text}")` without retry.
7. **R7**: The polling loop MUST GET `/v1/predictions/{id}` at `poll_interval` seconds (default 5.0) and return only when status is one of `succeeded`, `failed`, `canceled`.
8. **R8**: If polled prediction terminal status is `failed` or `canceled`, `run_prediction` MUST raise `ReplicatePredictionFailed(prediction_id, error)` and MUST NOT write to spend_ledger.
9. **R9**: On `succeeded` terminal status, `run_prediction` MUST write exactly one spend_ledger row via `plugin_api.record_spend(plugin_id=source, amount=1, unit="prediction", operation="replicate.run_prediction", job_ref=prediction_id, source="replicate")` BEFORE attempting output download.
10. **R10**: Output download MUST retry up to 3 times per URL with backoff `(1.0, 2.0, 4.0)` on either HTTP error or transport error. On exhaustion, `run_prediction` MUST raise `ReplicateDownloadFailed(prediction_id, spend_ledger_id)` with the ledger id already obtained.
11. **R11**: `PredictionResult` MUST contain `prediction_id`, `status=="succeeded"`, `output_paths: list[Path]`, `raw: dict` (the terminal prediction JSON), and `spend_ledger_id: str`.
12. **R12**: `PredictionResult.output_bytes` MUST return `output_paths[0].read_bytes()` if there is ≥1 output path; else `None`.
13. **R13**: Downloaded artifacts MUST be written to a new temp directory created via `mkdtemp(prefix="scenecraft-replicate-")`; each URL's filename is derived from the URL's last path segment (query/fragment stripped), with fallback `output_{i}`.
14. **R14**: Prediction output that is `None`, or contains no http(s) URL strings (after filtering), MUST yield `output_paths == []`. The ledger row is still written.
15. **R15**: `attach_polling(prediction_id, source, on_complete, poll_interval=5.0)` MUST resume polling an existing prediction, run synchronously in the calling thread, and invoke `on_complete` exactly once with either a `PredictionResult` or a `ReplicateError` subclass.
16. **R16**: `attach_polling` MUST NOT re-create the prediction (no POST `/v1/predictions`).
17. **R17**: `attach_polling` MUST record spend via `_record_spend` on `succeeded`, before attempting download. If download fails, `on_complete` receives a `ReplicateDownloadFailed` carrying the just-written `spend_ledger_id`. This may double-record if called for a prediction that was already charged once; dedup is the caller's responsibility.
18. **R18**: `get_balance()` MUST call `GET /v1/account` and return `None` on any `ReplicateError`. With the current Replicate API returning no numeric balance, it MUST return `None` even on success (stubbed for forward-compatibility). It MUST NEVER raise.
19. **R19**: `_resolve_version(model)` MUST accept three forms: `"owner/model"` (resolves latest via `GET /v1/models/{owner}/{name}` → `latest_version.id`), `"owner/model:version"` (returns `version`), bare `"version"` hash (returns as-is).
20. **R20**: `_resolve_version` on `"owner/model"` with no `latest_version` MUST raise `ReplicateError(f"model {model} has no latest_version")`.
21. **R21**: `_sanitize_input_for_json(input)` MUST raise `ReplicateError` if any input value is a `pathlib.Path` (local-file upload is unsupported; callers must pre-upload or pass URLs).
22. **R22**: The module MUST NOT import `scenecraft.db` or any raw-DB access path; spend writes go through `plugin_api.record_spend` only (R9a).
23. **R23**: The `__all__` export list MUST include `run_prediction`, `attach_polling`, `get_balance`, `PredictionResult`, all four exception classes, and constants `REPLICATE_API_BASE`, `REPLICATE_TOKEN_ENV`.
24. **R24**: The four exception classes MUST form a hierarchy rooted at `ReplicateError` (subclass of `Exception`); `ReplicateNotConfigured`, `ReplicatePredictionFailed`, `ReplicateDownloadFailed` MUST all subclass `ReplicateError`.
25. **R25**: `ReplicatePredictionFailed` MUST carry attributes `prediction_id` and `error`; `ReplicateDownloadFailed` MUST carry `prediction_id` and `spend_ledger_id`.

---

## Interfaces / Data Shapes

### Constants

```python
REPLICATE_API_BASE = "https://api.replicate.com"
REPLICATE_TOKEN_ENV = "REPLICATE_API_TOKEN"
DEFAULT_POLL_INTERVAL_SECONDS = 5.0
RATE_LIMIT_BACKOFF_SECONDS = (1.0, 2.0, 4.0)
DOWNLOAD_BACKOFF_SECONDS    = (1.0, 2.0, 4.0)
```

### Public signatures

```python
def run_prediction(
    *,
    model: str,
    input: dict[str, Any],
    source: str,
    poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS,
) -> PredictionResult: ...

def attach_polling(
    *,
    prediction_id: str,
    source: str,
    on_complete: Callable[[PredictionResult | ReplicateError], None],
    poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS,
) -> None: ...

def get_balance() -> float | None: ...
```

### `PredictionResult` (dataclass)

```python
@dataclass
class PredictionResult:
    prediction_id: str
    status: Literal["succeeded"]
    output_paths: list[Path]
    raw: dict
    spend_ledger_id: str

    @property
    def output_bytes(self) -> bytes | None: ...
```

### Exception hierarchy

```
Exception
└── ReplicateError
    ├── ReplicateNotConfigured                       # env missing
    ├── ReplicatePredictionFailed(prediction_id, error)
    └── ReplicateDownloadFailed(prediction_id, spend_ledger_id)
```

### Wire-level behavior

| Call | Method | Path | Retries |
|---|---|---|---|
| Create prediction | POST | `/v1/predictions` | 429 × 3 + transport × 3 |
| Poll prediction | GET | `/v1/predictions/{id}` | 429 × 3 + transport × 3 |
| Resolve version (when no `:`) | GET | `/v1/models/{owner}/{name}` | 429 × 3 + transport × 3 |
| Balance | GET | `/v1/account` | 429 × 3 + transport × 3; all errors swallowed → `None` |
| Download output | GET (stream) | prediction output URLs | download × 3 |

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | `run_prediction` on valid input with succeeding prediction | Returns `PredictionResult(status="succeeded", …)`, writes 1 ledger row, 1 output file on disk | `run-prediction-happy-path` |
| 2 | `run_prediction` when token missing at call time | Raises `ReplicateNotConfigured`; no HTTP call made | `missing-token-raises-not-configured` |
| 3 | `run_prediction` and Replicate returns `status="failed"` | Raises `ReplicatePredictionFailed(prediction_id, error)`; no ledger write | `prediction-failed-no-ledger` |
| 4 | `run_prediction` and Replicate returns `status="canceled"` | Raises `ReplicatePredictionFailed` with `error="status=canceled"` (if no error field); no ledger write | `prediction-canceled-no-ledger` |
| 5 | `run_prediction` success + download exhausts retries | Raises `ReplicateDownloadFailed`; ledger row WAS written; `.spend_ledger_id` populated | `download-failure-after-charge` |
| 6 | `run_prediction` sees HTTP 429 then 200 | Retries with `(1,2,4)` backoff; eventually succeeds | `rate-limit-retries-succeed` |
| 7 | `run_prediction` sees 4 consecutive 429s | Raises `ReplicateError` | `rate-limit-exhausted-raises` |
| 8 | `run_prediction` sees non-429 4xx/5xx | Raises `ReplicateError` with status + body; no retry | `http-error-raises-no-retry` |
| 9 | `run_prediction` sees transport error (timeout) then 200 | Retries with same backoff; eventually succeeds | `transport-retry-succeeds` |
| 10 | `run_prediction` input contains a `Path` value | Raises `ReplicateError` before any HTTP call | `local-path-input-rejected` |
| 11 | `run_prediction` with `model="owner/model"` | Calls `GET /v1/models/owner/model`, uses `latest_version.id` as `version` | `version-resolve-owner-model` |
| 12 | `run_prediction` with `model="owner/model:abcdef"` | Uses `abcdef` as version; no model lookup call | `version-resolve-explicit` |
| 13 | `run_prediction` with bare hash model | Uses hash as version directly | `version-resolve-bare-hash` |
| 14 | `run_prediction` with `owner/model` and no `latest_version` | Raises `ReplicateError("model … has no latest_version")` | `version-resolve-no-latest` |
| 15 | `run_prediction` success, prediction output is `None` | `output_paths == []`; ledger still written | `no-output-still-charges` |
| 16 | `run_prediction` success, output is a list of 2 URLs | 2 files written to tempdir; `output_paths` has 2 entries in order | `multiple-outputs-downloaded-in-order` |
| 17 | `run_prediction` success, output URL has query string | Filename derived from path only (pre-`?`) | `filename-strips-query` |
| 18 | `run_prediction` success, output URL has no filename segment | Falls back to `output_{i}` | `filename-fallback-when-missing` |
| 19 | `PredictionResult.output_bytes` with ≥1 output | Returns `output_paths[0].read_bytes()` | `output-bytes-reads-first` |
| 20 | `PredictionResult.output_bytes` with 0 outputs | Returns `None` | `output-bytes-none-when-empty` |
| 21 | `attach_polling` on a later-succeeding prediction | `on_complete(PredictionResult)`; ledger written; no POST made | `attach-polling-success` |
| 22 | `attach_polling` on a failed prediction | `on_complete(ReplicatePredictionFailed)`; no ledger write | `attach-polling-failed` |
| 23 | `attach_polling` success + download fails | `on_complete(ReplicateDownloadFailed)` with `spend_ledger_id` populated | `attach-polling-download-fails` |
| 24 | `attach_polling` polling raises `ReplicateError` | `on_complete(ReplicateError)`; no crash in calling thread | `attach-polling-catches-replicate-error` |
| 25 | `get_balance` with token unset | Returns `None`; does not raise | `get-balance-swallows-not-configured` |
| 26 | `get_balance` with 200 response | Returns `None` (stubbed) | `get-balance-returns-none-stub` |
| 27 | `get_balance` with 500 response | Returns `None`; does not raise | `get-balance-swallows-errors` |
| 28 | Module exports | `__all__` contains the 7 public names + 2 constants | `module-exports-complete` |
| 29 | R9a compliance — no raw DB import | Module does not import `scenecraft.db` at top level | `no-raw-db-import` |
| 30 | Token read timing | Token is read per HTTP call, not cached at import | `token-read-per-call` |
| 31 | Rate-limit retry beyond 3 attempts | **undefined** | → [OQ-1](#open-questions) |
| 32 | Prediction `output` is non-URL JSON (dict, number) | **undefined** | → [OQ-2](#open-questions) |
| 33 | `attach_polling` on already-completed prediction | **undefined** | → [OQ-3](#open-questions) |
| 34 | Concurrent `run_prediction` calls in same process | **undefined** | → [OQ-4](#open-questions) |
| 35 | Token rotated mid-poll (different value between calls) | **undefined** | → [OQ-5](#open-questions) |

---

## Behavior

### `run_prediction` — step-by-step

1. Call `_sanitize_input_for_json(input)`. If any value is a `Path`, raise `ReplicateError` immediately (no HTTP).
2. Compute `version = _resolve_version(model)`:
   - If `":" in model and "/" not in suffix` → use suffix as version.
   - If `"/" not in model` → treat as bare version hash.
   - Else → `GET /v1/models/{owner}/{name}`; pull `latest_version.id`; raise `ReplicateError` if missing.
3. `POST /v1/predictions` with body `{"version": version, "input": input}` via `_http_post_with_backoff`. Returns parsed JSON; raise `ReplicateError` if no `id`.
4. `_poll_to_completion(prediction_id, poll_interval)`:
   - Loop: `GET /v1/predictions/{id}`; if status in `{succeeded, failed, canceled}` return the prediction; else `time.sleep(poll_interval)`.
5. If `status != "succeeded"` → raise `ReplicatePredictionFailed(prediction_id, error=prediction.get("error") or f"status={status}")`. **No ledger write.**
6. Write ledger: `spend_ledger_id = plugin_api.record_spend(plugin_id=source, amount=1, unit="prediction", operation="replicate.run_prediction", job_ref=prediction_id, source="replicate")`.
7. `_download_outputs(prediction)`:
   - If `output is None` → `[]`.
   - Normalize to list; filter to http(s) URL strings.
   - Create a temp dir `mkdtemp(prefix="scenecraft-replicate-")`.
   - For each URL, try up to 3 + 1 attempts with `(1,2,4)` backoff: `httpx.stream("GET", url, timeout=120)`; on `status_code >= 400` or `httpx.HTTPError`, back off and retry; on last attempt, raise `ReplicateError`.
   - On success, write bytes to `tempdir/<filename>` (where filename strips query/fragment and falls back to `output_{i}`).
8. If download raises `ReplicateError` → catch, log, raise `ReplicateDownloadFailed(prediction_id, spend_ledger_id)` chained from original.
9. Return `PredictionResult(prediction_id, "succeeded", output_paths, raw=prediction, spend_ledger_id)`.

### HTTP backoff (shared by POST and GET)

Iterate `(1.0, 2.0, 4.0, None)`:
- Try the request.
- On `httpx.HTTPError`: if `wait is None` → raise `ReplicateError` wrapping it; else `sleep(wait)`, continue.
- On `status_code == 429`: if `wait is None` → fall through (next iteration); else `sleep(wait)`, continue.
- On `status_code >= 400` (non-429): raise `ReplicateError` immediately.
- Else: return parsed JSON.

### `attach_polling` — step-by-step

1. `_poll_to_completion(prediction_id, poll_interval)`.
2. If status != "succeeded" → `on_complete(ReplicatePredictionFailed(...))`; return.
3. Write ledger via `_record_spend`.
4. Try `_download_outputs`. On `ReplicateError`, call `on_complete(ReplicateDownloadFailed(prediction_id, spend_ledger_id))`; return.
5. Call `on_complete(PredictionResult(...))`.
6. If any `ReplicateError` escapes the polling step (step 1), call `on_complete(e)`.

### `get_balance` — step-by-step

1. Try `_http_get_with_backoff("/v1/account")`. On `ReplicateError` → return `None`.
2. Return `None` unconditionally (stubbed — Replicate does not expose a balance field).

---

## Acceptance Criteria

- [ ] `REPLICATE_API_TOKEN` is read from `os.environ` on every HTTP call (no import-time caching).
- [ ] Missing token raises `ReplicateNotConfigured` (a `ReplicateError`).
- [ ] Create → poll → download → return flow matches §Behavior exactly.
- [ ] Ledger is written exactly once on success (before download), never on `failed`/`canceled`.
- [ ] `ReplicateDownloadFailed` exposes the `spend_ledger_id` from the preceding successful charge.
- [ ] Rate-limit retries: `(1.0, 2.0, 4.0)` seconds between attempts; 4th failure raises.
- [ ] Download retries: `(1.0, 2.0, 4.0)` per URL; 4th failure raises.
- [ ] `attach_polling` never POSTs to `/v1/predictions`.
- [ ] `attach_polling` invokes `on_complete` exactly once, with either `PredictionResult` or the specific `ReplicateError` subclass.
- [ ] `get_balance` never raises; always returns `None` today.
- [ ] `Path` inputs raise `ReplicateError` pre-HTTP.
- [ ] Module does not `import scenecraft.db` (R9a).
- [ ] `__all__` matches §Interfaces.

---

## Tests

### Base Cases

#### Test: `run-prediction-happy-path` (covers R1, R3, R7, R9, R10, R11)

**Given**:
- `REPLICATE_API_TOKEN=tok`
- `POST /v1/predictions` → `{"id":"pred1"}`
- `GET /v1/predictions/pred1` (1st call) → `{"status":"processing"}`
- `GET /v1/predictions/pred1` (2nd call) → `{"status":"succeeded","output":"https://r2/foo.wav"}`
- Download of `foo.wav` → 200 with bytes `b"PCM"`
- `plugin_api.record_spend` returns `"sl_1"`

**When**: `run_prediction(model="owner/m:v1", input={"prompt":"dog"}, source="generate-foley")`

**Then** (assertions):
- **returns-result**: return value is a `PredictionResult`.
- **result-status-succeeded**: `result.status == "succeeded"`.
- **result-prediction-id**: `result.prediction_id == "pred1"`.
- **result-spend-id**: `result.spend_ledger_id == "sl_1"`.
- **result-output-count**: `len(result.output_paths) == 1`.
- **result-output-bytes**: `result.output_paths[0].read_bytes() == b"PCM"`.
- **authorization-header**: all HTTP calls carried `Authorization: Bearer tok`.
- **content-type-header**: POST carried `Content-Type: application/json`.
- **ledger-called-once**: `record_spend` invoked exactly once with `plugin_id="generate-foley", amount=1, unit="prediction", operation="replicate.run_prediction", job_ref="pred1", source="replicate"`.
- **ledger-called-before-download**: `record_spend` call preceded the download HTTP call.
- **poll-interval-respected**: ≥ `poll_interval` seconds elapsed between the two GET `/v1/predictions/pred1` calls.

#### Test: `missing-token-raises-not-configured` (covers R2)

**Given**: `REPLICATE_API_TOKEN` unset.
**When**: `run_prediction(model="owner/m:v1", input={"prompt":"x"}, source="p")` is called.
**Then**:
- **raises-not-configured**: raises `ReplicateNotConfigured`.
- **is-replicate-error**: the raised exception is also an instance of `ReplicateError` and `Exception`.
- **no-http-made**: zero HTTP calls were made.
- **no-ledger**: `record_spend` not invoked.

#### Test: `prediction-failed-no-ledger` (covers R8)

**Given**: POST returns `{"id":"p1"}`; poll returns `{"status":"failed","error":"oom"}`.
**When**: `run_prediction(...)` is called.
**Then**:
- **raises-prediction-failed**: raises `ReplicatePredictionFailed`.
- **carries-prediction-id**: `.prediction_id == "p1"`.
- **carries-error**: `.error == "oom"`.
- **no-ledger**: `record_spend` not invoked.
- **no-download**: no HTTP GET was made to any non-Replicate host.

#### Test: `prediction-canceled-no-ledger` (covers R8)

**Given**: poll returns `{"status":"canceled"}` (no `error`).
**When**: `run_prediction(...)` is called.
**Then**:
- **raises-prediction-failed**: raises `ReplicatePredictionFailed`.
- **error-fallback**: `.error == "status=canceled"`.
- **no-ledger**: `record_spend` not invoked.

#### Test: `download-failure-after-charge` (covers R9, R10)

**Given**: poll returns `succeeded` with `output="https://r2/foo.wav"`; all 4 download attempts return 503; `record_spend` returns `"sl_9"`.
**When**: `run_prediction(...)` is called.
**Then**:
- **raises-download-failed**: raises `ReplicateDownloadFailed`.
- **carries-prediction-id**: `.prediction_id` equals the created id.
- **carries-spend-id**: `.spend_ledger_id == "sl_9"`.
- **ledger-written-once**: `record_spend` invoked exactly once.
- **download-attempts**: exactly 4 download attempts made (initial + 3 retries).

#### Test: `rate-limit-retries-succeed` (covers R4)

**Given**: POST returns 429, 429, 200 `{"id":"p"}`; polling succeeds immediately.
**When**: `run_prediction(...)` is called.
**Then**:
- **returns-result**: returns a `PredictionResult`.
- **backoff-respected**: sleeps of ~1.0s then ~2.0s occurred between POST attempts.
- **post-attempts**: exactly 3 POSTs to `/v1/predictions` were made.

#### Test: `rate-limit-exhausted-raises` (covers R4)

**Given**: POST returns 429 on 4 consecutive attempts.
**When**: `run_prediction(...)` is called.
**Then**:
- **raises-replicate-error**: raises `ReplicateError` (exact class, not just subclass).
- **post-attempts**: exactly 4 POST attempts.
- **no-ledger**: `record_spend` not invoked.

#### Test: `http-error-raises-no-retry` (covers R6)

**Given**: POST returns 500.
**When**: `run_prediction(...)` is called.
**Then**:
- **raises-replicate-error**: raises `ReplicateError` whose message contains `"500"`.
- **no-retry**: exactly 1 POST attempt (no backoff retries on non-429).

#### Test: `attach-polling-success` (covers R15, R16, R17)

**Given**: GET `/v1/predictions/p` → `{"status":"succeeded","output":"https://x/a.wav"}`; download succeeds; `record_spend` → `"sl_2"`.
**When**: `attach_polling(prediction_id="p", source="gf", on_complete=cb)` is called.
**Then**:
- **no-post**: no POST to `/v1/predictions` was made.
- **cb-called-once**: `cb` invoked exactly once.
- **cb-arg-is-result**: `cb` argument is a `PredictionResult`.
- **cb-spend-id**: `result.spend_ledger_id == "sl_2"`.

#### Test: `attach-polling-failed` (covers R15)

**Given**: poll returns `{"status":"failed","error":"x"}`.
**When**: `attach_polling(...)` is called.
**Then**:
- **cb-called-once**: `cb` invoked exactly once.
- **cb-arg-class**: argument is an instance of `ReplicatePredictionFailed`.
- **no-ledger**: `record_spend` not invoked.

#### Test: `attach-polling-download-fails` (covers R17)

**Given**: poll succeeded, download exhausts retries, `record_spend` → `"sl_3"`.
**When**: `attach_polling(...)` is called.
**Then**:
- **cb-arg-class**: argument is `ReplicateDownloadFailed`.
- **cb-spend-id**: `.spend_ledger_id == "sl_3"`.
- **ledger-written-once**: `record_spend` invoked exactly once.

#### Test: `attach-polling-catches-replicate-error` (covers R15)

**Given**: polling raises `ReplicateError("transport fail")`.
**When**: `attach_polling(...)` is called.
**Then**:
- **no-reraise**: `attach_polling` returns normally (does not raise).
- **cb-arg-class**: `cb` called once with a `ReplicateError` (the exact raised instance).

#### Test: `get-balance-returns-none-stub` (covers R18)

**Given**: `/v1/account` returns 200 `{"username":"u"}`.
**When**: `get_balance()` is called.
**Then**:
- **returns-none**: return value is `None`.
- **no-raise**: no exception raised.

#### Test: `get-balance-swallows-not-configured` (covers R18)

**Given**: `REPLICATE_API_TOKEN` unset.
**When**: `get_balance()` is called.
**Then**:
- **returns-none**: returns `None`.
- **no-raise**: does not raise `ReplicateNotConfigured`.

#### Test: `get-balance-swallows-errors` (covers R18)

**Given**: `/v1/account` returns 500.
**When**: `get_balance()` is called.
**Then**:
- **returns-none**: returns `None`.
- **no-raise**: no exception raised.

#### Test: `local-path-input-rejected` (covers R21)

**Given**: `input = {"video": Path("/tmp/x.mp4")}`.
**When**: `run_prediction(...)` is called.
**Then**:
- **raises-replicate-error**: raises `ReplicateError` (NOT a subclass).
- **message-mentions-path**: exception message contains the offending key `"'video'"` and the path string.
- **no-http**: zero HTTP calls made.

#### Test: `no-raw-db-import` (covers R22)

**Given**: a fresh import of `scenecraft.plugin_api.providers.replicate`.
**When**: module `sys.modules` is inspected.
**Then**:
- **no-scenecraft-db**: `"scenecraft.db"` is NOT in `sys.modules` as a direct effect of importing this module.
- **record-spend-reference**: the only spend-writing path is the deferred import `from scenecraft import plugin_api` inside `_record_spend`.

#### Test: `module-exports-complete` (covers R23)

**Given**: the module.
**When**: `__all__` is read.
**Then**:
- **all-contents**: `__all__` equals exactly `["run_prediction","attach_polling","get_balance","PredictionResult","ReplicateError","ReplicateNotConfigured","ReplicatePredictionFailed","ReplicateDownloadFailed","REPLICATE_API_BASE","REPLICATE_TOKEN_ENV"]` (order per source).

### Edge Cases

#### Test: `transport-retry-succeeds` (covers R5)

**Given**: POST raises `httpx.ConnectError` twice then returns 200.
**When**: `run_prediction(...)` is called.
**Then**:
- **returns-result**: returns a `PredictionResult`.
- **backoff-respected**: sleeps of ~1.0s and ~2.0s observed.
- **post-attempts**: exactly 3 POST attempts.

#### Test: `version-resolve-owner-model` (covers R19)

**Given**: `model="owner/m"`; GET `/v1/models/owner/m` → `{"latest_version":{"id":"vhash"}}`.
**When**: `run_prediction(...)` is called.
**Then**:
- **models-called**: GET `/v1/models/owner/m` was called exactly once.
- **post-body-version**: POST body had `"version":"vhash"`.

#### Test: `version-resolve-explicit` (covers R19)

**Given**: `model="owner/m:explicitv"`.
**When**: `run_prediction(...)` is called.
**Then**:
- **no-models-call**: GET `/v1/models/...` NOT called.
- **post-body-version**: POST body had `"version":"explicitv"`.

#### Test: `version-resolve-bare-hash` (covers R19)

**Given**: `model="abcdef0123"` (no `/`, no `:`).
**When**: `run_prediction(...)` is called.
**Then**:
- **no-models-call**: GET `/v1/models/...` NOT called.
- **post-body-version**: POST body had `"version":"abcdef0123"`.

#### Test: `version-resolve-no-latest` (covers R20)

**Given**: `model="owner/m"`; GET `/v1/models/owner/m` returns `{}`.
**When**: `run_prediction(...)` is called.
**Then**:
- **raises-replicate-error**: raises `ReplicateError`.
- **message-no-latest**: message contains `"has no latest_version"`.
- **no-predict-post**: POST `/v1/predictions` NOT called.

#### Test: `no-output-still-charges` (covers R14)

**Given**: poll returns `succeeded` with `"output": None`.
**When**: `run_prediction(...)` is called.
**Then**:
- **returns-result**: returns a `PredictionResult`.
- **empty-outputs**: `result.output_paths == []`.
- **ledger-written**: `record_spend` invoked exactly once.

#### Test: `multiple-outputs-downloaded-in-order` (covers R13)

**Given**: poll returns `succeeded` with `"output": ["https://x/a.wav","https://x/b.wav"]`; both downloads succeed.
**When**: `run_prediction(...)` is called.
**Then**:
- **two-paths**: `len(result.output_paths) == 2`.
- **order-preserved**: `result.output_paths[0].name == "a.wav"`, `result.output_paths[1].name == "b.wav"`.
- **same-tempdir**: both paths share the same parent directory and its name starts with `"scenecraft-replicate-"`.

#### Test: `filename-strips-query` (covers R13)

**Given**: output URL `"https://x/foo.wav?sig=abc#frag"`.
**When**: `run_prediction(...)` is called.
**Then**:
- **filename**: `result.output_paths[0].name == "foo.wav"`.

#### Test: `filename-fallback-when-missing` (covers R13)

**Given**: output URL `"https://x/"` (trailing slash, no segment).
**When**: `run_prediction(...)` is called.
**Then**:
- **fallback-name**: `result.output_paths[0].name == "output_0"`.

#### Test: `output-bytes-reads-first` (covers R12)

**Given**: a `PredictionResult` with one output path containing bytes `b"AB"`.
**When**: `.output_bytes` is accessed.
**Then**:
- **bytes-match**: returns `b"AB"`.

#### Test: `output-bytes-none-when-empty` (covers R12)

**Given**: a `PredictionResult` with `output_paths=[]`.
**When**: `.output_bytes` is accessed.
**Then**:
- **returns-none**: returns `None`.

#### Test: `token-read-per-call` (covers R2)

**Given**: at import time `REPLICATE_API_TOKEN=A`; after import set to `B`; mock POST to 200.
**When**: `run_prediction(...)` runs to create the prediction.
**Then**:
- **header-uses-latest**: the POST request's `Authorization` header is `Bearer B`, not `Bearer A`.

#### Test: `exception-hierarchy-and-attrs` (covers R24, R25)

**Given**: the four exception classes.
**When**: instances are constructed.
**Then**:
- **base-is-exception**: `issubclass(ReplicateError, Exception)`.
- **not-configured-parent**: `issubclass(ReplicateNotConfigured, ReplicateError)`.
- **failed-parent**: `issubclass(ReplicatePredictionFailed, ReplicateError)`.
- **download-parent**: `issubclass(ReplicateDownloadFailed, ReplicateError)`.
- **failed-attrs**: `ReplicatePredictionFailed("p","e").prediction_id == "p"` and `.error == "e"`.
- **download-attrs**: `ReplicateDownloadFailed("p","sl").prediction_id == "p"` and `.spend_ledger_id == "sl"`.
- **failed-str**: `str(ReplicatePredictionFailed("p","e"))` contains `"p"` and `"e"`.
- **download-str**: `str(ReplicateDownloadFailed("p","sl"))` contains `"p"` and `"sl"`.

---

## Non-Goals

- **Local-file upload to Replicate**: the shim deliberately rejects `Path` inputs. Uploading via `/v1/files` is out of scope.
- **Deduping double spend on reattach**: `attach_polling` will re-charge if called on a prediction whose `run_prediction` already charged. Dedup is explicitly the caller's responsibility.
- **Numeric balance**: Replicate's `/v1/account` does not expose it; `get_balance` is stubbed.
- **Async/threaded dispatch**: both `run_prediction` and `attach_polling` run synchronously. Callers (e.g. `generate_foley`) spawn their own daemon threads.
- **Webhook-based completion**: polling-only. No Replicate webhook handling.
- **Caching of `_resolve_version`**: every `run_prediction` call with an `owner/model` ref triggers a fresh `GET /v1/models/...`.
- **JSON-output predictions**: models returning non-URL JSON outputs are intentionally ignored by `_download_outputs` — flagged `undefined` in OQ-2 since the source does not raise or expose them.

---

## Open Questions

- **OQ-1**: Rate-limit retry beyond the 3-attempt budget. The source exhausts after attempts at `(1,2,4)` and raises `ReplicateError`. It does NOT distinguish between persistent rate-limiting and transient spikes, and there is no longer fallback, no jitter, no circuit breaker. Should a 5th attempt exist? Should backoff jitter? Should persistent 429 get its own exception subclass? Source: unresolved. Behavior today: raise a generic `ReplicateError` and bubble up.
- **OQ-2**: Non-URL prediction output. When Replicate returns `output` as a dict, a number, a non-http string, or a mixed list, `_download_outputs` silently filters all entries, producing `output_paths=[]`. The caller sees a `PredictionResult` with 0 outputs and `raw` holding the original dict. Should this be an error? Should there be a distinct `.json_output` field on `PredictionResult`? Source: silent-filter today.
- **OQ-3**: `attach_polling` on a prediction that is ALREADY in a terminal state at first poll. Today: `_poll_to_completion` returns immediately; ledger is written again (possible double-charge attribution); download runs once. Source code comments acknowledge this may double-record, and push responsibility to the caller. Should there be a `get_prediction_no_side_effects` variant? Should spend be idempotent on `job_ref`?
- **OQ-4**: Concurrent `run_prediction` calls in the same process. The provider uses no locks; `httpx` is thread-safe. `plugin_api.record_spend` attribution is per-call. But: tempdirs are per-call, so no collision there. Are there failure modes around shared connection pools, per-token rate-limit budget, or log-ordering? Source: not addressed.
- **OQ-5**: Token rotation mid-poll. `_auth_headers()` reads the env on every call, so a rotation DURING a `run_prediction` takes effect on the next HTTP attempt. Is that desired (fast cutover) or dangerous (polls with mixed identities)? Source: implicit behavior — not called out as a contract.

---

## Key Design Decisions

- **Provider, not service shim**: the module is a strongly typed facade — callers import `plugin_api.providers.replicate` rather than `call_service("replicate", ...)`. Each provider submodule owns its auth, HTTP, polling, retry, ledger, and artifact download.
- **Ledger-before-download**: on a `succeeded` prediction, spend is recorded BEFORE the download attempt. Replicate has already charged regardless of whether our bytes arrive; surfacing the `spend_ledger_id` through `ReplicateDownloadFailed` lets callers communicate "you were charged; retry will re-charge" to the user.
- **Disconnect-survival via `attach_polling`**: matches the "Generation Jobs Survive Disconnect" invariant. A plugin persists `replicate_prediction_id` to its own sidecar table; on server restart, a resume hook re-enters polling without re-creating the prediction or re-charging the create call.
- **R9a compliance**: no raw DB import at module top-level; spend writes route through `plugin_api.record_spend`. The only `from scenecraft import plugin_api` is deferred inside `_record_spend`.
- **Path input rejection**: callers must pre-upload to `/v1/files` or provide a public URL; this avoids silent JSON-garbling from stringifying `Path`.
- **Version-resolution shorthand**: supports `owner/model` (latest lookup), `owner/model:version` (pinned), and bare version hash. Pinned is cheapest (zero extra HTTP calls).

---

## Related Artifacts

- **Audit**: `agent/reports/audit-2-architectural-deep-dive.md` §1A unit #10, §5 target #3.
- **Consumer plugin**: `scenecraft-engine/src/scenecraft/plugins/generate_foley/generate_foley.py` (worker + `resume_in_flight` reattach hook).
- **R9a surface**: `scenecraft-engine/src/scenecraft/plugin_api/__init__.py` (`record_spend`).
- **Related specs to author**:
  - `local.plugin-api-surface-and-r9a` (host-side R9a boundary)
  - `local.generate-foley-plugin` (end-to-end foley plugin)
  - `local.auth-jwt-api-keys-double-gate` (spend_ledger schema + attribution)
- **Memory**: "Chat generation jobs survive disconnect" (`feedback_generation_jobs_survive_disconnect.md`).

---

**Namespace**: local
**Spec**: replicate-provider
**Version**: 1.0.0
**Status**: Active (retroactive)
**Source module**: `scenecraft.plugin_api.providers.replicate` (scenecraft-engine)
