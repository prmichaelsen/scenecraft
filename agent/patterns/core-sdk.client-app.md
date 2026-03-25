# Pattern: App Client (Use-Case-Oriented)

**Namespace**: core-sdk
**Category**: Client SDK
**Created**: 2026-02-28
**Status**: Active

---

## Overview

The App Client pattern provides use-case-oriented compound operations for web applications. Unlike the Svc Client (1:1 REST mirror), the App Client combines multiple API calls into single methods that match real user workflows — "create and publish a profile", "search as a ghost persona", etc.

The App Client calls REST endpoints via `fetch()` (same as Svc Client). It does NOT wrap the Svc Client — it calls the API independently to stay decoupled from svc-tier versioning.

---

## Problem

Without an app-level client:

1. **Multi-step workflows scattered across components**: Profile creation requires create → publish → confirm, spread across different files
2. **Error handling for each step**: Every intermediate call needs its own error check
3. **Inconsistent compound logic**: Different consumers implement the same multi-step flow differently
4. **Tight coupling to REST structure**: UI code depends on knowing the REST API's two-phase confirmation model

---

## Solution

Create an App Client that:
- Groups methods by use case, not by REST resource
- Composes multiple REST calls into single methods
- Handles intermediate steps (token generation, confirmation) internally when appropriate
- Returns `SdkResponse<T>` like the Svc Client
- Calls REST endpoints directly (not through Svc Client) for decoupling

---

## Implementation

```typescript
// src/app/profiles.ts
import { HttpClient, SdkResponse, ok, fail } from '../clients/http';

interface CreateProfileInput {
  display_name: string;
  bio?: string;
  tags?: string[];
}

interface Profile {
  memory_id: string;
  display_name: string;
  bio?: string;
  tags: string[];
  published_at: string;
}

class ProfileOperations {
  constructor(private http: HttpClient) {}

  /**
   * Create a profile memory and publish it to the public space.
   * Combines: create memory → publish to space → confirm publication.
   */
  async createAndPublish(
    userId: string,
    input: CreateProfileInput,
  ): Promise<SdkResponse<Profile>> {
    // Step 1: Create memory
    const memory = await this.http.request<{ id: string }>(
      'POST', '/api/svc/v1/memories',
      {
        body: {
          content: JSON.stringify(input),
          type: 'profile',
          tags: ['profile', ...(input.tags ?? [])],
        },
        userId,
      },
    );
    if (memory.error) return fail(memory.error);

    // Step 2: Request publish token
    const token = await this.http.request<{ token: string }>(
      'POST', '/api/svc/v1/spaces/publish',
      {
        body: { memory_id: memory.data!.id, spaces: ['public'] },
        userId,
      },
    );
    if (token.error) return fail(token.error);

    // Step 3: Confirm publication
    const confirmed = await this.http.request<Profile>(
      'POST', `/api/svc/v1/confirmations/${token.data!.token}/confirm`,
      { userId },
    );
    return confirmed;
  }

  /**
   * Search for published profiles.
   */
  async search(
    userId: string,
    input: { query: string; limit?: number; offset?: number },
  ): Promise<SdkResponse<{ profiles: Profile[]; hasMore: boolean }>> {
    return this.http.request(
      'POST', '/api/svc/v1/spaces/search',
      {
        body: {
          query: input.query,
          limit: input.limit ?? 20,
          offset: input.offset ?? 0,
          filters: { content_type: 'profile' },
        },
        userId,
      },
    );
  }

  /**
   * Retract a published profile.
   */
  async retract(
    userId: string,
    input: { memory_id: string },
  ): Promise<SdkResponse<void>> {
    const token = await this.http.request<{ token: string }>(
      'POST', '/api/svc/v1/spaces/retract',
      { body: input, userId },
    );
    if (token.error) return fail(token.error);

    return this.http.request(
      'POST', `/api/svc/v1/confirmations/${token.data!.token}/confirm`,
      { userId },
    );
  }
}

// src/app/ghost.ts
class GhostOperations {
  constructor(private http: HttpClient) {}

  /**
   * Search memories as a ghost persona.
   * Resolves trust level → builds ghost context → searches → returns filtered results.
   */
  async searchAsGhost(
    userId: string,
    input: { owner_user_id: string; query: string; limit?: number },
  ): Promise<SdkResponse<SearchResult>> {
    // Step 1: Get ghost config for trust level
    const config = await this.http.request<GhostConfig>(
      'GET', '/api/svc/v1/trust/ghost-config',
      { userId: input.owner_user_id },
    );
    if (config.error) return fail(config.error);

    // Step 2: Search with ghost context
    return this.http.request(
      'POST', '/api/svc/v1/memories/search',
      {
        body: {
          query: input.query,
          limit: input.limit ?? 20,
          ghost_context: {
            accessor_user_id: userId,
            trust_level: config.data!.user_trust?.[userId] ?? 0.3,
          },
        },
        userId: input.owner_user_id,
      },
    );
  }
}

// src/app/index.ts — Factory
import { HttpClient, HttpClientConfig } from '../clients/http';
import { assertServerSide } from '../clients/guard';

interface AppClient {
  profiles: ProfileOperations;
  ghost: GhostOperations;
}

function createAppClient(config: HttpClientConfig): AppClient {
  assertServerSide();
  const http = new HttpClient(config);

  return {
    profiles: new ProfileOperations(http),
    ghost: new GhostOperations(http),
  };
}

export { createAppClient, AppClient };
```

