# Pattern: Adapter Base

**Namespace**: core-sdk
**Category**: Adapter Layer
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The Adapter Base pattern provides a foundational abstract class for all deployment target adapters. It establishes a consistent interface for adapting core business logic to different deployment environments (MCP servers, REST APIs, CLI tools, client libraries) while maintaining separation of concerns.

This pattern ensures adapters follow the same structure and conventions, making them predictable, testable, and maintainable across different deployment targets.

---

## Problem

Without a base adapter pattern, developers face:

1. **Inconsistent Adapter Structure**: Different adapters implement different interfaces
2. **Duplicated Adapter Logic**: Common functionality reimplemented in each adapter
3. **No Standard Lifecycle**: Adapters handle initialization/cleanup differently
4. **Testing Complexity**: Hard to test adapters consistently
5. **Maintenance Burden**: Changes to common functionality must be applied everywhere

---

## Solution

Create an abstract `BaseAdapter` class that:
- Defines standard adapter lifecycle (initialize, start, stop, cleanup)
- Manages service dependencies
- Provides request/response transformation hooks
- Enables consistent error handling
- Supports health checks and monitoring

---

## Implementation

### TypeScript Implementation

```typescript
// src/adapters/BaseAdapter.ts

import { ILogger } from '../core/logging/ILogger';
import { ServiceContainer } from '../core/container/ServiceContainer';

/**
 * Adapter configuration
 */
export interface AdapterConfig {
  /** Adapter name for identification */
  name: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Adapter-specific configuration */
  [key: string]: any;
}

/**
 * Adapter lifecycle state
 */
export enum AdapterState {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  INITIALIZED = 'initialized',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  ERROR = 'error',
}

/**
 * Base adapter class for all deployment targets
 * 
 * Provides common functionality and enforces consistent structure
 * across all adapters (MCP, REST, CLI, client).
 * 
 * @example
 * ```typescript
 * class MCPAdapter extends BaseAdapter {
 *   protected async onInitialize(): Promise<void> {
 *     // Initialize MCP server
 *   }
 * 
 *   protected async onStart(): Promise<void> {
 *     // Start listening for requests
 *   }
 * }
 * ```
 */
export abstract class BaseAdapter {
  protected config: AdapterConfig;
  protected state: AdapterState = AdapterState.UNINITIALIZED;
  protected logger: ILogger;
  protected container: ServiceContainer;
  protected initializationError?: Error;

  constructor(
    config: AdapterConfig,
    container: ServiceContainer,
    logger: ILogger
  ) {
    this.config = config;
    this.container = container;
    this.logger = logger.child({ adapter: config.name });
  }

  /**
   * Initialize the adapter
   * 
   * Must be called before starting. Subclasses should call
   * super.initialize() first, then perform their initialization.
   */
  async initialize(): Promise<void> {
    if (this.state !== AdapterState.UNINITIALIZED) {
      throw new Error(`Cannot initialize adapter in state: ${this.state}`);
    }

    this.state = AdapterState.INITIALIZING;
    this.logger.info('Initializing adapter');

    try {
      await this.onInitialize();
      this.state = AdapterState.INITIALIZED;
      this.logger.info('Adapter initialized successfully');
    } catch (error) {
      this.state = AdapterState.ERROR;
      this.initializationError = error as Error;
      this.logger.error('Adapter initialization failed', error as Error);
      throw error;
    }
  }

  /**
   * Start the adapter
   * 
   * Begins accepting requests/connections. Must be called after initialize().
   */
  async start(): Promise<void> {
    if (this.state !== AdapterState.INITIALIZED) {
      throw new Error(`Cannot start adapter in state: ${this.state}`);
    }

    this.state = AdapterState.STARTING;
    this.logger.info('Starting adapter');

    try {
      await this.onStart();
      this.state = AdapterState.RUNNING;
      this.logger.info('Adapter started successfully');
    } catch (error) {
      this.state = AdapterState.ERROR;
      this.logger.error('Adapter start failed', error as Error);
      throw error;
    }
  }

  /**
   * Stop the adapter
   * 
   * Stops accepting new requests but allows in-flight requests to complete.
   */
  async stop(): Promise<void> {
    if (this.state !== AdapterState.RUNNING) {
      return; // Already stopped
    }

    this.state = AdapterState.STOPPING;
    this.logger.info('Stopping adapter');

    try {
      await this.onStop();
      this.state = AdapterState.STOPPED;
      this.logger.info('Adapter stopped successfully');
    } catch (error) {
      this.state = AdapterState.ERROR;
      this.logger.error('Adapter stop failed', error as Error);
      throw error;
    }
  }

  /**
   * Cleanup adapter resources
   * 
   * Should be called when adapter is no longer needed.
   */
  async cleanup(): Promise<void> {
    if (this.state === AdapterState.RUNNING) {
      await this.stop();
    }

    this.logger.info('Cleaning up adapter');

    try {
      await this.onCleanup();
      this.logger.info('Adapter cleaned up successfully');
    } catch (error) {
      this.logger.error('Adapter cleanup failed', error as Error);
      throw error;
    }
  }

  /**
   * Check if adapter is running
   */
  isRunning(): boolean {
    return this.state === AdapterState.RUNNING;
  }

  /**
   * Get current adapter state
   */
  getState(): AdapterState {
    return this.state;
  }

  /**
   * Get adapter configuration
   */
  getConfig(): Readonly<AdapterConfig> {
    return Object.freeze({ ...this.config });
  }

  /**
   * Get adapter health status
   */
  async getHealth(): Promise<{
    status: 'healthy' | 'unhealthy';
    state: AdapterState;
    error?: string;
  }> {
    return {
      status: this.state === AdapterState.RUNNING ? 'healthy' : 'unhealthy',
      state: this.state,
      error: this.initializationError?.message,
    };
  }

  /**
   * Hook for subclass initialization logic
   * 
   * Override this to add adapter-specific initialization.
   */
  protected abstract onInitialize(): Promise<void>;

  /**
   * Hook for subclass start logic
   * 
   * Override this to add adapter-specific start logic.
   */
  protected abstract onStart(): Promise<void>;

  /**
   * Hook for subclass stop logic
   * 
   * Override this to add adapter-specific stop logic.
   */
  protected async onStop(): Promise<void> {
    // Default: no-op
  }

  /**
   * Hook for subclass cleanup logic
   * 
   * Override this to add adapter-specific cleanup.
   */
  protected async onCleanup(): Promise<void> {
    // Default: no-op
  }

  /**
   * Transform request from adapter format to service format
   * 
   * Override this to implement request transformation.
   */
  protected transformRequest<TAdapterRequest, TServiceRequest>(
    request: TAdapterRequest
  ): TServiceRequest {
    // Default: pass through
    return request as unknown as TServiceRequest;
  }

  /**
   * Transform response from service format to adapter format
   * 
   * Override this to implement response transformation.
   */
  protected transformResponse<TServiceResponse, TAdapterResponse>(
    response: TServiceResponse
  ): TAdapterResponse {
    // Default: pass through
    return response as unknown as TAdapterResponse;
  }

  /**
   * Handle adapter-level errors
   * 
   * Override this to implement custom error handling.
   */
  protected handleError(error: Error): void {
    this.logger.error('Adapter error occurred', error);
  }
}
```

