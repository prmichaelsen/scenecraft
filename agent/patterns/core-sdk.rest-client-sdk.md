# Pattern: REST Client SDK (Overview)

**Namespace**: core-sdk
**Category**: Client SDK
**Created**: 2026-03-01
**Status**: Active

---

## Overview

This is a **synthesis pattern** that describes how the five granular client SDK patterns fit together to form a complete, Supabase-style REST client SDK. Each component is documented in detail in its own pattern file — this document explains the architecture, data flow, and relationships between them.

The REST Client SDK provides server-side typed HTTP client wrappers that mirror REST API routes. Every method returns `SdkResponse<T>` — a `{ data, error, throwOnError() }` response that never throws by default.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Consumer Code                            │
│  const { data, error } = await client.posts.create(...)      │
└────────────────────────┬─────────────────────────────────────┘
                         │
         ┌───────────────┴───────────────┐
         │                               │
┌────────▼─────────┐          ┌──────────▼──────────┐
│   Svc Client     │          │    App Client       │
│   (1:1 REST)     │          │   (Compound Ops)    │
│                  │          │                     │
│ posts.create()   │          │ profiles             │
│ posts.get()      │          │   .createAndPublish()│
│ profiles.update()│          │ ghost                │
│ feeds.follow()   │          │   .searchAsGhost()   │
└────────┬─────────┘          └──────────┬──────────┘
         │                               │
         └───────────────┬───────────────┘
                         │
              ┌──────────▼──────────┐
              │     HttpClient      │
              │  (Shared Transport) │
              │                     │
              │  • fetch() wrapper  │
              │  • Auth resolution  │
              │  • JSON serializer  │
              │  • Error normalizer │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │   SdkResponse<T>    │
              │                     │
              │  { data, error,     │
              │    throwOnError() } │
              └─────────────────────┘
```

### Component Map

| Component | Pattern Document | Purpose |
|-----------|-----------------|---------|
| SdkResponse<T> | [SDK Response](core-sdk.client-response.md) | Unified `{ data, error }` return type for all methods |
| HttpClient | [HTTP Transport](core-sdk.client-http-transport.md) | Shared fetch layer with auth and error normalization |
| Svc Client | [Service Client](core-sdk.client-svc.md) | 1:1 REST route mirror — thin typed wrappers |
| App Client | [App Client](core-sdk.client-app.md) | Compound use-case operations (multi-step workflows) |
| Type Generation | [Type Generation](core-sdk.client-type-generation.md) | OpenAPI → TypeScript types for request/response shapes |

---

## Data Flow

### Request Path

```
consumer calls client.posts.create(userId, input)
  │
  ├─ PostsResource.create() builds path + body
  │   └─ delegates to HttpClient.request('POST', '/api/v1/posts', { userId, body })
  │       ├─ resolveAuthToken(userId) → Bearer token
  │       ├─ fetch(url, { method, headers, body })
  │       └─ fromHttpResponse(response) → SdkResponse<T>
  │
  └─ consumer receives { data: Post, error: null }
     OR { data: null, error: { code: 'validation', message: '...', status: 400 } }
```

### Error Normalization

All failures — network errors, HTTP errors, auth errors — are normalized into the same shape:

```typescript
interface SdkError {
  code: string;    // 'not_found' | 'unauthorized' | 'validation' | 'network_error' | ...
  message: string; // Human-readable
  status: number;  // HTTP status (0 for network errors)
  context?: Record<string, unknown>; // Optional structured details
}
```

HTTP status → error code mapping:
- `400` → `bad_request` / `validation`
- `401` → `unauthorized`
- `403` → `forbidden`
- `404` → `not_found`
- `409` → `conflict`
- `429` → `rate_limited`
- `500` → `internal`
- Network failure → `network_error` (status: 0)
- Auth resolution failure → `auth_error` (status: 0)

---

## Two Client Tiers

### Svc Client — Atomic Operations

1:1 mirror of REST routes. No business logic, no compound operations. Each method maps to exactly one HTTP request.

```typescript
const svc = createSvcClient({ baseUrl, getAuthToken });

// Each call = one HTTP request
await svc.posts.create(userId, { title: '...', content: '...' });
await svc.posts.get(userId, postId);
await svc.profiles.update(userId, { displayName: 'New Name' });
await svc.feeds.follow(userId, feedId);
```

**When to use**: Consumers who need full control over individual operations. Backend services, CLI tools, scripts.

See [Service Client Pattern](core-sdk.client-svc.md) for full details.

### App Client — Compound Operations

Use-case-oriented methods that compose multiple REST calls. Handles intermediate steps (tokens, confirmations) internally.

```typescript
const app = createAppClient({ baseUrl, auth: { serviceToken } });

