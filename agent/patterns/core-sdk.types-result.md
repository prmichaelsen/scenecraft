# Pattern: Result Types

**Category**: Type System
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Result Type pattern provides a `Result<T, E>` type for representing success or failure without throwing exceptions. This is useful for operations where failure is a normal, expected outcome (not a programmer error) and where callers must explicitly handle both cases. It works alongside the error type hierarchy rather than replacing it.

## Problem Statement

Using `throw` for all errors has trade-offs:
- Callers can forget to wrap calls in try/catch — errors become unchecked
- Function signatures don't communicate which errors can occur
- Deep call stacks make error propagation implicit and hard to trace
- TypeScript cannot enforce that `catch` blocks handle specific error types

## Solution

For operations where failure is expected (validation, parsing, lookups), return a `Result<T, E>` instead of throwing. The type encodes success (`Ok<T>`) and failure (`Err<E>`) as a discriminated union. TypeScript enforces that callers check the result before accessing the value.

## Implementation

### Core Result Type

```typescript
// src/types/result.types.ts

/**
 * Represents a successful result containing a value of type T
 */
export interface Ok<T> {
  readonly success: true;
  readonly value: T;
}

/**
 * Represents a failed result containing an error of type E
 */
export interface Err<E> {
  readonly success: false;
  readonly error: E;
}

/**
 * A value that is either Ok<T> or Err<E>
 */
export type Result<T, E = Error> = Ok<T> | Err<E>;

/**
 * Construct a successful result
 */
export function ok<T>(value: T): Ok<T> {
  return { success: true, value };
}

/**
 * Construct a failed result
 */
export function err<E>(error: E): Err<E> {
  return { success: false, error };
}

/**
 * Type guard: checks if a Result is successful
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.success === true;
}

/**
 * Type guard: checks if a Result is a failure
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.success === false;
}
```

### Using Result in Services

```typescript
// src/services/user.service.ts
import { Result, ok, err } from '../types/result.types';
import { ValidationError, NotFoundError } from '../errors';
import { User, UserId, CreateUserInput } from '../types';

export class UserService {
  /**
   * Returns Ok<User> on success, Err<NotFoundError> if not found
   * Callers must handle both cases
   */
  async findUser(id: UserId): Promise<Result<User, NotFoundError>> {
    const user = await this.repo.findById(id);
    if (!user) {
      return err(new NotFoundError('User', id));
    }
    return ok(user);
  }

  /**
   * Returns Ok<User> on success, Err<ValidationError> on invalid input
   */
  async createUser(
    input: CreateUserInput
  ): Promise<Result<User, ValidationError>> {
    const fields: Record<string, string[]> = {};

    if (!input.email.includes('@')) {
      fields.email = ['Must be a valid email address'];
    }
    if (input.name.trim().length < 2) {
      fields.name = ['Must be at least 2 characters'];
    }

    if (Object.keys(fields).length > 0) {
      return err(new ValidationError('Invalid input', fields));
    }

    const user = await this.repo.create(input);
    return ok(user);
  }
}
```

### Handling Results in Adapters

```typescript
// src/adapters/rest/user.routes.ts
import { Router } from 'express';
import { UserService } from '../../services/user.service';
import { isOk } from '../../types/result.types';
import { toUserId } from '../../types';

export function userRoutes(service: UserService): Router {
  const router = Router();

  router.get('/:id', async (req, res) => {
    const result = await service.findUser(toUserId(req.params.id));

    if (isOk(result)) {
      res.json(result.value);
    } else {
      // result.error is typed as NotFoundError — full access to its fields
      res.status(404).json({
        error: {
          kind: result.error.kind,
          message: result.error.message,
          resource: result.error.resource,
          id: result.error.id,
        },
      });
    }
  });

  router.post('/', async (req, res) => {
    const result = await service.createUser(req.body);

    if (isOk(result)) {
      res.status(201).json(result.value);
    } else {
      // result.error is typed as ValidationError
      res.status(400).json({
        error: {
          kind: result.error.kind,
          message: result.error.message,
          fields: result.error.fields,  // TypeScript knows ValidationError has .fields
        },
      });
    }
  });

  return router;
}
```

### Result Chaining

```typescript
// src/types/result.types.ts — additional combinators

/**
 * Apply a transform to the Ok value, passing Err through unchanged
 */
export function mapOk<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  if (isOk(result)) {
    return ok(fn(result.value));
  }
  return result;
}

/**
 * Apply a transform to the Err value, passing Ok through unchanged
 */
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F
): Result<T, F> {
  if (isErr(result)) {
    return err(fn(result.error));
  }
  return result;
}

/**
 * Chain two Result-returning operations
 */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  if (isOk(result)) {
    return fn(result.value);
  }
  return result;
}

/**
 * Unwrap the Ok value or return a default
 */
export function getOrElse<T, E>(result: Result<T, E>, defaultValue: T): T {
  return isOk(result) ? result.value : defaultValue;
}

/**
 * Wrap a function that might throw into one returning a Result
 */
export function tryCatch<T, E = Error>(
  fn: () => T,
  onError: (err: unknown) => E
): Result<T, E> {
  try {
    return ok(fn());
  } catch (e) {
    return err(onError(e));
  }
}

/**
 * Wrap an async function that might throw into one returning a Result
 */
export async function tryCatchAsync<T, E = Error>(
  fn: () => Promise<T>,
  onError: (err: unknown) => E
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(onError(e));
  }
}
```

### Result Chaining in Practice

