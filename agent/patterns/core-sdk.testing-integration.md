# Pattern: Integration Testing

**Category**: Testing
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Integration Testing pattern establishes how to test interactions between multiple real units — services working together, services with real configuration, and adapter-to-service wiring. Integration tests are colocated as `.spec.ts` files but clearly marked and may use real implementations instead of mocks.

## Problem Statement

Without integration tests:
- Unit tests pass but the wired-together system fails
- Service container setup errors only surface at runtime
- Adapter-to-service mapping bugs go undetected
- Configuration loading is never exercised in tests

## Solution

Write integration tests that use real service implementations with controlled inputs, test complete flows through multiple layers, and isolate external I/O (network, database) at the boundary.

## Implementation

### jest.config.js (with integration test support)

```javascript
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // Run unit specs by default
  testMatch: ['**/*.spec.ts'],

  // Exclude integration tests from the default run
  testPathIgnorePatterns: [
    '/node_modules/',
    '\\.integration\\.spec\\.ts$',
  ],

  clearMocks: true,
  restoreMocks: true,
};
```

```javascript
// jest.integration.config.js — run separately: jest --config jest.integration.config.js
/** @type {import('jest').Config} */
module.exports = {
  ...require('./jest.config.js'),
  testMatch: ['**/*.integration.spec.ts'],
  testTimeout: 30_000,  // Integration tests may be slower
  testPathIgnorePatterns: [],
};
```

### Integration Test File Naming

```
src/
├── services/
│   ├── user.service.ts
│   ├── user.service.spec.ts             ← unit test
│   └── user.service.integration.spec.ts ← integration test
└── container/
    ├── service-container.ts
    └── service-container.integration.spec.ts
```

### Service Integration Test

```typescript
// src/services/user.service.integration.spec.ts
import { UserService } from './user.service';
import { EmailService } from '../email/email.service';
import { AuditService } from '../audit/audit.service';
import { createServiceContainer } from '../container/service-container';
import { loadTestConfig } from '../config/test-config';

describe('UserService (integration)', () => {
  let userService: UserService;
  let emailService: EmailService;

  beforeAll(async () => {
    const config = loadTestConfig();
    const container = createServiceContainer(config);
    await container.initialize();
    userService = container.get(UserService);
    emailService = container.get(EmailService);
  });

  afterAll(async () => {
    await container.shutdown();
  });

  it('creates user and triggers welcome email', async () => {
    const input = { name: 'Alice', email: 'alice@test.local', password: 'pass123' };

    const user = await userService.createUser(input);

    expect(user.id).toBeDefined();
    expect(user.email).toBe(input.email);

    // Verify the downstream email service was called
    const sentEmails = emailService.getSentEmails(); // test-mode method
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({
      to: input.email,
      template: 'welcome',
    });
  });

  it('rolls back user creation when email fails', async () => {
    emailService.simulateFailure(true);

    await expect(
      userService.createUser({ name: 'Bob', email: 'bob@test.local', password: 'pass' })
    ).rejects.toThrow();

    // Verify user was not persisted
    const user = await userService.findByEmail('bob@test.local');
    expect(user).toBeNull();

    emailService.simulateFailure(false);
  });
});
```

### Adapter Integration Test

```typescript
// src/adapters/rest.adapter.integration.spec.ts
import request from 'supertest';
import { createApp } from '../app';
import { loadTestConfig } from '../config/test-config';

describe('REST Adapter (integration)', () => {
  let app: Express.Application;

  beforeAll(async () => {
    const config = loadTestConfig();
    app = await createApp(config);
  });

  describe('POST /users', () => {
    it('creates user and returns 201', async () => {
      const response = await request(app)
        .post('/users')
        .send({ name: 'Alice', email: 'alice@test.local', password: 'secret' })
        .expect(201);

      expect(response.body).toMatchObject({
        id: expect.any(String),
        name: 'Alice',
        email: 'alice@test.local',
      });
      // Password must not be returned
      expect(response.body.password).toBeUndefined();
    });

    it('returns 400 for invalid input', async () => {
      const response = await request(app)
        .post('/users')
        .send({ name: '' }) // missing required fields
        .expect(400);

      expect(response.body.errors).toBeDefined();
    });
  });
});
```