### Example Usage

```typescript
// src/adapters/ExampleAdapter.ts
import { BaseAdapter, AdapterConfig } from './BaseAdapter';
import { ServiceContainer } from '../core/container/ServiceContainer';
import { ILogger } from '../core/logging/ILogger';
import { IUserService } from '../core/interfaces/IUserService';

interface ExampleAdapterConfig extends AdapterConfig {
  port: number;
  host: string;
}

export class ExampleAdapter extends BaseAdapter {
  private userService!: IUserService;
  private server: any;

  constructor(
    config: ExampleAdapterConfig,
    container: ServiceContainer,
    logger: ILogger
  ) {
    super(config, container, logger);
  }

  protected async onInitialize(): Promise<void> {
    this.logger.debug('Resolving services from container');
    
    // Resolve services from container
    this.userService = await this.container.resolve<IUserService>('userService');
    
    this.logger.debug('Services resolved successfully');
  }

  protected async onStart(): Promise<void> {
    const config = this.config as ExampleAdapterConfig;
    
    this.logger.info('Starting server', {
      host: config.host,
      port: config.port,
    });

    // Start server (pseudo-code)
    this.server = await startServer({
      host: config.host,
      port: config.port,
      handler: this.handleRequest.bind(this),
    });

    this.logger.info('Server started');
  }

  protected async onStop(): Promise<void> {
    if (this.server) {
      this.logger.info('Stopping server');
      await this.server.close();
      this.logger.info('Server stopped');
    }
  }

  protected async onCleanup(): Promise<void> {
    this.logger.debug('Cleaning up adapter resources');
    // Cleanup any adapter-specific resources
  }

  private async handleRequest(request: any): Promise<any> {
    try {
      // Transform request
      const serviceRequest = this.transformRequest(request);
      
      // Call service
      const result = await this.userService.getUser(serviceRequest.userId);
      
      // Transform response
      return this.transformResponse(result);
    } catch (error) {
      this.handleError(error as Error);
      throw error;
    }
  }
}

// Usage
const container = new ServiceContainer();
const logger = LoggerFactory.getLogger('ExampleAdapter');

const adapter = new ExampleAdapter(
  {
    name: 'ExampleAdapter',
    port: 3000,
    host: 'localhost',
  },
  container,
  logger
);

await adapter.initialize();
await adapter.start();

// ... adapter is now running ...

await adapter.stop();
await adapter.cleanup();
```

