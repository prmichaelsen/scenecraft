# Pattern: REST Adapter

**Namespace**: core-sdk
**Category**: Adapter Layer
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The REST Adapter pattern provides a standardized way to expose core business logic through HTTP REST APIs. It adapts service methods to HTTP endpoints, handles request/response transformation, and manages the HTTP server lifecycle.

This pattern works with popular frameworks like Express or Fastify while keeping core logic framework-agnostic.

---

## Problem

Without a REST adapter pattern:

1. **Framework Lock-in**: Core logic tightly coupled to HTTP framework
2. **Inconsistent APIs**: Different endpoints use different patterns
3. **Manual Routing**: Must manually map routes to service methods
4. **Error Handling Duplication**: HTTP error formatting repeated everywhere

---

## Solution

Create a `RESTAdapter` class that:
- Extends BaseAdapter for consistent lifecycle
- Registers HTTP routes from service methods
- Transforms HTTP requests to service calls
- Formats responses with proper HTTP status codes
- Handles errors with appropriate HTTP responses

---

## Implementation

```typescript
// src/adapters/rest/RESTAdapter.ts
import express, { Express, Request, Response, NextFunction } from 'express';
import { BaseAdapter, AdapterConfig } from '../BaseAdapter';
import { ServiceContainer } from '../../core/container/ServiceContainer';
import { ILogger } from '../../core/logging/ILogger';
import { BaseError } from '../../core/errors/BaseError';

interface RESTAdapterConfig extends AdapterConfig {
  port: number;
  host?: string;
  cors?: boolean;
  routes: RouteDefinition[];
}

interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: (req: Request) => Promise<any>;
  middleware?: Array<(req: Request, res: Response, next: NextFunction) => void>;
}

export class RESTAdapter extends BaseAdapter {
  private app!: Express;
  private server: any;
  private routes: RouteDefinition[] = [];

  constructor(
    config: RESTAdapterConfig,
    container: ServiceContainer,
    logger: ILogger
  ) {
    super(config, container, logger);
  }

  protected async onInitialize(): Promise<void> {
    const config = this.config as RESTAdapterConfig;

    this.logger.info('Initializing REST server');

    // Create Express app
    this.app = express();

    // Setup middleware
    this.app.use(express.json());
    
    if (config.cors) {
      this.app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        next();
      });
    }

    // Register routes
    for (const route of config.routes) {
      this.registerRoute(route);
    }

    // Error handler
    this.app.use(this.errorHandler.bind(this));

    this.logger.info('REST server initialized', {
      routeCount: this.routes.length,
    });
  }

  protected async onStart(): Promise<void> {
    const config = this.config as RESTAdapterConfig;

    this.logger.info('Starting REST server', {
      host: config.host || '0.0.0.0',
      port: config.port,
    });

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(config.port, config.host, () => {
        this.logger.info('REST server started');
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  protected async onStop(): Promise<void> {
    if (!this.server) {
      return;
    }

    this.logger.info('Stopping REST server');

    return new Promise((resolve, reject) => {
      this.server.close((err: Error) => {
        if (err) {
          this.logger.error('Error stopping server', err);
          reject(err);
        } else {
          this.logger.info('REST server stopped');
          resolve();
        }
      });
    });
  }

  /**
   * Register an HTTP route
   */
  private registerRoute(route: RouteDefinition): void {
    this.routes.push(route);

    const handler = async (req: Request, res: Response, next: NextFunction) => {
      try {
        this.logger.info('Request received', {
          method: route.method,
          path: route.path,
          params: req.params,
          query: req.query,
        });

        // Call route handler
        const result = await route.handler(req);

        // Transform response
        const response = this.transformResponse(result);

        // Send response
        res.status(200).json(response);

        this.logger.info('Request completed', {
          method: route.method,
          path: route.path,
        });
      } catch (error) {
        next(error);
      }
    };

    // Register with Express
    const method = route.method.toLowerCase() as keyof Express;
    const middleware = route.middleware || [];
    
    this.app[method](route.path, ...middleware, handler);

    this.logger.debug('Registered route', {
      method: route.method,
      path: route.path,
    });
  }

  /**
   * Error handler middleware
   */
  private errorHandler(
    error: Error,
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    this.logger.error('Request error', error, {
      method: req.method,
      path: req.path,
    });

    if (error instanceof BaseError) {
      res.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.getUserMessage(),
          details: error.context,
        },
      });
    } else {
      res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred',
        },
      });
    }
  }
}

// Example usage
import { IUserService } from '../../core/interfaces/IUserService';

export function createUserRESTAdapter(
  container: ServiceContainer,
  logger: ILogger
): RESTAdapter {
  return new RESTAdapter(
    {
      name: 'UserRESTAdapter',
      port: 3000,
      host: 'localhost',
      cors: true,
      routes: [
        {
          method: 'GET',
          path: '/users/:id',
          handler: async (req) => {
            const userService = await container.resolve<IUserService>('userService');
            return await userService.getUser(req.params.id);
          },
        },
        {
          method: 'POST',
          path: '/users',
          handler: async (req) => {
            const userService = await container.resolve<IUserService>('userService');
            return await userService.createUser(req.body);
          },
        },
        {
          method: 'PUT',
          path: '/users/:id',
          handler: async (req) => {
            const userService = await container.resolve<IUserService>('userService');
            return await userService.updateUser(req.params.id, req.body);
          },
        },
        {
          method: 'DELETE',
          path: '/users/:id',
          handler: async (req) => {
            const userService = await container.resolve<IUserService>('userService');
            await userService.deleteUser(req.params.id);
            return { success: true };
          },
        },
        {
          method: 'GET',
          path: '/users',
          handler: async (req) => {
            const userService = await container.resolve<IUserService>('userService');
            return await userService.listUsers({
              limit: parseInt(req.query.limit as string) || 100,
              offset: parseInt(req.query.offset as string) || 0,
            });
          },
        },
      ],
    },
    container,
    logger
  );
}

// Usage
const container = createServiceContainer(config);
await container.initializeAll();

const logger = LoggerFactory.getLogger('RESTAdapter');
const adapter = createUserRESTAdapter(container, logger);

await adapter.initialize();
await adapter.start();

// REST API is now running on http://localhost:3000
```