```typescript
// src/services/order.service.ts
import { Result, ok, err, andThen, mapErr } from '../types/result.types';
import { ValidationError, NotFoundError } from '../errors';
import { UserService } from './user.service';

export class OrderService {
  constructor(
    private readonly users: UserService,
    private readonly repo: OrderRepository
  ) {}

  async createOrder(
    userId: UserId,
    items: OrderItem[]
  ): Promise<Result<Order, NotFoundError | ValidationError>> {
    // Chain: find user → validate items → create order
    const userResult = await this.users.findUser(userId);
    if (!userResult.success) {
      return userResult;  // Err<NotFoundError> passes through
    }

    const validationResult = this.validateItems(items);
    if (!validationResult.success) {
      return validationResult;  // Err<ValidationError> passes through
    }

    const order = await this.repo.create({
      userId,
      items: validationResult.value,
    });
    return ok(order);
  }

  private validateItems(
    items: OrderItem[]
  ): Result<ValidatedOrderItem[], ValidationError> {
    if (items.length === 0) {
      return err(new ValidationError('Order must have at least one item'));
    }
    // ... additional validation
    return ok(items as ValidatedOrderItem[]);
  }
}
```

### Wrapping Third-Party APIs

```typescript
// src/adapters/external/stripe.adapter.ts
import Stripe from 'stripe';
import { Result, tryCatchAsync, mapErr } from '../../types/result.types';
import { ExternalError } from '../../errors';

export class StripeAdapter {
  async createPaymentIntent(
    amount: number,
    currency: string
  ): Promise<Result<Stripe.PaymentIntent, ExternalError>> {
    return tryCatchAsync(
      () => this.stripe.paymentIntents.create({ amount, currency }),
      (err) => new ExternalError(
        `Stripe payment intent failed: ${err instanceof Error ? err.message : 'unknown'}`,
        'stripe'
      )
    );
  }
}
```

### Barrel Export

```typescript
// src/types/index.ts (additions)
export type { Result, Ok, Err } from './result.types';
export {
  ok,
  err,
  isOk,
  isErr,
  mapOk,
  mapErr,
  andThen,
  getOrElse,
  tryCatch,
  tryCatchAsync,
} from './result.types';
```

## When to Use Result vs Throw

| Scenario | Approach |
|----------|----------|
| Expected failure (not found, validation) | `Result<T, E>` |
| Unexpected programmer error | `throw` |
| External API wrapper | `Result<T, ExternalError>` via `tryCatchAsync` |
| Internal service errors | `throw` (still use typed `AppError` subclass) |
| Parse/validate untrusted input | `Result<T, ValidationError>` |
| Async middleware chains | `throw` (Express/framework handles it) |

## Usage Guidelines

### When to Use

- ✅ Service methods with expected failure modes (find, validate, parse)
- ✅ Adapter calls to external APIs where failure is normal
- ✅ Input parsing at service boundaries
- ✅ Chains of operations where any step can fail

### When Not to Use

- ❌ Functions that should never fail (pure transformations)
- ❌ Framework middleware (use throw + error handler middleware instead)
- ❌ Wrapping every possible error — be selective

## Best Practices

1. **Be consistent within a layer**: If services return `Result`, don't mix with `throw` in the same method
2. **Be specific about error types**: `Result<User, NotFoundError>` not `Result<User, AppError>`
3. **Use `tryCatchAsync` at external boundaries**: Wrap third-party calls that can throw
4. **Exhaust both cases**: Always handle both `isOk` and `isErr` in the caller
5. **Don't nest Results**: `Result<Result<T, E>, F>` is a design smell — use `andThen`

```typescript
// Good: Specific error type, both cases handled
const result: Result<User, NotFoundError> = await service.findUser(id);
if (isOk(result)) {
  return result.value;
} else {
  return null; // or a default, or re-throw
}

// Bad: Ignoring the error case
const result = await service.findUser(id);
return result.value; // TypeScript error — value may not exist
```

## Anti-Patterns

### ❌ Accessing Value Without Checking

```typescript
// Bad: TypeScript won't allow this, but conceptually wrong
const result = await service.findUser(id);
doSomethingWith(result.value);  // Error: value doesn't exist on Err<E>

// Good: Check success first
if (isOk(result)) {
  doSomethingWith(result.value);  // Safe
}
```

### ❌ Throwing Inside a Result-Returning Function

```typescript
// Bad: Inconsistent — caller doesn't know to handle throw
async function findUser(id: UserId): Promise<Result<User, NotFoundError>> {
  if (!id) throw new Error('id required');  // Mixed error handling
  ...
}

// Good: Return Err for all expected failures
async function findUser(id: UserId): Promise<Result<User, ValidationError | NotFoundError>> {
  if (!id) return err(new ValidationError('id is required'));
  ...
}
```

### ❌ Overly Broad Error Union

```typescript
// Bad: Callers can't handle specific cases
async function doSomething(): Promise<Result<Data, AppErrorUnion>> { ... }

// Good: Specific to the operation's failure modes
async function findUser(): Promise<Result<User, NotFoundError>> { ... }
async function createUser(): Promise<Result<User, ValidationError | ConflictError>> { ... }
```

## Related Patterns

- [Error Types](core-sdk.types-error.md) - The error classes used as the `E` in `Result<T, E>`
- [Service Base](core-sdk.service-base.md) - Services that return Result types
- [Adapter Base](core-sdk.adapter-base.md) - Adapters that unwrap Result types into HTTP/MCP responses
- [Generic Utility Types](core-sdk.types-generic.md) - Generic patterns used in Result combinators

---

**Status**: Active
**Recommendation**: Use `Result<T, E>` for expected failures in services and external adapter calls. Use typed error classes as the `E` type. Always handle both `Ok` and `Err` at the call site. Reserve `throw` for unexpected programmer errors.
