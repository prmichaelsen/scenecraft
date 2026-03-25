# Pattern: Client Adapter

**Namespace**: core-sdk
**Category**: Adapter Layer
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The Client Adapter pattern provides a standardized way to expose core business logic as a client library that can be consumed by other applications. It wraps services with a clean, user-friendly API while maintaining separation from core implementation.

This pattern enables developers to integrate your core library directly into their applications without deployment overhead.

---

## Problem

Without a client adapter pattern:

1. **Direct Service Exposure**: Services exposed directly, leaking implementation details
2. **No API Versioning**: Hard to maintain backward compatibility
3. **Complex Initialization**: Users must understand internal service structure
4. **Inconsistent Interface**: Different services have different usage patterns

---

## Solution

Create a `ClientAdapter` class that:
- Extends BaseAdapter for consistent lifecycle
- Provides a simple, high-level API
- Hides internal service complexity
- Manages initialization automatically
- Supports configuration and customization

---

## Implementation

```typescript
// src/adapters/client/ClientAdapter.ts
import { BaseAdapter, AdapterConfig } from '../BaseAdapter';
import { ServiceContainer } from '../../core/container/ServiceContainer';
import { ILogger, LogLevel } from '../../core/logging/ILogger';
import { LoggerFactory } from '../../core/logging/LoggerFactory';

interface ClientAdapterConfig extends AdapterConfig {
  logLevel?: LogLevel;
  autoInitialize?: boolean;
}

/**
 * Client adapter for library consumers
 * 
 * Provides a simple, high-level API for using the core library.
 * Hides internal complexity and manages initialization automatically.
 * 
 * @example
 * ```typescript
 * const client = new UserClient({ logLevel: LogLevel.INFO });
 * await client.initialize();
 * 
 * const user = await client.users.get('user-123');
 * const newUser = await client.users.create({
 *   email: 'user@example.com',
 *   name: 'John Doe',
 * });
 * ```
 */
export abstract class ClientAdapter extends BaseAdapter {
  private autoInitialized = false;

  constructor(config: ClientAdapterConfig) {
    // Create default container and logger
    const container = new ServiceContainer();
    const logger = LoggerFactory.getLogger(config.name);
    
    if (config.logLevel) {
      logger.setLevel(config.logLevel);
    }

    super(config, container, logger);
  }

  protected async onInitialize(): Promise<void> {
    this.logger.info('Initializing client');

    // Setup services in container
    await this.setupServices();

    // Initialize all services
    await this.container.initializeAll();

    this.logger.info('Client initialized');
  }

  protected async onStart(): Promise<void> {
    // Client doesn't need to "start" like servers do
    this.logger.debug('Client ready');
  }

  /**
   * Setup services in container
   * 
   * Override this to register your services.
   */
  protected abstract setupServices(): Promise<void>;

  /**
   * Ensure client is initialized before use
   */
  protected async ensureInitialized(): Promise<void> {
    if (!this.isRunning()) {
      const config = this.config as ClientAdapterConfig;
      
      if (config.autoInitialize && !this.autoInitialized) {
        this.logger.info('Auto-initializing client');
        await this.initialize();
        await this.start();
        this.autoInitialized = true;
      } else {
        throw new Error(
          'Client not initialized. Call client.initialize() first.'
        );
      }
    }
  }
}

// Example: User Client
import { IUserService, User, CreateUserData } from '../../core/interfaces/IUserService';
import { UserService } from '../../core/services/UserService';

export interface UserClientConfig extends ClientAdapterConfig {
  databaseUrl: string;
}

export class UserClient extends ClientAdapter {
  private userService!: IUserService;

  constructor(config: UserClientConfig) {
    super({
      ...config,
      name: 'UserClient',
    });
  }

  protected async setupServices(): Promise<void> {
    const config = this.config as UserClientConfig;

    // Register services
    this.container.registerSingleton('userService', () => {
      return new UserService({
        name: 'UserService',
        databaseUrl: config.databaseUrl,
      });
    });
  }

  /**
   * User operations
   */
  get users() {
    return {
      /**
       * Get user by ID
       */
      get: async (id: string): Promise<User> => {
        await this.ensureInitialized();
        
        if (!this.userService) {
          this.userService = await this.container.resolve<IUserService>('userService');
        }
        
        return await this.userService.getUser(id);
      },

      /**
       * Get user by email
       */
      getByEmail: async (email: string): Promise<User> => {
        await this.ensureInitialized();
        
        if (!this.userService) {
          this.userService = await this.container.resolve<IUserService>('userService');
        }
        
        return await this.userService.getUserByEmail(email);
      },

      /**
       * Create a new user
       */
      create: async (data: CreateUserData): Promise<User> => {
        await this.ensureInitialized();
        
        if (!this.userService) {
          this.userService = await this.container.resolve<IUserService>('userService');
        }
        
        return await this.userService.createUser(data);
      },

      /**
       * Update existing user
       */
      update: async (id: string, data: Partial<User>): Promise<User> => {
        await this.ensureInitialized();
        
        if (!this.userService) {
          this.userService = await this.container.resolve<IUserService>('userService');
        }
        
        return await this.userService.updateUser(id, data);
      },

      /**
       * Delete user
       */
      delete: async (id: string): Promise<void> => {
        await this.ensureInitialized();
        
        if (!this.userService) {
          this.userService = await this.container.resolve<IUserService>('userService');
        }
        
        return await this.userService.deleteUser(id);
      },

      /**
       * List users with pagination
       */
      list: async (options?: {
        limit?: number;
        offset?: number;
      }): Promise<User[]> => {
        await this.ensureInitialized();
        
        if (!this.userService) {
          this.userService = await this.container.resolve<IUserService>('userService');
        }
        
        return await this.userService.listUsers(options);
      },
    };
  }
}

// Usage - Manual initialization
const client = new UserClient({
  databaseUrl: 'postgresql://localhost/mydb',
  logLevel: LogLevel.INFO,
});

await client.initialize();
await client.start();

const user = await client.users.get('user-123');
const newUser = await client.users.create({
  email: 'user@example.com',
  name: 'John Doe',
  password: 'secret',
});

await client.cleanup();

// Usage - Auto initialization
const autoClient = new UserClient({
  databaseUrl: 'postgresql://localhost/mydb',
  autoInitialize: true,
});

// No need to call initialize() - happens automatically
const user2 = await autoClient.users.get('user-456');
```

