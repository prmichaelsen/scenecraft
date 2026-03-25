# Pattern: SDK Response Type

**Namespace**: core-sdk
**Category**: Client SDK
**Created**: 2026-02-28
**Status**: Active

---

## Overview

The SDK Response pattern defines a Supabase-style `{ data, error }` return type for all client SDK methods. Every method returns `SdkResponse<T>` — never throws. Consumers choose between pattern matching (`if (error)`) or opt-in throwing via `.throwOnError()`.

This replaces `Result<T, E>` (used in direct service calls) with a shape optimized for REST client SDKs where errors carry HTTP status codes and machine-readable error codes.

---

## Problem

Without a standard response type:

1. **Try/catch everywhere**: Consumers wrap every call in try/catch, nesting grows fast
2. **Inconsistent error shapes**: Some methods throw, some return null, some return error objects
3. **No HTTP context**: Error objects lack status codes, making retry/redirect logic impossible
4. **Framework mismatch**: Next.js/Express error boundaries don't know which errors to catch vs. handle

---

## Solution

Define a `SdkResponse<T>` discriminated type that:
- Returns `{ data: T, error: null }` on success
- Returns `{ data: null, error: RememberError }` on failure
- Extends with `.throwOnError()` for consumers who prefer exceptions
- Carries HTTP status and machine-readable error code on every failure

---

## Implementation

```typescript
// src/clients/response.ts

/**
 * Machine-readable error from the REST API.
 */
interface RememberError {
  /** Machine-readable code: 'not_found', 'validation', 'unauthorized', etc. */
  code: string;
  /** Human-readable message */
  message: string;
  /** HTTP status code (0 for network errors) */
  status: number;
  /** Optional structured context (e.g., field-level validation errors) */
  context?: Record<string, unknown>;
}

/**
 * Every SDK method returns this shape. Never throws.
 */
interface SdkResponse<T> {
  data: T | null;
  error: RememberError | null;
}

/**
 * Extended response with throw escape hatch.
 */
interface ThrowableSdkResponse<T> extends SdkResponse<T> {
  /** Throws RememberError if error exists, otherwise returns data */
  throwOnError(): T;
}

/**
 * Create a success response.
 */
function ok<T>(data: T): ThrowableSdkResponse<T> {
  return {
    data,
    error: null,
    throwOnError() { return data; },
  };
}

/**
 * Create an error response.
 */
function fail<T = never>(error: RememberError): ThrowableSdkResponse<T> {
  return {
    data: null,
    error,
    throwOnError() { throw error; },
  };
}

/**
 * Wrap an async operation into SdkResponse.
 */
async function trySdk<T>(
  fn: () => Promise<T>,
  fallbackCode = 'internal',
): Promise<ThrowableSdkResponse<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    if (isRememberError(err)) return fail(err);
    return fail({
      code: fallbackCode,
      message: err instanceof Error ? err.message : 'Unknown error',
      status: 500,
    });
  }
}

function isRememberError(err: unknown): err is RememberError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'status' in err &&
    'message' in err
  );
}
```

### Usage Patterns

```typescript
// Pattern 1: Destructure and check (recommended)
const { data, error } = await client.memories.create(userId, input);
if (error) {
  console.error(`[${error.code}] ${error.message}`);
  return;
}
console.log('Created:', data.id);

// Pattern 2: Throw on error (opt-in exceptions)
const memory = await client.memories.create(userId, input).throwOnError();

// Pattern 3: Switch on error code
const { data, error } = await client.memories.search(userId, query);
if (error) {
  switch (error.code) {
    case 'unauthorized': redirect('/login'); break;
    case 'rate_limited': await sleep(1000); break;
    default: showError(error.message);
  }
}

// Pattern 4: Collect errors from multiple calls
const results = await Promise.all([
  client.memories.search(userId, q1),
  client.memories.search(userId, q2),
]);
const errors = results.filter(r => r.error).map(r => r.error!);
```

---

## Benefits

1. **No try/catch needed** - Errors are values, not exceptions
2. **HTTP-aware** - Every error carries status code for retry/redirect logic
3. **Machine-readable** - `error.code` enables programmatic error handling
4. **Opt-in throwing** - `.throwOnError()` for consumers who prefer exceptions
5. **Composable** - `Promise.all()` and error collection work naturally

---

## Best Practices

### 1. Always Return ThrowableSdkResponse
```typescript
// Resource clients return ThrowableSdkResponse, not bare SdkResponse
async create(userId: string, input: CreateInput): Promise<ThrowableSdkResponse<Memory>> {
  const raw = await this.http.request<Memory>('POST', '/memories', { body: input, userId });
  return raw.error ? fail(raw.error) : ok(raw.data!);
}
```

### 2. Use Error Codes, Not Status Codes, for Logic
```typescript
// Bad: branch on HTTP status
if (error.status === 404) { ... }

// Good: branch on semantic code
if (error.code === 'not_found') { ... }
```

### 3. Include Context for Validation Errors
```typescript
return fail({
  code: 'validation',
  message: 'Invalid input',
  status: 400,
  context: {
    fields: { email: 'Invalid format', name: 'Required' },
  },
});
```

---

## Anti-Patterns

### No Mixed Return Styles

```typescript
// Bad: Some methods throw, some return { data, error }
async get(id: string): Promise<Memory> { throw new Error('not found'); }
async list(): Promise<SdkResponse<Memory[]>> { return { data: [], error: null }; }

// Good: All methods return SdkResponse
async get(id: string): Promise<ThrowableSdkResponse<Memory>> { ... }
async list(): Promise<ThrowableSdkResponse<Memory[]>> { ... }
```

### No Swallowing Error Details

```typescript
// Bad: Lose the original error
return fail({ code: 'internal', message: 'Something went wrong', status: 500 });

// Good: Preserve the API's error code and message
return fail({
  code: body.code ?? 'internal',
  message: body.message ?? 'Unknown error',
  status: res.status,
  context: body.context,
});
```

---

## Related Patterns

- **[Result Type Pattern](core-sdk.types-result.md)** - `Result<T, E>` for direct service calls (no HTTP context)
- **[HTTP Transport Pattern](core-sdk.client-http-transport.md)** - Transport that produces `SdkResponse<T>`
- **[Error Type Pattern](core-sdk.types-error.md)** - `AppError` hierarchy used by core services

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Node.js 18+
**Related Design**: [Client SDK Architecture](../design/core-sdk.architecture.md)
