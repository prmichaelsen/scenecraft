# Pattern: Service Container

**Namespace**: core-sdk
**Category**: Service Layer
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The Service Container pattern provides a centralized registry for managing service instances and their dependencies. It implements dependency injection, enabling loose coupling and making it easy to configure, test, and maintain complex service graphs.

This pattern is essential for applications with multiple services that depend on each other, providing a clean way to manage the creation, initialization, and lifecycle of all services.

---

## Problem

Without a service container, developers face:

1. **Manual Dependency Management**: Must manually create and wire up services
2. **Initialization Order Issues**: Hard to ensure services initialize in correct order
3. **Circular Dependencies**: Difficult to detect and resolve
4. **Testing Complexity**: Must manually mock all dependencies
5. **Configuration Sprawl**: Service configuration scattered across codebase
6. **Lifecycle Management**: No centralized way to initialize/cleanup services

---

## Solution

Create a `ServiceContainer` class that:
- Registers service factories
- Resolves dependencies automatically
- Manages service lifecycle
- Supports singleton and transient services
- Enables easy testing with mocks

---

## Implementation

### Basic Service Container

```typescript
// src/core/container/ServiceContainer.ts

/**
 * Service factory function
 */
export type ServiceFactory<T> = (container: ServiceContainer) => T | Promise<T>;

/**
 * Service registration options
 */
export interface ServiceOptions {
  /** Service lifecycle - singleton (default) or transient */
  lifecycle?: 'singleton' | 'transient';
  /** Service tags for grouping */
  tags?: string[];
}

/**
 * Service registration
 */
interface ServiceRegistration<T = any> {
  factory: ServiceFactory<T>;
  options: ServiceOptions;
  instance?: T;
}

/**
 * Service container for dependency injection
 * 
 * Manages service registration, resolution, and lifecycle.
 * 
 * @example
 * ```typescript
 * const container = new ServiceContainer();
 * 
 * // Register services
 * container.register('userService', (c) => new UserService(config));
 * container.register('orderService', (c) => 
 *   new OrderService(config, c.resolve('userService'))
 * );
 * 
 * // Resolve services
 * const orderService = await container.resolve('orderService');
 * ```
 */
export class ServiceContainer {
  private services: Map<string, ServiceRegistration> = new Map();
  private resolving: Set<string> = new Set();

  /**
   * Register a service with the container
   * 
   * @param name - Service identifier
   * @param factory - Function that creates the service
   * @param options - Service options
   */
  register<T>(
    name: string,
    factory: ServiceFactory<T>,
    options: ServiceOptions = {}
  ): void {
    if (this.services.has(name)) {
      throw new Error(`Service '${name}' is already registered`);
    }

    this.services.set(name, {
      factory,
      options: {
        lifecycle: 'singleton',
        tags: [],
        ...options,
      },
    });
  }

  /**
   * Register a singleton service (default)
   */
  registerSingleton<T>(
    name: string,
    factory: ServiceFactory<T>,
    options: Omit<ServiceOptions, 'lifecycle'> = {}
  ): void {
    this.register(name, factory, { ...options, lifecycle: 'singleton' });
  }

  /**
   * Register a transient service (new instance each time)
   */
  registerTransient<T>(
    name: string,
    factory: ServiceFactory<T>,
    options: Omit<ServiceOptions, 'lifecycle'> = {}
  ): void {
    this.register(name, factory, { ...options, lifecycle: 'transient' });
  }

  /**
   * Register an existing instance
   */
  registerInstance<T>(name: string, instance: T): void {
    this.services.set(name, {
      factory: () => instance,
      options: { lifecycle: 'singleton' },
      instance,
    });
  }

  /**
   * Resolve a service by name
   * 
   * @param name - Service identifier
   * @returns Service instance
   * @throws {Error} If service not found or circular dependency detected
   */
  async resolve<T>(name: string): Promise<T> {
    const registration = this.services.get(name);
    
    if (!registration) {
      throw new Error(`Service '${name}' not found`);
    }

    // Check for circular dependencies
    if (this.resolving.has(name)) {
      throw new Error(
        `Circular dependency detected: ${Array.from(this.resolving).join(' -> ')} -> ${name}`
      );
    }

    // Return existing singleton instance
    if (registration.options.lifecycle === 'singleton' && registration.instance) {
      return registration.instance as T;
    }

    // Create new instance
    this.resolving.add(name);
    
    try {
      const instance = await registration.factory(this);
      
      // Cache singleton instance
      if (registration.options.lifecycle === 'singleton') {
        registration.instance = instance;
      }
      
      return instance as T;
    } finally {
      this.resolving.delete(name);
    }
  }

  /**
   * Resolve multiple services by tag
   */
  async resolveByTag<T>(tag: string): Promise<T[]> {
    const services: T[] = [];
    
    for (const [name, registration] of this.services) {
      if (registration.options.tags?.includes(tag)) {
        services.push(await this.resolve<T>(name));
      }
    }
    
    return services;
  }

  /**
   * Check if service is registered
   */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Get all registered service names
   */
  getServiceNames(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Initialize all registered services
   * 
   * Calls initialize() on all services that have the method
   */
  async initializeAll(): Promise<void> {
    for (const name of this.services.keys()) {
      const service = await this.resolve(name);
      
      if (service && typeof (service as any).initialize === 'function') {
        await (service as any).initialize();
      }
    }
  }

  /**
   * Cleanup all registered services
   * 
   * Calls cleanup() on all services that have the method
   */
  async cleanupAll(): Promise<void> {
    const names = Array.from(this.services.keys()).reverse();
    
    for (const name of names) {
      const registration = this.services.get(name);
      
      if (registration?.instance) {
        const service = registration.instance;
        
        if (typeof (service as any).cleanup === 'function') {
          await (service as any).cleanup();
        }
      }
    }
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.services.clear();
    this.resolving.clear();
  }

  /**
   * Create a child container with inherited registrations
   */
  createChild(): ServiceContainer {
    const child = new ServiceContainer();
    
    // Copy parent registrations
    for (const [name, registration] of this.services) {
      child.services.set(name, { ...registration });
    }
    
    return child;
  }
}
```

