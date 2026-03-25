# Pattern: Service Interface

**Namespace**: core-sdk
**Category**: Service Layer
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The Service Interface pattern defines TypeScript interfaces for services to enable dependency injection, testing, and loose coupling. By programming to interfaces rather than concrete implementations, services become more flexible, testable, and maintainable.

This pattern is essential for building modular systems where services can be easily mocked, swapped, or extended without changing dependent code.

---

## Problem

Without service interfaces, developers face:

1. **Tight Coupling**: Code depends directly on concrete implementations
2. **Testing Difficulty**: Hard to mock services for unit tests
3. **Inflexibility**: Cannot swap implementations without code changes
4. **Poor Abstraction**: Implementation details leak into consuming code
5. **Circular Dependencies**: Services directly reference each other

---

## Solution

Define TypeScript interfaces that:
- Describe service contracts without implementation details
- Enable dependency injection
- Support multiple implementations
- Facilitate testing with mocks
- Enforce consistent APIs

---

## Implementation

### Basic Service Interface

```typescript
// src/core/interfaces/IUserService.ts

/**
 * User data transfer object
 */
export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

/**
 * User creation data
 */
export interface CreateUserData {
  email: string;
  name: string;
  password: string;
}

/**
 * User update data
 */
export interface UpdateUserData {
  name?: string;
  email?: string;
}

/**
 * User service interface
 * 
 * Defines the contract for user management operations.
 * Implementations must provide all methods defined here.
 */
export interface IUserService {
  /**
   * Get user by ID
   * @throws {UserNotFoundError} If user doesn't exist
   */
  getUser(id: string): Promise<User>;

  /**
   * Get user by email
   * @throws {UserNotFoundError} If user doesn't exist
   */
  getUserByEmail(email: string): Promise<User>;

  /**
   * Create a new user
   * @throws {UserAlreadyExistsError} If email is taken
   */
  createUser(data: CreateUserData): Promise<User>;

  /**
   * Update existing user
   * @throws {UserNotFoundError} If user doesn't exist
   */
  updateUser(id: string, data: UpdateUserData): Promise<User>;

  /**
   * Delete user
   * @throws {UserNotFoundError} If user doesn't exist
   */
  deleteUser(id: string): Promise<void>;

  /**
   * List all users with pagination
   */
  listUsers(options?: {
    limit?: number;
    offset?: number;
  }): Promise<User[]>;
}
```

### Implementing the Interface

```typescript
// src/core/services/UserService.ts
import { BaseService } from './BaseService';
import { IUserService, User, CreateUserData, UpdateUserData } from '../interfaces/IUserService';

export class UserService extends BaseService implements IUserService {
  private db: Database | null = null;

  protected async onInitialize(): Promise<void> {
    this.db = await Database.connect(this.config.databaseUrl);
  }

  protected async onCleanup(): Promise<void> {
    if (this.db) {
      await this.db.disconnect();
    }
  }

  async getUser(id: string): Promise<User> {
    this.ensureInitialized();
    
    const user = await this.db!.users.findById(id);
    if (!user) {
      throw new UserNotFoundError(id);
    }
    
    return user;
  }

  async getUserByEmail(email: string): Promise<User> {
    this.ensureInitialized();
    
    const user = await this.db!.users.findByEmail(email);
    if (!user) {
      throw new UserNotFoundError(email);
    }
    
    return user;
  }

  async createUser(data: CreateUserData): Promise<User> {
    this.ensureInitialized();
    
    // Check if user exists
    const existing = await this.db!.users.findByEmail(data.email);
    if (existing) {
      throw new UserAlreadyExistsError(data.email);
    }
    
    // Hash password
    const hashedPassword = await this.hashPassword(data.password);
    
    // Create user
    return await this.db!.users.create({
      ...data,
      password: hashedPassword,
    });
  }

  async updateUser(id: string, data: UpdateUserData): Promise<User> {
    this.ensureInitialized();
    
    const user = await this.getUser(id); // Throws if not found
    return await this.db!.users.update(id, data);
  }

  async deleteUser(id: string): Promise<void> {
    this.ensureInitialized();
    
    await this.getUser(id); // Throws if not found
    await this.db!.users.delete(id);
  }

  async listUsers(options?: { limit?: number; offset?: number }): Promise<User[]> {
    this.ensureInitialized();
    
    return await this.db!.users.findAll({
      limit: options?.limit ?? 100,
      offset: options?.offset ?? 0,
    });
  }

  private async hashPassword(password: string): Promise<string> {
    // Implementation
    return password; // Placeholder
  }
}
```

### Dependency Injection

