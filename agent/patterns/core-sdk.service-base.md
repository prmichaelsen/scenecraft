# Pattern: Service Base

**Namespace**: core-sdk
**Category**: Service Layer
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The Service Base pattern provides a foundational abstract class for all business logic services in a core library. It establishes a consistent lifecycle, configuration management, and common functionality that all services should implement.

This pattern ensures that services across different deployment targets (MCP servers, REST APIs, CLI tools, client libraries) follow the same structure and conventions, making them predictable and maintainable.

---

## Problem

Without a base service pattern, developers face several challenges:

1. **Inconsistent Lifecycle Management**: Different services handle initialization and cleanup differently
2. **Configuration Duplication**: Each service reimplements configuration loading
3. **No Standard Interface**: Services lack common methods for health checks, status, etc.
4. **Testing Complexity**: Mocking and testing services is harder without consistent structure
5. **Maintenance Burden**: Changes to common functionality must be applied to each service

---

## Solution

Create an abstract `BaseService` class that:
- Defines standard lifecycle methods (initialize, cleanup)
- Manages service configuration
- Provides common utility methods
- Enforces consistent service structure
- Enables dependency injection

---

## Implementation

### TypeScript Implementation

```typescript
// src/core/services/BaseService.ts

/**
 * Configuration interface for all services
 */
export interface ServiceConfig {
  /** Service name for logging and identification */
  name: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Service timeout in milliseconds */
  timeout?: number;
  /** Maximum retry attempts */
  maxRetries?: number;
}

/**
 * Service lifecycle state
 */
export enum ServiceState {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  READY = 'ready',
  ERROR = 'error',
  SHUTTING_DOWN = 'shutting_down',
  SHUTDOWN = 'shutdown',
}

/**
 * Base class for all services
 * 
 * Provides common functionality and enforces consistent structure
 * across all business logic services.
 * 
 * @example
 * ```typescript
 * class UserService extends BaseService {
 *   async initialize(): Promise<void> {
 *     await super.initialize();
 *     // Service-specific initialization
 *   }
 * 
 *   async getUser(id: string): Promise<User> {
 *     this.ensureInitialized();
 *     // Business logic
 *   }
 * }
 * ```
 */
export abstract class BaseService {
  protected config: ServiceConfig;
  protected state: ServiceState = ServiceState.UNINITIALIZED;
  protected initializationError?: Error;

  constructor(config: ServiceConfig) {
    this.config = {
      debug: false,
      timeout: 5000,
      maxRetries: 3,
      ...config,
    };
  }

  /**
   * Initialize the service
   * 
   * Must be called before using the service. Subclasses should
   * call super.initialize() first, then perform their own initialization.
   * 
   * @throws {Error} If initialization fails
   */
  async initialize(): Promise<void> {
    if (this.state !== ServiceState.UNINITIALIZED) {
      throw new Error(`Cannot initialize service in state: ${this.state}`);
    }

    this.state = ServiceState.INITIALIZING;

    try {
      // Subclasses override this to add their initialization logic
      await this.onInitialize();
      this.state = ServiceState.READY;
    } catch (error) {
      this.state = ServiceState.ERROR;
      this.initializationError = error as Error;
      throw error;
    }
  }

  /**
   * Cleanup service resources
   * 
   * Should be called when the service is no longer needed.
   * Subclasses should call super.cleanup() after their own cleanup.
   */
  async cleanup(): Promise<void> {
    if (this.state === ServiceState.SHUTDOWN) {
      return; // Already cleaned up
    }

    this.state = ServiceState.SHUTTING_DOWN;

    try {
      await this.onCleanup();
      this.state = ServiceState.SHUTDOWN;
    } catch (error) {
      this.state = ServiceState.ERROR;
      throw error;
    }
  }

  /**
   * Check if service is ready to use
   */
  isReady(): boolean {
    return this.state === ServiceState.READY;
  }

  /**
   * Get current service state
   */
  getState(): ServiceState {
    return this.state;
  }

  /**
   * Get service configuration
   */
  getConfig(): Readonly<ServiceConfig> {
    return Object.freeze({ ...this.config });
  }

  /**
   * Get service health status
   */
  async getHealth(): Promise<{
    status: 'healthy' | 'unhealthy';
    state: ServiceState;
    error?: string;
  }> {
    return {
      status: this.state === ServiceState.READY ? 'healthy' : 'unhealthy',
      state: this.state,
      error: this.initializationError?.message,
    };
  }

  /**
   * Ensure service is initialized before use
   * 
   * @throws {Error} If service is not ready
   */
  protected ensureInitialized(): void {
    if (this.state !== ServiceState.READY) {
      throw new Error(
        `Service ${this.config.name} is not ready. Current state: ${this.state}`
      );
    }
  }

  /**
   * Hook for subclass initialization logic
   * 
   * Override this method to add service-specific initialization.
   * Do not override initialize() directly.
   */
  protected async onInitialize(): Promise<void> {
    // Subclasses implement this
  }

  /**
   * Hook for subclass cleanup logic
   * 
   * Override this method to add service-specific cleanup.
   * Do not override cleanup() directly.
   */
  protected async onCleanup(): Promise<void> {
    // Subclasses implement this
  }

  /**
   * Log debug message if debug mode is enabled
   */
  protected debug(message: string, ...args: any[]): void {
    if (this.config.debug) {
      console.debug(`[${this.config.name}]`, message, ...args);
    }
  }
}
```