### Usage Example

```typescript
// src/core/container/setup.ts
import { ServiceContainer } from './ServiceContainer';
import { UserService } from '../services/UserService';
import { OrderService } from '../services/OrderService';
import { EmailService } from '../services/EmailService';

/**
 * Configure and create service container
 */
export function createServiceContainer(config: AppConfig): ServiceContainer {
  const container = new ServiceContainer();

  // Register configuration
  container.registerInstance('config', config);

  // Register services
  container.registerSingleton('userService', (c) => {
    const cfg = c.resolve<AppConfig>('config');
    return new UserService({
      name: 'UserService',
      databaseUrl: cfg.databaseUrl,
    });
  });

  container.registerSingleton('emailService', (c) => {
    const cfg = c.resolve<AppConfig>('config');
    return new EmailService({
      name: 'EmailService',
      smtpHost: cfg.smtpHost,
    });
  });

  container.registerSingleton('orderService', async (c) => {
    const cfg = await c.resolve<AppConfig>('config');
    const userService = await c.resolve<IUserService>('userService');
    const emailService = await c.resolve<IEmailService>('emailService');
    
    return new OrderService(
      {
        name: 'OrderService',
        databaseUrl: cfg.databaseUrl,
      },
      userService,
      emailService
    );
  });

  return container;
}

// Usage
const config = loadConfig();
const container = createServiceContainer(config);

// Initialize all services
await container.initializeAll();

// Use services
const orderService = await container.resolve<OrderService>('orderService');
const order = await orderService.createOrder('user-123', items);

// Cleanup
await container.cleanupAll();
```

### Tagged Services

