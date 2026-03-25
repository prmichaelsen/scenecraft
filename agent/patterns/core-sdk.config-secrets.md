# Pattern: Secret Management

**Category**: Configuration Management
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Secret Management pattern defines how to handle sensitive configuration values (passwords, API keys, tokens) securely. This pattern prevents secrets from being exposed in logs, error messages, source code, or configuration files while making them available to services that need them.

## Problem Statement

Without a structured approach to secret management:
- Secrets appear in log files and error messages
- Credentials are committed to source control
- Secret rotation requires code changes or restarts
- No distinction between sensitive and non-sensitive config
- Testing requires real credentials or complex mocking

## Solution

Separate secret handling from regular configuration with:
- Dedicated secret loading from secure sources (vault, env, files)
- Redaction of secret values in logs and error output
- Type-safe secret access without accidental exposure
- Support for secret rotation without restarts
- Test-friendly secret providers

## Implementation

### Secret Container Type

```typescript
/**
 * Secret wrapper that prevents accidental exposure in logs/errors
 */
class Secret<T extends string | number = string> {
  private readonly value: T;

  constructor(value: T) {
    this.value = value;
  }

  /**
   * Explicitly reveal the secret value
   * Must be called intentionally - prevents accidental toString exposure
   */
  reveal(): T {
    return this.value;
  }

  /**
   * Returns redacted string - safe for logging
   */
  toString(): string {
    return '[REDACTED]';
  }

  /**
   * Returns redacted JSON representation
   */
  toJSON(): string {
    return '[REDACTED]';
  }

  /**
   * Check if secret has a value
   */
  isEmpty(): boolean {
    return this.value === '' || this.value === null || this.value === undefined;
  }
}

// Usage
const apiKey = new Secret('sk-abc123...');
console.log(apiKey);          // [REDACTED]
console.log(apiKey.reveal()); // sk-abc123... (only when explicitly needed)

export { Secret };
```

### Secret Configuration Schema

```typescript
import { z } from 'zod';
import { Secret } from './secret';

/**
 * Transform raw string values into Secret instances
 */
const secretTransform = z.string().min(1).transform(val => new Secret(val));

/**
 * Schema for application secrets
 */
const SecretsSchema = z.object({
  // Database credentials
  databasePassword: secretTransform,
  databaseUrl: secretTransform,

  // API keys
  apiKey: secretTransform,
  apiSecret: secretTransform,

  // JWT secrets
  jwtSecret: secretTransform,

  // Optional secrets with defaults
  encryptionKey: z.string().optional().transform(val =>
    val ? new Secret(val) : null
  ),
});

type Secrets = z.infer<typeof SecretsSchema>;

export { SecretsSchema, Secrets };
```

### Environment-Based Secret Loading

```typescript
import { z } from 'zod';
import { Secret } from './secret';

/**
 * Load secrets from environment variables
 */
function loadSecretsFromEnv(
  env: Record<string, string | undefined> = process.env
): Secrets {
  const rawSecrets: Record<string, string | undefined> = {
    databasePassword: env.DATABASE_PASSWORD,
    databaseUrl: env.DATABASE_URL,
    apiKey: env.API_KEY,
    apiSecret: env.API_SECRET,
    jwtSecret: env.JWT_SECRET,
    encryptionKey: env.ENCRYPTION_KEY,
  };

  return SecretsSchema.parse(rawSecrets);
}

export { loadSecretsFromEnv };
```

### File-Based Secret Loading

```typescript
import { promises as fs } from 'fs';
import { join } from 'path';
import { Secret } from './secret';

interface FileSecretOptions {
  secretsDir: string;
  encoding?: BufferEncoding;
}

/**
 * Load secrets from files (Docker secrets / Kubernetes secrets pattern)
 * Each secret is a file named after the secret, containing the value
 *
 * Example directory structure:
 *   /run/secrets/
 *     database_password
 *     api_key
 *     jwt_secret
 */
class FileSecretLoader {
  private secretsDir: string;
  private encoding: BufferEncoding;

  constructor(options: FileSecretOptions) {
    this.secretsDir = options.secretsDir;
    this.encoding = options.encoding ?? 'utf-8';
  }

  /**
   * Load a single secret from file
   */
  async load(name: string): Promise<Secret> {
    const filePath = join(this.secretsDir, name);
    try {
      const value = await fs.readFile(filePath, this.encoding);
      return new Secret(value.trim());
    } catch (error) {
      throw new Error(`Failed to load secret '${name}' from file: ${filePath}`);
    }
  }

  /**
   * Load a secret or return null if not found
   */
  async loadOptional(name: string): Promise<Secret | null> {
    try {
      return await this.load(name);
    } catch {
      return null;
    }
  }

  /**
   * Load multiple secrets at once
   */
  async loadAll(names: string[]): Promise<Record<string, Secret>> {
    const entries = await Promise.all(
      names.map(async name => [name, await this.load(name)] as const)
    );
    return Object.fromEntries(entries);
  }
}

// Usage (Docker secrets pattern)
const secretLoader = new FileSecretLoader({ secretsDir: '/run/secrets' });
const dbPassword = await secretLoader.load('database_password');

export { FileSecretLoader, FileSecretOptions };
```

