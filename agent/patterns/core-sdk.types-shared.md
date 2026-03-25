# Pattern: Shared Types

**Category**: Type System
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Shared Types pattern establishes how to define domain types — DTOs, value objects, and primitive aliases — that are used across the service layer, adapter layer, and consuming applications. All shared types live in `src/types/` and are exported from a barrel index.

## Problem Statement

Without a shared type strategy:
- The same shape is defined multiple times with subtle differences
- Adapters and services use incompatible representations of the same concept
- Renaming a field requires searching across multiple files
- Type drift accumulates as teams independently evolve their definitions

## Solution

Define all cross-cutting domain types in `src/types/`. Organize by domain concept (not by layer). Export everything from `src/types/index.ts`. Both services and adapters import from this shared location.

## Implementation

### Directory Structure

```
src/
├── types/
│   ├── index.ts             ← barrel export
│   ├── user.types.ts        ← User domain types
│   ├── product.types.ts     ← Product domain types
│   ├── order.types.ts       ← Order domain types
│   ├── pagination.types.ts  ← Shared pagination shapes
│   └── common.types.ts      ← Cross-cutting primitives
```

### Branded Primitive Types

```typescript
// src/types/common.types.ts
// Branded types prevent mixing up semantically different strings/numbers

declare const __brand: unique symbol;
type Brand<T, B> = T & { [__brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type OrderId = Brand<string, 'OrderId'>;
export type ProductId = Brand<string, 'ProductId'>;
export type EmailAddress = Brand<string, 'EmailAddress'>;
export type ISODateString = Brand<string, 'ISODateString'>;
export type PositiveInt = Brand<number, 'PositiveInt'>;
export type Money = Brand<number, 'Money'>;  // in cents

// Constructor helpers (validate at runtime, brand at type level)
export function toUserId(value: string): UserId {
  if (!value || value.trim().length === 0) {
    throw new Error('UserId cannot be empty');
  }
  return value as UserId;
}

export function toMoney(cents: number): Money {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error('Money must be a non-negative integer (cents)');
  }
  return cents as Money;
}

export function toPositiveInt(value: number): PositiveInt {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('Value must be a positive integer');
  }
  return value as PositiveInt;
}
```

### Domain Entity Types

```typescript
// src/types/user.types.ts
import { UserId, EmailAddress, ISODateString } from './common.types';

export type UserRole = 'admin' | 'member' | 'viewer';

export type UserStatus = 'active' | 'suspended' | 'deleted';

/**
 * Full user entity — as stored in the database / returned from services
 */
export interface User {
  id: UserId;
  email: EmailAddress;
  name: string;
  role: UserRole;
  status: UserStatus;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt?: ISODateString;
}

/**
 * Input type for creating a new user
 */
export interface CreateUserInput {
  email: string;        // validated → EmailAddress inside service
  name: string;
  role?: UserRole;      // defaults to 'member'
}

/**
 * Input type for updating an existing user — all fields optional
 */
export interface UpdateUserInput {
  name?: string;
  role?: UserRole;
  status?: UserStatus;
}

/**
 * Public-facing representation — excludes sensitive/internal fields
 */
export interface UserDTO {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

/**
 * Map from full User entity to public DTO
 */
export function toUserDTO(user: User): UserDTO {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}
```

### Pagination Types

```typescript
// src/types/pagination.types.ts

export interface PaginationInput {
  page: number;      // 1-indexed
  limit: number;     // items per page
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export function createPaginatedResult<T>(
  items: T[],
  total: number,
  { page, limit }: PaginationInput
): PaginatedResult<T> {
  const totalPages = Math.ceil(total / limit);
  return {
    items,
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}
```

### Barrel Export

```typescript
// src/types/index.ts
export * from './common.types';
export * from './user.types';
export * from './product.types';
export * from './order.types';
export * from './pagination.types';
```

### Using Shared Types Across Layers

