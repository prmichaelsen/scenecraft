# Pattern: Generic Utility Types

**Category**: Type System
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Generic Utility Types pattern provides a small set of reusable TypeScript type utilities that cover the most common needs across a core SDK: deep partials for test helpers, nullable variants, branded types, async return type extraction, and discriminated union helpers. These utilities live in `src/types/utils.types.ts`.

## Problem Statement

Without a shared type utility file:
- The same `DeepPartial<T>` type is redefined in multiple files
- Teams write complex conditional types from scratch for common needs
- TypeScript built-ins like `Partial` don't cover nested objects
- Async function return types require manual unwrapping

## Solution

Define a small, practical set of generic type utilities in `src/types/utils.types.ts`. Export them alongside domain types. Prefer utilities that solve real problems in the codebase over exhaustive type libraries.

## Implementation

### Deep Partial

```typescript
// src/types/utils.types.ts

/**
 * Makes all properties optional recursively (for test overrides, config merges)
 */
export type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

// Usage in test fixtures
import { User } from './user.types';
import { DeepPartial } from './utils.types';

function createUserFixture(overrides: DeepPartial<User> = {}): User {
  return deepMerge(defaultUser, overrides);
}
```

### Nullable and Optional Variants

```typescript
/**
 * Adds null to a type
 */
export type Nullable<T> = T | null;

/**
 * Adds undefined to a type
 */
export type Optional<T> = T | undefined;

/**
 * Adds null and undefined to a type
 */
export type Maybe<T> = T | null | undefined;

// Usage
interface User {
  id: string;
  deletedAt: Nullable<string>;    // null when not deleted
  middleName: Optional<string>;   // undefined when not set
  avatar: Maybe<string>;          // either null or undefined means no avatar
}
```

### Async Return Type Extraction

```typescript
/**
 * Unwraps the resolved value of a Promise
 */
export type Awaited<T> = T extends Promise<infer U> ? U : T;

/**
 * Gets the return type of an async function
 */
export type AsyncReturnType<T extends (...args: any[]) => Promise<any>> =
  Awaited<ReturnType<T>>;

// Usage
async function fetchUser(id: string): Promise<User> { ... }

type FetchedUser = AsyncReturnType<typeof fetchUser>;  // User
```

### Record and Map Utilities

```typescript
/**
 * A record with string keys and typed values
 */
export type StringRecord<V> = Record<string, V>;

/**
 * Makes specific keys required, leaves rest optional
 */
export type RequireFields<T, K extends keyof T> =
  Omit<T, K> & Required<Pick<T, K>>;

/**
 * Makes specific keys optional, leaves rest required
 */
export type OptionalFields<T, K extends keyof T> =
  Omit<T, K> & Partial<Pick<T, K>>;

// Usage
interface CreateUserInput {
  email: string;
  name: string;
  role?: string;
}

// For an admin endpoint that MUST have role specified
type AdminCreateUserInput = RequireFields<CreateUserInput, 'role'>;
```

### Discriminated Union Helpers

```typescript
/**
 * Extracts the member of a discriminated union matching a specific tag
 */
export type Extract<T, U> = T extends U ? T : never;

/**
 * Gets all valid discriminant values for a union type
 */
export type DiscriminantOf<
  T extends { kind: string },
  K extends keyof T = 'kind'
> = T[K];

// Usage with discriminated unions
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'rectangle'; width: number; height: number }
  | { kind: 'triangle'; base: number; height: number };

type Circle = Extract<Shape, { kind: 'circle' }>;
// Circle = { kind: 'circle'; radius: number }

type ShapeKind = DiscriminantOf<Shape>;
// ShapeKind = 'circle' | 'rectangle' | 'triangle'
```

### Key and Value Extraction

```typescript
/**
 * Gets the keys of T as a union type (same as keyof, but more explicit)
 */
export type Keys<T> = keyof T;

/**
 * Gets the value types of T as a union type
 */
export type Values<T> = T[keyof T];

/**
 * Gets the entries of T as a union of [key, value] tuples
 */
export type Entries<T> = {
  [K in keyof T]: [K, T[K]];
}[keyof T];

// Usage
const statusMap = {
  active: 'Active',
  suspended: 'Suspended',
  deleted: 'Deleted',
} as const;

type StatusKey = Keys<typeof statusMap>;    // 'active' | 'suspended' | 'deleted'
type StatusLabel = Values<typeof statusMap>; // 'Active' | 'Suspended' | 'Deleted'
```

