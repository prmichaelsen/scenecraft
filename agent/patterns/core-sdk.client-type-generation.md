# Pattern: Client Type Generation

**Namespace**: core-sdk
**Category**: Client SDK
**Created**: 2026-02-28
**Status**: Active

---

## Overview

The Client Type Generation pattern uses `openapi-typescript` to generate TypeScript types from OpenAPI specs, then hand-writes thin client code that references those types. This gives full type safety for request/response shapes without maintaining types manually.

Generated types are committed to source control and regenerated when specs change. The client code is hand-written (not generated) for full control over the developer experience.

---

## Problem

Without type generation from API specs:

1. **Manual type maintenance**: Request/response types drift from the actual API
2. **Silent breakage**: API changes break clients at runtime, not compile time
3. **Duplicated definitions**: Types defined in server, then re-defined in client
4. **No single source of truth**: Server spec says one thing, client types say another

---

## Solution

Use a two-layer approach:
- **Generated layer**: `openapi-typescript` converts OpenAPI specs to TypeScript types
- **Hand-written layer**: Resource client classes reference generated types for inputs/outputs

This gives type safety from the spec plus a clean API surface that code generators can't match.

---

## Implementation

### 1. OpenAPI Spec (Source of Truth)

```yaml
# docs/openapi.yaml (abridged)
openapi: 3.0.3
info:
  title: My Service API
  version: 1.0.0
paths:
  /api/svc/v1/memories:
    post:
      operationId: createMemory
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateMemoryInput'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Memory'
components:
  schemas:
    CreateMemoryInput:
      type: object
      required: [content, type]
      properties:
        content: { type: string }
        type: { type: string }
        tags: { type: array, items: { type: string } }
    Memory:
      type: object
      properties:
        id: { type: string }
        content: { type: string }
        type: { type: string }
        tags: { type: array, items: { type: string } }
        created_at: { type: string, format: date-time }
```

### 2. Generate Types

```bash
# Add to package.json scripts
npx openapi-typescript docs/openapi.yaml -o src/clients/svc/v1/types.generated.ts
npx openapi-typescript docs/openapi-app.yaml -o src/app/types.generated.ts
```

```json
{
  "scripts": {
    "generate:types": "openapi-typescript docs/openapi.yaml -o src/clients/svc/v1/types.generated.ts",
    "generate:types:app": "openapi-typescript docs/openapi-app.yaml -o src/app/types.generated.ts"
  },
  "devDependencies": {
    "openapi-typescript": "^7.0.0"
  }
}
```

### 3. Generated Output (Committed to Source Control)

```typescript
// src/clients/svc/v1/types.generated.ts (auto-generated, do not edit)
export interface paths {
  '/api/svc/v1/memories': {
    post: {
      requestBody: {
        content: {
          'application/json': components['schemas']['CreateMemoryInput'];
        };
      };
      responses: {
        201: {
          content: {
            'application/json': components['schemas']['Memory'];
          };
        };
      };
    };
  };
  // ... more paths
}

export interface components {
  schemas: {
    CreateMemoryInput: {
      content: string;
      type: string;
      tags?: string[];
    };
    Memory: {
      id: string;
      content: string;
      type: string;
      tags: string[];
      created_at: string;
    };
  };
}
```

### 4. Hand-Written Client References Generated Types

```typescript
// src/clients/svc/v1/memories.ts (hand-written)
import { HttpClient, SdkResponse } from '../../http';
import type { paths, components } from './types.generated';

// Extract types from the generated spec
type CreateMemoryInput = paths['/api/svc/v1/memories']['post']['requestBody']['content']['application/json'];
type Memory = components['schemas']['Memory'];

class MemoriesResource {
  constructor(private http: HttpClient) {}

  create(userId: string, input: CreateMemoryInput): Promise<SdkResponse<Memory>> {
    return this.http.request('POST', '/api/svc/v1/memories', {
      body: input,
      userId,
    });
  }
}
```

### 5. Convenience Type Re-Exports

```typescript
// src/clients/svc/v1/types.ts (hand-written convenience aliases)
import type { components } from './types.generated';

export type Memory = components['schemas']['Memory'];
export type CreateMemoryInput = components['schemas']['CreateMemoryInput'];
export type Relationship = components['schemas']['Relationship'];
// ... etc.

// Consumers import clean names
import type { Memory, CreateMemoryInput } from '@my-org/my-core/clients/svc/v1';
```

---

## Benefits

1. **Single source of truth** - OpenAPI spec drives both server and client types
2. **Compile-time safety** - API changes caught by TypeScript, not at runtime
3. **Zero manual sync** - Regenerate types when spec changes, compiler finds breakage
4. **Clean DX** - Hand-written client code with full control over method signatures
5. **Committed types** - No build step needed to use the SDK; types are in source control

---

## Best Practices

### 1. Commit Generated Types
```bash
# Include in source control so consumers don't need to run generation
git add src/clients/svc/v1/types.generated.ts
```

### 2. Add a Banner Comment
```typescript
// types.generated.ts
// AUTO-GENERATED by openapi-typescript — DO NOT EDIT
// Regenerate: npm run generate:types
```

### 3. Create Convenience Type Aliases
```typescript
// Don't make consumers use paths['...']['post']['requestBody']['content']['application/json']
// Export clean names from a hand-written types.ts
export type Memory = components['schemas']['Memory'];
```

### 4. Regenerate in CI
```yaml
# .github/workflows/validate.yml
- name: Check types are up to date
  run: |
    npm run generate:types
    git diff --exit-code src/clients/svc/v1/types.generated.ts
```

---

## Anti-Patterns

### No Full Client Code Generation

```typescript
// Bad: Generate the entire client (lose control over DX)
npx orval --input docs/openapi.yaml --output src/clients/

// Good: Generate only types, hand-write client code
npx openapi-typescript docs/openapi.yaml -o src/clients/svc/v1/types.generated.ts
```

### No Manual Type Definitions That Mirror the Spec

```typescript
// Bad: Manually define types that exist in the spec
interface CreateMemoryInput {
  content: string;
  type: string;
  tags?: string[];
}

// Good: Import from generated types
import type { components } from './types.generated';
type CreateMemoryInput = components['schemas']['CreateMemoryInput'];
```

### No Forgetting to Regenerate After Spec Changes

```bash
# Bad: Spec updated, types stale, client compiles but sends wrong shapes

# Good: CI check ensures types match spec
npm run generate:types && git diff --exit-code
```

---

## Related Patterns

- **[Svc Client Pattern](core-sdk.client-svc.md)** - Resource clients that consume generated types
- **[App Client Pattern](core-sdk.client-app.md)** - App-tier types generated from separate spec
- **[HTTP Transport Pattern](core-sdk.client-http-transport.md)** - Transport layer that serializes typed inputs

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, openapi-typescript 7.0+
**Related Design**: [Client SDK Architecture](../design/core-sdk.architecture.md)
