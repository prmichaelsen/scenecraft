# Pattern: Configuration Loading

**Category**: Configuration Management
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The Configuration Loading pattern defines how to load configuration from multiple sources with a clear priority hierarchy. This pattern enables flexible configuration that can be overridden at different levels, from sensible defaults to runtime arguments.

## Problem Statement

Without a structured configuration loading approach:
- Configuration sources have unclear precedence
- Defaults are scattered and inconsistent
- Loading order affects final values unpredictably
- No single source of truth for configuration
- Difficult to debug configuration issues

## Solution

Implement a layered configuration loading system with:
- Clear priority hierarchy (defaults → file → env → CLI)
- Deep merging of configuration objects
- Validation after all sources are loaded
- Configuration source tracking for debugging

## Implementation

### Configuration Source Hierarchy

```typescript
/**
 * Configuration source priority (lowest to highest):
 * 1. Schema defaults - Built into the schema definition
 * 2. Default config file - config/default.yaml
 * 3. Environment config file - config/{NODE_ENV}.yaml
 * 4. Environment variables - Process environment
 * 5. Command-line arguments - Runtime overrides
 */

type ConfigSource = 'schema' | 'default' | 'environment' | 'env' | 'cli';

interface ConfigMetadata {
  source: ConfigSource;
  loadedAt: Date;
  filePath?: string;
}
```

### Configuration Loader Class

```typescript
import { z } from 'zod';
import { promises as fs } from 'fs';
import { parse } from 'js-yaml';
import { deepmerge } from 'deepmerge-ts';

interface ConfigLoaderOptions<T> {
  schema: z.ZodSchema<T>;
  configDir?: string;
  envPrefix?: string;
  configFilePattern?: string;
}

/**
 * Configuration loader with multiple sources
 */
class ConfigLoader<T extends object> {
  private schema: z.ZodSchema<T>;
  private configDir: string;
  private envPrefix: string;
  private configFilePattern: string;
  private metadata: Map<string, ConfigMetadata> = new Map();

  constructor(options: ConfigLoaderOptions<T>) {
    this.schema = options.schema;
    this.configDir = options.configDir ?? './config';
    this.envPrefix = options.envPrefix ?? 'APP';
    this.configFilePattern = options.configFilePattern ?? '{env}.yaml';
  }

  /**
   * Load configuration from all sources
   */
  async load(env = process.env): Promise<T> {
    const configs: Partial<T>[] = [];

    // 1. Load default config file
    const defaultConfig = await this.loadFile('default.yaml');
    if (defaultConfig) {
      configs.push(defaultConfig);
      this.metadata.set('default', { source: 'default', loadedAt: new Date(), filePath: 'default.yaml' });
    }

    // 2. Load environment-specific config file
    const nodeEnv = env.NODE_ENV || 'development';
    const envConfigFile = this.configFilePattern.replace('{env}', nodeEnv);
    const envConfig = await this.loadFile(envConfigFile);
    if (envConfig) {
      configs.push(envConfig);
      this.metadata.set('environment', { source: 'environment', loadedAt: new Date(), filePath: envConfigFile });
    }

    // 3. Load from environment variables
    const envConfig2 = this.loadFromEnv(env);
    if (Object.keys(envConfig2).length > 0) {
      configs.push(envConfig2);
      this.metadata.set('env', { source: 'env', loadedAt: new Date() });
    }

    // 4. Deep merge all configs
    const merged = deepmerge(...configs) as T;

    // 5. Validate against schema
    const validated = this.schema.parse(merged);

    return validated;
  }

  /**
   * Load configuration from YAML file
   */
  private async loadFile(filename: string): Promise<Partial<T> | null> {
    try {
      const filePath = `${this.configDir}/${filename}`;
      const content = await fs.readFile(filePath, 'utf-8');
      return parse(content) as Partial<T>;
    } catch {
      return null;
    }
  }

  /**
   * Load configuration from environment variables
   */
  private loadFromEnv(env: Record<string, string | undefined>): Partial<T> {
    const config: Record<string, unknown> = {};
    const prefix = `${this.envPrefix}_`;

    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith(prefix) || value === undefined) continue;

      // Convert APP_DB_HOST → database.host
      const configPath = key
        .slice(prefix.length)
        .toLowerCase()
        .split('_');

      // Set nested value
      this.setNestedValue(config, configPath, value);
    }

    return config as Partial<T>;
  }

  /**
   * Set nested value in object
   */
  private setNestedValue(obj: Record<string, unknown>, path: string[], value: string): void {
    let current = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    current[path[path.length - 1]] = this.coerceValue(value);
  }

  /**
   * Coerce string value to appropriate type
   */
  private coerceValue(value: string): unknown {
    // Boolean
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    
    // Number
    const num = Number(value);
    if (!isNaN(num)) return num;
    
    // JSON
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  /**
   * Get metadata about loaded configuration
   */
  getMetadata(): Map<string, ConfigMetadata> {
    return new Map(this.metadata);
  }
}

export { ConfigLoader, ConfigLoaderOptions, ConfigSource, ConfigMetadata };
```

