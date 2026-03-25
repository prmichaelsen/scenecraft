# Pattern: Mocks and Stubs

**Category**: Testing
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Mocks and Stubs pattern establishes how to create typed, reusable test doubles for services, adapters, and external dependencies using Jest. Mock factories are defined alongside the modules they mock as colocated `.mock.ts` files or inline within `.spec.ts` files.

## Problem Statement

Without a consistent mocking approach:
- Mock setup is duplicated across many `.spec.ts` files
- Mocks lose TypeScript type safety, hiding interface changes
- Spy assertions are fragile and implementation-coupled
- External dependencies bleed into unit tests

## Solution

Use Jest's `jest.fn()` and `jest.mock()` with TypeScript generic types to create fully-typed mocks. Extract reusable mock factories into colocated `.mock.ts` files for sharing across multiple test files.

## Implementation

### Typed Mock Factory Pattern

```typescript
// src/services/__mocks__/user.service.mock.ts
import { UserService } from '../user.service';

/**
 * Creates a fully-typed Jest mock of UserService
 * Use in any .spec.ts that depends on UserService
 */
export function createMockUserService(): jest.Mocked<UserService> {
  return {
    getUser: jest.fn(),
    createUser: jest.fn(),
    updateUser: jest.fn(),
    deleteUser: jest.fn(),
    listUsers: jest.fn(),
  } as jest.Mocked<UserService>;
}
```

```typescript
// src/services/product.service.spec.ts
import { ProductService } from './product.service';
import { createMockUserService } from './__mocks__/user.service.mock';

describe('ProductService', () => {
  let service: ProductService;
  let mockUserService: jest.Mocked<UserService>;

  beforeEach(() => {
    mockUserService = createMockUserService();
    service = new ProductService(mockUserService);
  });

  it('fetches owner before creating product', async () => {
    mockUserService.getUser.mockResolvedValue({ id: '1', name: 'Alice' });

    await service.createProduct({ name: 'Widget', ownerId: '1' });

    expect(mockUserService.getUser).toHaveBeenCalledWith('1');
  });
});
```

### Inline Mock with jest.mock()

```typescript
// src/adapters/email.adapter.spec.ts
import { EmailAdapter } from './email.adapter';

// Mock the external nodemailer module
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' }),
  }),
}));

import nodemailer from 'nodemailer';

describe('EmailAdapter', () => {
  let adapter: EmailAdapter;
  let mockTransport: jest.Mocked<ReturnType<typeof nodemailer.createTransport>>;

  beforeEach(() => {
    adapter = new EmailAdapter({ host: 'localhost', port: 1025 });
    mockTransport = nodemailer.createTransport() as any;
  });

  it('sends email with correct parameters', async () => {
    await adapter.send({
      to: 'alice@example.com',
      subject: 'Test',
      body: 'Hello',
    });

    expect(mockTransport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Test',
      })
    );
  });
});
```

### Spy Pattern for Method Verification

```typescript
// src/services/audit.service.spec.ts
import { AuditService } from './audit.service';
import { UserService } from './user.service';

describe('AuditService', () => {
  let auditService: AuditService;
  let userService: UserService;

  beforeEach(() => {
    userService = new UserService();
    auditService = new AuditService(userService);
  });

  it('calls userService.getUser when auditing user action', async () => {
    // Spy on the real method — keeps real implementation
    const spy = jest.spyOn(userService, 'getUser').mockResolvedValue({
      id: '1',
      name: 'Alice',
    });

    await auditService.logUserAction('1', 'login');

    expect(spy).toHaveBeenCalledWith('1');
    spy.mockRestore(); // Restore after test
  });
});
```

### Module-Level Mock with Auto-Mock

```typescript
// src/services/notification.service.spec.ts
import { NotificationService } from './notification.service';

// Auto-mock: Jest replaces all exports with jest.fn() versions
jest.mock('./email.service');
jest.mock('./sms.service');

import { EmailService } from './email.service';
import { SmsService } from './sms.service';

describe('NotificationService', () => {
  let service: NotificationService;
  let mockEmail: jest.Mocked<typeof EmailService.prototype>;
  let mockSms: jest.Mocked<typeof SmsService.prototype>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEmail = new EmailService() as jest.Mocked<EmailService>;
    mockSms = new SmsService() as jest.Mocked<SmsService>;
    service = new NotificationService(mockEmail, mockSms);
  });

  it('sends email and SMS for critical alerts', async () => {
    await service.sendAlert({ level: 'critical', message: 'Server down' });

    expect(mockEmail.send).toHaveBeenCalledTimes(1);
    expect(mockSms.send).toHaveBeenCalledTimes(1);
  });

  it('sends only email for non-critical alerts', async () => {
    await service.sendAlert({ level: 'info', message: 'Deployment complete' });

    expect(mockEmail.send).toHaveBeenCalledTimes(1);
    expect(mockSms.send).not.toHaveBeenCalled();
  });
});
```

