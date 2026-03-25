# Pattern: Error Types

**Category**: Type System
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Error Types pattern establishes a typed error hierarchy using discriminated unions and custom error classes. Errors are categorized by kind (validation, not found, auth, conflict, internal), carry typed payloads, and are exported from a central location so adapters can map them to appropriate HTTP status codes or MCP error responses.

## Problem Statement

Without typed errors:
- Catch blocks use `unknown` or `any`, discarding type information
- HTTP status codes are selected ad-hoc in each adapter
- Error messages are inconsistent across routes
- No way to distinguish "not found" from "unauthorized" without parsing error strings

## Solution

Define a discriminated union of error classes. Each error kind has a unique `kind` string literal. Adapters switch on `kind` to map errors to the right response. All error classes extend a common `AppError` base class.

## Implementation

### Base Error Class

```typescript
// src/errors/base.error.ts

export type ErrorKind =
  | 'validation'
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'rate_limit'
  | 'external'
  | 'internal';

export interface ErrorContext {
  [key: string]: unknown;
}

/**
 * Base class for all application errors.
 * Always use a specific subclass — never throw AppError directly.
 */
export abstract class AppError extends Error {
  abstract readonly kind: ErrorKind;

  constructor(
    message: string,
    public readonly context: ErrorContext = {}
  ) {
    super(message);
    this.name = this.constructor.name;
    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): object {
    return {
      kind: this.kind,
      name: this.name,
      message: this.message,
      context: this.context,
    };
  }
}
```

### Typed Error Subclasses

```typescript
// src/errors/app-errors.ts
import { AppError } from './base.error';

/**
 * Input validation failed — HTTP 400
 */
export class ValidationError extends AppError {
  readonly kind = 'validation' as const;

  constructor(
    message: string,
    public readonly fields: Record<string, string[]> = {}
  ) {
    super(message, { fields });
  }
}

/**
 * Resource not found — HTTP 404
 */
export class NotFoundError extends AppError {
  readonly kind = 'not_found' as const;

  constructor(
    public readonly resource: string,
    public readonly id: string
  ) {
    super(`${resource} not found: ${id}`, { resource, id });
  }
}

/**
 * Not authenticated — HTTP 401
 */
export class UnauthorizedError extends AppError {
  readonly kind = 'unauthorized' as const;

  constructor(message = 'Authentication required') {
    super(message);
  }
}

/**
 * Authenticated but not permitted — HTTP 403
 */
export class ForbiddenError extends AppError {
  readonly kind = 'forbidden' as const;

  constructor(
    message = 'Access denied',
    public readonly requiredRole?: string
  ) {
    super(message, { requiredRole });
  }
}

/**
 * Resource state conflict — HTTP 409
 */
export class ConflictError extends AppError {
  readonly kind = 'conflict' as const;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
  }
}

/**
 * Too many requests — HTTP 429
 */
export class RateLimitError extends AppError {
  readonly kind = 'rate_limit' as const;

  constructor(
    public readonly retryAfterSeconds: number
  ) {
    super(`Rate limit exceeded. Retry after ${retryAfterSeconds}s`, {
      retryAfterSeconds,
    });
  }
}

/**
 * External service failed (upstream API, database) — HTTP 502
 */
export class ExternalError extends AppError {
  readonly kind = 'external' as const;

  constructor(
    message: string,
    public readonly service: string
  ) {
    super(message, { service });
  }
}

/**
 * Unexpected internal error — HTTP 500
 */
export class InternalError extends AppError {
  readonly kind = 'internal' as const;

  constructor(message = 'Internal server error') {
    super(message);
  }
}
```

### Discriminated Union Type

```typescript
// src/errors/types.ts
import {
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  ExternalError,
  InternalError,
} from './app-errors';

/**
 * Union of all typed application errors.
 * Use this in catch blocks and Result types.
 */
export type AppErrorUnion =
  | ValidationError
  | NotFoundError
  | UnauthorizedError
  | ForbiddenError
  | ConflictError
  | RateLimitError
  | ExternalError
  | InternalError;

/**
 * Type guard: checks if a value is an AppError
 */
export function isAppError(value: unknown): value is AppErrorUnion {
  return value instanceof Error && 'kind' in value;
}
```

### HTTP Status Mapping (REST Adapter)

```typescript
// src/adapters/rest/error-handler.ts
import { Request, Response, NextFunction } from 'express';
import { AppErrorUnion, isAppError } from '../../errors/types';

const STATUS_MAP: Record<AppErrorUnion['kind'], number> = {
  validation:    400,
  unauthorized:  401,
  forbidden:     403,
  not_found:     404,
  conflict:      409,
  rate_limit:    429,
  external:      502,
  internal:      500,
};

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (isAppError(err)) {
    const status = STATUS_MAP[err.kind];
    res.status(status).json({
      error: {
        kind: err.kind,
        message: err.message,
        ...(err.kind === 'validation' ? { fields: err.fields } : {}),
        ...(err.kind === 'rate_limit' ? { retryAfter: err.retryAfterSeconds } : {}),
      },
    });
  } else {
    // Unknown error — don't leak details
    console.error('Unhandled error:', err);
    res.status(500).json({ error: { kind: 'internal', message: 'Internal server error' } });
  }
}
```

