# Spec: Auth — JWT + API Keys + Double-Gate + User/Org Management

> **Agent Directive**: This is a retroactive black-box spec describing the observable behavior of the existing auth subsystem. Implementations MUST match the Behavior Table and Tests section exactly. Anything flagged `undefined` is an explicit gap awaiting a product decision — do NOT guess it into code.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive)

---

## Purpose

Specify the server-side authentication surface of scenecraft: JWT session tokens, API key issuance and double-gate verification for paid-plugin endpoints, short-lived login-code SSH-to-browser handshake, and the underlying users / orgs / memberships schema.

## Source

- Mode: retroactive black-box audit (no single clarification/design source)
- Primary files audited:
  - `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/vcs/auth.py`
  - `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/auth_middleware.py`
  - `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/vcs/bootstrap.py`
  - `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/vcs/cli.py`
- Context: Audit #2 §1F units 6–11 (`/home/prmichaelsen/.acp/projects/scenecraft/agent/reports/audit-2-architectural-deep-dive.md`)

## Scope

### In Scope

- JWT token lifecycle: issuance, signing (HS256 via `.scenecraft/secret.key`), validation, 24h default expiry, cookie (`scenecraft_jwt`, HttpOnly, SameSite=Lax, Max-Age) and bearer header extraction, `sub`/`fingerprint`/`role`/`iat`/`exp` payload claims, sliding-expiration cookie renewal semantics.
- API keys: issuance via `scenecraft auth keys issue`, raw-key one-time display, PBKDF2-HMAC-SHA256 at 600,000 iterations, per-key salt, soft revocation (`revoked_at`), expiry, listing, revoking.
- Double-gate decorator `require_paid_plugin_auth`: both session JWT AND `X-Scenecraft-API-Key` header required; `must_change_password` gate; org resolution precedence (header → session `last_active_org` claim → single-org shortcut → 400 AMBIGUOUS_ORG).
- Short-lived login codes: `secrets.token_urlsafe(24)` code, 5-minute TTL, single-use consumption (SSH-issued → browser `/auth/login?code=…` → cookie set).
- User / org / `org_members` schema; role enum `admin | editor | viewer` at user level and `admin | member` at org_member level; `must_change_password` flag lifecycle (set on `user add`, cleared by `user set-password`).
- Exempt paths enumerated for non-paid-plugin middleware: `/auth/login`, `/auth/logout`, `/oauth/callback`.
- SSH pubkey fingerprinting: 16-char truncated SHA-256 hex, stored at user-creation time for future pubkey-based revocation.

### Out of Scope

- Spend ledger write path and `record_spend` semantics (covered in `plugin-api-surface-and-r9a` spec).
- OAuth / Remember MCP bridge token flow (covered in `chat-tool-dispatch-and-elicitation` spec).
- SSH key management beyond generation of the 16-char fingerprint claim.
- HTTP handler error-response format details (`_error(status, code, message)` shape is assumed a given from the handler base class).
- Session working-copy lifecycle (covered in VCS-sessions spec).

---

## Requirements

**R1. JWT signing key material**: The server MUST load its HS256 signing secret from `<.scenecraft>/secret.key`. If the file is missing at first read, the server MUST generate a new 32-byte (64-hex-char) secret via `secrets.token_hex(32)`, write it to `secret.key` with mode `0o600`, and use it thereafter. The file is never rotated automatically.

**R2. JWT payload schema**: `generate_token(sc_root, username, expiry_hours=24)` MUST produce an HS256 JWT whose payload contains exactly: `sub` (username), `fingerprint` (users.pubkey_fingerprint, possibly `""`), `role` (users.role), `iat` (UTC unix seconds), `exp` (iat + expiry_hours·3600), and `jti` (freshly-generated `uuid4().hex`, per OQ-3 resolution — guarantees byte-distinct tokens even when issued in the same second). Unknown user → `ValueError` with a message that includes the admin remediation command.

**R3. JWT validation**: `validate_token` MUST decode with the current secret, verify HS256, and pass `leeway=30` to `jwt.decode` (per OQ-7 — accepts tokens whose `exp` is past by up to 30 seconds to absorb clock skew). Raises `jwt.ExpiredSignatureError` on expiry beyond leeway or `jwt.InvalidTokenError` on signature / structural failure. `get_username_from_token` MUST swallow both and return `None`. Tokens signed with a now-replaced secret fail signature verification and are treated as expired → force re-login (per OQ-2 — secret regen is a nuke-sessions event; no grace period).

**R4. Cookie build/clear**: `build_cookie_header(token, max_age, secure=False)` MUST emit `scenecraft_jwt=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<n>`; `Secure` appended iff `secure=True`. `build_clear_cookie_header()` MUST emit the same cookie name with empty value, Max-Age=0, HttpOnly, SameSite=Lax, Path=/.

**R5. Token extraction precedence**: `extract_bearer_token` MUST parse `Authorization: Bearer <token>` case-insensitively on the scheme, returning the stripped token (or `None`). `extract_cookie_token` MUST split on `;`, strip, and return the first segment whose name is exactly `scenecraft_jwt`.

**R6. Login-code handshake**: `create_login_code(sc_root, token)` MUST insert a row into `login_codes (code, token, expires_at)` where `code = secrets.token_urlsafe(24)` and `expires_at = now_utc + 300s`. On every insert, rows with `expires_at < now` MUST be deleted (opportunistic GC).