### Return Value Sequencing

```typescript
// src/services/retry.service.spec.ts
import { RetryService } from './retry.service';
import { ExternalApiClient } from '../clients/external-api.client';

jest.mock('../clients/external-api.client');

describe('RetryService', () => {
  let service: RetryService;
  let mockClient: jest.Mocked<ExternalApiClient>;

  beforeEach(() => {
    mockClient = new ExternalApiClient() as jest.Mocked<ExternalApiClient>;
    service = new RetryService(mockClient, { maxRetries: 3 });
  });

  it('retries on failure and succeeds on third attempt', async () => {
    mockClient.fetch
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ data: 'success' });

    const result = await service.fetchWithRetry('/api/data');

    expect(result.data).toBe('success');
    expect(mockClient.fetch).toHaveBeenCalledTimes(3);
  });
});
```

### Mock Assertions

```typescript
// Checking call arguments
expect(mock.method).toHaveBeenCalledWith(
  expect.objectContaining({ key: 'value' })
);

// Checking call count
expect(mock.method).toHaveBeenCalledTimes(2);

// Checking order of calls
expect(mock.method.mock.calls[0][0]).toBe('first-arg');
expect(mock.method.mock.calls[1][0]).toBe('second-arg');

// Checking return value was used
const returnValue = await mock.method.mock.results[0].value;
expect(returnValue).toEqual(expected);
```

## Usage Guidelines

### When to Use

- ✅ Replacing slow or unreliable external dependencies (HTTP, database)
- ✅ Testing error paths that are hard to trigger with real implementations
- ✅ Verifying a service calls its dependencies correctly
- ✅ Controlling return values for deterministic tests

### When Not to Use

- ❌ Mocking the unit under test itself
- ❌ Mocking internal implementation details (private methods)
- ❌ When a real in-memory implementation is fast enough

## Best Practices

1. **Mock at the boundary**: Only mock external I/O and cross-service dependencies
2. **Use typed mocks**: `jest.Mocked<T>` preserves TypeScript interface contracts
3. **Extract shared mocks**: Put reusable mocks in `__mocks__/` alongside source
4. **Reset between tests**: `clearMocks: true` in jest.config.js prevents state leaks
5. **Prefer `mockResolvedValue` over `mockImplementation`**: Simpler and clearer
6. **Assert on behavior, not calls**: Only verify calls when call verification is the point

```typescript
// Good: Typed mock retains type checking
const mock: jest.Mocked<UserService> = createMockUserService();
mock.getUser.mockResolvedValue(user); // TypeScript checks return type

// Bad: Loses type safety
const mock: any = { getUser: jest.fn() };
```

## Anti-Patterns

### ❌ Mocking What You Own (Over-Mocking)

```typescript
// Bad: Mocking internal helpers makes tests brittle
jest.mock('./utils/format-date');

// Good: Let real utils run — they're fast and deterministic
import { formatDate } from './utils/format-date';
```

### ❌ Asserting on Every Call

```typescript
// Bad: Brittle — breaks if implementation changes how it calls things
expect(mockRepo.findById).toHaveBeenCalled();
expect(mockRepo.save).toHaveBeenCalled();
expect(mockLogger.log).toHaveBeenCalled();
expect(mockCache.set).toHaveBeenCalled();

// Good: Assert on the outcome that matters
const result = await service.updateUser(input);
expect(result.updatedAt).toBeDefined();
```

### ❌ Not Clearing Mocks

```typescript
// Bad: Mock calls accumulate across tests
const mockFn = jest.fn();
// ... 3 tests later ...
expect(mockFn).toHaveBeenCalledTimes(1); // Actually 4!
```

## Related Patterns

- [Unit Testing](core-sdk.testing-unit.md) - Where mocks are primarily used
- [Test Fixtures](core-sdk.testing-fixtures.md) - Test data for mock return values
- [Integration Testing](core-sdk.testing-integration.md) - When to use real implementations

---

**Status**: Active
**Recommendation**: Use `jest.Mocked<T>` for typed mocks. Extract shared mock factories into `__mocks__/` files colocated with the source.
