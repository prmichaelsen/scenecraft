# Pattern: Multi-Environment Configuration

**Category**: Configuration Management
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Multi-Environment Configuration pattern defines how to manage distinct configurations across development, staging, and production environments. This pattern uses a layered inheritance model where a base configuration is progressively overridden by environment-specific values, ensuring consistency while enabling environment-specific customization.

## Problem Statement

Without a structured multi-environment approach:
- Configuration differences between environments are unclear and error-prone
- Developers accidentally use production credentials locally
- Staging doesn't accurately reflect production configuration
- Configuration drift causes "works in dev, broken in prod" bugs
- No clear inheritance model — copy-pasting configs leads to drift

## Solution

Implement a layered configuration hierarchy:
- **Base configuration**: Shared defaults across all environments
- **Environment overrides**: Only the differences for each environment
- **Secret injection**: Environment-specific secrets always from secure sources
- **Validation**: Same schema validates across all environments

## Implementation

### Environment Configuration Structure

```
config/
├── base.yaml              # Shared defaults for all environments
├── development.yaml       # Dev overrides (local dev settings)
├── staging.yaml           # Staging overrides (production-like)
├── production.yaml        # Production overrides (performance/scale)
└── test.yaml              # Test overrides (fast, isolated)
```

```typescript
type Environment = 'development' | 'staging' | 'production' | 'test';

/**
 * Determine current environment
 */
function getCurrentEnvironment(): Environment {
  const env = process.env.NODE_ENV;
  const valid: Environment[] = ['development', 'staging', 'production', 'test'];
  if (valid.includes(env as Environment)) {
    return env as Environment;
  }
  return 'development';
}

export { Environment, getCurrentEnvironment };
```

### Base and Environment Config Files

```yaml
# config/base.yaml — shared defaults for all environments
server:
  port: 3000
  host: 0.0.0.0
  keepAliveTimeout: 65000
  requestTimeout: 30000

logging:
  level: info
  format: json
  output: stdout

cache:
  enabled: true
  ttl: 3600
  maxSize: 1000

pagination:
  defaultLimit: 20
  maxLimit: 100
```

```yaml
# config/development.yaml — local dev overrides
logging:
  level: debug
  format: text  # Human-readable in dev

cache:
  enabled: false  # Disable caching for dev
  ttl: 60
```

```yaml
# config/staging.yaml — staging overrides
server:
  port: 8080

cache:
  ttl: 1800  # Shorter TTL for staging
```

```yaml
# config/production.yaml — production overrides
server:
  port: 8080
  keepAliveTimeout: 120000

logging:
  level: warn  # Less verbose in production

cache:
  maxSize: 10000  # Larger cache in production
```

```yaml
# config/test.yaml — test overrides
server:
  port: 0  # Random port for tests

logging:
  level: error  # Silent tests

cache:
  enabled: false
```

### Multi-Environment Config Loader

```typescript
import { z } from 'zod';
import { promises as fs } from 'fs';
import { join } from 'path';
import { parse } from 'js-yaml';
import { Environment, getCurrentEnvironment } from './environment';

interface MultiEnvLoaderOptions<T> {
  schema: z.ZodSchema<T>;
  configDir: string;
  baseFile?: string;
}

/**
 * Configuration loader with environment-specific inheritance
 */
class MultiEnvConfigLoader<T extends object> {
  private schema: z.ZodSchema<T>;
  private configDir: string;
  private baseFile: string;

  constructor(options: MultiEnvLoaderOptions<T>) {
    this.schema = options.schema;
    this.configDir = options.configDir;
    this.baseFile = options.baseFile ?? 'base.yaml';
  }

  /**
   * Load configuration for current environment
   */
  async load(env?: Environment): Promise<T> {
    const currentEnv = env ?? getCurrentEnvironment();
    return this.loadForEnv(currentEnv);
  }

  /**
   * Load configuration for a specific environment
   */
  async loadForEnv(env: Environment): Promise<T> {
    // 1. Load base configuration
    const base = await this.loadFile(this.baseFile);

    // 2. Load environment-specific overrides
    const overrides = await this.loadFile(`${env}.yaml`);

    // 3. Deep merge: base → environment overrides → env vars
    const merged = this.deepMerge(base, overrides);

    // 4. Apply environment variable overrides
    const withEnv = this.applyEnvOverrides(merged, env);

    // 5. Validate final configuration
    return this.schema.parse(withEnv);
  }

  /**
   * Load configuration for all environments (useful for validation)
   */
  async loadAll(): Promise<Record<Environment, T>> {
    const environments: Environment[] = ['development', 'staging', 'production', 'test'];
    const configs = await Promise.all(
      environments.map(env => this.loadForEnv(env))
    );
    return Object.fromEntries(
      environments.map((env, i) => [env, configs[i]])
    ) as Record<Environment, T>;
  }

  /**
   * Load YAML file, return empty object if not found
   */
  private async loadFile(filename: string): Promise<Partial<T>> {
    try {
      const filePath = join(this.configDir, filename);
      const content = await fs.readFile(filePath, 'utf-8');
      return parse(content) as Partial<T>;
    } catch {
      return {} as Partial<T>;
    }
  }

  /**
   * Apply environment variable overrides
   * (Environment variables always take highest precedence)
   */
  private applyEnvOverrides(config: Partial<T>, _env: Environment): Partial<T> {
    // Delegate to environment-based config loader
    // This integrates with core-sdk.config-environment pattern
    return config;
  }

  /**
   * Deep merge two objects
   */
  private deepMerge(target: Partial<T>, source: Partial<T>): Partial<T> {
    const output = { ...target };
    for (const key of Object.keys(source) as Array<keyof T>) {
      const sourceVal = source[key];
      const targetVal = target[key];
      if (this.isObject(sourceVal) && this.isObject(targetVal)) {
        output[key] = this.deepMerge(targetVal as any, sourceVal as any) as T[typeof key];
      } else if (sourceVal !== undefined) {
        output[key] = sourceVal;
      }
    }
    return output;
  }

  private isObject(item: unknown): item is Record<string, unknown> {
    return item !== null && typeof item === 'object' && !Array.isArray(item);
  }
}

export { MultiEnvConfigLoader, MultiEnvLoaderOptions };
```