---

## Benefits

1. **Framework Agnostic** - Core logic independent of HTTP framework
2. **Standard REST APIs** - Consistent endpoint patterns
3. **Type Safety** - TypeScript for routes and handlers
4. **Error Handling** - Automatic HTTP error responses
5. **Testability** - Easy to test route handlers

---

## Best Practices

### 1. Use RESTful Conventions
```typescript
GET    /users      - List users
GET    /users/:id  - Get user
POST   /users      - Create user
PUT    /users/:id  - Update user
DELETE /users/:id  - Delete user
```

### 2. Validate Input
```typescript
handler: async (req) => {
  if (!req.body.email) {
    throw new ValidationError('Email is required', 'email');
  }
  return await service.createUser(req.body);
}
```

### 3. Use Middleware
```typescript
{
  method: 'POST',
  path: '/users',
  middleware: [authMiddleware, validateMiddleware],
  handler: async (req) => { ... }
}
```

---

## Anti-Patterns

### ❌ Business Logic in Route Handlers

```typescript
// Bad: Core logic in the route handler
router.post('/users', async (req, res) => {
  if (!req.body.email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  const user = await db.users.create(req.body);  // Direct DB access
  res.json(user);
});

// Good: Handler delegates to service
router.post('/users', async (req, res) => {
  const user = await userService.createUser(req.body);
  res.status(201).json(user);
});
```

### ❌ Inconsistent HTTP Status Codes

```typescript
// Bad: Returning 200 for all responses including errors
router.get('/users/:id', async (req, res) => {
  const user = await userService.getUser(req.params.id);
  if (!user) return res.json({ error: 'Not found' });  // Should be 404
  res.json(user);
});

// Good: Correct status codes per HTTP semantics
router.get('/users/:id', async (req, res) => {
  const user = await userService.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});
```

### ❌ No Centralized Error Handling

```typescript
// Bad: Each route handles errors differently
router.get('/users/:id', async (req, res) => {
  try { ... } catch (err) { res.status(500).json({ message: err.message }); }
});
router.post('/users', async (req, res) => {
  try { ... } catch (err) { res.status(400).send(err.toString()); }  // Different format!
});

// Good: Centralized error handler middleware
app.use(errorHandlerMiddleware);  // Handles all routes consistently
```

---

## Related Patterns

- **[Adapter Base Pattern](core-sdk.adapter-base.md)** - Base adapter class
- **[Service Interface Pattern](core-sdk.service-interface.md)** - Services used by adapter
- **[Error Handling Pattern](core-sdk.service-error-handling.md)** - HTTP error responses

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Express 4.x+
**Related Design**: [Core SDK Architecture](../design/core-sdk.architecture.md)