### Usage

```typescript
import { createAppClient } from '@my-org/my-core/app';

const app = createAppClient({
  baseUrl: 'https://api.example.com',
  auth: { serviceToken: process.env.SERVICE_TOKEN! },
});

// One call does create → publish → confirm
const { data, error } = await app.profiles.createAndPublish(userId, {
  display_name: 'Patrick M',
  bio: 'Building tools for memory',
  tags: ['developer'],
});

// Search as ghost persona
const results = await app.ghost.searchAsGhost(viewerId, {
  owner_user_id: ownerId,
  query: 'project ideas',
  limit: 10,
});
```

---

## Benefits

1. **Use-case aligned** - Methods match real user workflows, not REST resources
2. **Hidden complexity** - Multi-step flows collapsed into single calls
3. **Consistent error handling** - Intermediate errors propagated cleanly
4. **Decoupled from svc versioning** - App client evolves independently
5. **Migration-ready** - When server adds `/api/app/v1/` routes, client switches to single calls transparently

---

## Best Practices

### 1. Group by Use Case, Not Resource
```typescript
// Good: Organized by what users do
app.profiles.createAndPublish(...)
app.profiles.search(...)
app.ghost.searchAsGhost(...)

// Bad: Organized by REST resource (that's the Svc Client's job)
app.memories.create(...)
app.spaces.publish(...)
```

### 2. Call REST Endpoints Directly, Not Svc Client
```typescript
// Good: Independent HTTP calls
const memory = await this.http.request('POST', '/api/svc/v1/memories', { ... });

// Bad: Wrapping the Svc Client (creates coupling)
const memory = await this.svcClient.memories.create(userId, input);
```

### 3. Fail Fast on Intermediate Errors
```typescript
const step1 = await this.http.request(...);
if (step1.error) return fail(step1.error); // Don't continue

const step2 = await this.http.request(...);
if (step2.error) return fail(step2.error);
```

### 4. Document Which REST Calls Are Composed
```typescript
/**
 * Create a profile memory and publish it to the public space.
 * Combines: create memory → publish to space → confirm publication.
 */
async createAndPublish(...) { ... }
```

---

## Anti-Patterns

### No Wrapping the Svc Client

```typescript
// Bad: App client depends on Svc Client class
class ProfileOperations {
  constructor(private svc: SvcClient) {}
  async create(userId: string, input: CreateProfileInput) {
    const mem = await this.svc.memories.create(userId, { ... });
    // Coupled to svc client's interface and versioning
  }
}

// Good: App client calls HTTP directly
class ProfileOperations {
  constructor(private http: HttpClient) {}
  async create(userId: string, input: CreateProfileInput) {
    const mem = await this.http.request('POST', '/api/svc/v1/memories', { ... });
    // Decoupled — can switch to /api/app/v1/ later
  }
}
```

### No Mixing Svc and App Patterns

```typescript
// Bad: App client exposes both compound and 1:1 methods
app.memories.create(...)           // 1:1 → belongs in Svc Client
app.profiles.createAndPublish(...) // compound → belongs in App Client

// Good: Clear separation
svc.memories.create(...)           // 1:1 svc operations
app.profiles.createAndPublish(...) // compound app operations
```

---

## Related Patterns

- **[Svc Client Pattern](core-sdk.client-svc.md)** - 1:1 REST mirror (atomic operations)
- **[HTTP Transport Pattern](core-sdk.client-http-transport.md)** - Shared fetch layer
- **[SDK Response Pattern](core-sdk.client-response.md)** - `SdkResponse<T>` return type
- **[Adapter Client Pattern](core-sdk.adapter-client.md)** - Higher-level client for direct service calls

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Node.js 18+
**Related Design**: [Client SDK Architecture](../design/core-sdk.architecture.md)