### MCP Error Mapping

```typescript
// src/adapters/mcp/error-handler.ts
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AppErrorUnion, isAppError } from '../../errors/types';

const MCP_CODE_MAP: Record<AppErrorUnion['kind'], ErrorCode> = {
  validation:    ErrorCode.InvalidParams,
  unauthorized:  ErrorCode.InvalidRequest,
  forbidden:     ErrorCode.InvalidRequest,
  not_found:     ErrorCode.InvalidParams,
  conflict:      ErrorCode.InvalidRequest,
  rate_limit:    ErrorCode.InternalError,
  external:      ErrorCode.InternalError,
  internal:      ErrorCode.InternalError,
};

export function toMcpError(err: unknown): McpError {
  if (isAppError(err)) {
    return new McpError(MCP_CODE_MAP[err.kind], err.message);
  }
  return new McpError(ErrorCode.InternalError, 'Internal server error');
}
```

### Usage in Services

```typescript
// src/services/user.service.ts
import { NotFoundError, ValidationError, ConflictError } from '../errors/app-errors';
import { UserId, CreateUserInput } from '../types';

export class UserService {
  async getUser(id: UserId): Promise<User> {
    const user = await this.repo.findById(id);
    if (!user) {
      throw new NotFoundError('User', id);  // Typed: kind='not_found', resource, id
    }
    return user;
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const errors: Record<string, string[]> = {};

    if (!input.email.includes('@')) {
      errors.email = ['Must be a valid email address'];
    }
    if (input.name.trim().length < 2) {
      errors.name = ['Must be at least 2 characters'];
    }

    if (Object.keys(errors).length > 0) {
      throw new ValidationError('Invalid user input', errors);
    }

    const existing = await this.repo.findByEmail(input.email);
    if (existing) {
      throw new ConflictError(`User with email ${input.email} already exists`, {
        email: input.email,
      });
    }

    return this.repo.create(input);
  }
}
```

### Barrel Export

```typescript
// src/errors/index.ts
export { AppError } from './base.error';
export type { ErrorKind, ErrorContext } from './base.error';
export {
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  ExternalError,
  InternalError,
} from './app-errors';
export type { AppErrorUnion } from './types';
export { isAppError } from './types';
```

## Usage Guidelines

### When to Use

- ✅ All service-layer errors that cross layer boundaries
- ✅ Any error with distinct handling logic per adapter
- ✅ Validation failures with field-level detail
- ✅ Resource lookups that may fail (not found, forbidden)

### When Not to Use

- ❌ Truly unexpected programmer errors (let them bubble as native `Error`)
- ❌ Internal retry logic within a single service method

## Best Practices

1. **Always throw specific subclasses**: `throw new NotFoundError(...)`, never `throw new AppError(...)`
2. **Include context**: Pass relevant IDs, field names, and values in the error context
3. **Map at adapter boundaries**: Services throw typed errors; adapters convert them to HTTP/MCP responses
4. **Use `isAppError()` in catch blocks**: Don't catch unknown errors as `AppError` directly
5. **Don't swallow errors**: Always log or re-throw unknown errors in catch blocks

```typescript
// Good: Typed catch with discriminated handling
try {
  await userService.getUser(id);
} catch (err) {
  if (isAppError(err)) {
    switch (err.kind) {
      case 'not_found': return res.status(404).json({ message: err.message });
      case 'unauthorized': return res.status(401).json({ message: err.message });
      default: return res.status(500).json({ message: 'Error' });
    }
  }
  throw err;  // Re-throw unknown errors
}
```

## Anti-Patterns

### ❌ Throwing Strings or Plain Objects

```typescript
// Bad: No type information, no stack trace
throw 'User not found';
throw { error: 'not_found' };

// Good: Typed error with context
throw new NotFoundError('User', userId);
```

### ❌ Checking Error Messages

```typescript
// Bad: Fragile — breaks if message changes
if (error.message.includes('not found')) { ... }

// Good: Check the kind discriminant
if (isAppError(error) && error.kind === 'not_found') { ... }
```

### ❌ Mapping Errors Inside Services

```typescript
// Bad: Service knows about HTTP — couples service to transport
if (!user) {
  res.status(404).json({ message: 'Not found' });
  return;
}

// Good: Service throws typed error, adapter maps it
if (!user) {
  throw new NotFoundError('User', id);
}
```

## Related Patterns

- [Result Types](core-sdk.types-result.md) - Alternative to throwing: `Result<T, AppErrorUnion>`
- [Service Error Handling](core-sdk.service-error-handling.md) - How services use these error types
- [Adapter Base](core-sdk.adapter-base.md) - Error mapping at adapter boundaries
- [Shared Types](core-sdk.types-shared.md) - Domain types that errors reference (UserId, etc.)

---

**Status**: Active
**Recommendation**: Define a discriminated union error hierarchy with one class per error kind. Map errors to HTTP/MCP responses at adapter boundaries, not inside services.