// One call = multiple HTTP requests behind the scenes
await app.profiles.createAndPublish(userId, { display_name: 'Pat', bio: '...' });
await app.ghost.searchAsGhost(viewerId, { owner_user_id: ownerId, query: '...' });
```

**When to use**: Web applications with multi-step workflows. Reduces boilerplate in UI/API route handlers.

See [App Client Pattern](core-sdk.client-app.md) for full details.

---

## Auth Patterns

The HttpClient supports two mutually exclusive auth strategies, configured once at client creation:

### Callback-Based (Consumer Provides Tokens)

```typescript
const client = createSvcClient({
  baseUrl: 'https://api.example.com',
  getAuthToken: async (userId) => {
    // Consumer resolves token (from session, cache, etc.)
    return myAuth.getTokenForUser(userId);
  },
});
```

### Service Token (SDK Generates JWTs)

```typescript
const client = createSvcClient({
  baseUrl: 'https://api.example.com',
  auth: {
    serviceToken: process.env.SERVICE_SECRET!,
    jwtOptions: { issuer: 'my-service', expiresIn: '5m' },
  },
});
```

Requires `jsonwebtoken` as an optional peer dependency. Loaded via dynamic `import()` only when this auth pattern is used.

See [HTTP Transport Pattern](core-sdk.client-http-transport.md) for implementation details.

---

## Browser Guard

Both `createSvcClient()` and `createAppClient()` call `assertServerSide()` at construction time. This throws immediately if `typeof window !== 'undefined'`, preventing server-side credentials from being bundled into browser code.

```typescript
export function assertServerSide(): void {
  if (typeof window !== 'undefined') {
    throw new Error('Client SDKs are server-side only.');
  }
}
```

---

## Type Safety with OpenAPI

Types are generated from OpenAPI specs using `openapi-typescript`, then referenced in hand-written client code:

```bash
npx openapi-typescript docs/openapi.yaml -o src/clients/svc/v1/types.generated.ts
```

```typescript
import type { paths, components } from './types.generated';

type CreatePostInput = paths['/api/v1/posts']['post']['requestBody']['content']['application/json'];
type Post = components['schemas']['Post'];
```

Convenience re-exports give consumers clean names:

```typescript
import type { Post, CreatePostInput } from '@my-org/my-core/clients/svc/v1';
```

See [Type Generation Pattern](core-sdk.client-type-generation.md) for full workflow.

---

## Package Exports

```json
{
  "exports": {
    "./clients/svc/v1": {
      "types": "./dist/clients/svc/v1/index.d.ts",
      "import": "./dist/clients/svc/v1/index.js"
    },
    "./app": {
      "types": "./dist/app/index.d.ts",
      "import": "./dist/app/index.js"
    }
  }
}
```

Consumers import the tier they need:

```typescript
import { createSvcClient } from '@my-org/my-core/clients/svc/v1';
import { createAppClient } from '@my-org/my-core/app';
```

---

## Adding a New Resource

To add a new resource (e.g., `notifications`):

1. **Create resource file** `src/clients/svc/v1/notifications.ts`:
   - Define `NotificationsResource` interface
   - Implement `createNotificationsResource(http)` factory
   - Each method calls `http.request()` with the right verb/path

2. **Register in factory** `src/clients/svc/v1/index.ts`:
   - Import the resource factory
   - Add `notifications` to the `SvcClient` interface
   - Wire in `createSvcClient()`

3. **Generate types** (if OpenAPI spec exists):
   - Update the OpenAPI spec with new routes
   - Run `npm run generate:types`
   - Reference generated types in the resource file

4. **Add tests** — mock `fetch`, verify method → HTTP mapping

---

## Anti-Patterns

### No Business Logic in Client Code
Client SDKs are **transport wrappers only**. Validation, caching, and transformation belong in server-side services.

### No Mixing Tiers
Svc Client = atomic 1:1 operations. App Client = compound workflows. Never mix them in the same client.

### No Browser Usage
These SDKs carry credentials. For browser clients, build a separate BFF-backed client.

### No Wrapping Svc Client in App Client
App Client calls HTTP directly, not through Svc Client. This keeps them decoupled for independent versioning.

---

## Checklist for New Projects

- [ ] `src/clients/response.ts` — SdkResponse<T>, createSuccess, createError, fromHttpResponse
- [ ] `src/clients/http.ts` — HttpClient with dual auth
- [ ] `src/clients/guard.ts` — assertServerSide()
- [ ] `src/clients/svc/v1/` — Resource files + factory
- [ ] `src/app/` — App client with compound operations (if needed)
- [ ] `package.json` exports — `./clients/svc/v1` and `./app` subpaths
- [ ] OpenAPI spec + type generation script (if API spec exists)
- [ ] `jsonwebtoken` as optional peer dependency (if using serviceToken auth)
- [ ] Tests mocking `fetch` for each resource

---

## Related Patterns (Detailed Docs)

- **[SDK Response](core-sdk.client-response.md)** — `SdkResponse<T>` type, error codes, usage patterns
- **[HTTP Transport](core-sdk.client-http-transport.md)** — HttpClient class, auth resolution, error normalization
- **[Service Client](core-sdk.client-svc.md)** — 1:1 resource wrappers, factory composition
- **[App Client](core-sdk.client-app.md)** — Compound operations, fail-fast error propagation
- **[Type Generation](core-sdk.client-type-generation.md)** — OpenAPI → TypeScript workflow

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Node.js 18+
**Related Design**: [Client SDK Architecture](../design/core-sdk.architecture.md)
