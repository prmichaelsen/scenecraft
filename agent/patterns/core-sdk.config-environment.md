# Pattern: Environment-Based Configuration

**Category**: Configuration Management
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The Environment-Based Configuration pattern defines how to map environment variables to application configuration. This pattern enables 12-factor app compliance by storing configuration in the environment, making applications portable across deployment targets.

## Problem Statement

Without a structured approach to environment configuration:
- Environment variable names are inconsistent and undocumented
- Type coercion from string environment variables is error-prone
- Required vs optional variables are unclear
- Default values are scattered throughout codebase
- Configuration cannot be validated at startup

## Solution

Create a structured mapping between environment variables and configuration schema with:
- Consistent naming conventions
- Automatic type coercion
- Required/optional validation
- Default value handling
- Documentation through schema

## Implementation

### Basic Environment Mapping

```typescript
import { z } from 'zod';

/**
 * Environment variable schema with automatic coercion
 */
const EnvSchema = z.object({
  // Node environment
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  
  // Server configuration
  PORT: z.string().transform(Number).pipe(z.number().int().min(1).max(65535)).default('3000'),
  HOST: z.string().default('0.0.0.0'),
  
  // Database configuration
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_SIZE: z.string().transform(Number).pipe(z.number().int().positive()).default('10'),
  
  // Feature flags
  ENABLE_CACHE: z.string().transform(val => val === 'true').default('false'),
  DEBUG_MODE: z.string().transform(val => val === 'true').default('false'),
  
  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate environment variables
 */
function parseEnv(env: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(env);
}

export { EnvSchema, Env, parseEnv };
```

### Environment Variable Naming Convention

```typescript
/**
 * Standard naming convention for environment variables
 * 
 * Format: {APP_PREFIX}_{CATEGORY}_{NAME}
 * 
 * Examples:
 * - MYAPP_DB_HOST          → database.host
 * - MYAPP_DB_PORT          → database.port
 * - MYAPP_CACHE_ENABLED    → cache.enabled
 * - MYAPP_LOG_LEVEL        → logging.level
 */

interface EnvNamingConvention {
  // Application prefix (prevents collisions)
  prefix: string;
  
  // Category grouping (DB, CACHE, LOG, etc.)
  categories: readonly string[];
  
  // Separator between parts
  separator: '_';
}

/**
 * Environment variable mapper with naming convention
 */
class EnvMapper {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix.toUpperCase();
  }

  /**
   * Get environment variable with prefix
   */
  get(name: string): string | undefined {
    return process.env[`${this.prefix}_${name}`];
  }

  /**
   * Get required environment variable
   */
  getRequired(name: string): string {
    const value = this.get(name);
    if (!value) {
      throw new Error(`Missing required environment variable: ${this.prefix}_${name}`);
    }
    return value;
  }

  /**
   * Get environment variable with default
   */
  getWithDefault(name: string, defaultValue: string): string {
    return this.get(name) ?? defaultValue;
  }

  /**
   * Get number environment variable
   */
  getNumber(name: string, defaultValue: number): number {
    const value = this.get(name);
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      throw new Error(`Environment variable ${this.prefix}_${name} is not a valid number: ${value}`);
    }
    return parsed;
  }

  /**
   * Get boolean environment variable
   */
  getBoolean(name: string, defaultValue: boolean): boolean {
    const value = this.get(name);
    if (!value) return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
  }

  /**
   * Get JSON environment variable
   */
  getJSON<T>(name: string, defaultValue: T): T {
    const value = this.get(name);
    if (!value) return defaultValue;
    try {
      return JSON.parse(value) as T;
    } catch {
      throw new Error(`Environment variable ${this.prefix}_${name} is not valid JSON: ${value}`);
    }
  }

  /**
   * Get array environment variable (comma-separated)
   */
  getArray(name: string, defaultValue: string[] = []): string[] {
    const value = this.get(name);
    if (!value) return defaultValue;
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
}

// Usage
const env = new EnvMapper('MYAPP');
const dbHost = env.getRequired('DB_HOST');
const dbPort = env.getNumber('DB_PORT', 5432);
const cacheEnabled = env.getBoolean('CACHE_ENABLED', false);
const corsOrigins = env.getArray('CORS_ORIGINS', ['localhost']);

export { EnvMapper };
```

