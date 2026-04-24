# Task 128: plugin-api Service-Routing Shim

**Milestone**: [M16](../../milestones/milestone-16-music-generation-plugin.md)
**Spec**: `agent/specs/local.music-generation-plugin.md` (§ "Behavior" Flow A step 5 + "Mode decision at call-time")
**Design Reference**: `agent/design/local.scenecraft-online-platform.md` — "Brokered vs. BYO service mode"
**Estimated Time**: 2 hours
**Dependencies**: task-127 (plugin_api exists + exports enumerated helpers)
**Status**: Not Started

---

## Objective

Introduce `plugin_api.call_service()` as the ONLY way plugin code reaches external APIs. In M16 it only implements BYO mode (env-var-present → direct call). Broker mode is stubbed with a clear "not yet available" error. Plugin code stays mode-agnostic so brokered support is a host-only change later.

---

## Steps

### 1. Signature

```python
def call_service(
    *,
    service: str,                       # 'musicful' | 'veo' | 'replicate' | ...
    method: str,                        # 'GET' | 'POST' | ...
    path: str,                          # API path, e.g. '/v1/music/generate'
    body: dict | None = None,
    headers: dict | None = None,        # plugin-supplied headers (merged with auth headers host adds)
    query: dict | None = None,
    timeout_seconds: float = 30.0,
) -> ServiceResponse:
    """Call an external service with host-managed auth + routing.
    In BYO mode: direct call to the service; host injects the API key from env.
    In broker mode: POST to scenecraft.online broker endpoint (M17+; raises NotImplementedError in M16).
    Throws ServiceError on HTTP errors (non-2xx). Throws ServiceConfigError when neither mode configured.
    """
```

`ServiceResponse` is a lightweight typed wrapper: `{status: int, headers: dict, body: dict | bytes}`.

### 2. Per-service config resolution

A new `plugin_api.get_service_config(service: str) -> ServiceConfig` helper resolves the per-service mode:

```python
@dataclass
class ServiceConfig:
    mode: Literal['byo', 'broker', 'unconfigured']
    base_url: str | None                # BYO: provider's URL; broker: scenecraft.online broker URL
    api_key_env: str | None             # BYO only: e.g. 'MUSICFUL_API_KEY'
    auth_header_name: str = 'x-api-key' # varies per provider
```

Resolution order (M16):
1. If `<SERVICE>_API_KEY` env var is set (e.g. `MUSICFUL_API_KEY`), return `mode='byo'` with a per-service config map of base URLs (hardcoded constant map: `SERVICE_BASE_URLS = {'musicful': 'https://api.musicful.ai', 'veo': '...', ...}`).
2. Else return `mode='unconfigured'` for M16. (Broker resolution lives in M17+.)

### 3. BYO call flow

```python
def _call_byo(service, cfg, method, path, body, headers, query, timeout):
    key = os.environ.get(cfg.api_key_env)
    if not key:
        raise ServiceConfigError(f"{cfg.api_key_env} not set")
    url = f"{cfg.base_url}{path}"
    merged_headers = {cfg.auth_header_name: key, **(headers or {})}
    r = httpx.request(method, url, json=body, headers=merged_headers,
                      params=query, timeout=timeout)
    # Do NOT log key, do NOT echo key in error messages
    if r.status_code >= 400:
        raise ServiceError(status=r.status_code, body=_safe_body(r))
    return ServiceResponse(status=r.status_code, headers=dict(r.headers),
                           body=r.json() if 'application/json' in r.headers.get('content-type', '') else r.content)
```

### 4. Broker stub

```python
def _call_broker(service, cfg, method, path, body, headers, query, timeout):
    raise NotImplementedError(
        f"Brokered mode for '{service}' is not yet available. "
        f"Set the {cfg.api_key_env} environment variable to use BYO mode, "
        f"or wait for scenecraft.online brokered billing."
    )
```

### 5. Service base URL registry

Small constant map at module top:

```python
SERVICE_BASE_URLS = {
    'musicful': ('https://api.musicful.ai', 'MUSICFUL_API_KEY', 'x-api-key'),
    # Future:
    # 'veo':       ('https://aiplatform.googleapis.com', 'GOOGLE_API_KEY', 'authorization'),
    # 'replicate': ('https://api.replicate.com', 'REPLICATE_API_TOKEN', 'authorization'),
}
```

When a second service lands, add a row here — no plugin code changes.

### 6. Error shapes

- `ServiceConfigError` — misconfig; surfaces as admin-oriented error to user
- `ServiceError` — non-2xx from provider; carries status + safe body
- `ServiceTimeoutError` — request timeout; for retry logic in plugins

### 7. Tests

- `byo-call-injects-key` — mock server asserts `x-api-key` header; plugin gets 200
- `byo-no-env-var-raises-config-error` — `MUSICFUL_API_KEY` unset → `ServiceConfigError`
- `broker-mode-raises-not-implemented` — future broker config → `NotImplementedError` with clear message
- `key-never-in-error-body` — force a 500 from mock; `ServiceError.body` excludes any substring matching the key value
- `key-never-in-logs` — same scenario; captured logs contain zero occurrences of the key value
- `unknown-service-raises-config-error` — `call_service(service='unknown', ...)` → `ServiceConfigError` mentioning the registry

### 8. Update `plugin_api` exports

`plugin_api.__all__` adds `call_service`, `get_service_config`, `ServiceResponse`, `ServiceError`, `ServiceConfigError`, `ServiceTimeoutError`.

---

## Verification

- [ ] `call_service()` is the only export plugins use for external HTTP
- [ ] BYO mode works end-to-end against a mock Musicful server
- [ ] Missing env var → `ServiceConfigError`, not a raw KeyError
- [ ] Broker path stubbed with a clear error (visible to admins if misconfigured)
- [ ] Zero key-value leaks in logs/errors under failure scenarios
- [ ] Adding `'veo'` to the registry (test case) works without touching `call_service` internals

---

## Notes

- `httpx` vs `requests` — if scenecraft-engine already uses one, use it. Don't add a dep for this.
- Response body handling is intentionally lenient (JSON vs raw bytes) — Musicful returns JSON for all endpoints but future services may return binary (mp3 download URL responses, etc.).
- Keep the shim ~100 LoC. It's a boundary, not an abstraction for its own sake. If it grows, that's usually a sign a provider-specific concern is leaking into it — push it back into the plugin.
