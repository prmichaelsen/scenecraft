# Pattern: Service Client (1:1 REST Mirror)

**Namespace**: core-sdk
**Category**: Client SDK
**Created**: 2026-02-28
**Status**: Active

---

## Overview

The Service Client pattern provides a typed, 1:1 mirror of REST API routes. Each REST resource gets a resource class with methods that map directly to endpoints. The client adds type safety, auth, and error normalization but does not add business logic — it is a thin typed wrapper.

Use this pattern when consumers need full control over individual API operations without compound abstractions.

---

## Problem

Without a typed service client:

1. **Manual URL construction**: Consumers build URLs by hand, typos cause silent failures
2. **No input validation**: Wrong request shapes only caught at runtime by the server
3. **No response types**: `fetch().json()` returns `any`, no autocomplete or type checking
4. **Auth boilerplate**: Every call needs manual header construction

---

## Solution

Create resource-grouped client classes that:
- Map 1:1 to REST API routes
- Accept typed inputs and return typed `SdkResponse<T>`
- Delegate all HTTP to the shared `HttpClient` transport
- Use types generated from OpenAPI specs
- Expose a factory function (`createSvcClient`) that assembles all resources

---

## Implementation

```typescript
// src/clients/svc/v1/memories.ts
import { HttpClient, SdkResponse } from '../../http';
import type { paths } from './types.generated';

type CreateInput = paths['/api/svc/v1/memories']['post']['requestBody']['content']['application/json'];
type Memory = paths['/api/svc/v1/memories']['post']['responses']['201']['content']['application/json'];
type SearchInput = paths['/api/svc/v1/memories/search']['post']['requestBody']['content']['application/json'];
type SearchResult = paths['/api/svc/v1/memories/search']['post']['responses']['200']['content']['application/json'];

class MemoriesResource {
  constructor(private http: HttpClient) {}

  create(userId: string, input: CreateInput): Promise<SdkResponse<Memory>> {
    return this.http.request('POST', '/api/svc/v1/memories', { body: input, userId });
  }

  update(userId: string, id: string, input: Partial<CreateInput>): Promise<SdkResponse<Memory>> {
    return this.http.request('PATCH', `/api/svc/v1/memories/${id}`, { body: input, userId });
  }

  delete(userId: string, id: string): Promise<SdkResponse<void>> {
    return this.http.request('DELETE', `/api/svc/v1/memories/${id}`, { userId });
  }

  search(userId: string, input: SearchInput): Promise<SdkResponse<SearchResult>> {
    return this.http.request('POST', '/api/svc/v1/memories/search', { body: input, userId });
  }

  similar(userId: string, input: SimilarInput): Promise<SdkResponse<SimilarResult>> {
    return this.http.request('POST', '/api/svc/v1/memories/similar', { body: input, userId });
  }

  query(userId: string, input: QueryInput): Promise<SdkResponse<QueryResult>> {
    return this.http.request('POST', '/api/svc/v1/memories/query', { body: input, userId });
  }
}

// src/clients/svc/v1/relationships.ts
class RelationshipsResource {
  constructor(private http: HttpClient) {}

  create(userId: string, input: CreateRelInput): Promise<SdkResponse<Relationship>> {
    return this.http.request('POST', '/api/svc/v1/relationships', { body: input, userId });
  }

  update(userId: string, id: string, input: UpdateRelInput): Promise<SdkResponse<Relationship>> {
    return this.http.request('PATCH', `/api/svc/v1/relationships/${id}`, { body: input, userId });
  }

  delete(userId: string, id: string): Promise<SdkResponse<void>> {
    return this.http.request('DELETE', `/api/svc/v1/relationships/${id}`, { userId });
  }

  search(userId: string, input: SearchRelInput): Promise<SdkResponse<SearchRelResult>> {
    return this.http.request('POST', '/api/svc/v1/relationships/search', { body: input, userId });
  }
}

// src/clients/svc/v1/index.ts — Factory
import { HttpClient, HttpClientConfig } from '../../http';
import { assertServerSide } from '../../guard';

interface SvcClient {
  memories: MemoriesResource;
  relationships: RelationshipsResource;
  spaces: SpacesResource;
  confirmations: ConfirmationsResource;
  preferences: PreferencesResource;
  trust: TrustResource;
  health: HealthResource;
}

function createSvcClient(config: HttpClientConfig): SvcClient {
  assertServerSide();
  const http = new HttpClient(config);

  return {
    memories: new MemoriesResource(http),
    relationships: new RelationshipsResource(http),
    spaces: new SpacesResource(http),
    confirmations: new ConfirmationsResource(http),
    preferences: new PreferencesResource(http),
    trust: new TrustResource(http),
    health: new HealthResource(http),
  };
}

export { createSvcClient, SvcClient };
```