### Environment to Config Mapping

```typescript
import { z } from 'zod';

/**
 * Maps environment variables to configuration structure
 */
function mapEnvToConfig(env: Record<string, string | undefined>) {
  return {
    env: env.NODE_ENV || 'development',
    
    server: {
      port: parseInt(env.PORT || '3000', 10),
      host: env.HOST || '0.0.0.0',
    },
    
    database: {
      url: env.DATABASE_URL!,
      poolSize: parseInt(env.DATABASE_POOL_SIZE || '10', 10),
      ssl: env.DATABASE_SSL === 'true',
    },
    
    cache: {
      enabled: env.CACHE_ENABLED === 'true',
      ttl: parseInt(env.CACHE_TTL || '3600', 10),
      host: env.CACHE_HOST || 'localhost',
      port: parseInt(env.CACHE_PORT || '6379', 10),
    },
    
    logging: {
      level: env.LOG_LEVEL || 'info',
      format: env.LOG_FORMAT || 'json',
    },
    
    features: {
      debug: env.DEBUG_MODE === 'true',
      metrics: env.METRICS_ENABLED === 'true',
      tracing: env.TRACING_ENABLED === 'true',
    },
  };
}

/**
 * Configuration schema for validation
 */
const ConfigSchema = z.object({
  env: z.enum(['development', 'staging', 'production']),
  server: z.object({
    port: z.number().int().min(1).max(65535),
    host: z.string(),
  }),
  database: z.object({
    url: z.string().url(),
    poolSize: z.number().int().positive(),
    ssl: z.boolean(),
  }),
  cache: z.object({
    enabled: z.boolean(),
    ttl: z.number().positive(),
    host: z.string(),
    port: z.number().int().positive(),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    format: z.enum(['json', 'text']),
  }),
  features: z.object({
    debug: z.boolean(),
    metrics: z.boolean(),
    tracing: z.boolean(),
  }),
});

type Config = z.infer<typeof ConfigSchema>;

/**
 * Load and validate configuration from environment
 */
function loadConfigFromEnv(env: Record<string, string | undefined> = process.env): Config {
  const rawConfig = mapEnvToConfig(env);
  return ConfigSchema.parse(rawConfig);
}

export { mapEnvToConfig, loadConfigFromEnv, ConfigSchema, Config };
```

### Environment Variable Documentation