### Environment-Specific Feature Flags

```typescript
import { z } from 'zod';
import { Environment } from './environment';

/**
 * Feature flag configuration with environment-specific overrides
 */
const FeatureFlagsSchema = z.object({
  enableBetaFeatures: z.boolean().default(false),
  enableExperimentalApi: z.boolean().default(false),
  enableMetrics: z.boolean().default(true),
  enableDetailedLogging: z.boolean().default(false),
  enableRateLimiting: z.boolean().default(true),
  maintenanceMode: z.boolean().default(false),
});

type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

/**
 * Environment-specific feature flag defaults
 */
const ENVIRONMENT_FLAGS: Record<Environment, Partial<FeatureFlags>> = {
  development: {
    enableBetaFeatures: true,          // Test new features in dev
    enableExperimentalApi: true,
    enableDetailedLogging: true,
    enableRateLimiting: false,         // No rate limiting locally
  },
  staging: {
    enableBetaFeatures: true,          // Validate new features
    enableMetrics: true,
    enableDetailedLogging: true,
    enableRateLimiting: true,
  },
  production: {
    enableBetaFeatures: false,         // Only stable features
    enableExperimentalApi: false,
    enableDetailedLogging: false,      // Performance sensitive
    enableRateLimiting: true,
  },
  test: {
    enableBetaFeatures: false,
    enableMetrics: false,              // No metrics in tests
    enableDetailedLogging: false,
    enableRateLimiting: false,
  },
};

/**
 * Get feature flags for current environment
 */
function getFeatureFlags(env?: Environment): FeatureFlags {
  const currentEnv = env ?? (process.env.NODE_ENV as Environment) ?? 'development';
  const envFlags = ENVIRONMENT_FLAGS[currentEnv] ?? {};
  return FeatureFlagsSchema.parse(envFlags);
}

export { FeatureFlagsSchema, FeatureFlags, ENVIRONMENT_FLAGS, getFeatureFlags };
```

### Environment Validation

```typescript
import { z } from 'zod';
import { Environment } from './environment';

/**
 * Validate that configuration is safe for an environment
 */
const ProductionConstraints = z.object({
  // Ensure production doesn't use development-only settings
  logging: z.object({
    level: z.enum(['info', 'warn', 'error']), // No debug in production
  }),
  database: z.object({
    ssl: z.literal(true),                      // SSL required in production
    poolSize: z.number().min(5),               // Adequate pool size
  }),
  server: z.object({
    host: z.string().refine(h => h !== 'localhost', {
      message: 'Production should not bind to localhost',
    }),
  }),
});

/**
 * Validate environment-specific configuration constraints
 */
function validateForEnvironment<T extends object>(
  config: T,
  env: Environment
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (env === 'production') {
    const result = ProductionConstraints.safeParse(config);
    if (!result.success) {
      errors.push(...result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`));
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export { validateForEnvironment, ProductionConstraints };
```

### Configuration Comparison Tool

```typescript
import { Environment } from './environment';

/**
 * Compare configurations between environments to spot differences
 */