### Synchronous Configuration Loading

```typescript
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { parse } from 'js-yaml';

/**
 * Synchronous configuration loader for startup
 */
class SyncConfigLoader<T extends object> {
  private schema: z.ZodSchema<T>;
  private configDir: string;

  constructor(schema: z.ZodSchema<T>, configDir = './config') {
    this.schema = schema;
    this.configDir = configDir;
  }

  /**
   * Load configuration synchronously
   */
  load(env = process.env): T {
    const configs: Partial<T>[] = [];

    // Load default config
    const defaultPath = `${this.configDir}/default.yaml`;
    if (existsSync(defaultPath)) {
      configs.push(parse(readFileSync(defaultPath, 'utf-8')) as Partial<T>);
    }

    // Load environment config
    const envPath = `${this.configDir}/${env.NODE_ENV || 'development'}.yaml`;
    if (existsSync(envPath)) {
      configs.push(parse(readFileSync(envPath, 'utf-8')) as Partial<T>);
    }

    // Load from environment
    configs.push(this.loadFromEnv(env));

    // Merge and validate
    const merged = this.deepMerge(configs);
    return this.schema.parse(merged);
  }

  /**
   * Deep merge multiple objects
   */
  private deepMerge(objects: Partial<T>[]): T {
    return objects.reduce((acc, obj) => this.mergeDeep(acc, obj), {} as T);
  }

  /**
   * Merge two objects deeply
   */
  private mergeDeep(target: any, source: any): any {
    const output = { ...target };
    for (const key of Object.keys(source)) {
      if (this.isObject(source[key]) && this.isObject(target[key])) {
        output[key] = this.mergeDeep(target[key], source[key]);
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }

  /**
   * Check if value is a plain object
   */
  private isObject(item: unknown): item is Record<string, unknown> {
    return item !== null && typeof item === 'object' && !Array.isArray(item);
  }

  /**
   * Load from environment variables
   */
  private loadFromEnv(env: Record<string, string | undefined>): Partial<T> {
    // Implementation similar to async version
    return {};
  }
}

export { SyncConfigLoader };
```

### Configuration with CLI Arguments

```typescript
import { z } from 'zod';
import { parseArgs } from 'util';

interface CliConfigOptions {
  args?: string[];
  options?: Record<string, {
    type: 'string' | 'boolean';
    short?: string;
    default?: string | boolean;
  }>;
}

/**
 * Configuration loader with CLI argument support
 */
class CliConfigLoader<T extends object> extends ConfigLoader<T> {
  private cliOptions: CliConfigOptions['options'];

  constructor(options: ConfigLoaderOptions<T> & CliConfigOptions) {
    super(options);
    this.cliOptions = options.options ?? {};
  }

  /**
   * Load configuration including CLI arguments
   */
  async load(env = process.env): Promise<T> {
    // Load base configuration
    const baseConfig = await super.load(env);

    // Parse CLI arguments
    const cliConfig = this.parseCliArgs();

    // Merge CLI overrides
    const merged = this.mergeDeep(baseConfig, cliConfig);

    // Validate final configuration
    return this.schema.parse(merged);
  }

  /**
   * Parse CLI arguments into config object
   */
  private parseCliArgs(): Partial<T> {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: this.cliOptions,
      strict: false,
    });

    // Map CLI args to config structure
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) {
        config[this.camelToSnake(key)] = value;
      }
    }

    return config as Partial<T>;
  }

  /**
   * Convert camelCase to snake_case
   */
  private camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  }

  /**
   * Deep merge helper
   */
  private mergeDeep(target: any, source: any): any {
    const output = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] !== undefined) {
        output[key] = source[key];
      }
    }
    return output;
  }
}

export { CliConfigLoader, CliConfigOptions };
```

### Configuration Hot Reloading