```typescript
// src/core/services/OrderService.ts
import { IUserService } from '../interfaces/IUserService';
import { BaseService } from './BaseService';

/**
 * Order service that depends on user service
 */
export class OrderService extends BaseService {
  constructor(
    config: ServiceConfig,
    private userService: IUserService // ✅ Depend on interface, not implementation
  ) {
    super(config);
  }

  async createOrder(userId: string, items: OrderItem[]): Promise<Order> {
    this.ensureInitialized();
    
    // Use injected user service
    const user = await this.userService.getUser(userId);
    
    // Create order
    return await this.db!.orders.create({
      userId: user.id,
      items,
      total: this.calculateTotal(items),
    });
  }

  private calculateTotal(items: OrderItem[]): number {
    return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
}

// Usage with dependency injection
const userService = new UserService(userConfig);
await userService.initialize();

const orderService = new OrderService(
  orderConfig,
  userService // ✅ Inject concrete implementation
);
await orderService.initialize();
```

### Generic Service Interface

```typescript
// src/core/interfaces/IRepository.ts

/**
 * Generic repository interface for CRUD operations
 */
export interface IRepository<T, ID = string> {
  /**
   * Find entity by ID
   */
  findById(id: ID): Promise<T | null>;

  /**
   * Find all entities matching criteria
   */
  findAll(criteria?: Partial<T>): Promise<T[]>;

  /**
   * Create new entity
   */
  create(data: Omit<T, 'id'>): Promise<T>;

  /**
   * Update existing entity
   */
  update(id: ID, data: Partial<T>): Promise<T>;

  /**
   * Delete entity
   */
  delete(id: ID): Promise<void>;

  /**
   * Check if entity exists
   */
  exists(id: ID): Promise<boolean>;
}

// Concrete implementation
export class UserRepository implements IRepository<User> {
  async findById(id: string): Promise<User | null> {
    // Implementation
  }

  async findAll(criteria?: Partial<User>): Promise<User[]> {
    // Implementation
  }

  async create(data: Omit<User, 'id'>): Promise<User> {
    // Implementation
  }

  async update(id: string, data: Partial<User>): Promise<User> {
    // Implementation
  }

  async delete(id: string): Promise<void> {
    // Implementation
  }

  async exists(id: string): Promise<boolean> {
    // Implementation
  }
}
```

---

## Benefits

### 1. Loose Coupling
- Services depend on abstractions, not concrete implementations
- Easy to swap implementations
- Reduces ripple effects from changes

### 2. Testability
- Easy to create mock implementations
- Unit tests don't need real dependencies
- Faster test execution

### 3. Flexibility
- Multiple implementations of same interface
- Can switch implementations at runtime
- Supports different environments (dev, test, prod)

### 4. Clear Contracts
- Interface documents expected behavior
- Type safety enforced by TypeScript
- Self-documenting code

### 5. Maintainability
- Changes to implementation don't affect interface
- Easier to refactor
- Better separation of concerns

---

## Best Practices

### 1. Name Interfaces with 'I' Prefix
```typescript
// ✅ Clear interface naming
export interface IUserService { }
export interface IEmailService { }
export interface IPaymentService { }
```

### 2. Keep Interfaces Focused
```typescript
// ✅ Single responsibility
export interface IUserService {
  getUser(id: string): Promise<User>;
  createUser(data: CreateUserData): Promise<User>;
}

// ❌ Too many responsibilities
export interface IGodService {
  getUser(id: string): Promise<User>;
  sendEmail(to: string): Promise<void>;
  processPayment(amount: number): Promise<void>;
  // ... 50 more methods
}
```

### 3. Document Interface Methods
```typescript
export interface IUserService {
  /**
   * Get user by ID
   * @param id - User identifier
   * @returns User object
   * @throws {UserNotFoundError} If user doesn't exist
   */
  getUser(id: string): Promise<User>;
}
```

### 4. Use Dependency Injection
```typescript
// ✅ Inject interface
class OrderService {
  constructor(private userService: IUserService) {}
}

// ❌ Direct instantiation
class OrderService {
  private userService = new UserService(config);
}
```

### 5. Define DTOs Alongside Interfaces
```typescript
// ✅ Keep related types together
export interface User {
  id: string;
  email: string;
}

export interface CreateUserData {
  email: string;
  password: string;
}

export interface IUserService {
  createUser(data: CreateUserData): Promise<User>;
}
```

---

## Anti-Patterns

### ❌ Don't Expose Implementation Details
```typescript
// ❌ Wrong - exposes database
export interface IUserService {
  getDatabase(): Database;
  executeQuery(sql: string): Promise<any>;
}

// ✅ Correct - hides implementation
export interface IUserService {
  getUser(id: string): Promise<User>;
}
```

### ❌ Don't Create Interfaces for Everything
```typescript
// ❌ Unnecessary interface
export interface IUserDTO {
  id: string;
  email: string;
}

// ✅ Just use a type
export type User = {
  id: string;
  email: string;
};
```

