# Task 34: Frontend JWT Authentication

**Objective**: Add JWT-based login flow and auth context to the frontend so all API calls are authenticated
**Milestone**: M6 — Git-Style Version Control
**Priority**: P1
**Repo**: scenecraft
**Estimated Hours**: 4
**Status**: Not Started

---

## Context

The version control system requires user identity for commits, branch ownership, and access control. Users obtain a JWT token via the `scenecraft token` CLI command and paste it into the frontend. The token is stored in localStorage and attached to every API request, enabling the backend to identify the current user.

This is a prerequisite for any user-facing version control features since commits and branches must be attributed to authenticated users.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Create a login page/modal with a simple text input where the user pastes their JWT token (obtained via `scenecraft token` CLI).

2. On submission, decode the JWT payload (client-side, no verification needed) to extract user info (username, org, role). Validate that the token has the expected fields before accepting it.

3. Store the JWT in localStorage under the key `scenecraft_jwt`.

4. Create an `AuthContext` provider that:
   - Reads the token from localStorage on mount
   - Exposes `{ user, token, login, logout, isAuthenticated }` to all components
   - Decodes and caches user info from the JWT payload

5. Update all fetch wrappers / API client functions to include the `Authorization: Bearer <token>` header when a token is present.

6. Add a global 401 response interceptor: when any API call returns 401, clear the stored token and redirect to the login page.

7. Show the current username in the editor header bar (e.g., next to the workspace menu).

8. Add a logout button that clears the token from localStorage and resets the auth context.

## Verification

- [ ] User can paste a JWT token and log in successfully
- [ ] JWT is persisted in localStorage under `scenecraft_jwt`
- [ ] All API calls include the `Authorization: Bearer <token>` header
- [ ] Decoded user info (username) is displayed in the editor header
- [ ] A 401 response clears the token and redirects to login
- [ ] Logout clears the token and returns to the login page
- [ ] Refreshing the page preserves the authenticated session (reads token from localStorage)

---

**Dependencies**: Task 30