```typescript
import { watch } from 'fs';
import { EventEmitter } from 'events';

interface ConfigWatchEvents {
  'config:changed': (config: unknown) => void;
  'config:error': (error: Error) => void;
}

/**
 * Configuration loader with hot reload support
 */
class WatchableConfigLoader<T extends object> extends ConfigLoader<T> {
  private emitter = new EventEmitter();
  private watchers: Array<() => void> = [];

  /**
   * Load and watch configuration for changes
   */
  async loadAndWatch(env = process.env): Promise<T> {
    const config = await this.load(env);
    this.setupWatchers();
    return config;
  }

  /**
   * Setup file watchers
   */
  private setupWatchers(): void {
    const defaultPath = `${this.configDir}/default.yaml`;
    const envPath = `${this.configDir}/${process.env.NODE_ENV || 'development'}.yaml`;

    for (const filePath of [defaultPath, envPath]) {
      try {
        const watcher = watch(filePath, async (eventType) => {
          if (eventType === 'change') {
            try {
              const newConfig = await this.load();
              this.emitter.emit('config:changed', newConfig);
            } catch (error) {
              this.emitter.emit('config:error', error);
            }
          }
        });
        this.watchers.push(() => watcher.close());
      } catch {
        // File doesn't exist, skip watching
      }
    }
  }

  /**
   * Subscribe to configuration changes
   */
  on<K extends keyof ConfigWatchEvents>(event: K, listener: ConfigWatchEvents[K]): this {
    this.emitter.on(event, listener);
    return this;
  }

  /**
   * Stop watching for changes
   */
  stopWatching(): void {
    for (const close of this.watchers) {
      close();
    }
    this.watchers = [];
  }
}

export { WatchableConfigLoader };
```

### Configuration Loading at Application Startup

```typescript
import { z } from 'zod';

// Define schema
const AppConfigSchema = z.object({
  env: z.enum(['development', 'staging', 'production']),
  server: z.object({
    port: z.number().default(3000),
    host: z.string().default('0.0.0.0'),
  }),
  database: z.object({
    url: z.string(),
    poolSize: z.number().default(10),
  }),
});

type AppConfig = z.infer<typeof AppConfigSchema>;

// Global configuration instance
let config: AppConfig | null = null;

/**
 * Initialize configuration at startup
 */
async function initializeConfig(): Promise<AppConfig> {
  if (config) {
    return config;
  }

  const loader = new ConfigLoader({
    schema: AppConfigSchema,
    configDir: './config',
    envPrefix: 'APP',
  });

  config = await loader.load();
  return config;
}

/**
 * Get current configuration
 */
function getConfig(): AppConfig {
  if (!config) {
    throw new Error('Configuration not initialized. Call initializeConfig() first.');
  }
  return config;
}

/**
 * Reset configuration (for testing)
 */
function resetConfig(): void {
  config = null;
}

export { initializeConfig, getConfig, resetConfig, AppConfigSchema, AppConfig };
```

## Usage Guidelines

### When to Use

- ✅ Applications with multiple configuration sources
- ✅ Environment-specific configuration
- ✅ When configuration needs to be overridden at runtime
- ✅ Development with hot reloading

### When Not to Use

- ❌ Simple applications with static configuration
- ❌ Client-side applications (use different pattern)
- ❌ When configuration never changes

## Best Practices

1. **Load Once at Startup**: Initialize configuration once, share instance
2. **Validate After Merge**: Ensure final config is valid, not individual sources
3. **Use Deep Merge**: Preserve nested structure when merging
4. **Track Sources**: Know where each value came from for debugging
5. **Fail Fast**: Throw errors early if configuration is invalid
6. **Provide Defaults**: Every optional value should have a sensible default

```typescript
// Good: Load once at startup
async function main() {
  const config = await initializeConfig();
  const app = createApp(config);
  await app.start();
}
```

## Anti-Patterns

### ❌ Loading Configuration Multiple Times

```typescript
// Bad: Loading config on every request
app.get('/api/data', async (req, res) => {
  const config = await loadConfig(); // Expensive!
  // ...
});
```

### ❌ No Priority Hierarchy

```typescript
// Bad: Random merge order
const config = { ...envConfig, ...fileConfig, ...defaults };
```

### ❌ Shallow Merge

```typescript
// Bad: Shallow merge loses nested values
const config = Object.assign({}, defaults, envConfig);
```

### ❌ No Validation

```typescript
// Bad: No validation after merge
const config = merge(defaults, envConfig);
return config; // Could be invalid!
```

## Related Patterns

- [Configuration Schema](core-sdk.config-schema.md) - Schema validation
- [Configuration Environment](core-sdk.config-environment.md) - Environment mapping
- [Multi-Environment Configuration](core-sdk.config-multi-env.md) - Environment-specific files

---

**Status**: Active
**Recommendation**: Use this pattern for all applications that need flexible, layered configuration loading.