### Example Usage

```typescript
// src/core/services/UserService.ts
import { BaseService, ServiceConfig } from './BaseService';

interface UserServiceConfig extends ServiceConfig {
  databaseUrl: string;
}

export class UserService extends BaseService {
  private db: Database | null = null;

  constructor(config: UserServiceConfig) {
    super(config);
  }

  protected async onInitialize(): Promise<void> {
    this.debug('Initializing UserService');
    
    // Connect to database
    this.db = await Database.connect(
      (this.config as UserServiceConfig).databaseUrl
    );
    
    this.debug('UserService initialized successfully');
  }

  protected async onCleanup(): Promise<void> {
    this.debug('Cleaning up UserService');
    
    if (this.db) {
      await this.db.disconnect();
      this.db = null;
    }
    
    this.debug('UserService cleaned up successfully');
  }

  async getUser(id: string): Promise<User> {
    this.ensureInitialized();
    
    if (!this.db) {
      throw new Error('Database not connected');
    }
    
    return await this.db.users.findById(id);
  }

  async createUser(data: CreateUserData): Promise<User> {
    this.ensureInitialized();
    
    if (!this.db) {
      throw new Error('Database not connected');
    }
    
    return await this.db.users.create(data);
  }
}

// Usage
const userService = new UserService({
  name: 'UserService',
  debug: true,
  databaseUrl: 'postgresql://localhost/mydb',
});

await userService.initialize();

try {
  const user = await userService.getUser('123');
  console.log(user);
} finally {
  await userService.cleanup();
}
```

---

## Benefits

### 1. Consistent Lifecycle Management
- All services follow the same initialization and cleanup pattern
- Predictable state transitions
- Easy to reason about service lifecycle

### 2. Configuration Standardization
- Common configuration interface
- Default values handled consistently
- Type-safe configuration access

### 3. Error Handling
- Consistent error states
- Initialization errors captured and accessible
- State validation before operations

### 4. Testing Support
- Easy to mock and test
- Health checks for monitoring
- State inspection for debugging

### 5. Maintainability
- Common functionality in one place
- Changes propagate to all services
- Clear extension points for subclasses

---

## Best Practices

### 1. Always Call Super Methods
```typescript
class MyService extends BaseService {
  async initialize(): Promise<void> {
    await super.initialize(); // ✅ Always call super first
    // Your initialization
  }
}
```

### 2. Use ensureInitialized() in Public Methods
```typescript
async getData(): Promise<Data> {
  this.ensureInitialized(); // ✅ Validate state
  // Your logic
}
```

### 3. Implement onInitialize/onCleanup, Not initialize/cleanup
```typescript
// ✅ Correct
protected async onInitialize(): Promise<void> {
  // Your initialization
}

// ❌ Wrong - don't override these directly
async initialize(): Promise<void> {
  // This breaks the lifecycle management
}
```

### 4. Handle Cleanup Gracefully
```typescript
protected async onCleanup(): Promise<void> {
  // ✅ Check if resources exist before cleanup
  if (this.connection) {
    await this.connection.close();
  }
}
```

### 5. Use Debug Logging
```typescript
protected async onInitialize(): Promise<void> {
  this.debug('Starting initialization'); // ✅ Use debug method
  // Your logic
  this.debug('Initialization complete');
}
```

---

## Anti-Patterns

### ❌ Don't Skip Initialization
```typescript
// ❌ Wrong
const service = new UserService(config);
await service.getUser('123'); // Will throw - not initialized
```