```typescript
// Register services with tags
container.registerSingleton(
  'userService',
  (c) => new UserService(config),
  { tags: ['data-service', 'core'] }
);

container.registerSingleton(
  'orderService',
  (c) => new OrderService(config),
  { tags: ['data-service', 'core'] }
);

container.registerSingleton(
  'analyticsService',
  (c) => new AnalyticsService(config),
  { tags: ['analytics'] }
);

// Resolve all data services
const dataServices = await container.resolveByTag<BaseService>('data-service');

// Initialize only data services
for (const service of dataServices) {
  await service.initialize();
}
```

---

## Benefits

### 1. Centralized Configuration
- All service registration in one place
- Easy to see service dependencies
- Consistent service setup

### 2. Automatic Dependency Resolution
- Container resolves dependencies automatically
- No manual wiring required
- Detects circular dependencies

### 3. Lifecycle Management
- Initialize all services in correct order
- Cleanup all services properly
- Singleton vs transient control

### 4. Testing Support
- Easy to swap real services with mocks
- Create test containers with test services
- Isolated test environments

### 5. Flexibility
- Change implementations without changing consumers
- Support multiple configurations
- Child containers for scoped services

---

## Best Practices

### 1. Register Services at Startup
```typescript
// ✅ Register all services at application startup
async function bootstrap() {
  const container = createServiceContainer(config);
  await container.initializeAll();
  return container;
}
```

### 2. Use Interfaces for Dependencies
```typescript
// ✅ Depend on interfaces
container.registerSingleton('orderService', async (c) => {
  const userService = await c.resolve<IUserService>('userService');
  return new OrderService(config, userService);
});
```

### 3. Use Tags for Grouping
```typescript
// ✅ Tag related services
container.registerSingleton(
  'userService',
  factory,
  { tags: ['data-service', 'core'] }
);
```

### 4. Create Factory Functions
```typescript
// ✅ Encapsulate container setup
export function createServiceContainer(config: AppConfig): ServiceContainer {
  const container = new ServiceContainer();
  // Register services
  return container;
}
```

### 5. Use Child Containers for Scopes
```typescript
// ✅ Create child container for request scope
function handleRequest(req: Request) {
  const requestContainer = globalContainer.createChild();
  requestContainer.registerInstance('request', req);
  // Use request-scoped services
}
```

---

## Anti-Patterns

### ❌ Don't Resolve Services in Constructors
```typescript
// ❌ Wrong - creates tight coupling
class OrderService {
  private userService: IUserService;
  
  constructor(container: ServiceContainer) {
    this.userService = container.resolve('userService'); // Synchronous!
  }
}

// ✅ Correct - inject dependencies
class OrderService {
  constructor(private userService: IUserService) {}
}
```

### ❌ Don't Create Multiple Global Containers
```typescript
// ❌ Wrong
const container1 = new ServiceContainer();
const container2 = new ServiceContainer();

// ✅ Correct - one global, use child containers for scopes
const globalContainer = new ServiceContainer();
const requestContainer = globalContainer.createChild();
```

### ❌ Don't Register Services Dynamically
```typescript
// ❌ Wrong - register during request handling
app.get('/users', async (req, res) => {
  container.register('tempService', () => new TempService());
});

// ✅ Correct - register at startup
const container = createServiceContainer(config);
app.get('/users', async (req, res) => {
  const service = await container.resolve('userService');
});
```

---

## Related Patterns

- **[Service Base Pattern](core-sdk.service-base.md)** - Services managed by container
- **[Service Interface Pattern](core-sdk.service-interface.md)** - Interfaces for dependency injection
- **[Configuration Pattern](core-sdk.config-schema.md)** - Configuration management

---

## Testing

```typescript
// src/container/service-container.spec.ts
describe('ServiceContainer', () => {
  let container: ServiceContainer;

  beforeEach(() => {
    container = new ServiceContainer();
  });

  describe('registration', () => {
    it('should register and resolve service', async () => {
      container.register('test', () => ({ value: 42 }));
      const service = await container.resolve('test');
      expect(service.value).toBe(42);
    });

    it('should throw if service already registered', () => {
      container.register('test', () => ({}));
      expect(() => container.register('test', () => ({}))).toThrow();
