# Task 30: SSH Auth System

**Objective**: Implement user authentication via SSH public keys and JWT token generation/validation
**Milestone**: M6 — Git-Style Version Control
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 6
**Status**: Not Started

---

## Context

Multi-user collaboration requires a secure authentication system. This task implements SSH public key registration in `server.db` and a JWT-based token flow. Users authenticate by running `scenecraft token`, which looks up their OS username in the registry, verifies their SSH key, and issues a signed JWT. The API server then validates this token on every request to identify the user and enforce access control.

Attribution is also critical for collaboration — every entity modification must record who made the change via a `last_modified_by` column.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Implement user registry in `server.db`:
   - Store `username`, SSH `pubkey` (full public key text), and `pubkey_fingerprint` for each user
   - Provide helper functions to register, look up, and list users

2. Implement the `scenecraft token` CLI command:
   - Read the current OS username (e.g., via `os.getlogin()` or `getpass.getuser()`)
   - Look up the user in `server.db`
   - Generate a JWT using PyJWT encoding the following claims: `username`, `pubkey_fingerprint`, `issued_at`, `expires_at`
   - Print the token to stdout for the user to copy or pipe

3. Implement JWT signing:
   - Generate or load a server secret from `.scenecraft/secret.key` (create on first use during `scenecraft init` or on first token generation)
   - Use HS256 algorithm for signing
   - Set a reasonable expiration (e.g., 24 hours)

4. Implement API middleware for token validation:
   - Extract `Authorization: Bearer <token>` header from every incoming request
   - Decode and validate the JWT (check signature, expiration)
   - Attach the authenticated username to the request context
   - Return 401 Unauthorized if the token is missing, invalid, or expired

5. Add `last_modified_by` column to entity tables:
   - `keyframes` table
   - `transitions` table
   - `effects` table
   - `tracks` table
   - Update all write operations (insert/update) to populate this column from the authenticated user

6. Write tests for token generation, token validation, expired token rejection, and `last_modified_by` population.

## Verification

- [ ] `scenecraft token` outputs a valid JWT when run by a registered user
- [ ] JWT contains correct claims: `username`, `pubkey_fingerprint`, `issued_at`, `expires_at`
- [ ] API requests without a token receive 401 response
- [ ] API requests with an expired token receive 401 response
- [ ] API requests with a valid token succeed and the username is available in the request context
- [ ] Entity tables include `last_modified_by` column
- [ ] Write operations correctly set `last_modified_by` to the authenticated user
- [ ] Tests pass for all auth flows

---

**Dependencies**: Task 29
