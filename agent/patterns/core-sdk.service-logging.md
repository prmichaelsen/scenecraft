# Pattern: Service Logging

**Namespace**: core-sdk
**Category**: Service Layer
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The Service Logging pattern establishes structured, consistent logging across all services in a core library. It provides a standardized logger interface that works across different deployment targets (MCP servers, REST APIs, CLI tools) and supports multiple logging backends.

This pattern ensures logs are informative, searchable, and useful for debugging and monitoring in production.

---

## Problem

Without standardized logging, developers face:

1. **Inconsistent Log Formats**: Different services log differently
2. **Lost Context**: Logs lack correlation IDs and metadata
3. **Poor Searchability**: Unstructured logs are hard to query
4. **No Log Levels**: Can't filter logs by severity
5. **Performance Issues**: Excessive logging in production
6. **Adapter Complexity**: Each deployment target logs differently

---

## Solution

Create a logging abstraction that:
- Provides structured logging with consistent format
- Supports multiple log levels (debug, info, warn, error)
- Includes contextual metadata (service name, request ID, etc.)
- Works across all deployment targets
- Supports different backends (console, file, cloud services)
- Enables performance-conscious logging

---

## Implementation

### Logger Interface

```typescript
// src/core/logging/ILogger.ts

/**
 * Log levels in order of severity
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

/**
 * Log entry structure
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  service?: string;
  requestId?: string;
  metadata?: Record<string, any>;
  error?: Error;
}

/**
 * Logger interface
 */
export interface ILogger {
  debug(message: string, metadata?: Record<string, any>): void;
  info(message: string, metadata?: Record<string, any>): void;
  warn(message: string, metadata?: Record<string, any>): void;
  error(message: string, error?: Error, metadata?: Record<string, any>): void;
  child(context: Record<string, any>): ILogger;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
}
```

### Console Logger

```typescript
// src/core/logging/ConsoleLogger.ts
export class ConsoleLogger implements ILogger {
  private level: LogLevel = LogLevel.INFO;
  private context: Record<string, any> = {};

  constructor(
    private serviceName?: string,
    private options: {
      level?: LogLevel;
      pretty?: boolean;
      colors?: boolean;
    } = {}
  ) {
    this.level = options.level ?? LogLevel.INFO;
  }

  debug(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, metadata);
  }

  info(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, metadata);
  }

  warn(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, metadata);
  }

  error(message: string, error?: Error, metadata?: Record<string, any>): void {
    this.log(LogLevel.ERROR, message, {
      ...metadata,
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : undefined,
    });
  }

  child(context: Record<string, any>): ILogger {
    const child = new ConsoleLogger(this.serviceName, this.options);
    child.level = this.level;
    child.context = { ...this.context, ...context };
    return child;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  private log(level: LogLevel, message: string, metadata?: Record<string, any>): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      service: this.serviceName,
      metadata: { ...this.context, ...metadata },
    };

    if (this.options.pretty) {
      this.logPretty(entry);
    } else {
      this.logJSON(entry);
    }
  }

  private logPretty(entry: LogEntry): void {
    const timestamp = entry.timestamp.toISOString();
    const level = entry.level.toUpperCase().padEnd(5);
    const service = entry.service ? `[${entry.service}]` : '';
    
    console.log(`${timestamp} ${level} ${service} ${entry.message}`);
    
    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      console.log(JSON.stringify(entry.metadata, null, 2));
    }
  }

  private logJSON(entry: LogEntry): void {
    console.log(JSON.stringify({
      timestamp: entry.timestamp.toISOString(),
      level: entry.level,
      service: entry.service,
      message: entry.message,
      ...entry.metadata,
    }));
  }

  private isLevelEnabled(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }
}
```

### Usage in Services

```typescript
// src/core/services/UserService.ts
import { LoggerFactory } from '../logging/LoggerFactory';

export class UserService extends BaseService {
  private logger: ILogger;

  constructor(config: ServiceConfig) {
    super(config);
    this.logger = LoggerFactory.getLogger('UserService');
  }

  protected async onInitialize(): Promise<void> {
    this.logger.info('Initializing UserService');
    
    try {
      this.db = await Database.connect(this.config.databaseUrl);
      this.logger.info('Database connected');
    } catch (error) {
      this.logger.error('Failed to connect', error as Error);
      throw error;
    }
  }

  async getUser(id: string): Promise<User> {
    const requestLogger = this.logger.child({ userId: id });
    requestLogger.debug('Fetching user');
    
    try {
      const user = await this.db!.users.findById(id);
      requestLogger.info('User fetched');
      return user;
    } catch (error) {
      requestLogger.error('Failed to fetch user', error as Error);
      throw error;
    }
  }
}
```

---

## Benefits

1. **Consistency** - All services log in same format
2. **Context** - Request correlation and metadata
3. **Flexibility** - Multiple backends and formats
4. **Performance** - Level-based filtering
5. **Debugging** - Structured data and error tracking

---

## Best Practices

### 1. Use Appropriate Log Levels
```typescript
logger.debug('Detailed debugging info');
logger.info('User logged in');
logger.warn('Rate limit approaching');
logger.error('Database connection failed', error);
```

### 2. Include Context
```typescript
logger.info('Order created', {
  orderId: order.id,
  userId: user.id,
  total: order.total,
});
```

### 3. Use Child Loggers
```typescript
const requestLogger = logger.child({
  requestId: req.id,
  userId: req.user.id,
});
```

### 4. Avoid Sensitive Data
```typescript
// ❌ Wrong - logs password
logger.info('User created', { email, password });

// ✅ Correct - no sensitive data
logger.info('User created', { email });
```

---

## Anti-Patterns

### ❌ Don't Log Sensitive Data
```typescript
// ❌ Wrong
logger.info('Login attempt', { password: user.password });

// ✅ Correct
logger.info('Login attempt', { email: user.email });
```

### ❌ Don't Use console.log Directly
```typescript
// ❌ Wrong
console.log('User created');

// ✅ Correct
logger.info('User created');
```

### ❌ Don't Log in Loops Without Sampling
```typescript
// ❌ Wrong - logs 10000 times
for (const item of items) {
  logger.debug('Processing item', { item });
}

// ✅ Correct - sample or aggregate
logger.debug('Processing items', { count: items.length });
```

---

## Related Patterns

- **[Service Base Pattern](core-sdk.service-base.md)** - Services that use logging
- **[Error Handling Pattern](core-sdk.service-error-handling.md)** - Logging errors
- **[Adapter Patterns](core-sdk.adapter-base.md)** - Logging in adapters

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Node.js 18+
**Related Design**: [Core SDK Architecture](../design/core-sdk.architecture.md)
