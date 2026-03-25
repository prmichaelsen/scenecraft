# Pattern: Service Error Handling

**Namespace**: core-sdk
**Category**: Service Layer
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The Service Error Handling pattern establishes consistent error handling across all services in a core library. It defines custom error classes, error codes, and standardized error responses that work across different deployment targets (MCP servers, REST APIs, CLI tools).

This pattern ensures errors are predictable, informative, and easy to handle for both developers and end users.

---

## Problem

Without standardized error handling, developers face:

1. **Inconsistent Error Formats**: Different services throw different error types
2. **Lost Context**: Errors lack important debugging information
3. **Poor User Experience**: Generic error messages aren't helpful
4. **Difficult Debugging**: Hard to trace errors across service boundaries
5. **Adapter Complexity**: Each adapter must handle errors differently
6. **No Error Codes**: Can't programmatically handle specific errors

---

## Solution

Create a hierarchy of custom error classes that:
- Extend native Error with additional context
- Include error codes for programmatic handling
- Provide user-friendly messages
- Support error chaining (cause tracking)
- Work consistently across all deployment targets

---

## Implementation

### Base Error Classes

```typescript
// src/core/errors/BaseError.ts

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

/**
 * Base error class for all application errors
 * 
 * Extends native Error with additional context and metadata.
 */
export abstract class BaseError extends Error {
  /**
   * Unique error code for programmatic handling
   */
  abstract readonly code: string;

  /**
   * HTTP status code (for REST APIs)
   */
  abstract readonly statusCode: number;

  /**
   * Error severity
   */
  readonly severity: ErrorSeverity;

  /**
   * Additional error context
   */
  readonly context?: Record<string, any>;

  /**
   * Original error that caused this error
   */
  readonly cause?: Error;

  /**
   * Timestamp when error occurred
   */
  readonly timestamp: Date;

  constructor(
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, any>;
      severity?: ErrorSeverity;
    }
  ) {
    super(message);
    
    this.name = this.constructor.name;
    this.severity = options?.severity ?? ErrorSeverity.MEDIUM;
    this.context = options?.context;
    this.cause = options?.cause;
    this.timestamp = new Date();

    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert error to JSON for logging/serialization
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      severity: this.severity,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
      cause: this.cause ? {
        name: this.cause.name,
        message: this.cause.message,
        stack: this.cause.stack,
      } : undefined,
    };
  }

  /**
   * Get user-friendly error message
   * 
   * Override this to provide custom user messages
   */
  getUserMessage(): string {
    return this.message;
  }
}

/**
 * Validation error - invalid input data
 */
export class ValidationError extends BaseError {
  readonly code = 'VALIDATION_ERROR';
  readonly statusCode = 400;

  constructor(
    message: string,
    public readonly field?: string,
    options?: {
      cause?: Error;
      context?: Record<string, any>;
    }
  ) {
    super(message, {
      ...options,
      severity: ErrorSeverity.LOW,
      context: {
        ...options?.context,
        field,
      },
    });
  }

  getUserMessage(): string {
    return this.field
      ? `Invalid value for ${this.field}: ${this.message}`
      : `Validation error: ${this.message}`;
  }
}

/**
 * Not found error - resource doesn't exist
 */
export class NotFoundError extends BaseError {
  readonly code = 'NOT_FOUND';
  readonly statusCode = 404;

  constructor(
    resourceType: string,
    identifier: string,
    options?: {
      cause?: Error;
      context?: Record<string, any>;
    }
  ) {
    super(`${resourceType} not found: ${identifier}`, {
      ...options,
      severity: ErrorSeverity.LOW,
      context: {
        ...options?.context,
        resourceType,
        identifier,
      },
    });
  }

  getUserMessage(): string {
    const { resourceType, identifier } = this.context!;
    return `${resourceType} '${identifier}' was not found`;
  }
}

/**
 * Already exists error - duplicate resource
 */
export class AlreadyExistsError extends BaseError {
  readonly code = 'ALREADY_EXISTS';
  readonly statusCode = 409;

  constructor(
    resourceType: string,
    identifier: string,
    options?: {
      cause?: Error;
      context?: Record<string, any>;
    }
  ) {
    super(`${resourceType} already exists: ${identifier}`, {
      ...options,
      severity: ErrorSeverity.LOW,
      context: {
        ...options?.context,
        resourceType,
        identifier,
      },
    });
  }

  getUserMessage(): string {
    const { resourceType, identifier } = this.context!;
    return `${resourceType} '${identifier}' already exists`;
  }
}

/**
 * Unauthorized error - authentication required
 */
export class UnauthorizedError extends BaseError {
  readonly code = 'UNAUTHORIZED';
  readonly statusCode = 401;

  constructor(
    message: string = 'Authentication required',
    options?: {
      cause?: Error;
      context?: Record<string, any>;
    }
  ) {
    super(message, {
      ...options,
      severity: ErrorSeverity.MEDIUM,
    });
  }

  getUserMessage(): string {
    return 'You must be logged in to perform this action';
  }
}

/**
 * Forbidden error - insufficient permissions
 */
export class ForbiddenError extends BaseError {
  readonly code = 'FORBIDDEN';
  readonly statusCode = 403;

  constructor(
    message: string = 'Insufficient permissions',
    options?: {
      cause?: Error;
      context?: Record<string, any>;
    }
  ) {
    super(message, {
      ...options,
      severity: ErrorSeverity.MEDIUM,
    });
  }

  getUserMessage(): string {
    return 'You do not have permission to perform this action';
  }
}

/**
 * Service error - internal service failure
 */
export class ServiceError extends BaseError {
  readonly code = 'SERVICE_ERROR';
  readonly statusCode = 500;

  constructor(
    serviceName: string,
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, any>;
    }
  ) {
    super(`${serviceName}: ${message}`, {
      ...options,
      severity: ErrorSeverity.HIGH,
      context: {
        ...options?.context,
        serviceName,
      },
    });
  }

  getUserMessage(): string {
    return 'An internal error occurred. Please try again later.';
  }
}

/**
 * External service error - third-party service failure
 */
export class ExternalServiceError extends BaseError {
  readonly code = 'EXTERNAL_SERVICE_ERROR';
  readonly statusCode = 502;

  constructor(
    serviceName: string,
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, any>;
    }
  ) {
    super(`External service ${serviceName} failed: ${message}`, {
      ...options,
      severity: ErrorSeverity.HIGH,
      context: {
        ...options?.context,
        serviceName,
      },
    });
  }

  getUserMessage(): string {
    return 'A required external service is currently unavailable. Please try again later.';
  }
}

/**
 * Timeout error - operation took too long
 */
export class TimeoutError extends BaseError {
  readonly code = 'TIMEOUT';
  readonly statusCode = 504;

  constructor(
    operation: string,
    timeoutMs: number,
    options?: {
      cause?: Error;
      context?: Record<string, any>;
    }
  ) {
    super(`Operation '${operation}' timed out after ${timeoutMs}ms`, {
      ...options,
      severity: ErrorSeverity.MEDIUM,
      context: {
        ...options?.context,
        operation,
        timeoutMs,
      },
    });
  }

  getUserMessage(): string {
    return 'The operation took too long to complete. Please try again.';
  }
}

/**
 * Rate limit error - too many requests
 */
export class RateLimitError extends BaseError {
  readonly code = 'RATE_LIMIT_EXCEEDED';
  readonly statusCode = 429;

  constructor(
    retryAfterSeconds?: number,
    options?: {
      cause?: Error;
      context?: Record<string, any>;
    }
  ) {
    super('Rate limit exceeded', {
      ...options,
      severity: ErrorSeverity.LOW,
      context: {
        ...options?.context,
        retryAfterSeconds,
      },
    });
  }

  getUserMessage(): string {
    const { retryAfterSeconds } = this.context || {};
    return retryAfterSeconds
      ? `Too many requests. Please try again in ${retryAfterSeconds} seconds.`
      : 'Too many requests. Please try again later.';
  }
}
```