### Constructor and Class Type Helpers

```typescript
/**
 * A type that can be instantiated with `new`
 */
export type Constructor<T = object, Args extends any[] = any[]> = new (...args: Args) => T;

/**
 * Gets the instance type of a class
 */
export type InstanceOf<T extends Constructor> = InstanceType<T>;

// Usage for dependency injection
function createInstance<T>(Cls: Constructor<T>, ...args: any[]): T {
  return new Cls(...args);
}
```

### Strict Object Utilities

```typescript
/**
 * Removes properties with undefined values from a type
 * (useful for clean API responses)
 */
export type DefinedProperties<T> = {
  [K in keyof T as T[K] extends undefined ? never : K]: T[K];
};

/**
 * Makes readonly — prevents accidental mutation
 */
export type Immutable<T> = {
  readonly [K in keyof T]: T[K] extends object ? Immutable<T[K]> : T[K];
};

// Usage for config objects that should not be mutated
type ImmutableConfig = Immutable<AppConfig>;
```

### Barrel Export

```typescript
// src/types/index.ts (additions)
export type {
  DeepPartial,
  Nullable,
  Optional,
  Maybe,
  Awaited,
  AsyncReturnType,
  StringRecord,
  RequireFields,
  OptionalFields,
  Keys,
  Values,
  Entries,
  Constructor,
  DefinedProperties,
  Immutable,
} from './utils.types';
```

## Usage Guidelines

### When to Use

- ✅ `DeepPartial<T>` — test fixture factories with override pattern
- ✅ `Nullable<T>` / `Maybe<T>` — nullable fields in domain types
- ✅ `RequireFields<T, K>` — endpoint-specific input variants
- ✅ `Immutable<T>` — config objects, frozen state

### When Not to Use

- ❌ Utilities you'll only use once — just inline the type
- ❌ Complex conditional types for abstract purposes — keep it practical
- ❌ Reimplementing TypeScript built-ins (`Partial`, `Required`, `Pick`, `Omit`)

## Best Practices

1. **Prefer built-ins first**: TypeScript has `Partial`, `Required`, `Readonly`, `Pick`, `Omit`, `Record`, `Extract`, `Exclude`, `NonNullable` — use them before writing custom utilities
2. **Keep utilities small**: Each utility should have a clear, single purpose
3. **Add JSDoc comments**: Explain what the utility does and when to use it
4. **Use in practice**: Don't add a utility until you actually need it twice
5. **Test complex utilities**: Type-level tests catch regressions

```typescript
// Type-level test using 'satisfies' and assignment assertions
type TestDeepPartial = DeepPartial<{ a: { b: string } }>;
const _test: TestDeepPartial = { a: {} };  // compiles ✅
const _test2: TestDeepPartial = {};         // compiles ✅
const _test3: TestDeepPartial = { a: { b: 123 } };  // error ✅
```

## Anti-Patterns

### ❌ Overusing `any`

```typescript
// Bad: Loses all type information
function merge(a: any, b: any): any { ... }

// Good: Preserves type structure
function deepMerge<T>(target: T, source: DeepPartial<T>): T { ... }
```

### ❌ Duplicating Built-in Utilities

```typescript
// Bad: Unnecessary — TypeScript already has this
type MyPartial<T> = { [K in keyof T]?: T[K] };

// Good: Just use Partial<T>
type UserUpdate = Partial<User>;
```

### ❌ Over-Engineering Type Utilities

```typescript
// Bad: Too abstract, never actually used
type DeepReadonlyArray<T> = ReadonlyArray<DeepReadonly<T>>;
type DeepReadonlyObject<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
type DeepReadonly<T> = T extends (infer U)[] ? DeepReadonlyArray<U>
  : T extends object ? DeepReadonlyObject<T>
  : T;

// Good: Just use what you need
type ImmutableConfig = Readonly<AppConfig>;
```

## Related Patterns

- [Shared Types](core-sdk.types-shared.md) - Uses `Nullable`, `Maybe`, `DeepPartial`
- [Configuration Types](core-sdk.types-config.md) - Uses `DeepPartial` in test config helpers
- [Result Types](core-sdk.types-result.md) - Uses generic type parameters
- [Test Fixtures](core-sdk.testing-fixtures.md) - Uses `DeepPartial` in fixture overrides

---

**Status**: Active
**Recommendation**: Maintain a small `utils.types.ts` with practical utilities. Use TypeScript built-ins first. Add custom utilities only when you need the same type in multiple files.
