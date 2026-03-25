# Pattern: Unit Testing

**Category**: Testing
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Unit Testing pattern establishes how to write focused, isolated tests for individual service classes and functions. Tests are colocated with their source files as `.spec.ts` files and run with Jest configured via `jest.config.js`.

## Problem Statement

Without a consistent unit testing approach:
- Tests are scattered in separate directories, hard to find and maintain
- Service logic is tested through integration points instead of in isolation
- Test setup is duplicated across files with no shared conventions
- TypeScript compilation errors in tests are caught late

## Solution

Colocate `.spec.ts` files next to their source, test each unit in isolation with mocked dependencies, and configure Jest once in `jest.config.js` at the project root.

## Implementation

### Project Structure

```
src/
├── services/
│   ├── user.service.ts
│   ├── user.service.spec.ts     ← colocated test
│   └── product.service.ts
│   └── product.service.spec.ts  ← colocated test
├── adapters/
│   ├── rest.adapter.ts
│   └── rest.adapter.spec.ts     ← colocated test
└── config/
    ├── loader.ts
    └── loader.spec.ts           ← colocated test
```

### jest.config.js

```javascript
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // Match colocated spec files only
  testMatch: ['**/*.spec.ts'],

  // Collect coverage from source files (not specs)
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/index.ts',
  ],

  // Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },

  // Module path aliases (if using tsconfig paths)
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,
};
```

### Basic Unit Test

```typescript
// src/services/user.service.spec.ts
import { UserService } from './user.service';
import { UserRepository } from '../repositories/user.repository';

// Mock the dependency
jest.mock('../repositories/user.repository');

describe('UserService', () => {
  let service: UserService;
  let mockRepo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    // Create typed mock instance
    mockRepo = new UserRepository() as jest.Mocked<UserRepository>;
    service = new UserService(mockRepo);
  });

  describe('getUser', () => {
    it('returns user when found', async () => {
      const expected = { id: '1', name: 'Alice', email: 'alice@example.com' };
      mockRepo.findById.mockResolvedValue(expected);

      const result = await service.getUser('1');

      expect(result).toEqual(expected);
      expect(mockRepo.findById).toHaveBeenCalledWith('1');
    });

    it('throws NotFoundError when user does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);

      await expect(service.getUser('999')).rejects.toThrow('User not found: 999');
    });
  });

  describe('createUser', () => {
    it('creates user with hashed password', async () => {
      const input = { name: 'Bob', email: 'bob@example.com', password: 'secret' };
      const created = { id: '2', name: 'Bob', email: 'bob@example.com' };
      mockRepo.create.mockResolvedValue(created);

      const result = await service.createUser(input);

      expect(result).toEqual(created);
      // Verify password was NOT passed as plain text
      expect(mockRepo.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ password: 'secret' })
      );
    });
  });
});
```

### Testing Async Error Handling

```typescript
// src/services/payment.service.spec.ts
import { PaymentService } from './payment.service';
import { PaymentGateway } from '../gateways/payment.gateway';
import { PaymentError } from '../errors';

jest.mock('../gateways/payment.gateway');

describe('PaymentService', () => {
  let service: PaymentService;
  let mockGateway: jest.Mocked<PaymentGateway>;

  beforeEach(() => {
    mockGateway = new PaymentGateway() as jest.Mocked<PaymentGateway>;
    service = new PaymentService(mockGateway);
  });

  it('retries on transient gateway errors', async () => {
    mockGateway.charge
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ transactionId: 'txn_123', status: 'success' });

    const result = await service.processPayment({ amount: 100, currency: 'USD' });

    expect(result.status).toBe('success');
    expect(mockGateway.charge).toHaveBeenCalledTimes(3);
  });

  it('throws PaymentError after max retries exceeded', async () => {
    mockGateway.charge.mockRejectedValue(new Error('timeout'));

    await expect(
      service.processPayment({ amount: 100, currency: 'USD' })
    ).rejects.toThrow(PaymentError);
  });
});
```

### Testing Pure Functions

