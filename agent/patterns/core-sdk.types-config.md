# Pattern: Configuration Types

**Category**: Type System
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Configuration Types pattern establishes how to derive TypeScript types from Zod schemas so that configuration is fully typed throughout the application. Types are inferred from schemas — not written separately — ensuring the schema and types are always in sync.

## Problem Statement

Without typed configuration:
- Configuration access uses string indexing: `config['database']['host']`
- Typos in config keys fail at runtime, not compile time
- IDE autocomplete doesn't work for nested config paths
- Changing a config shape requires a manual audit of all access sites

## Solution

Define Zod schemas as the single source of truth. Use `z.infer<typeof Schema>` to derive TypeScript types. Export both the schema (for validation) and the type (for usage). Never write the type manually.

## Implementation

### Schema → Type Derivation

```typescript
// src/config/schema.ts
import { z } from 'zod';

export const DatabaseConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  name: z.string(),
  user: z.string(),
  password: z.string(),
  ssl: z.boolean().default(false),
  poolMin: z.number().int().default(2),
  poolMax: z.number().int().default(10),
});

export const ServerConfigSchema = z.object({
  port: z.number().int().default(3000),
  host: z.string().default('0.0.0.0'),
  corsOrigins: z.array(z.string()).default([]),
  requestTimeout: z.number().int().default(30_000),
});

export const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['json', 'pretty']).default('json'),
});

export const AppConfigSchema = z.object({
  env: z.enum(['development', 'staging', 'production']).default('development'),
  database: DatabaseConfigSchema,
  server: ServerConfigSchema,
  logging: LoggingConfigSchema,
});

// Derive types — never write these manually
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
```

### Typed Config Access

```typescript
// src/services/database.service.ts
import { DatabaseConfig } from '../config/schema';

export class DatabaseService {
  constructor(private readonly config: DatabaseConfig) {}

  async connect(): Promise<void> {
    // Full autocomplete and type safety — no string indexing
    const pool = createPool({
      host: this.config.host,       // string ✅
      port: this.config.port,       // number ✅
      database: this.config.name,   // string ✅
      ssl: this.config.ssl,         // boolean ✅
    });
  }
}
```

### Partial Config for Testing

```typescript
// src/config/schema.ts — export a test config helper
export function createTestConfig(
  overrides: DeepPartial<AppConfig> = {}
): AppConfig {
  const defaults: AppConfig = AppConfigSchema.parse({
    env: 'development',
    database: {
      host: 'localhost',
      port: 5432,
      name: 'test_db',
      user: 'test',
      password: 'test',
    },
    server: {},
    logging: {},
  });
  return deepMerge(defaults, overrides);
}
```

### Config Sections as Separate Types

```typescript
// src/config/types.ts
import { AppConfig, DatabaseConfig, ServerConfig, LoggingConfig } from './schema';

// Re-export config types from the central types barrel
export type { AppConfig, DatabaseConfig, ServerConfig, LoggingConfig };

// Partial configs for layer-specific access
// Services only get the sections they need
export type ServiceConfig = Pick<AppConfig, 'database' | 'logging'>;
export type AdapterConfig = Pick<AppConfig, 'server' | 'logging'>;
```

```typescript
// src/services/user.service.ts — only receives database + logging config
import { ServiceConfig } from '../config/types';

export class UserService {
  constructor(private readonly config: ServiceConfig) {}
  // Cannot accidentally access server config — not in the type
}

// src/adapters/rest.adapter.ts — only receives server + logging config
import { AdapterConfig } from '../config/types';

export class RestAdapter {
  constructor(private readonly config: AdapterConfig) {}
}
```

### Validated Config Factory

```typescript
// src/config/loader.ts
import { parse } from 'js-yaml';
import { readFileSync } from 'fs';
import { AppConfigSchema, AppConfig } from './schema';

export function loadConfig(configPath: string): AppConfig {
  const raw = parse(readFileSync(configPath, 'utf-8'));
  const env = process.env;

  // Merge file config + env overrides, then validate
  const merged = {
    ...raw,
    database: {
      ...raw.database,
      host: env.DB_HOST ?? raw.database?.host,
      port: env.DB_PORT ? parseInt(env.DB_PORT) : raw.database?.port,
      password: env.DB_PASSWORD ?? raw.database?.password,
    },
    server: {
      ...raw.server,
      port: env.PORT ? parseInt(env.PORT) : raw.server?.port,
    },
    logging: {
      ...raw.logging,
      level: env.LOG_LEVEL ?? raw.logging?.level,
    },
  };

  // Parse validates and applies defaults
  return AppConfigSchema.parse(merged);
}
```

