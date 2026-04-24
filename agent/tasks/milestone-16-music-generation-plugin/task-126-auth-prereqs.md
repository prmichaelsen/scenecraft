# Task 126: Auth Layer Prerequisites

**Milestone**: [M16](../../milestones/milestone-16-music-generation-plugin.md)
**Spec**: `agent/specs/local.music-generation-plugin.md` — R54, R54a-f
**Design Reference**: `agent/design/local.scenecraft-online-platform.md` — "Double-gate auth on the box"
**Estimated Time**: 4 hours
**Dependencies**: M6 JWT + sessions (done)
**Status**: Not Started

---

## Objective

Extend M6's auth layer with the schema + middleware needed to enforce the spec's double-gate requirement. New surface: `api_keys` core table, `users.must_change_password` column, `X-Scenecraft-API-Key` header validation, key-expiry check, password-change gate, active-org resolution.

---

## Steps

### 1. Schema — `api_keys` table on `server.db`

```sql
CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,                                                    -- UUID; referenced by spend_ledger.api_key_id
    username     TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    key_hash     TEXT NOT NULL,                                                       -- bcrypt / argon2; never the raw key
    issued_by    TEXT NOT NULL,                                                       -- admin username
    issued_at    TEXT NOT NULL,
    expires_at   TEXT NOT NULL,                                                       -- ISO 8601; max 1 year from issued_at
    revoked_at   TEXT,                                                                -- NULL until revoked
    label        TEXT                                                                 -- optional free-text
);
CREATE INDEX idx_api_keys_username ON api_keys(username);
CREATE INDEX idx_api_keys_expires  ON api_keys(expires_at);
```

### 2. `users` column addition

```sql
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
```

(Default 0 for existing users; new provisions set it to 1.)

### 3. Auth middleware (backend)

Single middleware wraps the request-handler stack for paid-plugin routes (scope narrow in this task; broader rollout later):

1. Decode session JWT → resolve `username`. Reject 401 if absent/invalid.
2. Read `X-Scenecraft-API-Key` header. Reject 401 if absent.
3. Hash and look up in `api_keys` WHERE `username = <session.username>` AND `revoked_at IS NULL` AND `expires_at > now`. Reject 401 if not found.
4. If `users.must_change_password = 1` → reject 403 with body instructing password change.
5. Resolve active org:
   - If `X-Scenecraft-Org` header present AND user is in `org_members` for that org → use it.
   - Else if session has `last_active_org` AND user is still in that org → use it.
   - Else if user is in exactly one org → use it.
   - Else reject 400 "specify org via X-Scenecraft-Org header".
6. Attach `{username, org, api_key_id}` to request context for downstream handlers.

### 4. Admin CLI for key management

Commands under `scenecraft auth` or similar:

- `scenecraft auth keys issue <username> --expires <YYYY-MM-DD> [--label X]` → prints the raw key once; stores hash
- `scenecraft auth keys list <username>` → id, issued_at, expires_at, revoked_at, label
- `scenecraft auth keys revoke <key_id>` → sets `revoked_at = now`
- `scenecraft users create <username> [--org <name>]` → random default password (printed once); `must_change_password=1`
- `scenecraft users set-password <username>` → interactive; clears `must_change_password`

### 5. First-login password change flow

- Login endpoint checks `must_change_password`; if 1, returns session token flagged `requires_password_change`
- Frontend login view detects the flag and routes to a password-change screen before any editor routes
- Change-password endpoint updates hash + clears `must_change_password=0`

### 6. Tests

Backend tests (pytest-style, not code):

- `rejects-missing-session` → 401
- `rejects-missing-api-key-header` → 401
- `rejects-session-key-mismatch` (alice session + bob key) → 401
- `rejects-expired-api-key` → 401
- `rejects-revoked-api-key` → 401
- `forces-password-change-on-first-login` → 403
- `active-org-from-header` → 200, context.org matches header
- `active-org-from-session-fallback` → 200, context.org matches session
- `ambiguous-org-rejected` → 400
- `single-org-user-resolved-automatically` → 200

CLI smoke tests:

- `scenecraft auth keys issue` round-trips: issue → login + use key → revoke → key fails
- `scenecraft users create` produces a `must_change_password=1` row
- `scenecraft users set-password` clears the flag

---

## Verification

- [ ] `api_keys` table exists after schema migration
- [ ] `users.must_change_password` column exists with default 0
- [ ] Middleware blocks every scenario in the tests above with correct status codes
- [ ] Admin CLI commands all functional
- [ ] First-login UI correctly routes to password-change before editor
- [ ] No raw key values appear in logs, error responses, or DB columns
- [ ] `pbkdf2_sha256` or bcrypt/argon2 used for `key_hash` (NOT plain SHA)

---

## Notes

- This task's scope is the **middleware + schema**. Wiring every existing endpoint through the double-gate is intentionally OUT of scope — only paid-plugin endpoints (added by task-130) need it in M16. A broader rollout is a separate decision.
- Key rotation UX for admins is CLI-only in M16. A portal UI for rotation lands with scenecraft.online work.
- Out-of-session administrative tools (CLI runs) bypass the double-gate by design — those run with OS-level trust.