### Vault Integration Pattern

```typescript
import { Secret } from './secret';

interface VaultConfig {
  address: string;
  token: Secret;
  mountPath?: string;
  namespace?: string;
}

interface VaultSecretData {
  [key: string]: string;
}

/**
 * HashiCorp Vault secret provider (interface pattern)
 */
interface SecretProvider {
  getSecret(path: string): Promise<Secret>;
  getSecrets(path: string): Promise<Record<string, Secret>>;
  invalidateCache(path?: string): void;
}

/**
 * Vault-based secret provider with caching
 */
class VaultSecretProvider implements SecretProvider {
  private cache = new Map<string, { value: Secret; expiresAt: number }>();
  private cacheTtl: number;

  constructor(
    private config: VaultConfig,
    cacheTtlMs = 5 * 60 * 1000 // 5 minutes
  ) {
    this.cacheTtl = cacheTtlMs;
  }

  /**
   * Get a single secret value by path and key
   */
  async getSecret(path: string, key = 'value'): Promise<Secret> {
    const secrets = await this.getSecrets(path);
    const secret = secrets[key];
    if (!secret) {
      throw new Error(`Secret key '${key}' not found at path '${path}'`);
    }
    return secret;
  }

  /**
   * Get all secrets at a path
   */
  async getSecrets(path: string): Promise<Record<string, Secret>> {
    // Check cache
    const cached = this.cache.get(path);
    if (cached && Date.now() < cached.expiresAt) {
      return { value: cached.value };
    }

    // Fetch from Vault (implementation uses actual Vault API)
    const data = await this.fetchFromVault(path);

    // Wrap in Secret instances
    const secrets = Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, new Secret(value)])
    );

    // Cache the primary value
    if (data.value) {
      this.cache.set(path, {
        value: new Secret(data.value),
        expiresAt: Date.now() + this.cacheTtl,
      });
    }

    return secrets;
  }

  /**
   * Invalidate cache for a path (or all paths)
   */
  invalidateCache(path?: string): void {
    if (path) {
      this.cache.delete(path);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Fetch data from Vault API
   * In a real implementation, this calls the Vault HTTP API
   */
  private async fetchFromVault(path: string): Promise<VaultSecretData> {
    const url = `${this.config.address}/v1/${this.config.mountPath ?? 'secret'}/data/${path}`;
    const response = await fetch(url, {
      headers: {
        'X-Vault-Token': this.config.token.reveal(),
        ...(this.config.namespace && { 'X-Vault-Namespace': this.config.namespace }),
      },
    });

    if (!response.ok) {
      throw new Error(`Vault request failed: ${response.statusText}`);
    }

    const body = await response.json() as { data: { data: VaultSecretData } };
    return body.data.data;
  }
}

export { VaultSecretProvider, SecretProvider, VaultConfig };
```

### Secret-Aware Logging

```typescript
import { Secret } from './secret';

/**
 * Redact secrets from objects before logging
 */
function redactSecrets<T extends Record<string, unknown>>(
  obj: T,
  knownSecretKeys: string[] = []
): Record<string, unknown> {
  const defaultSecretKeys = [
    'password', 'secret', 'token', 'key', 'credential',
    'apiKey', 'api_key', 'privateKey', 'private_key',
  ];
  const secretKeys = new Set([...defaultSecretKeys, ...knownSecretKeys]);

  function redact(value: unknown, path: string): unknown {
    if (value instanceof Secret) {
      return '[REDACTED]';
    }
    if (typeof value === 'string' && secretKeys.has(path.split('.').pop() ?? '')) {
      return '[REDACTED]';
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          redact(v, path ? `${path}.${k}` : k),
        ])
      );
    }
    return value;
  }

  return redact(obj, '') as Record<string, unknown>;
}

// Usage
const config = {
  server: { port: 3000 },
  database: { host: 'localhost', password: new Secret('secret123') },
};

const safeConfig = redactSecrets(config);
console.log(JSON.stringify(safeConfig));
// { "server": { "port": 3000 }, "database": { "host": "localhost", "password": "[REDACTED]" } }

export { redactSecrets };
```