### Service Container Integration Test

```typescript
// src/container/service-container.integration.spec.ts
import { createServiceContainer } from './service-container';
import { UserService } from '../services/user.service';
import { EmailService } from '../email/email.service';
import { loadTestConfig } from '../config/test-config';

describe('ServiceContainer (integration)', () => {
  it('initializes all services without errors', async () => {
    const config = loadTestConfig();
    const container = createServiceContainer(config);

    await expect(container.initialize()).resolves.not.toThrow();
    await container.shutdown();
  });

  it('provides correct service instances', async () => {
    const config = loadTestConfig();
    const container = createServiceContainer(config);
    await container.initialize();

    const userService = container.get(UserService);
    const emailService = container.get(EmailService);

    expect(userService).toBeInstanceOf(UserService);
    expect(emailService).toBeInstanceOf(EmailService);

    await container.shutdown();
  });

  it('shuts down gracefully', async () => {
    const config = loadTestConfig();
    const container = createServiceContainer(config);
    await container.initialize();

    await expect(container.shutdown()).resolves.not.toThrow();
  });
});
```

### Test Config for Integration Tests

```typescript
// src/config/test-config.ts
import { AppConfigSchema } from './schema';

/**
 * Load deterministic test configuration
 * Overrides env vars with test-safe values
 */
export function loadTestConfig() {
  return AppConfigSchema.parse({
    env: 'test',
    server: { port: 0 },         // random port
    database: { url: ':memory:' }, // in-memory DB
    logging: { level: 'error' },   // silent
    email: { mode: 'test' },        // capture, don't send
    cache: { enabled: false },
  });
}
```

## Usage Guidelines

### When to Use

- ✅ Testing that services wire together correctly in the container
- ✅ Testing complete request/response flows through an adapter
- ✅ Verifying that configuration is correctly plumbed into services
- ✅ Testing error propagation across service boundaries

### When Not to Use

- ❌ Testing individual service methods (use unit tests)
- ❌ Testing against live external services in CI (mock at boundary)
- ❌ When unit tests already cover the same scenario

## Best Practices

1. **Use `.integration.spec.ts` suffix**: Clearly distinguishes from unit tests
2. **Run separately from unit tests**: Slower — keep fast feedback loop for unit tests
3. **Use test config**: Never use real environment config in tests
4. **Teardown reliably**: Always call `afterAll` cleanup to avoid leaked resources
5. **Colocate near the module being integrated**: Not in a separate `integration/` directory
6. **Limit scope**: Test one integration boundary per file

```typescript
// Good: Clear integration boundary
describe('UserService + EmailService (integration)', () => { ... });

// Bad: Testing everything at once
describe('Full application (integration)', () => { ... });
```

## Anti-Patterns

### ❌ Integration Tests in a Separate Directory

```
// Bad
integration/
  user-flow.test.ts

// Good: Colocated
src/services/user.service.integration.spec.ts
```

### ❌ Using Real External Services in Tests

```typescript
// Bad: Tests fail when Stripe is down
const stripe = new Stripe(process.env.STRIPE_KEY);

// Good: Use a test double at the external boundary
const mockStripe = createMockStripeClient();
```

### ❌ Leaking State Between Tests

```typescript
// Bad: Database state from one test affects another
it('creates user', async () => {
  await userService.createUser({ email: 'alice@test.local' });
});
it('lists users', async () => {
  const users = await userService.listUsers();
  expect(users).toHaveLength(1); // Fragile! Depends on previous test
});
```

## Related Patterns

- [Unit Testing](core-sdk.testing-unit.md) - Isolated unit tests
- [Mocks and Stubs](core-sdk.testing-mocks.md) - Boundary mocking
- [Test Fixtures](core-sdk.testing-fixtures.md) - Shared test data setup

---

**Status**: Active
**Recommendation**: Write integration tests for service container wiring and adapter flows. Keep them separate from unit tests via the `.integration.spec.ts` naming convention.
