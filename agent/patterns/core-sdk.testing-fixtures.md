# Pattern: Test Fixtures

**Category**: Testing
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Test Fixtures pattern establishes how to create reusable, typed test data for use across `.spec.ts` files. Fixtures are defined as factory functions in colocated `.fixtures.ts` files, producing realistic but deterministic data without relying on external sources.

## Problem Statement

Without a structured fixture approach:
- Test data is duplicated and inconsistent across spec files
- Changes to data models require updating dozens of test files
- Test data is hardcoded with magic strings and numbers
- Large object literals clutter test files and hide intent

## Solution

Define typed fixture factories as named functions in `.fixtures.ts` files colocated next to the relevant source. Factories accept optional overrides so each test can customize only what matters.

## Implementation

### Fixture File Structure

```
src/
├── services/
│   ├── user.service.ts
│   ├── user.service.spec.ts
│   └── user.fixtures.ts         ← fixtures for user-related tests
├── adapters/
│   ├── rest.adapter.ts
│   ├── rest.adapter.spec.ts
│   └── rest.fixtures.ts         ← fixtures for adapter tests
└── shared/
    └── shared.fixtures.ts       ← cross-cutting fixtures
```

### Basic Fixture Factory

```typescript
// src/services/user.fixtures.ts
import { User, CreateUserInput } from './user.service';

/**
 * Creates a test user with sensible defaults
 * Pass partial overrides to customize specific fields
 */
export function createUserFixture(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    name: 'Alice Example',
    email: 'alice@example.com',
    role: 'member',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function createAdminUserFixture(overrides: Partial<User> = {}): User {
  return createUserFixture({ role: 'admin', ...overrides });
}

export function createUserInputFixture(
  overrides: Partial<CreateUserInput> = {}
): CreateUserInput {
  return {
    name: 'Bob Example',
    email: 'bob@example.com',
    password: 'test-password-123',
    ...overrides,
  };
}
```

```typescript
// src/services/user.service.spec.ts
import { UserService } from './user.service';
import { createUserFixture, createUserInputFixture } from './user.fixtures';

describe('UserService.updateUser', () => {
  it('updates only provided fields', async () => {
    // Clear intent — only the email matters for this test
    const existingUser = createUserFixture({ email: 'old@example.com' });
    mockRepo.findById.mockResolvedValue(existingUser);

    const updated = await service.updateUser('user-1', { email: 'new@example.com' });

    expect(updated.email).toBe('new@example.com');
    expect(updated.name).toBe(existingUser.name); // unchanged
  });
});
```

### List Fixtures

```typescript
// src/services/product.fixtures.ts
import { Product } from './product.service';

let counter = 0;

/**
 * Creates a unique product fixture (counter ensures unique ids)
 */
export function createProductFixture(overrides: Partial<Product> = {}): Product {
  counter++;
  return {
    id: `product-${counter}`,
    name: `Product ${counter}`,
    price: 9.99,
    category: 'general',
    stock: 100,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Creates a list of product fixtures
 */
export function createProductListFixture(
  count: number,
  overrides: Partial<Product> = {}
): Product[] {
  return Array.from({ length: count }, () => createProductFixture(overrides));
}

/**
 * Reset counter between tests (call in beforeEach if needed)
 */
export function resetProductCounter(): void {
  counter = 0;
}
```

```typescript
// src/services/product.service.spec.ts
import {
  createProductFixture,
  createProductListFixture,
  resetProductCounter,
} from './product.fixtures';

describe('ProductService.listProducts', () => {
  beforeEach(() => resetProductCounter());

  it('returns paginated products', async () => {
    const products = createProductListFixture(25);
    mockRepo.findAll.mockResolvedValue(products);

    const result = await service.listProducts({ page: 1, limit: 10 });

    expect(result.items).toHaveLength(10);
    expect(result.total).toBe(25);
  });
});
```

### Complex Nested Fixtures