### Error Handler Utility

```typescript
// src/core/errors/ErrorHandler.ts
import { BaseError } from './BaseError';

/**
 * Error handler for consistent error processing
 */
export class ErrorHandler {
  /**
   * Check if error is a known application error
   */
  static isAppError(error: unknown): error is BaseError {
    return error instanceof BaseError;
  }

  /**
   * Convert any error to BaseError
   */
  static normalize(error: unknown): BaseError {
    if (error instanceof BaseError) {
      return error;
    }

    if (error instanceof Error) {
      return new ServiceError('Unknown', error.message, {
        cause: error,
      });
    }

    return new ServiceError('Unknown', String(error));
  }

  /**
   * Log error with appropriate severity
   */
  static log(error: BaseError, logger: Logger): void {
    const logData = {
      ...error.toJSON(),
      userMessage: error.getUserMessage(),
    };

    switch (error.severity) {
      case ErrorSeverity.CRITICAL:
        logger.error('Critical error occurred', logData);
        break;
      case ErrorSeverity.HIGH:
        logger.error('Error occurred', logData);
        break;
      case ErrorSeverity.MEDIUM:
        logger.warn('Warning occurred', logData);
        break;
      case ErrorSeverity.LOW:
        logger.info('Info error occurred', logData);
        break;
    }
  }

  /**
   * Handle error in service context
   */
  static async handle(
    error: unknown,
    context: {
      logger: Logger;
      operation: string;
      rethrow?: boolean;
    }
  ): Promise<BaseError> {
    const normalized = this.normalize(error);
    
    // Add operation context
    normalized.context = {
      ...normalized.context,
      operation: context.operation,
    };

    // Log error
    this.log(normalized, context.logger);

    // Rethrow if requested
    if (context.rethrow !== false) {
      throw normalized;
    }

    return normalized;
  }
}
```