---

## Benefits

### 1. Consistent Structure
- All adapters follow same lifecycle
- Predictable state transitions
- Standard initialization pattern

### 2. Code Reuse
- Common functionality in base class
- Transformation hooks provided
- Error handling standardized

### 3. Testability
- Easy to mock and test
- Health checks for monitoring
- State inspection for debugging

### 4. Maintainability
- Changes propagate to all adapters
- Clear extension points
- Separation of concerns

### 5. Flexibility
- Support multiple deployment targets
- Easy to add new adapters
- Configurable behavior

---

## Best Practices

### 1. Always Call Super Methods
```typescript
class MyAdapter extends BaseAdapter {
  protected async onInitialize(): Promise<void> {
    // Your initialization
  }
}
```

### 2. Use Dependency Injection
```typescript
protected async onInitialize(): Promise<void> {
  // ✅ Resolve from container
  this.userService = await this.container.resolve('userService');
}
```

### 3. Implement Transformation Methods
```typescript
protected transformRequest<TReq, TService>(req: TReq): TService {
  return {
    userId: req.user_id, // Transform naming
    data: req.payload,
  } as TService;
}
```

### 4. Handle Errors Gracefully
```typescript
protected handleError(error: Error): void {
  super.handleError(error);
  // Add adapter-specific error handling
}
```

### 5. Log Important Events
```typescript
protected async onStart(): Promise<void> {
  this.logger.info('Starting adapter', { config: this.config });
  // Start logic
  this.logger.info('Adapter started');
}
```

---

## Anti-Patterns

### ❌ Don't Skip Initialization
```typescript
// ❌ Wrong
const adapter = new MyAdapter(config, container, logger);
await adapter.start(); // Will throw - not initialized
```

### ❌ Don't Override Lifecycle Methods Directly
```typescript
// ❌ Wrong
async initialize(): Promise<void> {
  // This breaks state management
}

// ✅ Correct
protected async onInitialize(): Promise<void> {
  // Use hooks
}
```