```typescript
// src/services/order.fixtures.ts
import { Order, OrderLine, Address } from './order.service';
import { createUserFixture } from '../users/user.fixtures';
import { createProductFixture } from '../products/product.fixtures';

export function createAddressFixture(overrides: Partial<Address> = {}): Address {
  return {
    street: '123 Main St',
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    country: 'US',
    ...overrides,
  };
}

export function createOrderLineFixture(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    product: createProductFixture(),
    quantity: 1,
    unitPrice: 9.99,
    ...overrides,
  };
}

export function createOrderFixture(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    user: createUserFixture(),
    lines: [createOrderLineFixture()],
    shippingAddress: createAddressFixture(),
    status: 'pending',
    total: 9.99,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// Scenario-specific fixtures
export function createPaidOrderFixture(): Order {
  return createOrderFixture({
    status: 'paid',
    paidAt: new Date('2026-01-01T01:00:00Z'),
  });
}

export function createMultiLineOrderFixture(): Order {
  return createOrderFixture({
    lines: [
      createOrderLineFixture({ quantity: 2, unitPrice: 5.00 }),
      createOrderLineFixture({ quantity: 1, unitPrice: 19.99 }),
    ],
    total: 29.99,
  });
}
```

### Shared Test Fixtures

```typescript
// src/shared/shared.fixtures.ts
// Cross-cutting fixtures used by many test files

export const TEST_DATE = new Date('2026-01-01T00:00:00Z');
export const TEST_DATE_ISO = '2026-01-01T00:00:00.000Z';

export const TEST_USER_ID = 'test-user-id';
export const TEST_ORG_ID = 'test-org-id';

/**
 * Standard pagination parameters for tests
 */
export const DEFAULT_PAGE = { page: 1, limit: 10 };

/**
 * Creates a mock Express request object
 */
export function createMockRequest(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    headers: {},
    params: {},
    query: {},
    body: {},
    ...overrides,
  };
}

/**
 * Creates a mock Express response object with jest spies
 */
export function createMockResponse(): {
  res: Partial<Response>;
  json: jest.Mock;
  status: jest.Mock;
  send: jest.Mock;
} {
  const json = jest.fn().mockReturnThis();
  const send = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnThis();

  return {
    res: { json, send, status } as any,
    json,
    send,
    status,
  };
}
```

## Usage Guidelines

### When to Use

- ✅ Any test that needs domain model instances (User, Product, Order)
- ✅ When the same base object is needed with minor variations across tests
- ✅ When test data setup clutters the test file
- ✅ Shared Express request/response mocks

### When Not to Use

- ❌ Trivial primitive values — just inline them (`'user-1'`, `42`)
- ❌ Fixtures that are only used once in a single test
- ❌ Database seeds (use migration fixtures, not test fixtures)

## Best Practices

1. **Use override pattern**: `createFoo(overrides = {})` — every field has a default
2. **Colocate with source**: `user.fixtures.ts` next to `user.service.ts`
3. **Use realistic values**: Not `'test'`, `'foo'`, `1` — use plausible domain data
4. **Keep fixtures stable**: Don't use `Date.now()` or random values by default
5. **Name for the scenario**: `createPaidOrderFixture()` is clearer than `createOrderFixture({ status: 'paid' })`
6. **Reset stateful counters**: Use `beforeEach` to reset sequence counters

```typescript
// Good: Realistic, stable, override-friendly
export function createUserFixture(overrides: Partial<User> = {}): User {
  return { id: 'user-1', name: 'Alice Example', email: 'alice@example.com', ...overrides };
}

// Bad: Magic values, not override-friendly
export const testUser = { id: '1', name: 'test', email: 'x@x.com' };
```

## Anti-Patterns

### ❌ Fixture Files in a Separate Directory

```
// Bad: Disconnected from source
fixtures/
  user.fixture.ts
  product.fixture.ts

// Good: Colocated
src/services/user.fixtures.ts
src/services/product.fixtures.ts
```

### ❌ Non-Deterministic Fixtures

```typescript
// Bad: Different on every run
export function createUserFixture(): User {
  return { id: crypto.randomUUID(), createdAt: new Date() };
}

// Good: Stable by default, overridable
export function createUserFixture(overrides = {}): User {
  return { id: 'user-1', createdAt: new Date('2026-01-01'), ...overrides };
}
```

### ❌ Fixture Objects Instead of Factories

```typescript
// Bad: Shared mutable object — tests interfere with each other
export const testUser: User = { id: 'user-1', name: 'Alice' };

// Good: Factory returns a new object each time
export function createUserFixture(): User {
  return { id: 'user-1', name: 'Alice' };
}
```

## Related Patterns

- [Unit Testing](core-sdk.testing-unit.md) - Where fixtures are used
- [Mocks and Stubs](core-sdk.testing-mocks.md) - Fixtures provide data for mock return values
- [Integration Testing](core-sdk.testing-integration.md) - Fixtures for integration test scenarios

---

**Status**: Active
**Recommendation**: Define fixture factories in `.fixtures.ts` files colocated with the source. Always use the override pattern so individual tests can customize only what matters.