---

## Benefits

1. **Simple API** - Clean, intuitive interface for users
2. **Auto-Initialization** - Optional automatic setup
3. **Type Safety** - Full TypeScript support
4. **Error Handling** - Consistent error handling
5. **Testability** - Easy to mock and test

---

## Best Practices

### 1. Provide Fluent API
```typescript
get users() {
  return {
    get: async (id: string) => { ... },
    create: async (data: CreateUserData) => { ... },
    list: async (options?: ListOptions) => { ... },
  };
}
```

### 2. Support Auto-Initialization
```typescript
protected async ensureInitialized(): Promise<void> {
  if (!this.isRunning() && this.config.autoInitialize) {
    await this.initialize();
    await this.start();
  }
}
```

### 3. Hide Implementation Details
```typescript
// ❌ Don't expose services directly
public getUserService(): IUserService { ... }

// ✅ Provide high-level methods
get users() {
  return {
    get: async (id: string) => { ... }
  };
}
```

### 4. Provide Good Defaults
```typescript
constructor(config: Partial<UserClientConfig>) {
  super({
    logLevel: LogLevel.WARN,
    autoInitialize: true,
    ...config,
    name: 'UserClient',
  });
}
```

---

## Anti-Patterns

### ❌ Exposing Internal Service Classes Directly

```typescript
// Bad: Consumer has direct access to service internals
export { UserService } from './services/user.service';

// Good: Expose a clean client interface only
export { UserClient } from './client';
export type { UserDTO, CreateUserInput } from './types';
```

### ❌ No Error Boundary in Client Methods

```typescript
// Bad: Internal errors leak to the caller with no context
async getUser(id: string): Promise<User> {
  return this.service.getUser(id);  // May throw with internal error messages
}

// Good: Catch and wrap errors at the client boundary
async getUser(id: string): Promise<User> {
  try {
    return await this.service.getUser(id as UserId);
  } catch (err) {
    if (isAppError(err)) throw err;  // Re-throw typed errors
    throw new ExternalError('Client.getUser failed', 'core-sdk-client');
  }
}
```

### ❌ Requiring Consumers to Manage Lifecycle

```typescript
// Bad: Consumer must manually initialize and cleanup
const service = new UserService(config);
await service.initialize();
// ... use service ...
await service.cleanup();

// Good: Client handles lifecycle internally
const client = new UserClient(config);
const user = await client.users.getUser(id);  // Auto-initializes on first call
```

---

## Related Patterns

- **[Adapter Base Pattern](core-sdk.adapter-base.md)** - Base adapter class
- **[Service Interface Pattern](core-sdk.service-interface.md)** - Services wrapped by client
- **[Service Container Pattern](core-sdk.service-container.md)** - DI for client services

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Node.js 18+
**Related Design**: [Core SDK Architecture](../design/core-sdk.architecture.md)