### Secret Rotation Support

```typescript
import { EventEmitter } from 'events';
import { Secret } from './secret';

interface SecretRotationEvents {
  'secret:rotated': (path: string) => void;
  'secret:rotation-failed': (path: string, error: Error) => void;
}

/**
 * Secret manager with rotation support
 */
class RotatableSecretManager extends EventEmitter {
  private secrets = new Map<string, Secret>();
  private provider: SecretProvider;

  constructor(provider: SecretProvider) {
    super();
    this.provider = provider;
  }

  /**
   * Load and cache a secret
   */
  async load(path: string): Promise<Secret> {
    const secret = await this.provider.getSecret(path);
    this.secrets.set(path, secret);
    return secret;
  }

  /**
   * Get cached secret
   */
  get(path: string): Secret {
    const secret = this.secrets.get(path);
    if (!secret) {
      throw new Error(`Secret not loaded: ${path}. Call load() first.`);
    }
    return secret;
  }

  /**
   * Rotate a secret - reload from provider
   */
  async rotate(path: string): Promise<void> {
    try {
      this.provider.invalidateCache(path);
      const newSecret = await this.provider.getSecret(path);
      this.secrets.set(path, newSecret);
      this.emit('secret:rotated', path);
    } catch (error) {
      this.emit('secret:rotation-failed', path, error as Error);
      throw error;
    }
  }

  /**
   * Schedule automatic rotation
   */
  scheduleRotation(path: string, intervalMs: number): () => void {
    const interval = setInterval(
      () => this.rotate(path).catch(err => {
        this.emit('secret:rotation-failed', path, err);
      }),
      intervalMs
    );
    return () => clearInterval(interval);
  }
}

export { RotatableSecretManager, SecretRotationEvents };
```

## Usage Guidelines

### When to Use

- ✅ All sensitive configuration values (passwords, API keys, tokens)
- ✅ Credentials for external services (databases, third-party APIs)
- ✅ Applications deployed to production environments
- ✅ Multi-tenant applications where secret isolation matters

### When Not to Use

- ❌ Non-sensitive configuration (ports, log levels, feature flags)
- ❌ Public configuration that is intentionally visible
- ❌ Development-only placeholder values

## Best Practices

1. **Never Log Secrets**: Use `Secret` wrapper to prevent accidental exposure
2. **Use Secret Wrappers**: Wrap secrets at the boundary where they're loaded
3. **Prefer Environment Variables**: For cloud deployments, env vars are simplest
4. **Use a Secret Manager**: For production, use Vault, AWS Secrets Manager, or similar
5. **Rotate Regularly**: Implement rotation without service restarts
6. **Validate at Startup**: Fail fast if required secrets are missing

```typescript
// Good: Explicit revelation only when needed
const dbConfig = {
  host: config.database.host,
  password: secrets.databasePassword.reveal(), // Intentional
};

// Good: Redact before logging
logger.info('Starting server', redactSecrets(config));
```

## Anti-Patterns

### ❌ Secrets in Source Code

```typescript
// Bad: Hardcoded secrets
const apiKey = 'sk-prod-abc123secret';
```

### ❌ Logging Secrets

```typescript
// Bad: Secrets appear in logs
console.log('Config:', JSON.stringify(config)); // Exposes passwords!
```

### ❌ Secrets in Config Files

```typescript
// Bad: Committed to source control
// config/production.json
// { "database": { "password": "prod_secret_123" } }
```

### ❌ Passing Secrets as Plain Strings

```typescript
// Bad: Secrets lose their protective wrapper
function connectDb(password: string) { ... }
connectDb(secrets.databasePassword.reveal()); // Better to pass Secret type

// Good: Accept Secret type
function connectDb(password: Secret) {
  const conn = createConnection({ password: password.reveal() });
}
connectDb(secrets.databasePassword);
```

## Related Patterns

- [Configuration Schema](core-sdk.config-schema.md) - Schema validation for configuration
- [Configuration Environment](core-sdk.config-environment.md) - Environment variable mapping
- [Configuration Loading](core-sdk.config-loading.md) - Loading from multiple sources

---

**Status**: Active
**Recommendation**: Use this pattern for all sensitive configuration values in production applications. Never store secrets in source code or non-secret configuration files.