```typescript
/**
 * Environment variable definition with metadata
 */
interface EnvVarDefinition {
  name: string;
  description: string;
  required: boolean;
  default?: string | number | boolean;
  type: 'string' | 'number' | 'boolean' | 'json' | 'array';
  sensitive?: boolean;
}

/**
 * Registry of environment variables with documentation
 */
const ENV_DEFINITIONS: EnvVarDefinition[] = [
  {
    name: 'NODE_ENV',
    description: 'Application environment',
    required: false,
    default: 'development',
    type: 'string',
  },
  {
    name: 'PORT',
    description: 'Server port number',
    required: false,
    default: 3000,
    type: 'number',
  },
  {
    name: 'DATABASE_URL',
    description: 'Database connection URL',
    required: true,
    type: 'string',
    sensitive: true,
  },
  {
    name: 'DATABASE_POOL_SIZE',
    description: 'Number of database connections',
    required: false,
    default: 10,
    type: 'number',
  },
  {
    name: 'CACHE_ENABLED',
    description: 'Enable caching',
    required: false,
    default: false,
    type: 'boolean',
  },
  {
    name: 'CORS_ORIGINS',
    description: 'Comma-separated list of allowed CORS origins',
    required: false,
    default: 'localhost',
    type: 'array',
  },
];

/**
 * Generate environment variable documentation
 */
function generateEnvDocs(): string {
  const lines: string[] = [
    '# Environment Variables',
    '',
    'This application uses the following environment variables:',
    '',
  ];

  for (const def of ENV_DEFINITIONS) {
    lines.push(`## ${def.name}`);
    lines.push(``);
    lines.push(`${def.description}`);
    lines.push(``);
    lines.push(`- **Type**: ${def.type}`);
    lines.push(`- **Required**: ${def.required ? 'Yes' : 'No'}`);
    if (def.default !== undefined) {
      lines.push(`- **Default**: \`${def.default}\``);
    }
    if (def.sensitive) {
      lines.push(`- **Sensitive**: Yes (do not log or expose)`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}

/**
 * Generate .env.example file
 */
function generateEnvExample(): string {
  return ENV_DEFINITIONS
    .map(def => {
      const comment = `# ${def.description}${def.required ? ' (required)' : ''}`;
      const value = def.default !== undefined ? `=${def.default}` : '=';
      return `${comment}\n${def.name}${value}`;
    })
    .join('\n\n');
}

export { EnvVarDefinition, ENV_DEFINITIONS, generateEnvDocs, generateEnvExample };
```

### Environment Validation at Startup

```typescript
import { z } from 'zod';

/**
 * Validates environment at application startup
 */
function validateEnvironment(env: Record<string, string | undefined> = process.env): void {
  const errors: string[] = [];

  // Check required variables
  const requiredVars = ENV_DEFINITIONS.filter(d => d.required);
  for (const def of requiredVars) {
    if (!env[def.name]) {
      errors.push(`Missing required environment variable: ${def.name}`);
    }
  }

  // Validate types
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    
    const def = ENV_DEFINITIONS.find(d => d.name === key);
    if (!def) continue;

    switch (def.type) {
      case 'number':
        if (isNaN(parseInt(value, 10))) {
          errors.push(`${key} must be a number, got: ${value}`);
        }
        break;
      case 'boolean':
        if (!['true', 'false', '1', '0'].includes(value.toLowerCase())) {
          errors.push(`${key} must be a boolean (true/false), got: ${value}`);
        }
        break;
      case 'json':
        try {
          JSON.parse(value);
        } catch {
          errors.push(`${key} must be valid JSON, got: ${value}`);
        }
        break;
    }
  }

  if (errors.length > 0) {
    console.error('Environment validation failed:');
    errors.forEach(err => console.error(`  - ${err}`));
    console.error('\nRun with --show-env-docs for documentation');
    process.exit(1);
  }
}

export { validateEnvironment };
```

## Usage Guidelines

### When to Use

- ✅ All applications deployed to multiple environments
- ✅ Containerized applications (Docker, Kubernetes)
- ✅ 12-factor app compliance
- ✅ CI/CD pipelines with environment-specific config

### When Not to Use

- ❌ Client-side applications (no process.env)
- ❌ Static site generation (build-time config instead)
- ❌ Browser extensions (use storage API)

## Best Practices

1. **Use Consistent Prefix**: Prevent collisions with other applications
2. **Document All Variables**: Maintain registry with descriptions
3. **Validate at Startup**: Fail fast on missing/invalid config
4. **Provide Defaults**: Reduce required configuration
5. **Use Type Coercion**: Handle string-to-type conversion consistently
6. **Never Log Secrets**: Mark sensitive variables and exclude from logs

```typescript
// Good: Structured environment loading
const config = loadConfigFromEnv();
console.log('Loaded config:', {
  ...config,
  database: { ...config.database, url: '[REDACTED]' },
});
```

## Anti-Patterns

### ❌ Direct process.env Access

```typescript
// Bad: Scattered direct access
const port = process.env.PORT || 3000;
const dbUrl = process.env.DATABASE_URL!;
```

### ❌ No Type Coercion

```typescript
// Bad: String comparison for numbers
if (process.env.PORT > '1024') { ... }
```

### ❌ Missing Validation

```typescript
// Bad: No validation, runtime errors possible
const config = {
  port: parseInt(process.env.PORT!), // May be NaN
};
```

### ❌ Logging Secrets

```typescript
// Bad: Exposing secrets in logs
console.log('Config:', config); // Includes passwords, API keys
```

## Related Patterns

- [Configuration Schema](core-sdk.config-schema.md) - Schema validation for configuration
- [Configuration Loading](core-sdk.config-loading.md) - Loading from multiple sources
- [Secret Management](core-sdk.config-secrets.md) - Secure handling of sensitive values

---

**Status**: Active
**Recommendation**: Use this pattern for all server-side applications that need environment-specific configuration.
