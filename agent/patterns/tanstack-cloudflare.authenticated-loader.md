# Authenticated Loader

**Category**: Architecture  
**Applicable To**: TanStack Start route loaders with server-side auth  
**Status**: Stable

---

## Overview

The Authenticated Loader pattern eliminates the repetitive 5-line auth ceremony (`initFirebaseAdmin`, `getServerSession`, null-check, anonymous-check) from every route loader. Two factory functions — `createAuthenticatedLoader` (parameterized) and `createAuthenticatedLoaderNoInput` (session-only) — wrap `createServerFn` with built-in auth validation. A companion `requireSession` helper serves the same purpose inside hand-written `createServerFn` handlers.

**Key principle**: "Loader for reads, client services for writes." Loaders run on the server before render, so the component always has data — no loading spinners needed.

---

## When to Use This Pattern

✅ **Use this pattern when:**
- A route needs authenticated data before rendering
- Multiple routes repeat the same auth boilerplate in their loaders
- You want to guarantee data is present at render time (no `isLoading` state)

❌ **Don't use this pattern when:**
- The route is fully public with no auth dependency
- You need fine-grained error handling per-route (use `requireSession` directly)
- The data fetch is a mutation (use client-side services instead)

---

## Core Principles

1. **DRY Auth Ceremony**: Auth setup runs once inside the factory, not in every route file
2. **Null = Unauthenticated**: Loaders return `null` when auth fails — the route component handles the redirect
3. **Loader for Reads**: Server functions via loaders handle all read operations; mutations go through client services
4. **Anonymous Gating**: Anonymous users are blocked by default; opt-in via `{ allowAnonymous: true }`

---

## Implementation

### Structure

```
src/lib/auth/
├── create-authenticated-loader.ts   # Factory functions
├── require-session.ts               # Inline auth helper
└── session.ts                       # getServerSession (existing)
```

### Key Component 1: createAuthenticatedLoader (parameterized)

For loaders that need route params or other input:

```typescript
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { initFirebaseAdmin } from '@/lib/firebase-admin'
import { getServerSession } from '@/lib/auth/session'
import type { ServerSession } from '@/types/auth'

interface LoaderOptions {
  allowAnonymous?: boolean
}

export function createAuthenticatedLoader<TInput, TResult>(
  fn: (session: ServerSession, input: TInput) => Promise<TResult>,
  options?: LoaderOptions,
) {
  return createServerFn({ method: 'POST' })
    .inputValidator((input: TInput) => input)
    .handler(async ({ data }): Promise<TResult | null> => {
      initFirebaseAdmin()
      const session = await getServerSession(getRequest())
      if (!session?.user) return null
      if (session.user.isAnonymous && !options?.allowAnonymous) return null
      return fn(session, data)
    })
}
```

### Key Component 2: createAuthenticatedLoaderNoInput (session-only)

For "get my stuff" loaders that only need the session:

```typescript
export function createAuthenticatedLoaderNoInput<TResult>(
  fn: (session: ServerSession) => Promise<TResult>,
  options?: LoaderOptions,
) {
  return createServerFn({ method: 'GET' }).handler(
    async (): Promise<TResult | null> => {
      initFirebaseAdmin()
      const session = await getServerSession(getRequest())
      if (!session?.user) return null
      if (session.user.isAnonymous && !options?.allowAnonymous) return null
      return fn(session)
    },
  )
}
```

### Key Component 3: requireSession (inline helper)

For use inside hand-written `createServerFn` handlers when the factory is too rigid:

```typescript
export async function requireSession(
  options?: { allowAnonymous?: boolean },
): Promise<ServerSession | null> {
  initFirebaseAdmin()
  const session = await getServerSession(getRequest())
  if (!session?.user) return null
  if (session.user.isAnonymous && !options?.allowAnonymous) return null
  return session
}
```

---

## Examples

### Example 1: Parameterized Loader (fetch by route param)

```typescript
// src/lib/loaders/appointments.ts
const getAppointments = createAuthenticatedLoader(
  async (session, { businessId }: { businessId: string }) =>
    AppointmentDatabaseService.findByBusinessId(businessId)
)

// src/routes/dashboard/$businessId/appointments.tsx
export const Route = createFileRoute('/dashboard/$businessId/appointments')({
  loader: ({ params }) =>
    getAppointments({ data: { businessId: params.businessId } }),
  component: AppointmentsPage,
})

function AppointmentsPage() {
  const appointments = Route.useLoaderData() // always present, never loading
  if (!appointments) return <Navigate to="/auth" />
  return <AppointmentList items={appointments} />
}
```

### Example 2: No-Input Loader (session-only)

```typescript
const getMyDisputes = createAuthenticatedLoaderNoInput(async (session) => {
  const dbUser = await UserDatabaseService.findByFirebaseUid(session.user.uid)
  if (!dbUser) return []
  return DisputeDatabaseService.getDisputesByUser(dbUser.id)
})

export const Route = createFileRoute('/disputes')({
  loader: () => getMyDisputes(),
  component: DisputesPage,
})
```

### Example 3: Allow Anonymous Access

```typescript
const getPublicProfile = createAuthenticatedLoader(
  async (session, { userId }: { userId: string }) =>
    CleanerProfileDatabaseService.getPublicProfile(userId),
  { allowAnonymous: true }
)
```

---

## Benefits

### 1. Zero Boilerplate
Each route file drops from ~10 lines of auth setup to a single function call.

### 2. No Loading States for Server Data
Because loaders run before render, the component always receives data — no `isLoading` / skeleton screens for initial page loads.

### 3. Consistent Auth Behavior
Anonymous gating, session validation, and Firebase init happen identically across all routes.

---

## Trade-offs

### 1. Null Return vs. Redirect
**Downside**: The loader returns `null` instead of throwing a redirect, pushing redirect logic to the component.  
**Mitigation**: Use a shared `<AuthGuard>` wrapper or `beforeLoad` redirect for routes that should never render without auth.

### 2. POST Method for Parameterized Loaders
**Downside**: `createAuthenticatedLoader` uses POST (to send input data), which is non-idiomatic for reads.  
**Mitigation**: This is a TanStack Start convention for server functions with input validators — it doesn't affect caching since loaders run server-side.

---

## Anti-Patterns

### ❌ Anti-Pattern: Inline Auth in Every Route

```typescript
// ❌ Bad — repeated in every route file
export const Route = createFileRoute('/dashboard')({
  loader: async () => {
    initFirebaseAdmin()
    const session = await getServerSession(getRequest())
    if (!session?.user) return null
    if (session.user.isAnonymous) return null
    return MyService.getData(session.user.uid)
  },
})

// ✅ Good — use the factory
const getData = createAuthenticatedLoaderNoInput(
  (session) => MyService.getData(session.user.uid)
)
export const Route = createFileRoute('/dashboard')({
  loader: () => getData(),
})
```

---

## Related Patterns

- **[Auth Session Management](./tanstack-cloudflare.auth-session-management.md)**: Provides `getServerSession` used by this pattern
- **[Firebase Auth](./tanstack-cloudflare.firebase-auth.md)**: Client-side auth that produces the session token
- **[Library Services](./tanstack-cloudflare.library-services.md)**: Service layer that loaders delegate to
- **[API Route Handlers](./tanstack-cloudflare.api-route-handlers.md)**: Uses `requireSession` for REST endpoints

---

**Status**: Stable  
**Last Updated**: 2026-04-08  