### ❌ Don't Ignore State
```typescript
// ❌ Wrong
async handleRequest(req: any): Promise<any> {
  // Missing state check
  return await this.service.process(req);
}

// ✅ Correct
async handleRequest(req: any): Promise<any> {
  if (!this.isRunning()) {
    throw new Error('Adapter not running');
  }
  return await this.service.process(req);
}
```

### ❌ Don't Forget Cleanup
```typescript
// ❌ Wrong
await adapter.stop();
// Missing: await adapter.cleanup();

// ✅ Correct
await adapter.stop();
await adapter.cleanup();
```

---

## Related Patterns

- **[Service Base Pattern](core-sdk.service-base.md)** - Services used by adapters
- **[Service Container Pattern](core-sdk.service-container.md)** - DI for adapter dependencies
- **[MCP Adapter Pattern](core-sdk.adapter-mcp.md)** - MCP-specific adapter
- **[REST Adapter Pattern](core-sdk.adapter-rest.md)** - REST API adapter
- **[CLI Adapter Pattern](core-sdk.adapter-cli.md)** - CLI tool adapter
- **[Client Adapter Pattern](core-sdk.adapter-client.md)** - Client library adapter

---

## Testing

```typescript
// src/adapters/base.adapter.spec.ts
describe('BaseAdapter', () => {
  let adapter: TestAdapter;
  let container: ServiceContainer;
  let logger: ILogger;

  class TestAdapter extends BaseAdapter {
    initializeCalled = false;
    startCalled = false;
    stopCalled = false;
    cleanupCalled = false;

    protected async onInitialize(): Promise<void> {
      this.initializeCalled = true;
    }

    protected async onStart(): Promise<void> {
      this.startCalled = true;
    }

    protected async onStop(): Promise<void> {
      this.stopCalled = true;
    }

    protected async onCleanup(): Promise<void> {
      this.cleanupCalled = true;
    }
  }

  beforeEach(() => {
    container = new ServiceContainer();
    logger = new ConsoleLogger('TestAdapter');
    adapter = new TestAdapter(
      { name: 'TestAdapter' },
      container,
      logger
    );
  });

  describe('lifecycle', () => {
    it('should start in uninitialized state', () => {
      expect(adapter.getState()).toBe(AdapterState.UNINITIALIZED);
      expect(adapter.isRunning()).toBe(false);
    });

    it('should transition through states correctly', async () => {
      await adapter.initialize();
      expect(adapter.getState()).toBe(AdapterState.INITIALIZED);
      expect(adapter.initializeCalled).toBe(true);

      await adapter.start();
      expect(adapter.getState()).toBe(AdapterState.RUNNING);
      expect(adapter.isRunning()).toBe(true);
      expect(adapter.startCalled).toBe(true);

      await adapter.stop();
      expect(adapter.getState()).toBe(AdapterState.STOPPED);
      expect(adapter.isRunning()).toBe(false);
      expect(adapter.stopCalled).toBe(true);

      await adapter.cleanup();
      expect(adapter.cleanupCalled).toBe(true);
    });

    it('should not allow double initialization', async () => {
      await adapter.initialize();
      await expect(adapter.initialize()).rejects.toThrow();
    });

    it('should not allow starting before initialization', async () => {
      await expect(adapter.start()).rejects.toThrow();
    });
  });

  describe('health check', () => {
    it('should report healthy when running', async () => {
      await adapter.initialize();
      await adapter.start();
      
      const health = await adapter.getHealth();
      expect(health.status).toBe('healthy');
      expect(health.state).toBe(AdapterState.RUNNING);
    });

    it('should report unhealthy when not running', async () => {
      const health = await adapter.getHealth();
      expect(health.status).toBe('unhealthy');
    });
  });
});
```

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Node.js 18+
**Related Design**: [Core SDK Architecture](../design/core-sdk.architecture.md)