### ❌ Don't Make Interfaces Too Granular
```typescript
// ❌ Too granular
export interface IUserGetter {
  getUser(id: string): Promise<User>;
}

export interface IUserCreator {
  createUser(data: CreateUserData): Promise<User>;
}

// ✅ Cohesive interface
export interface IUserService {
  getUser(id: string): Promise<User>;
  createUser(data: CreateUserData): Promise<User>;
}
```

### ❌ Don't Depend on Concrete Classes
```typescript
// ❌ Wrong
class OrderService {
  constructor(private userService: UserService) {}
}

// ✅ Correct
class OrderService {
  constructor(private userService: IUserService) {}
}
```

---

## Related Patterns

- **[Service Base Pattern](core-sdk.service-base.md)** - Base class that implements interfaces
- **[Service Container Pattern](core-sdk.service-container.md)** - Manages interface-to-implementation bindings
- **[Testing Mocks Pattern](core-sdk.testing-mocks.md)** - Creating mock implementations of interfaces

---

## Testing

### Mock Implementation for Testing

```typescript
// src/services/user.service.mock.ts
import { IUserService, User, CreateUserData, UpdateUserData } from '../core/interfaces/IUserService';

export class MockUserService implements IUserService {
  private users: Map<string, User> = new Map();

  async getUser(id: string): Promise<User> {
    const user = this.users.get(id);
    if (!user) {
      throw new Error(`User ${id} not found`);
    }
    return user;
  }

  async getUserByEmail(email: string): Promise<User> {
    const user = Array.from(this.users.values()).find(u => u.email === email);
    if (!user) {
      throw new Error(`User with email ${email} not found`);
    }
    return user;
  }

  async createUser(data: CreateUserData): Promise<User> {
    const user: User = {
      id: Math.random().toString(36),
      email: data.email,
      name: data.name,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async updateUser(id: string, data: UpdateUserData): Promise<User> {
    const user = await this.getUser(id);
    const updated = { ...user, ...data };
    this.users.set(id, updated);
    return updated;
  }

  async deleteUser(id: string): Promise<void> {
    this.users.delete(id);
  }

  async listUsers(): Promise<User[]> {
    return Array.from(this.users.values());
  }

  // Test helper methods
  addUser(user: User): void {
    this.users.set(user.id, user);
  }

  clear(): void {
    this.users.clear();
  }
}
```

### Unit Test Using Mock

```typescript
// src/services/order.service.spec.ts
import { OrderService } from './order.service';
import { MockUserService } from './user.service.mock';

describe('OrderService', () => {
  let orderService: OrderService;
  let mockUserService: MockUserService;

  beforeEach(async () => {
    mockUserService = new MockUserService();
    
    // Add test user
    mockUserService.addUser({
      id: 'user-1',
      email: 'test@example.com',
      name: 'Test User',
      createdAt: new Date(),
    });

    orderService = new OrderService(
      { name: 'OrderService' },
      mockUserService // ✅ Inject mock
    );
    
    await orderService.initialize();
  });

  afterEach(async () => {
    await orderService.cleanup();
  });

  it('should create order for existing user', async () => {
    const order = await orderService.createOrder('user-1', [
      { productId: 'p1', quantity: 2, price: 10 },
    ]);

    expect(order.userId).toBe('user-1');
    expect(order.total).toBe(20);
  });

  it('should throw error for non-existent user', async () => {
    await expect(
      orderService.createOrder('invalid-user', [])
    ).rejects.toThrow();
  });
});
```

---

## Migration Guide

### From Concrete Dependencies

**Before:**
```typescript
class OrderService {
  private userService: UserService;

  constructor(config: Config) {
    this.userService = new UserService(config.userServiceConfig);
  }

  async createOrder(userId: string): Promise<Order> {
    const user = await this.userService.getUser(userId);
    // ...
  }
}
```

**After:**
```typescript
// 1. Define interface
export interface IUserService {
  getUser(id: string): Promise<User>;
}

// 2. Implement interface
class UserService extends BaseService implements IUserService {
  async getUser(id: string): Promise<User> {
    // Implementation
  }
}

// 3. Depend on interface
class OrderService {
  constructor(
    config: Config,
    private userService: IUserService // ✅ Interface dependency
  ) {}

  async createOrder(userId: string): Promise<Order> {
    const user = await this.userService.getUser(userId);
    // ...
  }
}

// 4. Inject implementation
const userService = new UserService(config);
const orderService = new OrderService(config, userService);
```

---

**Status**: Active
**Compatibility**: TypeScript 5.0+
**Related Design**: [Core SDK Architecture](../design/core-sdk.architecture.md)
