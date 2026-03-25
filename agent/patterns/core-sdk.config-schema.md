# Pattern: Configuration Schema

**Category**: Configuration Management
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The Configuration Schema pattern establishes type-safe configuration definitions with runtime validation. This pattern ensures that all configuration values are validated against a schema before use, preventing runtime errors from misconfigured values.

## Problem Statement

Without a defined configuration schema:
- Configuration errors are discovered only at runtime
- No type safety when accessing configuration values
- Validation logic is scattered throughout the codebase
- Configuration documentation becomes stale
- Refactoring configuration is error-prone

## Solution

Define configuration schemas using a validation library (like Zod) that provides:
- Runtime type validation
- TypeScript type inference
- Detailed error messages
- Default values
- Schema composition

## Implementation

### Basic Configuration Schema

```typescript
import { z } from 'zod';

// Define configuration schema with validation
const DatabaseConfigSchema = z.object({
  host: z.string().min(1, "Database host is required"),
  port: z.number().int().positive().default(5432),
  database: z.string().min(1, "Database name is required"),
  username: z.string().min(1, "Database username is required"),
  password: z.string().min(1, "Database password is required"),
  ssl: z.boolean().default(false),
  poolSize: z.number().int().positive().default(10),
  connectionTimeout: z.number().positive().default(30000),
});

// Infer TypeScript type from schema
type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

// Export schema for composition
export { DatabaseConfigSchema, DatabaseConfig };
```

### Nested Configuration Schema

```typescript
import { z } from 'zod';

// Sub-schemas for modular configuration
const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['json', 'text']).default('json'),
  output: z.enum(['stdout', 'file', 'both']).default('stdout'),
  filePath: z.string().optional(),
  maxFileSize: z.number().positive().default(10485760), // 10MB
  maxFiles: z.number().int().positive().default(5),
});

const CacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ttl: z.number().positive().default(3600), // 1 hour
  maxSize: z.number().positive().default(1000),
  strategy: z.enum(['lru', 'lfu', 'fifo']).default('lru'),
});

// Compose schemas into application configuration
const AppConfigSchema = z.object({
  env: z.enum(['development', 'staging', 'production']).default('development'),
  port: z.number().int().positive().default(3000),
  database: DatabaseConfigSchema,
  logging: LoggingConfigSchema.default(() => LoggingConfigSchema.parse({})),
  cache: CacheConfigSchema.default(() => CacheConfigSchema.parse({})),
});

type AppConfig = z.infer<typeof AppConfigSchema>;

export { AppConfigSchema, AppConfig, LoggingConfigSchema, CacheConfigSchema };
```

### Schema with Custom Validation

```typescript
import { z } from 'zod';

const ServerConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  // Custom validation for URL
  apiUrl: z.string().url("API URL must be a valid URL"),
  // Custom refinement for cross-field validation
  ssl: z.object({
    enabled: z.boolean(),
    certPath: z.string().optional(),
    keyPath: z.string().optional(),
  }).refine(
    (data) => !data.enabled || (data.certPath && data.keyPath),
    { message: "SSL certificate and key paths required when SSL is enabled" }
  ),
  // Transform string to array
  corsOrigins: z.string().transform(val => val.split(',').map(s => s.trim())),
  // Preprocess for environment variable coercion
  retryAttempts: z.preprocess(
    (val) => typeof val === 'string' ? parseInt(val, 10) : val,
    z.number().int().min(0).max(10).default(3)
  ),
});

type ServerConfig = z.infer<typeof ServerConfigSchema>;

export { ServerConfigSchema, ServerConfig };
```

### Schema Validation Function

```typescript
import { z } from 'zod';
import { Result } from '../types/result';

/**
 * Validates configuration against schema
 */
function validateConfig<T extends z.ZodSchema>(
  schema: T,
  data: unknown
): Result<z.infer<T>, ConfigValidationError> {
  try {
    const config = schema.parse(data);
    return { success: true, data: config };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const validationError: ConfigValidationError = {
        message: 'Configuration validation failed',
        errors: error.errors.map(err => ({
          path: err.path.join('.'),
          message: err.message,
          code: err.code,
        })),
      };
      return { success: false, error: validationError };
    }
    throw error;
  }
}

interface ConfigValidationError {
  message: string;
  errors: Array<{
    path: string;
    message: string;
    code: string;
  }>;
}

export { validateConfig, ConfigValidationError };
```