```typescript
// src/services/user.service.ts
import { User, UserId, CreateUserInput, UpdateUserInput, UserDTO, toUserDTO } from '../types';
import { PaginationInput, PaginatedResult, createPaginatedResult } from '../types';

export class UserService {
  async getUser(id: UserId): Promise<User> { ... }

  async createUser(input: CreateUserInput): Promise<UserDTO> {
    const user = await this.repo.create(input);
    return toUserDTO(user);
  }

  async listUsers(pagination: PaginationInput): Promise<PaginatedResult<UserDTO>> {
    const [users, total] = await this.repo.findAll(pagination);
    return createPaginatedResult(users.map(toUserDTO), total, pagination);
  }
}

// src/adapters/rest.adapter.ts — same types, no duplication
import { UserDTO, CreateUserInput } from '../types';

router.post('/users', async (req, res) => {
  const input: CreateUserInput = req.body;
  const user: UserDTO = await userService.createUser(input);
  res.json(user);
});
```

## Usage Guidelines

### When to Use

- ✅ Any type used by more than one file
- ✅ Domain entities and their DTOs
- ✅ Pagination and filtering inputs/outputs
- ✅ Branded primitives (IDs, Money, email addresses)

### When Not to Use

- ❌ Types internal to a single service or adapter
- ❌ Framework-specific types (Express `Request`, `Response`)
- ❌ Implementation details that don't cross layer boundaries

## Best Practices

1. **Separate entity from DTO**: Return DTOs from services and adapters, not raw entities
2. **Brand domain primitives**: `UserId` prevents accidentally passing an `OrderId` where a `UserId` is expected
3. **Use `interface` for extensible shapes**: Allows declaration merging if needed
4. **Use `type` for unions and aliases**: `UserRole = 'admin' | 'member'`
5. **Co-locate DTO transformers**: Keep `toUserDTO()` in `user.types.ts`, not scattered across adapters
6. **Export from barrel**: All types imported from `'../types'`, not from specific files

```typescript
// Good: Branded type catches mistakes at compile time
function sendWelcomeEmail(userId: UserId, email: EmailAddress) { ... }
const orderId: OrderId = 'ord-123' as OrderId;
sendWelcomeEmail(orderId, email);  // ✅ TypeScript error — OrderId is not UserId

// Bad: Plain strings — all IDs look the same
function sendWelcomeEmail(userId: string, email: string) { ... }
sendWelcomeEmail(orderId, email);  // No error — silent bug
```

## Anti-Patterns

### ❌ Defining the Same Shape in Multiple Places

```typescript
// Bad: UserDTO defined separately in each adapter
// rest.adapter.ts
interface UserResponse { id: string; name: string; }

// mcp.adapter.ts
interface UserResult { id: string; name: string; }  // Drift begins here

// Good: One canonical UserDTO in src/types/user.types.ts
import { UserDTO } from '../types';
```

### ❌ Exposing Internal Entity Fields

```typescript
// Bad: Returning raw entity leaks internal fields
async getUser(id: string): Promise<User> {
  return this.repo.findById(id);  // includes deletedAt, internal audit fields
}

// Good: Map to DTO at the service boundary
async getUser(id: UserId): Promise<UserDTO> {
  const user = await this.repo.findById(id);
  return toUserDTO(user);
}
```

### ❌ Any-Typed IDs

```typescript
// Bad
async getUser(id: any) { ... }
async getUser(id: string) { ... }  // Which kind of string?

// Good
async getUser(id: UserId) { ... }  // Clear, type-safe
```

## Related Patterns

- [Generic Utility Types](core-sdk.types-generic.md) - Type helpers used with shared types
- [Error Types](core-sdk.types-error.md) - Error shapes that cross layer boundaries
- [Configuration Types](core-sdk.types-config.md) - Typed configuration using the same conventions
- [Service Base](core-sdk.service-base.md) - Consumes shared types in method signatures

---

**Status**: Active
**Recommendation**: Define all cross-cutting domain types in `src/types/`. Use branded primitives for domain IDs and value objects. Always map entities to DTOs before returning across layer boundaries.