```typescript
// src/utils/pricing.spec.ts
import { calculateDiscount, applyTax, formatPrice } from './pricing';

describe('calculateDiscount', () => {
  it.each([
    [100, 0.1, 90],
    [200, 0.25, 150],
    [50, 0, 50],
  ])('applies %p%% discount to $%p → $%p', (price, discount, expected) => {
    expect(calculateDiscount(price, discount)).toBe(expected);
  });

  it('throws when discount exceeds 100%', () => {
    expect(() => calculateDiscount(100, 1.1)).toThrow('Discount cannot exceed 100%');
  });
});

describe('formatPrice', () => {
  it('formats USD', () => {
    expect(formatPrice(9.99, 'USD')).toBe('$9.99');
  });

  it('formats EUR', () => {
    expect(formatPrice(9.99, 'EUR')).toBe('€9.99');
  });
});
```

### Testing with Fake Timers

```typescript
// src/services/cache.service.spec.ts
import { CacheService } from './cache.service';

describe('CacheService', () => {
  let service: CacheService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new CacheService({ ttl: 60_000 }); // 60 second TTL
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns cached value within TTL', () => {
    service.set('key', 'value');
    jest.advanceTimersByTime(30_000); // advance 30s
    expect(service.get('key')).toBe('value');
  });

  it('returns null after TTL expires', () => {
    service.set('key', 'value');
    jest.advanceTimersByTime(61_000); // advance past TTL
    expect(service.get('key')).toBeNull();
  });
});
```

## Usage Guidelines

### When to Use

- ✅ Testing individual service methods in isolation
- ✅ Testing pure functions and utilities
- ✅ Verifying error handling paths
- ✅ Testing business logic without external dependencies

### When Not to Use

- ❌ Testing interactions between multiple real services (use integration tests)
- ❌ Testing database or network calls (mock those instead)

## Best Practices

1. **One describe per module**: Mirror the module name in the outermost `describe`
2. **AAA pattern**: Arrange → Act → Assert in each test
3. **Single assertion focus**: Each test verifies one behavior
4. **Descriptive test names**: `it('throws when input is invalid')` not `it('works')`
5. **Reset mocks between tests**: Use `clearMocks: true` in jest.config.js
6. **Test behavior, not implementation**: Assert outcomes, not internal calls

```typescript
// Good: Tests the observable behavior
it('sends welcome email after user creation', async () => {
  await service.createUser(input);
  expect(mockEmailService.send).toHaveBeenCalledWith(
    expect.objectContaining({ template: 'welcome' })
  );
});

// Bad: Tests implementation details
it('calls hashPassword then saveToDatabase', async () => {
  await service.createUser(input);
  expect(hashPassword).toHaveBeenCalled();
  expect(db.save).toHaveBeenCalled();
});
```

## Anti-Patterns

### ❌ Tests in Separate `__tests__/` Directory

```
// Bad: Disconnected from source
src/services/user.service.ts
__tests__/services/user.service.test.ts

// Good: Colocated
src/services/user.service.ts
src/services/user.service.spec.ts
```

### ❌ Testing Multiple Behaviors in One Test

```typescript
// Bad: Multiple concerns in one test
it('creates user', async () => {
  const user = await service.createUser(input);
  expect(user.id).toBeDefined();
  expect(mockEmail.send).toHaveBeenCalled();
  expect(mockAudit.log).toHaveBeenCalled();
  expect(cache.invalidate).toHaveBeenCalled();
});

// Good: Separate tests per behavior
it('returns user with generated id', async () => { ... });
it('sends welcome email', async () => { ... });
it('logs audit event', async () => { ... });
```

### ❌ Not Resetting Mocks

```typescript
// Bad: State leaks between tests
describe('MyService', () => {
  const mockDep = jest.fn(); // shared, never reset
  it('test 1', () => { ... });
  it('test 2', () => { /* mockDep still has calls from test 1 */ });
});
```

## Related Patterns

- [Integration Testing](core-sdk.testing-integration.md) - Testing across multiple units
- [Mocks and Stubs](core-sdk.testing-mocks.md) - Typed mock creation
- [Test Fixtures](core-sdk.testing-fixtures.md) - Reusable test data

---

**Status**: Active
**Recommendation**: Use for all service and utility unit tests. Always colocate `.spec.ts` next to the source file.