### Schema Builder Pattern

```typescript
import { z } from 'zod';

/**
 * Builder for creating configuration schemas with common patterns
 */
class ConfigSchemaBuilder<T extends z.ZodRawShape> {
  private shape: T;

  constructor(shape: T) {
    this.shape = shape;
  }

  static create(): ConfigSchemaBuilder<{}> {
    return new ConfigSchemaBuilder({});
  }

  with<K extends string, V extends z.ZodTypeAny>(
    key: K,
    schema: V
  ): ConfigSchemaBuilder<T & Record<K, V>> {
    return new ConfigSchemaBuilder({
      ...this.shape,
      [key]: schema,
    } as T & Record<K, V>);
  }

  withString<K extends string>(key: K, options?: { required?: boolean; default?: string }) {
    const schema = options?.required !== false 
      ? z.string().min(1) 
      : z.string().optional();
    return this.with(key, options?.default ? schema.default(options.default) : schema);
  }

  withNumber<K extends string>(key: K, options?: { min?: number; max?: number; default?: number }) {
    let schema = z.number();
    if (options?.min !== undefined) schema = schema.min(options.min);
    if (options?.max !== undefined) schema = schema.max(options.max);
    return this.with(key, options?.default !== undefined ? schema.default(options.default) : schema);
  }

  withBoolean<K extends string>(key: K, defaultValue = false) {
    return this.with(key, z.boolean().default(defaultValue));
  }

  build(): z.ZodObject<T> {
    return z.object(this.shape);
  }
}

// Usage
const MyConfigSchema = ConfigSchemaBuilder
  .create()
  .withString('appName', { required: true })
  .withNumber('port', { min: 1, max: 65535, default: 3000 })
  .withBoolean('debug', false)
  .with('features', z.array(z.string()).default([]))
  .build();

export { ConfigSchemaBuilder };
```

## Usage Guidelines

### When to Use

- ✅ All application configuration should have a schema
- ✅ When configuration comes from external sources (files, env, API)
- ✅ When multiple services share configuration structure
- ✅ When configuration needs validation beyond type checking

### When Not to Use

- ❌ For simple hardcoded values
- ❌ For configuration that changes frequently at runtime
- ❌ When the overhead of schema definition outweighs benefits

## Best Practices

1. **Use Descriptive Error Messages**: Provide clear validation messages
2. **Set Sensible Defaults**: Reduce required configuration with good defaults
3. **Compose Schemas**: Build complex schemas from smaller, reusable ones
4. **Document with Comments**: Add JSDoc comments for generated documentation
5. **Use Enums for Fixed Values**: Constrain options with enum types
6. **Validate Early**: Validate at application startup, not on first use

```typescript
// Good: Descriptive validation
const config = z.object({
  // Database connection timeout in milliseconds (default: 30 seconds)
  connectionTimeout: z.number()
    .positive()
    .default(30000)
    .describe("Database connection timeout in milliseconds"),
});
```

## Anti-Patterns

### ❌ No Validation

```typescript
// Bad: No validation, any type
const config: any = JSON.parse(configFile);
```

### ❌ Manual Validation

```typescript
// Bad: Scattered manual validation
if (!config.port || config.port < 0 || config.port > 65535) {
  throw new Error('Invalid port');
}
if (!config.host || typeof config.host !== 'string') {
  throw new Error('Invalid host');
}
// ... more manual checks
```

### ❌ Overly Permissive Schema

```typescript
// Bad: Too permissive
const config = z.object({
  settings: z.record(z.any()), // Loses type safety
});
```

### ❌ Schema Duplication

```typescript
// Bad: Duplicating schema definitions
const dbConfig1 = z.object({ host: z.string(), port: z.number() });
const dbConfig2 = z.object({ host: z.string(), port: z.number() });

// Good: Reuse schema
const DatabaseConfigSchema = z.object({ host: z.string(), port: z.number() });
```

## Related Patterns

- [Configuration Environment](core-sdk.config-environment.md) - Environment variable mapping
- [Configuration Loading](core-sdk.config-loading.md) - Loading configuration from sources
- [Type-Safe Configuration](core-sdk.types-config.md) - Type definitions for configuration

---

**Status**: Active
**Recommendation**: Use this pattern for all configuration that requires validation and type safety.