### Config Type Guards

```typescript
// src/config/guards.ts
import { AppConfig } from './schema';

export function isProductionConfig(config: AppConfig): boolean {
  return config.env === 'production';
}

export function isDevelopmentConfig(config: AppConfig): boolean {
  return config.env === 'development';
}

// Discriminated union for environment-specific handling
export type ProductionConfig = AppConfig & { env: 'production' };
export type DevelopmentConfig = AppConfig & { env: 'development' };

export function assertProductionConfig(
  config: AppConfig
): asserts config is ProductionConfig {
  if (config.env !== 'production') {
    throw new Error(`Expected production config, got: ${config.env}`);
  }
}
```

### Barrel Export

```typescript
// src/config/index.ts
export { AppConfigSchema, DatabaseConfigSchema, ServerConfigSchema, LoggingConfigSchema } from './schema';
export type { AppConfig, DatabaseConfig, ServerConfig, LoggingConfig, ServiceConfig, AdapterConfig } from './types';
export { loadConfig, createTestConfig } from './loader';
export { isProductionConfig, isDevelopmentConfig, assertProductionConfig } from './guards';
```

## Usage Guidelines

### When to Use

- ✅ All configuration that crosses file boundaries
- ✅ Config passed into services and adapters as constructor arguments
- ✅ Testing — `createTestConfig()` for default test fixtures
- ✅ Layer-scoped config slices: `ServiceConfig`, `AdapterConfig`

### When Not to Use

- ❌ One-off constants that never change (use `const` literals)
- ❌ Feature flags that change at runtime (use a dedicated feature flag system)

## Best Practices

1. **Never write types manually**: Always use `z.infer<typeof Schema>`
2. **One schema, one type**: Each config section has exactly one schema and one derived type
3. **Slice config by layer**: Services get `ServiceConfig`, adapters get `AdapterConfig`
4. **Validate at startup**: Parse and validate config before any services initialize
5. **Fail fast on bad config**: `AppConfigSchema.parse()` throws immediately with a clear error
6. **Export from barrel**: Config types imported from `'../config'`, not from schema file directly

```typescript
// Good: Type derived from schema — always in sync
export type AppConfig = z.infer<typeof AppConfigSchema>;

// Bad: Type written manually — will drift from schema
export interface AppConfig {
  env: string;
  database: { host: string; port: number; };
  // Will forget to update when schema changes
}
```

## Anti-Patterns

### ❌ Accessing Config with String Indexing

```typescript
// Bad: No type safety, no autocomplete
const host = config['database']['host'];
const port = (config as any).server.port;

// Good: Typed access with full IDE support
const host: string = config.database.host;
const port: number = config.server.port;
```

### ❌ Passing Full Config to Every Layer

```typescript
// Bad: Service receives entire AppConfig — too broad
class UserService {
  constructor(private config: AppConfig) {}
  // Can access server config it doesn't need
}

// Good: Service receives only what it needs
class UserService {
  constructor(private config: ServiceConfig) {}
}
```

### ❌ Validating Config Per-Access Instead of At Startup

```typescript
// Bad: Repeated validation at every access point
function getDbHost(): string {
  const host = process.env.DB_HOST;
  if (!host) throw new Error('DB_HOST not set');
  return host;
}

// Good: Validate once at startup
const config: AppConfig = loadConfig('./config/production.yaml');
// All subsequent accesses are guaranteed to be valid
```

## Related Patterns

- [Config Schema](core-sdk.config-schema.md) - Zod schema definitions
- [Config Loading](core-sdk.config-loading.md) - Layered loading and hot reload
- [Shared Types](core-sdk.types-shared.md) - Domain types using the same conventions
- [Generic Utility Types](core-sdk.types-generic.md) - `DeepPartial` used in test helpers

---

**Status**: Active
**Recommendation**: Always derive TypeScript types from Zod schemas with `z.infer`. Export typed slices of config per layer (`ServiceConfig`, `AdapterConfig`). Validate at startup with `AppConfigSchema.parse()`.
