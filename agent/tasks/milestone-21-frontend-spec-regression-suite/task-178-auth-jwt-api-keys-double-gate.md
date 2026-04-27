# Task 178: auth-jwt-api-keys-double-gate spec tests

**Milestone**: [M21 — Frontend Spec Regression Suite](../../milestones/milestone-21-frontend-spec-regression-suite.md)
**Spec**: [`local.auth-jwt-api-keys-double-gate`](../../specs/local.auth-jwt-api-keys-double-gate.md)
**Estimated Time**: 6 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Write unit + integration tests for the auth flow: JWT token management, API key storage, login/logout, and the double-gate pattern (bearer token + session cookie).

## Test File

`src/lib/__tests__/spec-auth-jwt-api-keys-double-gate.test.ts`

## Coverage Plan

- **Token storage**: JWT stored/retrieved from localStorage or cookie; token refresh logic
- **Bearer header injection**: every fetch call includes Authorization header when token exists
- **Login flow**: POST /auth/login with credentials -> receive JWT -> store -> redirect
- **Logout flow**: clear token; POST /auth/logout; redirect to login
- **401 handling**: expired/invalid token -> redirect to login; clear stale token
- **Double gate**: bearer token tried first, session cookie fallback
- **API key flow**: if applicable, API key header alternative to JWT
- **Public routes**: login/logout/oauth endpoints don't require auth
- **Integration**: login -> token stored -> subsequent API calls include bearer -> 401 -> redirect

## Completion Criteria

- [ ] Every spec requirement has >=1 test
- [ ] `npx vitest run` passes for this file
- [ ] fetch mocked to verify header injection