### ❌ Don't Override initialize() Directly
```typescript
// ❌ Wrong
class MyService extends BaseService {
  async initialize(): Promise<void> {
    // This breaks state management
  }
}
```

### ❌ Don't Ignore State
```typescript
// ❌ Wrong
async getData(): Promise<Data> {
  // Missing ensureInitialized() check
  return this.db.query();
}
```

### ❌ Don't Forget Cleanup
```typescript
// ❌ Wrong
const service = new UserService(config);
await service.initialize();
await service.getData();
// Missing: await service.cleanup();
```

### ❌ Don't Mutate Config
```typescript
// ❌ Wrong
async someMethod(): Promise<void> {
  this.config.timeout = 10000; // Don't mutate config
}
```

---

## Related Patterns

- **[Service Interface Pattern](core-sdk.service-interface.md)** - Defines interfaces for dependency injection
- **[Service Container Pattern](core-sdk.service-container.md)** - Manages service instances and dependencies
- **[Error Handling Pattern](core-sdk.service-error-handling.md)** - Consistent error handling across services
- **[Logging Pattern](core-sdk.service-logging.md)** - Structured logging for services

---

## Testing

### Unit Test Example

```typescript
// src/services/base.service.spec.ts
import { BaseService, ServiceState } from './base.service';

class TestService extends BaseService {
  initializeCalled = false;
  cleanupCalled = false;

  protected async onInitialize(): Promise<void> {
    this.initializeCalled = true;
  }

  protected async onCleanup(): Promise<void> {
    this.cleanupCalled = true;
  }
}

describe('BaseService', () => {
  let service: TestService;

  beforeEach(() => {
    service = new TestService({ name: 'TestService' });
  });

  afterEach(async () => {
    if (service.isReady()) {
      await service.cleanup();
    }
  });

  describe('initialization', () => {
    it('should start in uninitialized state', () => {
      expect(service.getState()).toBe(ServiceState.UNINITIALIZED);
      expect(service.isReady()).toBe(false);
    });

    it('should transition to ready state after initialization', async () => {
      await service.initialize();
      expect(service.getState()).toBe(ServiceState.READY);
      expect(service.isReady()).toBe(true);
      expect(service.initializeCalled).toBe(true);
    });

    it('should not allow double initialization', async () => {
      await service.initialize();
      await expect(service.initialize()).rejects.toThrow();
    });

    it('should capture initialization errors', async () => {
      const errorService = new (class extends BaseService {
        protected async onInitialize(): Promise<void> {
          throw new Error('Init failed');
        }
      })({ name: 'ErrorService' });

      await expect(errorService.initialize()).rejects.toThrow('Init failed');
      expect(errorService.getState()).toBe(ServiceState.ERROR);
    });
  });

  describe('cleanup', () => {
    it('should call onCleanup hook', async () => {
      await service.initialize();
      await service.cleanup();
      expect(service.cleanupCalled).toBe(true);
      expect(service.getState()).toBe(ServiceState.SHUTDOWN);
    });

    it('should be idempotent', async () => {
      await service.initialize();
      await service.cleanup();
      await service.cleanup(); // Should not throw
    });
  });

  describe('health check', () => {
    it('should report healthy when ready', async () => {
      await service.initialize();
      const health = await service.getHealth();
      expect(health.status).toBe('healthy');
      expect(health.state).toBe(ServiceState.READY);
    });

    it('should report unhealthy when not ready', async () => {
      const health = await service.getHealth();
      expect(health.status).toBe('unhealthy');
      expect(health.state).toBe(ServiceState.UNINITIALIZED);
    });
  });
});
```

---

## Migration Guide

### From Unstructured Services

**Before:**
```typescript
class UserService {
  private db: Database;

  constructor(dbUrl: string) {
    this.db = new Database(dbUrl);
  }

  async getUser(id: string): Promise<User> {
    return this.db.users.findById(id);
  }
}
```

**After:**
```typescript
class UserService extends BaseService {
  private db: Database | null = null;

  constructor(config: UserServiceConfig) {
    super(config);
  }

  protected async onInitialize(): Promise<void> {
    this.db = await Database.connect(
      (this.config as UserServiceConfig).databaseUrl
    );
  }

  protected async onCleanup(): Promise<void> {
    if (this.db) {
      await this.db.disconnect();
    }
  }

  async getUser(id: string): Promise<User> {
    this.ensureInitialized();
    return this.db!.users.findById(id);
  }
}
```

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Node.js 18+
**Related Design**: [Core SDK Architecture](../design/core-sdk.architecture.md)