**R7. Login-code consumption**: `consume_login_code(sc_root, code)` MUST wrap SELECT→DELETE in a `BEGIN IMMEDIATE` transaction (per OQ-6 — SQLite's only real at-most-once guarantee). Concurrent double-submits serialize: one consumer gets the JWT and deletes the row, the other sees the row gone and returns `None`. Returns the stored JWT if the row existed and had not expired; returns `None` if the row was missing OR expired (row is always deleted when found).

**R8. API key issuance**: `scenecraft auth keys issue <username> --expires YYYY-MM-DD [--label …]` MUST: (a) verify user exists (else exit 1), (b) parse `--expires` as UTC midnight (else exit 1), (c) generate `raw_key = "sck_" + secrets.token_urlsafe(32)` (per OQ-14 — `sck_` prefix enables GitHub secret-scanning), `salt = os.urandom(16)`, `key_id = "ak_" + uuid4().hex[:12]`, (d) compute `key_hash = PBKDF2-HMAC-SHA256(raw_key, salt, 600_000)` hex-encoded, (e) INSERT `(id, username=<target>, key_hash, salt_hex, issued_by=<caller>, issued_at=now_utc_iso, expires_at=iso, label)` — `issued_by` is the CLI caller (may differ from `username` when an admin issues on behalf of another user, per OQ-13), (f) print `Key ID`, `API Key`, `Expires`, optional `Label`, and a warning line stating the key will not be shown again. The raw key MUST NOT be logged or persisted anywhere else.

**R9. API key listing**: `scenecraft auth keys list <username>` MUST print only `id, issued_at, expires_at, revoked_at, label, status` (never `key_hash` or `salt`). `status` is computed (per OQ-8): `revoked` if `revoked_at IS NOT NULL`, else `expired` if `expires_at < now_utc_iso`, else `active`. Pure display; does not mutate DB.

**R10. API key revocation**: `scenecraft auth keys revoke <key_id>` MUST set `revoked_at = now_utc_iso` on a non-revoked key. Already-revoked keys MUST produce an idempotent success message WITHOUT updating `revoked_at` (per OQ-15 — CI-friendly; preserves original revocation timestamp). Missing key MUST exit 1.

**R11. Double-gate middleware — Gate 1 (JWT)**: `require_paid_plugin_auth` MUST first look for a bearer token in `Authorization`; if present, the cookie is ignored entirely (per OQ-1 — bearer wins as canonical; no mismatch detection). If bearer is absent, fall back to the `scenecraft_jwt` cookie. Missing token → 401 `UNAUTHORIZED` "Missing session token". Invalid/expired token → 401 "Invalid or expired session token". Valid token with no `sub` claim → 401 "Malformed session token".

**R12. Double-gate middleware — Gate 2 (API key)**: After JWT success, the middleware MUST require `X-Scenecraft-API-Key`. Missing → 401. Present → middleware loads all `api_keys` WHERE `username = JWT.sub AND revoked_at IS NULL AND expires_at > now_utc_iso`, and for each row computes `PBKDF2(raw, salt_from_row, 600_000)` comparing to stored `key_hash`. First equal hash wins; no match → 401 "Invalid API key or session/key user mismatch".

**R13. Double-gate middleware — must_change_password**: After Gate 2, if `users.must_change_password = 1` → 403 `PASSWORD_CHANGE_REQUIRED`.

**R14. Double-gate middleware — org resolution**: Precedence is (a) `X-Scenecraft-Org` header if the user is a member of it (else 400 `ORG_NOT_FOUND`); (b) else `payload.last_active_org` if user is still a member; (c) else if the user belongs to exactly one org, use that; (d) else 400 `AMBIGUOUS_ORG`.

**R15. Auth context attachment**: On success, middleware MUST set `handler_self._paid_auth_ctx = PaidPluginAuthContext(username, org, api_key_id)` and invoke the wrapped handler. Wrapper MUST preserve `__name__` and `__doc__`.

**R16. User creation flag**: `bootstrap.create_user(root, username, pubkey="", role="editor")` MUST insert a row with `must_change_password = 1` (always), `pubkey_fingerprint = sha256(pubkey).hexdigest()[:16]` iff pubkey given else `""`. The `users.pubkey_fingerprint` column carries a `UNIQUE` constraint (per OQ-5 — 2^64 space is safe for <10k users; free safety); duplicate fingerprint inserts raise `sqlite3.IntegrityError`. `init_root` MUST insert its admin user without setting `must_change_password` (uses the default `0` path because it does not go through `create_user`). `user_set_password` MUST clear the flag.

**R17. Role enum**: `users.role` MUST be one of `admin | editor | viewer` (CLI `--role` choice). `org_members.role` MUST be one of `admin | editor | viewer` — canonical enum per OQ-12 (the legacy `member` value is dropped). CLI default + `init_root` for a non-founding admin use `editor`; `init_root` for the founding admin uses `admin`. A `CHECK` constraint on the column enforces the enum.

**R18. Schema preservation**: `get_server_db` MUST be idempotent: on every call it applies `SERVER_DB_SCHEMA` with `CREATE TABLE IF NOT EXISTS`, and — as a live migration — adds `must_change_password INTEGER NOT NULL DEFAULT 0` to `users` if a probe SELECT raises `OperationalError`.

**R19. Exempt paths for non-paid-plugin middleware**: The general REST/WS auth middleware (outside `require_paid_plugin_auth`) MUST allow unauthenticated access to exactly: `/auth/login`, `/auth/logout`, `/oauth/callback`. All other routes MUST require a valid JWT (via bearer or cookie). (This spec describes the exempt set; the general middleware itself lives in `api_server.py` and is covered elsewhere — this requirement fixes the list.)

**R20. Cookie sliding expiration**: When a request arrives with a valid cookie token, the server SHOULD re-issue the cookie with a fresh `Max-Age = TOKEN_EXPIRY_HOURS*3600` to implement sliding session expiry. (See OQ-9 for the invariant this spec does not pin down.)

---

## Interfaces / Data Shapes

### JWT payload (decoded)

```json
{
  "sub": "alice",
  "fingerprint": "3f9a1b2c4d5e6f70",
  "role": "editor",
  "iat": 1745712000,
  "exp": 1745798400
}
```

Notes: `fingerprint` may be `""` for users created without a pubkey. `last_active_org` is an optional forward-compat claim consulted by the middleware but not written by `generate_token` today (see OQ-3).

### Cookie

```
Set-Cookie: scenecraft_jwt=<jwt>; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400[; Secure]
```

### `X-Scenecraft-API-Key` header

Raw URL-safe token (43 chars from `secrets.token_urlsafe(32)`). Compared by hashing with the matching row's salt.

### `api_keys` row

| col | type | notes |
|---|---|---|
| id | TEXT PK | `ak_` + 12 hex |
| username | TEXT FK | `ON DELETE CASCADE` |
| key_hash | TEXT | hex PBKDF2 output |
| salt | TEXT | 16-byte salt, hex-encoded |
| issued_by | TEXT | username who issued (self via CLI) |
| issued_at | TEXT | ISO-8601 UTC |
| expires_at | TEXT | ISO-8601 UTC |
| revoked_at | TEXT? | ISO-8601 UTC or NULL |
| label | TEXT? | optional human label |

### `users` row

| col | type | notes |
|---|---|---|
| username | TEXT PK | — |
| pubkey_fingerprint | TEXT | `""` if no pubkey, else 16-char truncated SHA-256 hex |
| pubkey | TEXT | full pubkey text; `""` if none |
| created_at | TEXT | ISO-8601 UTC |
| role | TEXT | `admin` / `editor` / `viewer`; default `editor` |
| must_change_password | INTEGER | 0/1; default 0; set to 1 by `create_user` |

### `orgs`, `org_members`

```
orgs (name PK, created_at)
org_members (org FK, username FK, role DEFAULT 'member', joined_at, PRIMARY KEY (org, username))
```

### `login_codes`

```
login_codes (code TEXT PK, token TEXT, expires_at INTEGER)  -- unix seconds
```

### `PaidPluginAuthContext`

```python
@dataclass
class PaidPluginAuthContext:
    username: str
    org: str
    api_key_id: str
```

### Error codes (string `code` field on `_error(status, code, msg)`)

| HTTP | code | when |
|---|---|---|
| 401 | `UNAUTHORIZED` | gate 1 or gate 2 failure |
| 403 | `PASSWORD_CHANGE_REQUIRED` | `must_change_password = 1` |
| 400 | `ORG_NOT_FOUND` | header org exists-but-not-a-member |
| 400 | `AMBIGUOUS_ORG` | multi-org user, no resolvable hint |

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | `generate_token` for a registered user | Returns HS256 JWT with `sub`/`fingerprint`/`role`/`iat`/`exp`; `exp = iat + 86400` | `generate-token-happy`, `generate-token-claims` |
| 2 | `generate_token` for unknown user | Raises `ValueError` with "Ask an admin to run: …" | `generate-token-unknown-user` |
| 3 | `validate_token` on fresh token | Returns decoded payload dict | `validate-token-fresh` |
| 4 | `validate_token` on expired token | Raises `jwt.ExpiredSignatureError` | `validate-token-expired` |
| 5 | `validate_token` on tampered token | Raises `jwt.InvalidTokenError` | `validate-token-tampered` |
| 6 | First call with no `secret.key` | Generates 64-hex-char secret, writes file mode `0o600` | `secret-key-autogen` |
| 7 | Subsequent calls | Reads existing secret, never rewrites | `secret-key-stable` |
| 8 | `build_cookie_header(t)` | `scenecraft_jwt=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` (no Secure) | `cookie-default` |
| 9 | `build_cookie_header(t, secure=True)` | Appends `; Secure` | `cookie-secure-flag` |
| 10 | `build_clear_cookie_header()` | Emits cookie with empty value and `Max-Age=0` | `cookie-clear` |
| 11 | `extract_bearer_token("Bearer abc")` | Returns `"abc"` | `bearer-happy` |
| 12 | `extract_bearer_token("bearer abc")` | Returns `"abc"` (case-insensitive scheme) | `bearer-case-insensitive` |
| 13 | `extract_bearer_token(None)` or malformed | Returns `None` | `bearer-none`, `bearer-malformed` |
| 14 | `extract_cookie_token("scenecraft_jwt=abc; other=x")` | Returns `"abc"` | `cookie-extract-happy` |
| 15 | `extract_cookie_token` without the named cookie | Returns `None` | `cookie-extract-absent` |
| 16 | `create_login_code` | Inserts row, returns 24-byte urlsafe code, GCs expired rows | `login-code-create` |
| 17 | `consume_login_code` with valid code | Returns JWT, deletes row | `login-code-consume-happy` |
| 18 | `consume_login_code` with expired code | Returns `None`, still deletes row | `login-code-expired` |
| 19 | `consume_login_code` with unknown code | Returns `None` | `login-code-unknown` |
| 20 | `consume_login_code` twice on same code | Second call returns `None` | `login-code-single-use` |
| 21 | `auth keys issue` happy path | Prints `Key ID`, `API Key`, `Expires`, persists PBKDF2(600k) hash + salt; raw key printed once | `keys-issue-happy`, `keys-issue-hash-iterations`, `keys-issue-prints-once` |
| 22 | `auth keys issue` for unknown user | Exits 1 with error | `keys-issue-unknown-user` |
| 23 | `auth keys issue --expires badformat` | Exits 1 | `keys-issue-bad-expiry` |
| 24 | `auth keys list` | Prints metadata only; never shows `key_hash` or `salt` | `keys-list-no-secrets` |
| 25 | `auth keys revoke` active key | Sets `revoked_at = now` | `keys-revoke-active` |
| 26 | `auth keys revoke` already revoked | Idempotent message, no error | `keys-revoke-idempotent` |
| 27 | `auth keys revoke` unknown id | Exits 1 | `keys-revoke-unknown` |
| 28 | Double-gate: no cookie, no bearer, no API key header | 401 `UNAUTHORIZED` "Missing session token" | `dg-no-token` |
| 29 | Double-gate: bearer present but invalid | 401 "Invalid or expired session token" | `dg-bad-jwt` |
| 30 | Double-gate: bearer valid, no API key header | 401 "Missing X-Scenecraft-API-Key header" | `dg-no-apikey` |
| 31 | Double-gate: JWT sub = alice, API key belongs to bob | 401 "Invalid API key or session/key user mismatch" | `dg-user-mismatch` |
| 32 | Double-gate: JWT + API key both valid, `must_change_password=1` | 403 `PASSWORD_CHANGE_REQUIRED` | `dg-must-change-password` |
| 33 | Double-gate: valid, user in exactly one org, no header | Resolves org to that sole org | `dg-single-org` |
| 34 | Double-gate: valid, `X-Scenecraft-Org` header, user is a member | Resolves to header org | `dg-header-org` |
| 35 | Double-gate: valid, `X-Scenecraft-Org` header, user is NOT a member | 400 `ORG_NOT_FOUND` | `dg-header-org-notmember` |
| 36 | Double-gate: valid, user in N>1 orgs, no header, no `last_active_org` | 400 `AMBIGUOUS_ORG` | `dg-ambiguous-org` |
| 37 | Double-gate: valid, `last_active_org` claim present and still a member | Resolves to that org | `dg-last-active-org` |
| 38 | Double-gate: happy path | Attaches `_paid_auth_ctx`, calls handler; wrapper preserves `__name__`/`__doc__` | `dg-happy-attaches-ctx`, `dg-wrapper-metadata` |
| 39 | `create_user` default | `must_change_password = 1` | `user-add-must-change` |
| 40 | `create_user` with pubkey | `pubkey_fingerprint = sha256(pubkey)[:16]` | `user-add-fingerprint` |
| 41 | `init_root` founding admin | Inserted with role `admin`, added to org_members as `admin` | `init-root-admin` |
| 42 | `user set-password` | Clears `must_change_password` to 0 | `user-set-password` |
| 43 | Migration: existing `users` table without `must_change_password` | `get_server_db` adds the column with default 0 | `schema-migration-must-change` |
| 44 | Exempt paths outside double-gate | `/auth/login`, `/auth/logout`, `/oauth/callback` reachable without JWT | `exempt-paths-reachable` |
| 45 | Role values accepted by CLI | Exactly `admin`, `editor`, `viewer` | `role-enum-cli` |
| 46 | Bearer AND cookie both present with different tokens | Bearer wins; cookie ignored when `Authorization` header is present (codified per OQ-1) | `bearer-and-cookie-bearer-wins` |
| 47 | JWT signed with an old secret after `secret.key` is regenerated | Stale-secret tokens treated as expired → force re-login; no grace period (secret regen nukes sessions) | `old-secret-token-forces-relogin` |
| 48 | Two concurrent `generate_token` calls for the same user in the same second | Distinct tokens via added `jti` (uuid4) claim | `concurrent-token-generation-jti-differs` |
| 49 | API key used after its owning user is deleted | **Deferred** — user-deletion feature not built yet | → [OQ-4](#open-questions) |
| 50 | Pubkey fingerprint collision within 16-char SHA-256 truncation | Prevented by `UNIQUE` constraint on `users.pubkey_fingerprint`; colliding insert raises IntegrityError | `fingerprint-unique-constraint-enforced` |
| 51 | Login code submitted a second time (explicit double-submit race) | `BEGIN IMMEDIATE` wraps SELECT→DELETE; at-most-once guaranteed; losing call returns `None` | `login-code-concurrent-double-submit-at-most-once` |
| 52 | JWT expired within clock-skew window (±30s) | Accepted within 30s leeway via `jwt.decode(..., leeway=30)` | `clock-skew-within-leeway-accepted` |
| 53 | API key `expires_at < now` on list | `keys list` shows computed `status` = `expired` (alongside `revoked` / `active`) | `keys-list-computes-expired-status` |
| 54 | Sliding cookie expiration — does server re-issue cookie on each auth'd request? | **Deferred** — verify actual api_server.py behavior first | → [OQ-9](#open-questions) |
| 55 | Two concurrent API-key issuances for the same user with the same raw key (secrets collision) | No UNIQUE index on `(username, key_hash)`; both rows persist; Gate 2 returns whichever sorts first (cost > benefit to enforce) | `api-key-hash-no-uniqueness-constraint` |

---

## Behavior (step-by-step)

### SSH-to-browser login handshake

1. Operator runs `scenecraft token --user alice` on the remote machine.
2. CLI calls `generate_token(sc_root, "alice")` → JWT.
3. CLI calls `create_login_code(sc_root, jwt)`; login code `c` stored with `expires_at = now+300s`.
4. CLI prints `http(s)://<host>/auth/login?code=c` and optionally opens browser.
5. Browser GETs `/auth/login?code=c`. Handler calls `consume_login_code(sc_root, c)`. Row is deleted regardless; returns JWT iff row existed and was unexpired.
6. On success, handler responds with `Set-Cookie: scenecraft_jwt=<jwt>; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` and redirects to `redirect_uri` if provided.
7. All subsequent browser requests carry the cookie, extracted by `extract_cookie_token`.

### Double-gate request lifecycle

1. Incoming request to a `@require_paid_plugin_auth`-decorated handler.
2. Middleware reads `Authorization`; if no Bearer, reads `Cookie` for `scenecraft_jwt`. Missing → 401.
3. `validate_token` → payload. Invalid → 401. No `sub` → 401.
4. `X-Scenecraft-API-Key` required. Missing → 401.
5. For each non-revoked, non-expired key of `payload.sub`, hash raw against that row's salt with PBKDF2(600k). First match → `api_key_id`. No match → 401.
6. Check `users.must_change_password`; if 1 → 403.
7. Resolve org: header → last_active_org claim → single-org shortcut → 400 AMBIGUOUS_ORG.
8. Attach `_paid_auth_ctx = PaidPluginAuthContext(username, org, api_key_id)`; call handler.

### API key issuance

1. Admin or user runs `scenecraft auth keys issue <username> --expires YYYY-MM-DD [--label L]`.
2. Verify `users.username` exists (else exit 1).
3. Parse expiry as UTC midnight (else exit 1).
4. Generate `raw_key` (`token_urlsafe(32)`), `salt` (16 random bytes), `key_id = "ak_" + uuid4().hex[:12]`.
5. `key_hash = PBKDF2-HMAC-SHA256(raw_key, salt, 600_000).hex()`.
6. INSERT row. Commit. Close.
7. Print key_id, raw key, expiry, optional label, and the "store securely — will NOT be shown again" notice.

---

## Acceptance Criteria

- [ ] All R1–R19 requirements have at least one passing test.
- [ ] The Behavior Table rows 46–55 remain `undefined` in tests — they MUST NOT be silently pinned to current behavior. If a product decision is made, update this spec first, then add a test.
- [ ] `.scenecraft/secret.key` is never logged, printed, or included in a response body.
- [ ] Raw API keys are never logged or persisted beyond the one-time print in `keys issue`.
- [ ] No test inspects or depends on the PBKDF2 iteration count by timing — the count is asserted structurally (R8).
- [ ] Error HTTP status codes match the table exactly (401 vs 403 vs 400 — not conflated).
- [ ] The double-gate wrapper preserves `__name__` and `__doc__` so REST routing introspection keeps working.

---

## Tests

### Base Cases

#### Test: generate-token-happy (covers R1, R2)

**Given**: A `.scenecraft` root with user `alice` (role `editor`, empty pubkey).
**When**: `generate_token(sc_root, "alice")` is called.
**Then**:
- **returns-string**: return value is a non-empty string containing two `.` separators.
- **decodes-with-secret**: `validate_token` on the result returns a payload dict.

#### Test: generate-token-claims (covers R2)

**Given**: User `alice`, role `editor`, pubkey_fingerprint `3f9a…` (16 chars).
**When**: `generate_token(sc_root, "alice")` called at time T.
**Then**:
- **sub-matches**: `payload["sub"] == "alice"`.
- **role-matches**: `payload["role"] == "editor"`.
- **fingerprint-matches**: `payload["fingerprint"] == users.pubkey_fingerprint`.
- **exp-is-iat-plus-24h**: `payload["exp"] - payload["iat"] == 86400`.
- **iat-within-second**: `abs(payload["iat"] - T_unix) <= 1`.
- **jti-present**: `payload["jti"]` is a 32-char hex string (uuid4).

#### Test: generate-token-unknown-user (covers R2 bad path)

**Given**: No row in `users` for username `ghost`.
**When**: `generate_token(sc_root, "ghost")` called.
**Then**:
- **raises-valueerror**: `ValueError` raised.
- **message-mentions-admin-cmd**: error message contains `scenecraft vcs user add ghost`.
- **no-row-created**: `users` row count unchanged.

#### Test: validate-token-fresh (covers R3)

**Given**: JWT minted with current secret, `exp > now`.
**When**: `validate_token` called.
**Then**:
- **returns-payload**: returns dict with `sub`, `fingerprint`, `role`, `iat`, `exp`.

#### Test: validate-token-expired (covers R3)

**Given**: JWT minted with `exp < now`.
**When**: `validate_token` called.
**Then**:
- **raises-expired**: raises `jwt.ExpiredSignatureError`.
- **username-helper-returns-none**: `get_username_from_token` returns `None` for the same input.

#### Test: validate-token-tampered (covers R3)

**Given**: A valid JWT with one character in the signature flipped.
**When**: `validate_token` called.
**Then**:
- **raises-invalidtoken**: raises `jwt.InvalidTokenError` (or subclass).
- **username-helper-returns-none**: `get_username_from_token` returns `None`.

#### Test: secret-key-autogen (covers R1)

**Given**: `.scenecraft` root with no `secret.key` file.
**When**: `_get_secret` invoked (e.g., indirectly via `generate_token`).
**Then**:
- **file-exists**: `secret.key` now exists.
- **length-64-hex**: contents are 64 hexadecimal characters.
- **mode-0600**: file permissions are `0o600` (owner read/write only).

#### Test: secret-key-stable (covers R1)

**Given**: `secret.key` already written with known contents S.
**When**: `_get_secret` called twice more.
**Then**:
- **contents-unchanged**: file contents remain S.
- **returns-same-secret**: both calls return S (stripped).

#### Test: cookie-default (covers R4)

**Given**: A token string `abc.def.ghi`.
**When**: `build_cookie_header("abc.def.ghi")`.
**Then**:
- **format**: result equals `scenecraft_jwt=abc.def.ghi; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`.

#### Test: cookie-secure-flag (covers R4)

**Given**: Same token.
**When**: `build_cookie_header(token, secure=True)`.
**Then**:
- **ends-with-secure**: result ends with `; Secure`.

#### Test: cookie-clear (covers R4)

**When**: `build_clear_cookie_header()`.
**Then**:
- **equals**: result is `scenecraft_jwt=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`.

#### Test: bearer-happy (covers R5)

**When**: `extract_bearer_token("Bearer abc")`.
**Then**: **returns-abc**.

#### Test: bearer-case-insensitive (covers R5)

**When**: `extract_bearer_token("bearer abc")` and `extract_bearer_token("BEARER abc")`.
**Then**: **both-return-abc**.

#### Test: bearer-none (covers R5)

**When**: `extract_bearer_token(None)`.
**Then**: **returns-none**.

#### Test: bearer-malformed (covers R5)

**When**: `extract_bearer_token("Token xyz")` and `extract_bearer_token("Bearer")` (no value).
**Then**: **both-return-none**.

#### Test: cookie-extract-happy (covers R5)

**When**: `extract_cookie_token("scenecraft_jwt=abc; other=x")`.
**Then**: **returns-abc**.

#### Test: cookie-extract-absent (covers R5)

**When**: `extract_cookie_token("other=x")` and `extract_cookie_token(None)`.
**Then**: **both-return-none**.

#### Test: login-code-create (covers R6)

**Given**: A fresh `.scenecraft` root.
**When**: `create_login_code(sc_root, "some.jwt.here")` called.
**Then**:
- **returns-urlsafe-code**: return value is a URL-safe string of ≥ 32 characters.
- **row-persisted**: a row exists in `login_codes` with `token = "some.jwt.here"`.
- **expires-in-5-min**: `expires_at - now ≈ 300` (within 2s).

#### Test: login-code-consume-happy (covers R7)

**Given**: Code `c` created 1s ago for token `t`.
**When**: `consume_login_code(sc_root, c)`.
**Then**:
- **returns-t**: return value equals `t`.
- **row-deleted**: row `c` no longer in `login_codes`.

#### Test: login-code-expired (covers R7)

**Given**: Row `c` exists with `expires_at` in the past.
**When**: `consume_login_code(sc_root, c)`.
**Then**:
- **returns-none**: return value is `None`.
- **row-deleted**: row `c` is deleted regardless.

#### Test: login-code-unknown (covers R7)

**When**: `consume_login_code(sc_root, "never-existed")`.
**Then**: **returns-none**.

#### Test: login-code-single-use (covers R7)

**Given**: Code `c` consumed once successfully.
**When**: `consume_login_code(sc_root, c)` called a second time.
**Then**:
- **returns-none**: second call returns `None`.

#### Test: keys-issue-happy (covers R8)

**Given**: User `alice` exists.
**When**: CLI `scenecraft auth keys issue alice --expires 2027-01-01 --label laptop`.
**Then**:
- **exit-0**: command exits 0.
- **prints-key-id**: stdout contains `Key ID:    ak_` followed by 12 hex chars.
- **prints-raw-key**: stdout contains `API Key:` followed by a 43-char urlsafe string.
- **prints-expiry**: stdout contains `Expires:   2027-01-01`.
- **prints-label**: stdout contains `Label:     laptop`.
- **prints-one-time-warning**: stdout contains `will NOT be shown again`.
- **row-persisted**: `api_keys` has a matching row with `username="alice"`, `label="laptop"`, `expires_at` iso for 2027-01-01 UTC, `revoked_at IS NULL`.
- **hash-not-raw**: persisted `key_hash` != raw key.
- **salt-is-hex-32**: `salt` column is 32 hex chars (16 bytes).

#### Test: keys-issue-hash-iterations (covers R8, R12)

**Given**: A known raw key, salt, and persisted hash.
**When**: `hash_api_key(raw, salt_bytes)` is recomputed.
**Then**:
- **matches-persisted**: result equals persisted `key_hash`.
- **iterations-constant**: `PBKDF2_ITERATIONS == 600_000`.

#### Test: keys-issue-prints-once (covers R8 negative)

**Given**: Issuance completed for `alice`.
**When**: Any later code path is inspected.
**Then**:
- **raw-not-in-db**: raw key string does NOT appear in any persisted column (DB scan across all tables).
- **raw-not-in-log**: raw key string does NOT appear in process logs after issuance.

#### Test: keys-issue-unknown-user (covers R8 bad path)

**When**: `scenecraft auth keys issue ghost --expires 2027-01-01`.
**Then**:
- **exit-1**.
- **no-row-inserted**: `api_keys` unchanged.

#### Test: keys-issue-bad-expiry (covers R8 bad path)

**When**: `scenecraft auth keys issue alice --expires tomorrow`.
**Then**:
- **exit-1**.
- **error-message-format**: stderr mentions `YYYY-MM-DD`.

#### Test: keys-list-no-secrets (covers R9 negative)

**Given**: `alice` has one key.
**When**: `scenecraft auth keys list alice`.
**Then**:
- **prints-id-and-label**: stdout contains the key's `id`, `issued_at`, `expires_at`, `status`, optional `label`.
- **does-not-print-hash**: `key_hash` value does not appear in stdout.
- **does-not-print-salt**: `salt` value does not appear in stdout.

#### Test: keys-revoke-active (covers R10)

**Given**: Active key `ak_x`.
**When**: `scenecraft auth keys revoke ak_x`.
**Then**:
- **exit-0**.
- **revoked-at-set**: row's `revoked_at` equals `now_iso` (within 2s).
- **next-double-gate-fails**: a request using this raw key now returns 401.

#### Test: keys-revoke-idempotent (covers R10)

**Given**: Key already revoked yesterday.
**When**: Revoke again.
**Then**:
- **exit-0**.
- **no-overwrite**: `revoked_at` is NOT updated to a newer timestamp.
- **message-already-revoked**: stdout contains "already revoked".

#### Test: keys-revoke-unknown (covers R10 bad path)

**When**: `scenecraft auth keys revoke ak_nope`.
**Then**: **exit-1**.

#### Test: dg-no-token (covers R11)

**Given**: Request with no `Authorization`, no `Cookie`, no `X-Scenecraft-API-Key`.
**When**: Decorated handler invoked.
**Then**:
- **status-401**.
- **code-UNAUTHORIZED**.
- **message-missing-session-token**.
- **handler-not-called**: wrapped handler body did not execute.

#### Test: dg-bad-jwt (covers R11)

**Given**: Bearer token with tampered signature.
**When**: Handler invoked.
**Then**:
- **status-401**, **code-UNAUTHORIZED**, **message-invalid-or-expired**.

#### Test: dg-no-apikey (covers R12)

**Given**: Valid JWT, no `X-Scenecraft-API-Key`.
**When**: Handler invoked.
**Then**: **status-401**, **code-UNAUTHORIZED**, **message-missing-api-key**.

#### Test: dg-user-mismatch (covers R12)

**Given**: JWT for `alice`, but provided raw key belongs to `bob`.
**When**: Handler invoked.
**Then**:
- **status-401**.
- **message-user-mismatch**: error message contains `Invalid API key or session/key user mismatch`.
- **no-context-attached**: `_paid_auth_ctx` not set on handler.

#### Test: dg-must-change-password (covers R13)

**Given**: Valid JWT + API key for `alice`; `users.must_change_password = 1`.
**When**: Handler invoked.
**Then**:
- **status-403**.
- **code-PASSWORD_CHANGE_REQUIRED**.

#### Test: dg-single-org (covers R14 c)

**Given**: `alice` member of exactly `acme`; no header; JWT has no `last_active_org`.
**When**: Handler invoked.
**Then**:
- **ctx-org-acme**: `_paid_auth_ctx.org == "acme"`.
- **handler-called**.

#### Test: dg-header-org (covers R14 a)

**Given**: `alice` in `acme` and `globex`; header `X-Scenecraft-Org: globex`.
**When**: Handler invoked.
**Then**: **ctx-org-globex**, **handler-called**.

#### Test: dg-header-org-notmember (covers R14 a bad path)

**Given**: Header `X-Scenecraft-Org: globex`, but alice is NOT a member.
**When**: Handler invoked.
**Then**: **status-400**, **code-ORG_NOT_FOUND**.

#### Test: dg-ambiguous-org (covers R14 d)

**Given**: `alice` in 2 orgs, no header, JWT has no `last_active_org`.
**When**: Handler invoked.
**Then**: **status-400**, **code-AMBIGUOUS_ORG**.

#### Test: dg-last-active-org (covers R14 b)

**Given**: JWT payload contains `last_active_org: "acme"`; alice still in `acme`; no header; alice in 3 orgs.
**When**: Handler invoked.
**Then**: **ctx-org-acme**.

#### Test: dg-happy-attaches-ctx (covers R15)

**Given**: Valid JWT + API key + resolvable org.
**When**: Handler invoked.
**Then**:
- **handler-called**: the wrapped body ran.
- **ctx-username**: `_paid_auth_ctx.username == payload.sub`.
- **ctx-org-set**: `_paid_auth_ctx.org` is non-empty.
- **ctx-api-key-id-set**: `_paid_auth_ctx.api_key_id` matches the DB row id.

#### Test: dg-wrapper-metadata (covers R15 negative)

**Given**: A handler function `foo` wrapped with `require_paid_plugin_auth`.
**Then**:
- **name-preserved**: `wrapped.__name__ == "foo"`.
- **doc-preserved**: `wrapped.__doc__ == foo.__doc__`.

#### Test: user-add-must-change (covers R16)

**When**: `create_user(root, "alice")` called.
**Then**: **must-change-password-is-1**: `users.must_change_password == 1` for alice.

#### Test: user-add-fingerprint (covers R16)

**When**: `create_user(root, "alice", pubkey="ssh-ed25519 AAAA…")` called.
**Then**:
- **fingerprint-16-chars**: `pubkey_fingerprint` is exactly 16 hex characters.
- **fingerprint-is-truncated-sha256**: equals `sha256(pubkey).hexdigest()[:16]`.

#### Test: init-root-admin (covers R16, R17)

**Given**: Fresh directory.
**When**: `init_root(root, org_name="acme", admin_username="alice")`.
**Then**:
- **user-alice-admin**: `users` row has `role="admin"`, `must_change_password=0`.
- **org-acme-exists**.
- **membership-admin**: `org_members` row has `role="admin"`.

#### Test: user-set-password (covers R16)

**Given**: alice with `must_change_password=1`.
**When**: `scenecraft user set-password alice`.
**Then**:
- **exit-0**.
- **flag-cleared**: `must_change_password=0`.

#### Test: schema-migration-must-change (covers R18)

**Given**: An existing `server.db` whose `users` table was created before the M16 migration (no `must_change_password` column).
**When**: `get_server_db(root)` called.
**Then**:
- **column-exists**: `PRAGMA table_info(users)` lists `must_change_password`.
- **default-zero**: existing rows have value `0`.

#### Test: exempt-paths-reachable (covers R19)

**Given**: The non-paid-plugin middleware is in effect; no auth headers or cookies.
**When**: Requests are made to `/auth/login`, `/auth/logout`, `/oauth/callback`, and any other path.
**Then**:
- **login-not-401**: `/auth/login` does NOT return 401 (exempt).
- **logout-not-401**.
- **oauth-callback-not-401**.
- **other-path-401**: a sample protected path returns 401.

#### Test: role-enum-cli (covers R17)

**When**: `scenecraft user add alice --role superuser`.
**Then**:
- **click-usage-error**: exit non-zero with Click's "invalid choice" message.
- **valid-choices-accepted**: `--role admin|editor|viewer` all succeed.

### Edge Cases

#### Test: old-secret-token-forces-relogin (covers OQ-2, R3)

**Given**: JWT signed with secret S1; `secret.key` is replaced with S2.
**When**: `validate_token(token)` called with the old token.
**Then**:
- **raises-invalid**: raises `jwt.InvalidTokenError` (signature mismatch)
- **username-helper-returns-none**: `get_username_from_token` returns `None` — caller treats as force-re-login
- **no-grace**: no code path accepts the old-secret token after regen

#### Test: concurrent-token-generation-jti-differs (covers OQ-3, R2)

**Given**: Two threads call `generate_token(sc_root, "alice")` at the same wall-clock second.
**When**: Both complete.
**Then**:
- **tokens-distinct**: the two returned token strings are NOT byte-identical
- **jti-differs**: decoded `payload["jti"]` differs between the two
- **both-valid**: both pass `validate_token`

#### Test: jwt-payload-includes-jti (covers R2, OQ-3)

**Given**: Fresh `generate_token` call.
**Then**:
- **jti-uuid4-hex**: `payload["jti"]` matches `^[0-9a-f]{32}$` (uuid4 hex)

#### Test: fingerprint-unique-constraint-enforced (covers R16, OQ-5)

**Given**: User `alice` already has `pubkey_fingerprint='deadbeefcafef00d'`.
**When**: `create_user(root, "bob", pubkey=<crafted pubkey whose sha256 prefix collides>)` is called with a pubkey whose sha256 first-16 would equal alice's fingerprint.
**Then**:
- **raises-integrity**: raises `sqlite3.IntegrityError` (UNIQUE violation)
- **no-bob-row**: `users` has no row for `bob`

#### Test: login-code-concurrent-double-submit-at-most-once (covers R7, OQ-6)

**Given**: A valid login-code `c` in the table. Two threads / connections call `consume_login_code(sc_root, c)` concurrently.
**When**: Both complete.
**Then**:
- **exactly-one-returns-token**: exactly one of the calls returns the JWT; the other returns `None`
- **row-deleted**: row `c` is gone from `login_codes`
- **no-dup-jwt**: only one successful browser login possible

#### Test: clock-skew-within-leeway-accepted (covers R3, OQ-7)

**Given**: JWT whose `exp` is 15 seconds in the past (within the 30s leeway).
**When**: `validate_token(token)` called.
**Then**:
- **returns-payload**: returns decoded payload
- **no-raise**: does NOT raise `ExpiredSignatureError`

#### Test: clock-skew-beyond-leeway-rejected (covers R3, OQ-7)

**Given**: JWT whose `exp` is 60 seconds in the past (beyond leeway).
**When**: `validate_token(token)` called.
**Then**:
- **raises-expired**: raises `jwt.ExpiredSignatureError`

#### Test: keys-list-computes-expired-status (covers R9, OQ-8)

**Given**: Three keys for `alice`: one active (expires tomorrow, revoked_at NULL), one expired (expires yesterday, revoked_at NULL), one revoked (revoked_at set).
**When**: `scenecraft auth keys list alice`.
**Then**:
- **active-status**: active key's printed status is `active`
- **expired-status**: expired-but-not-revoked key's printed status is `expired`
- **revoked-status**: revoked key's printed status is `revoked`

#### Test: api-key-hash-no-uniqueness-constraint (covers OQ-10)

**Given**: The `api_keys` table schema.
**When**: inspected.
**Then**:
- **no-unique-hash-index**: no `UNIQUE` index / constraint on `(username, key_hash)` or on `key_hash` alone
- **rationale-in-spec**: this is codified as intentional per OQ-10 resolution

#### Test: bearer-and-cookie-bearer-wins (covers R11, OQ-1)

**Given**: Request with BOTH `Authorization: Bearer <tokenA>` AND `Cookie: scenecraft_jwt=<tokenB>` where `tokenA != tokenB`; `tokenA` is valid for alice; `tokenB` is valid for bob.
**When**: Double-gate invoked (with matching `X-Scenecraft-API-Key` for alice).
**Then**:
- **handler-called**: handler runs
- **ctx-username-alice**: `_paid_auth_ctx.username == "alice"` (bearer path)
- **cookie-ignored**: bob's cookie token is never decoded

#### Test: keys-issue-raw-has-sck-prefix (covers R8, OQ-14)

**Given**: `scenecraft auth keys issue alice --expires 2027-01-01` runs.
**Then**:
- **raw-starts-with-sck**: printed `API Key:` begins with `sck_`
- **length**: total length is `4 + 43 = 47` chars (prefix + urlsafe 32-byte)

#### Test: keys-issue-admin-on-behalf-issued-by-admin (covers R8, OQ-13)

**Given**: Admin `root` runs `scenecraft auth keys issue alice --expires 2027-01-01`.
**When**: Row is persisted.
**Then**:
- **username-is-target**: `api_keys.username = "alice"`
- **issued-by-is-caller**: `api_keys.issued_by = "root"`

#### Test: org-members-role-enum-accepted (covers R17, OQ-12)

**Given**: `create_user("alice")` + `create_org("acme")`.
**When**: inserting `org_members` rows with `role` ∈ `{admin, editor, viewer}`.
**Then**:
- **all-accepted**: each insert succeeds

#### Test: org-members-role-enum-rejected (covers R17, OQ-12)

**Given**: Same fixtures.
**When**: inserting `org_members` row with `role='member'` (legacy value).
**Then**:
- **raises-check**: raises `sqlite3.IntegrityError` (CHECK violation)

#### Test: no-concurrency-invariant (covers R1–R19 negative)

**Given**: The auth module as a whole.
**Then**:
- **no-shared-mutable-state**: there is no in-process caching of users, tokens, or keys; every call re-reads `server.db` via `get_server_db`. This is asserted to prevent future "optimizations" from introducing stale-data bugs.
- **no-file-locks**: neither `secret.key` nor `server.db` is taken under an explicit advisory lock in this module.

---

## Non-Goals

- **Secret rotation**: `.scenecraft/secret.key` is never rotated automatically and the spec deliberately does not require it.
- **Password-based login**: `must_change_password` is currently a flag without a set-password flow (only `user set-password` clears the flag; there is no password column).
- **Per-request rate limiting on Gate 2**: A valid-looking raw key triggers PBKDF2 work against every candidate row; this is accepted because per-user key count is single-digit in practice.
- **Revocation of all keys on user role downgrade**: Role changes do NOT cascade to existing API keys or JWTs.
- **JWT leeway / clock skew configuration** (see OQ-7): deliberately not spec'd.
- **OAuth/Remember bridge** token cache and refresh (covered in chat spec).

---

## Open Questions

### Resolved

**OQ-1 (resolved)**: Bearer + Cookie mismatch. **Decision**: bearer wins; cookie ignored entirely when `Authorization` header is present. Matches current code order. **Tests**: `bearer-and-cookie-bearer-wins`.

**OQ-2 (resolved)**: JWT signed under old secret after regen. **Decision**: stale-secret tokens are treated as expired → force re-login. No grace period — secret regen is a nuke-sessions event. **Tests**: `old-secret-token-forces-relogin`.

**OQ-3 (resolved)**: Concurrent token generation for same user. **Decision**: add `jti` (uuid4) claim to JWT payload. Same-second issuance produces byte-distinct tokens. **Tests**: `concurrent-token-generation-jti-differs`, `jwt-payload-includes-jti`.

**OQ-5 (resolved)**: Fingerprint collision. **Decision**: add `UNIQUE` constraint on `users.pubkey_fingerprint`. 64-bit space is safe for <10k users; free safety. **Tests**: `fingerprint-unique-constraint-enforced`.

**OQ-6 (resolved)**: Login-code double-submit race. **Decision**: wrap SELECT→DELETE in `BEGIN IMMEDIATE` — SQLite's only real at-most-once primitive. **Tests**: `login-code-concurrent-double-submit-at-most-once`.

**OQ-7 (resolved)**: Clock skew. **Decision**: add `leeway=30` to `jwt.decode`. Industry standard. **Tests**: `clock-skew-within-leeway-accepted`, `clock-skew-beyond-leeway-rejected`.

**OQ-8 (resolved)**: Expired-key listing. **Decision**: `keys list` shows computed `status` ∈ `{revoked, expired, active}`. Pure display. **Tests**: `keys-list-computes-expired-status`.

**OQ-10 (resolved)**: API key hash uniqueness. **Decision**: no `UNIQUE` index on `(username, key_hash)`. Cost > benefit given collision probability of ~2^-256. **Tests**: `api-key-hash-no-uniqueness-constraint`.

**OQ-12 (resolved)**: `org_members.role` semantics. **Decision**: canonical enum `admin | editor | viewer`; `member` dropped. CLI default + `init_root` (non-founding) use `editor`; founding admin uses `admin`. `CHECK` constraint enforces. **Tests**: `org-members-role-enum-accepted`, `org-members-role-enum-rejected`.

**OQ-13 (resolved)**: Self-issued vs admin-issued keys. **Decision**: `issued_by = <CLI caller>`, `username = <target>`. Fixes audit trail for admin-issued keys. **Tests**: `keys-issue-admin-on-behalf-issued-by-admin`.

**OQ-14 (resolved)**: Raw key format. **Decision**: prefix raw keys with `sck_` for GitHub secret-scanning. Final format: `sck_` + 43 urlsafe chars. **Tests**: `keys-issue-raw-has-sck-prefix`.

**OQ-15 (resolved)**: Re-revoke idempotency. **Decision**: re-revoke returns success WITHOUT updating `revoked_at` (preserves original timestamp). CI-friendly. **Tests**: `keys-revoke-idempotent` (already present, with added `no-overwrite` assertion).

### Deferred

- **OQ-4 — API key after user deletion** (row 49): **Deferred**: awaiting user-deletion feature. When deletion is designed, `ON DELETE CASCADE` coverage and revocation-audit semantics will be revisited.
- **OQ-9 — Sliding cookie re-issue** (row 54): **Deferred**: verify actual current behavior in `api_server.py` first. If the re-issue path is not shipped, mark R20 as explicit non-feature.
- **OQ-11 — `last_active_org` claim write path**: **Deferred**: awaiting future `/api/orgs/switch` endpoint — the only path that populates this claim. Spec will pin the write path then.

---

## Related Artifacts

- Audit #2 §1F units 6–11 — `/home/prmichaelsen/.acp/projects/scenecraft/agent/reports/audit-2-architectural-deep-dive.md`
- Spec (future) — `local.plugin-api-surface-and-r9a.md` — covers `record_spend` write path referenced from `PaidPluginAuthContext.api_key_id`.
- Spec (future) — `local.chat-tool-dispatch-and-elicitation.md` — covers OAuth/Remember bridge excluded here.
- Spec (future) — `local.vcs-object-store-commits-refs.md` — covers sessions/branches/commits that share `server.db` with auth.
- Source files:
  - `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/vcs/auth.py`
  - `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/auth_middleware.py`
  - `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/vcs/bootstrap.py`
  - `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/vcs/cli.py`

---

**Namespace**: local
**Spec**: auth-jwt-api-keys-double-gate
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive)