function compareConfigs<T extends object>(
  configs: Partial<Record<Environment, T>>
): Record<string, Record<Environment, unknown>> {
  const allKeys = new Set<string>();
  const flatConfigs: Record<Environment, Record<string, unknown>> = {} as any;

  // Flatten all configs
  for (const [env, config] of Object.entries(configs) as [Environment, T][]) {
    flatConfigs[env] = flattenObject(config);
    Object.keys(flatConfigs[env]).forEach(key => allKeys.add(key));
  }

  // Find differences
  const differences: Record<string, Record<Environment, unknown>> = {};
  for (const key of allKeys) {
    const values: Record<Environment, unknown> = {} as any;
    let isDifferent = false;
    const firstValue = Object.values(flatConfigs)[0]?.[key];

    for (const [env, flat] of Object.entries(flatConfigs) as [Environment, Record<string, unknown>][]) {
      values[env] = flat[key];
      if (flat[key] !== firstValue) {
        isDifferent = true;
      }
    }

    if (isDifferent) {
      differences[key] = values;
    }
  }

  return differences;
}

/**
 * Flatten nested object to dot-notation keys
 */
function flattenObject(obj: object, prefix = ''): Record<string, unknown> {
  return Object.entries(obj).reduce((acc, [key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(acc, flattenObject(value, fullKey));
    } else {
      acc[fullKey] = value;
    }
    return acc;
  }, {} as Record<string, unknown>);
}

// Usage
const configs = await loader.loadAll();
const differences = compareConfigs(configs);
console.log('Configuration differences across environments:', differences);

export { compareConfigs, flattenObject };
```

## Usage Guidelines

### When to Use

- ✅ Applications deployed to multiple environments (dev/staging/prod)
- ✅ When environments have meaningfully different configuration needs
- ✅ Teams that need to validate staging mirrors production
- ✅ Applications with environment-specific feature flags

### When Not to Use

- ❌ Applications with a single deployment environment
- ❌ When all configuration differences come from env vars only
- ❌ Simple scripts or one-off tools

## Best Practices

1. **Minimize Differences**: Keep production and staging as similar as possible
2. **Never Include Secrets**: Config files contain structure, not credentials
3. **Use Inheritance**: Override only what differs from base
4. **Validate All Environments**: Run schema validation against every environment config
5. **Document Differences**: Comment why environments differ
6. **Version Control Config Files**: All non-secret config should be in git

```typescript
// Good: Staging mirrors production except for scale
const stagingConfig = {
  server: { port: 8080 },
  // Same logging, same features, same behavior
  // Only differences: smaller pool sizes, test data
  database: { poolSize: 2 }, // vs production: 20
};
```

## Anti-Patterns

### ❌ Environment Detection in Business Logic

```typescript
// Bad: Environment-specific code in business logic
async function createUser(data: UserData) {
  if (process.env.NODE_ENV === 'development') {
    return mockUser; // Hidden dev-only path
  }
  return await db.create(data);
}

// Good: Use configuration flags instead
async function createUser(data: UserData, config: AppConfig) {
  if (config.features.useMockData) {
    return mockUser;
  }
  return await db.create(data);
}
```

### ❌ Production Config in Development

```typescript
// Bad: Dev config pointing to prod resources
const devConfig = {
  database: { url: 'postgres://prod-db.example.com/prod' },
};

// Good: Always use local/dedicated dev resources
const devConfig = {
  database: { url: 'postgres://localhost:5432/myapp_dev' },
};
```

### ❌ Missing Environment Validation

```typescript
// Bad: Load config without validating environment-specific constraints
const config = await loader.load();
startServer(config); // Might start with invalid production config

// Good: Validate constraints for current environment
const config = await loader.load();
const validation = validateForEnvironment(config, getCurrentEnvironment());
if (!validation.valid) {
  throw new Error(`Invalid config for ${env}: ${validation.errors.join(', ')}`);
}
startServer(config);
```

### ❌ Copying Instead of Inheriting

```yaml
# Bad: Complete copy with minor changes
# production.json has 50 keys, only 3 differ from staging

# Good: Only override what differs
# staging.json: 3 keys
# production.json: 3 keys
# base.json: 50 keys (single source of truth)
```

## Related Patterns

- [Configuration Schema](core-sdk.config-schema.md) - Schema validation
- [Configuration Loading](core-sdk.config-loading.md) - Layered loading with file support
- [Configuration Environment](core-sdk.config-environment.md) - Environment variable mapping
- [Secret Management](core-sdk.config-secrets.md) - Environment-specific secrets

---

**Status**: Active
**Recommendation**: Use this pattern for any application deployed across multiple environments. Always keep production and staging as similar as possible to catch environment-specific bugs early.