### Usage in Services

```typescript
// src/core/services/UserService.ts
import { BaseService } from './BaseService';
import {
  NotFoundError,
  AlreadyExistsError,
  ValidationError,
  ServiceError,
  ErrorHandler,
} from '../errors';

export class UserService extends BaseService {
  async getUser(id: string): Promise<User> {
    this.ensureInitialized();

    try {
      // Validate input
      if (!id || id.trim() === '') {
        throw new ValidationError('User ID is required', 'id');
      }

      // Query database
      const user = await this.db!.users.findById(id);
      
      if (!user) {
        throw new NotFoundError('User', id);
      }

      return user;
    } catch (error) {
      // Wrap unexpected errors
      if (!ErrorHandler.isAppError(error)) {
        throw new ServiceError('UserService', 'Failed to get user', {
          cause: error as Error,
          context: { userId: id },
        });
      }
      
      throw error;
    }
  }

  async createUser(data: CreateUserData): Promise<User> {
    this.ensureInitialized();

    try {
      // Validate input
      if (!data.email || !data.email.includes('@')) {
        throw new ValidationError('Invalid email format', 'email');
      }

      // Check if exists
      const existing = await this.db!.users.findByEmail(data.email);
      if (existing) {
        throw new AlreadyExistsError('User', data.email);
      }

      // Create user
      return await this.db!.users.create(data);
    } catch (error) {
      return await ErrorHandler.handle(error, {
        logger: this.logger,
        operation: 'createUser',
      });
    }
  }
}
```

---

## Benefits

### 1. Consistency
- All errors follow same structure
- Predictable error handling
- Standard error codes

### 2. Rich Context
- Error cause tracking
- Additional metadata
- Stack traces preserved

### 3. User-Friendly
- Separate technical and user messages
- Localization support
- Appropriate detail levels

### 4. Debugging
- Full error context
- Cause chains
- Timestamps

### 5. Adapter Support
- HTTP status codes for REST
- Error codes for programmatic handling
- JSON serialization

---

## Best Practices

### 1. Use Specific Error Classes
```typescript
// ✅ Specific error
throw new NotFoundError('User', userId);

// ❌ Generic error
throw new Error('User not found');
```

### 2. Include Context
```typescript
// ✅ With context
throw new ServiceError('PaymentService', 'Payment failed', {
  context: { orderId, amount, currency },
  cause: originalError,
});
```

### 3. Chain Errors
```typescript
// ✅ Preserve cause
try {
  await externalAPI.call();
} catch (error) {
  throw new ExternalServiceError('PaymentAPI', 'API call failed', {
    cause: error as Error,
  });
}
```

### 4. Validate Early
```typescript
// ✅ Validate at entry point
async createUser(data: CreateUserData): Promise<User> {
  if (!data.email) {
    throw new ValidationError('Email is required', 'email');
  }
  // ... rest of logic
}
```

---

## Anti-Patterns

### ❌ Don't Swallow Errors
```typescript
// ❌ Wrong
try {
  await service.doSomething();
} catch (error) {
  console.log('Error occurred'); // Lost!
}

// ✅ Correct
try {
  await service.doSomething();
} catch (error) {
  throw ErrorHandler.normalize(error);
}
```

### ❌ Don't Lose Error Context
```typescript
// ❌ Wrong
catch (error) {
  throw new Error('Failed'); // Lost original error
}

// ✅ Correct
catch (error) {
  throw new ServiceError('MyService', 'Failed', {
    cause: error as Error,
  });
}
```

### ❌ Don't Use Generic Errors
```typescript
// ❌ Wrong
throw new Error('Something went wrong');

// ✅ Correct
throw new ServiceError('MyService', 'Specific failure reason');
```

---

## Related Patterns

- **[Service Base Pattern](core-sdk.service-base.md)** - Services that throw these errors
- **[Logging Pattern](core-sdk.service-logging.md)** - Logging errors consistently
- **[Adapter Patterns](core-sdk.adapter-base.md)** - Converting errors for different targets

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Node.js 18+
**Related Design**: [Core SDK Architecture](../design/core-sdk.architecture.md)
