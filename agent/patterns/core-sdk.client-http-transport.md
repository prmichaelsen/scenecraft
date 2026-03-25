# Pattern: Client HTTP Transport

**Namespace**: core-sdk
**Category**: Client SDK
**Created**: 2026-02-28
**Status**: Active

---

## Overview

The Client HTTP Transport pattern provides a shared, configurable `fetch()`-based HTTP layer that all client SDKs build on. It handles base URL resolution, authentication (JWT or consumer-provided tokens), request serialization, and response parsing into a standard `SdkResponse<T>` shape.

This is the foundation layer — individual resource clients (memories, users, etc.) delegate all HTTP calls to this transport.

---

## Problem

Without a shared HTTP transport:

1. **Duplicated fetch logic**: Every resource client hand-writes `fetch()` calls with headers, body serialization, and error parsing
2. **Inconsistent auth**: Some endpoints get tokens, others don't; token refresh logic scattered
3. **No error normalization**: Different HTTP errors parsed differently across the SDK
4. **Hard to test**: Each resource client needs its own `fetch()` mock setup

---

## Solution

Create an `HttpClient` class that:
- Accepts a `baseUrl` and auth configuration
- Provides a single `request<T>()` method used by all resource clients
- Handles JWT generation or token callback per request
- Normalizes all HTTP errors into `SdkResponse<T>` shape
- Is independently testable and mockable

---

## Implementation

```typescript
// src/clients/http.ts

interface HttpClientConfig {
  baseUrl: string;
  /** Option A: SDK generates JWT per request (requires jsonwebtoken) */
  auth?: {
    serviceToken: string;
    jwtOptions?: { issuer?: string; audience?: string; expiresIn?: string };
  };
  /** Option B: Consumer provides token per request */
  getAuthToken?: (userId: string) => string | Promise<string>;
  /** Optional: validate response shapes at runtime */
  validateResponses?: boolean;
}

interface RequestOptions {
  body?: unknown;
  params?: Record<string, string>;
  userId: string;
  headers?: Record<string, string>;
}

interface SdkResponse<T> {
  data: T | null;
  error: RememberError | null;
}

interface RememberError {
  code: string;       // e.g. 'not_found', 'validation', 'unauthorized'
  message: string;
  status: number;     // HTTP status
  context?: Record<string, unknown>;
}

class HttpClient {
  private readonly baseUrl: string;
  private readonly config: HttpClientConfig;

  constructor(config: HttpClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.config = config;
  }

  async request<T>(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<SdkResponse<T>> {
    const url = this.buildUrl(path, options?.params);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers,
    };

    // Attach auth
    if (options?.userId) {
      const token = await this.resolveToken(options.userId);
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });

      if (!res.ok) {
        return { data: null, error: await this.parseError(res) };
      }

      const data = res.status === 204 ? null : await res.json();
      return { data: data as T, error: null };
    } catch (err) {
      return {
        data: null,
        error: {
          code: 'network_error',
          message: err instanceof Error ? err.message : 'Unknown error',
          status: 0,
        },
      };
    }
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  private async resolveToken(userId: string): Promise<string | null> {
    if (this.config.getAuthToken) {
      return this.config.getAuthToken(userId);
    }
    if (this.config.auth?.serviceToken) {
      // Lazy-import jsonwebtoken (optional peer dep)
      const jwt = await import('jsonwebtoken');
      return jwt.default.sign(
        { sub: userId },
        this.config.auth.serviceToken,
        {
          issuer: this.config.auth.jwtOptions?.issuer ?? 'sdk',
          audience: this.config.auth.jwtOptions?.audience ?? 'api',
          expiresIn: this.config.auth.jwtOptions?.expiresIn ?? '5m',
        },
      );
    }
    return null;
  }

  private async parseError(res: Response): Promise<RememberError> {
    try {
      const body = await res.json();
      return {
        code: body.code ?? this.statusToCode(res.status),
        message: body.message ?? res.statusText,
        status: res.status,
        context: body.context,
      };
    } catch {
      return {
        code: this.statusToCode(res.status),
        message: res.statusText,
        status: res.status,
      };
    }
  }

  private statusToCode(status: number): string {
    const map: Record<number, string> = {
      400: 'validation',
      401: 'unauthorized',
      403: 'forbidden',
      404: 'not_found',
      409: 'conflict',
      429: 'rate_limited',
      500: 'internal',
    };
    return map[status] ?? 'unknown';
  }
}
```

---

## Benefits

1. **Single responsibility** - All HTTP concerns in one place
2. **Auth flexibility** - JWT generation or consumer-provided tokens
3. **Error normalization** - Every failure becomes `{ data: null, error: RememberError }`
4. **Testable** - Mock one class to test all resource clients
5. **Zero coupling** - Resource clients only depend on the `request<T>()` signature

---

## Best Practices

### 1. Make jsonwebtoken an Optional Peer Dependency
```json
{
  "peerDependencies": {
    "jsonwebtoken": "^9.0.0"
  },
  "peerDependenciesMeta": {
    "jsonwebtoken": { "optional": true }
  }
}
```

### 2. Use Lazy Import for Optional Dependencies
```typescript
// Only loaded when auth.serviceToken is used
const jwt = await import('jsonwebtoken');
```

### 3. Normalize All Errors Through parseError
```typescript
// Every non-2xx response goes through the same parser
if (!res.ok) {
  return { data: null, error: await this.parseError(res) };
}
```

---

## Anti-Patterns

### No Raw fetch in Resource Clients

```typescript
// Bad: Each resource client calls fetch() directly
class MemoriesResource {
  async create(input: CreateInput) {
    const res = await fetch(`${this.baseUrl}/memories`, { ... });
    // Duplicate error handling, auth, serialization...
  }
}

// Good: Delegate to HttpClient
class MemoriesResource {
  constructor(private http: HttpClient) {}
  async create(userId: string, input: CreateInput) {
    return this.http.request<Memory>('POST', '/api/svc/v1/memories', {
      body: input, userId,
    });
  }
}
```

### No Hardcoded Auth Strategy

```typescript
// Bad: Always requires a service token
constructor(config: { serviceToken: string }) { ... }

// Good: Support both auth strategies
constructor(config: {
  auth?: { serviceToken: string };          // SDK-managed JWT
  getAuthToken?: (userId: string) => string; // Consumer-managed token
}) { ... }
```

---

## Related Patterns

- **[SDK Response Pattern](core-sdk.client-response.md)** - The `SdkResponse<T>` type this transport returns
- **[Svc Client Pattern](core-sdk.client-svc.md)** - Resource clients that consume this transport
- **[Adapter Client Pattern](core-sdk.adapter-client.md)** - Higher-level client adapter (direct service calls)

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Node.js 18+
**Related Design**: [Client SDK Architecture](../design/core-sdk.architecture.md)