### Usage

```typescript
import { createSvcClient } from '@my-org/my-core/clients/svc/v1';

const client = createSvcClient({
  baseUrl: 'https://api.example.com',
  auth: { serviceToken: process.env.SERVICE_TOKEN! },
});

// Type-safe, 1:1 REST calls
const { data, error } = await client.memories.create(userId, {
  content: 'Meeting notes from Q4 planning',
  type: 'note',
  tags: ['meetings', 'q4'],
});

if (error) {
  console.error(`[${error.code}] ${error.message}`);
  return;
}

console.log('Created memory:', data.id);

// Search
const results = await client.memories.search(userId, { query: 'Q4 planning' });

// Confirmations are explicit (no auto-confirm)
const { data: token } = await client.spaces.publish(userId, { memory_id: data.id, spaces: ['public'] });
await client.confirmations.confirm(userId, token.token);
```

---

## Benefits

1. **1:1 mapping** - Every REST endpoint has exactly one typed method
2. **OpenAPI-driven types** - Request/response shapes generated from specs
3. **No hidden behavior** - No auto-confirm, no compound operations, no magic
4. **Versionable** - `clients/svc/v1` → `clients/svc/v2` when API evolves
5. **Composable** - Consumers build their own workflows from atomic operations

---

## Best Practices

### 1. One Resource Class Per REST Resource
```
/api/svc/v1/memories/*       → MemoriesResource
/api/svc/v1/relationships/*  → RelationshipsResource
/api/svc/v1/spaces/*         → SpacesResource
```

### 2. Version the Subpath Export
```json
{
  "exports": {
    "./clients/svc/v1": "./dist/clients/svc/v1/index.js"
  }
}
```

### 3. Generate Types from OpenAPI
```bash
npx openapi-typescript docs/openapi.yaml -o src/clients/svc/v1/types.generated.ts
```

### 4. userId is Always the First Parameter
```typescript
// Consistent signature across all resource methods
client.memories.create(userId, input)
client.memories.search(userId, input)
client.relationships.create(userId, input)
```

---

## Anti-Patterns

### No Business Logic in Svc Client

```typescript
// Bad: Svc client does compound operations
async createAndPublish(userId: string, input: CreateInput) {
  const memory = await this.create(userId, input);
  const token = await this.spaces.publish(userId, { memory_id: memory.data.id });
  return this.confirmations.confirm(userId, token.data.token);
}

// Good: Svc client is 1:1 only. Compound ops go in the App Client.
async create(userId: string, input: CreateInput) {
  return this.http.request('POST', '/api/svc/v1/memories', { body: input, userId });
}
```

### No Auto-Confirm in Svc Client

```typescript
// Bad: publish() auto-confirms the action
async publish(userId: string, input: PublishInput) {
  const token = await this.http.request('POST', '/spaces/publish', { body: input, userId });
  return this.http.request('POST', `/confirmations/${token.data.token}/confirm`, { userId });
}

// Good: Return token, let consumer decide
async publish(userId: string, input: PublishInput) {
  return this.http.request('POST', '/api/svc/v1/spaces/publish', { body: input, userId });
}
```

---

## Related Patterns

- **[HTTP Transport Pattern](core-sdk.client-http-transport.md)** - Shared fetch layer used by all resources
- **[SDK Response Pattern](core-sdk.client-response.md)** - `SdkResponse<T>` returned by all methods
- **[App Client Pattern](core-sdk.client-app.md)** - Compound operations built on top of svc calls
- **[Type Generation Pattern](core-sdk.client-type-generation.md)** - OpenAPI → TypeScript type generation

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Node.js 18+
**Related Design**: [Client SDK Architecture](../design/core-sdk.architecture.md)
