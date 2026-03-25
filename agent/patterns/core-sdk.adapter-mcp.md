# Pattern: MCP Adapter

**Namespace**: core-sdk
**Category**: Adapter Layer
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The MCP Adapter pattern provides a standardized way to expose core business logic through the Model Context Protocol (MCP). It adapts service methods to MCP tools, handles request/response transformation, and manages the MCP server lifecycle.

This pattern enables AI agents to interact with your core library through a consistent, well-defined interface.

---

## Problem

Without an MCP adapter pattern:

1. **Inconsistent Tool Definitions**: Each MCP server defines tools differently
2. **Manual Request Mapping**: Must manually map MCP requests to service calls
3. **Error Handling Complexity**: MCP-specific error formatting is duplicated
4. **No Standard Structure**: Hard to maintain and test MCP integrations

---

## Solution

Create an `MCPAdapter` class that:
- Extends BaseAdapter for consistent lifecycle
- Registers MCP tools from service methods
- Transforms MCP requests to service calls
- Formats responses for MCP clients
- Handles errors appropriately

---

## Implementation

```typescript
// src/adapters/mcp/MCPAdapter.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { BaseAdapter, AdapterConfig } from '../BaseAdapter';
import { ServiceContainer } from '../../core/container/ServiceContainer';
import { ILogger } from '../../core/logging/ILogger';
import { BaseError } from '../../core/errors/BaseError';

interface MCPAdapterConfig extends AdapterConfig {
  serverInfo: {
    name: string;
    version: string;
  };
  tools: MCPToolDefinition[];
}

interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (args: any) => Promise<any>;
}

export class MCPAdapter extends BaseAdapter {
  private server!: Server;
  private transport!: StdioServerTransport;
  private tools: Map<string, MCPToolDefinition> = new Map();

  constructor(
    config: MCPAdapterConfig,
    container: ServiceContainer,
    logger: ILogger
  ) {
    super(config, container, logger);
  }

  protected async onInitialize(): Promise<void> {
    const config = this.config as MCPAdapterConfig;

    this.logger.info('Initializing MCP server', {
      name: config.serverInfo.name,
      version: config.serverInfo.version,
    });

    // Create MCP server
    this.server = new Server(config.serverInfo, {
      capabilities: {
        tools: {},
      },
    });

    // Register tools
    for (const tool of config.tools) {
      this.registerTool(tool);
    }

    // Setup request handlers
    this.setupHandlers();

    this.logger.info('MCP server initialized', {
      toolCount: this.tools.size,
    });
  }

  protected async onStart(): Promise<void> {
    this.logger.info('Starting MCP server');

    // Create stdio transport
    this.transport = new StdioServerTransport();

    // Connect server to transport
    await this.server.connect(this.transport);

    this.logger.info('MCP server started and listening on stdio');
  }

  protected async onStop(): Promise<void> {
    this.logger.info('Stopping MCP server');

    if (this.server) {
      await this.server.close();
    }

    this.logger.info('MCP server stopped');
  }

  /**
   * Register an MCP tool
   */
  private registerTool(tool: MCPToolDefinition): void {
    this.tools.set(tool.name, tool);
    this.logger.debug('Registered MCP tool', { name: tool.name });
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers(): void {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = Array.from(this.tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      this.logger.debug('Listed tools', { count: tools.length });

      return { tools };
    });

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      this.logger.info('Tool called', { name, args });

      try {
        const tool = this.tools.get(name);

        if (!tool) {
          throw new Error(`Unknown tool: ${name}`);
        }

        // Call tool handler
        const result = await tool.handler(args);

        // Transform response
        const response = this.transformResponse(result);

        this.logger.info('Tool executed successfully', { name });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        this.logger.error('Tool execution failed', error as Error, { name });

        return {
          content: [
            {
              type: 'text',
              text: this.formatError(error as Error),
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Format error for MCP response
   */
  private formatError(error: Error): string {
    if (error instanceof BaseError) {
      return JSON.stringify({
        error: {
          code: error.code,
          message: error.getUserMessage(),
          details: error.context,
        },
      }, null, 2);
    }

    return JSON.stringify({
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message,
      },
    }, null, 2);
  }
}

// Example usage
import { IUserService } from '../../core/interfaces/IUserService';

export function createUserMCPAdapter(
  container: ServiceContainer,
  logger: ILogger
): MCPAdapter {
  return new MCPAdapter(
    {
      name: 'UserMCPAdapter',
      serverInfo: {
        name: 'user-service',
        version: '1.0.0',
      },
      tools: [
        {
          name: 'get_user',
          description: 'Get user by ID',
          inputSchema: {
            type: 'object',
            properties: {
              userId: {
                type: 'string',
                description: 'User ID',
              },
            },
            required: ['userId'],
          },
          handler: async (args) => {
            const userService = await container.resolve<IUserService>('userService');
            return await userService.getUser(args.userId);
          },
        },
        {
          name: 'create_user',
          description: 'Create a new user',
          inputSchema: {
            type: 'object',
            properties: {
              email: {
                type: 'string',
                description: 'User email',
              },
              name: {
                type: 'string',
                description: 'User name',
              },
              password: {
                type: 'string',
                description: 'User password',
              },
            },
            required: ['email', 'name', 'password'],
          },
          handler: async (args) => {
            const userService = await container.resolve<IUserService>('userService');
            return await userService.createUser(args);
          },
        },
        {
          name: 'list_users',
          description: 'List all users with pagination',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of users to return',
                default: 100,
              },
              offset: {
                type: 'number',
                description: 'Number of users to skip',
                default: 0,
              },
            },
          },
          handler: async (args) => {
            const userService = await container.resolve<IUserService>('userService');
            return await userService.listUsers(args);
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

const logger = LoggerFactory.getLogger('MCPAdapter');
const adapter = createUserMCPAdapter(container, logger);

await adapter.initialize();
await adapter.start();

// MCP server is now running and listening on stdio
```

---

## Benefits

1. **Standard MCP Integration** - Consistent tool definitions
2. **Type Safety** - TypeScript schemas for tools
3. **Error Handling** - Automatic error formatting
4. **Service Integration** - Direct access to core services
5. **Testability** - Easy to test tool handlers

---

## Best Practices

### 1. Define Clear Tool Schemas
```typescript
{
  name: 'get_user',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User ID' }
    },
    required: ['userId']
  }
}
```

### 2. Use Service Container
```typescript
handler: async (args) => {
  const service = await container.resolve<IUserService>('userService');
  return await service.getUser(args.userId);
}
```

### 3. Handle Errors Gracefully
```typescript
try {
  return await service.process(args);
} catch (error) {
  // Error automatically formatted by adapter
  throw error;
}
```

---

## Anti-Patterns

### ❌ Business Logic in Tool Handlers

```typescript
// Bad: Core logic inside the MCP tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const user = await db.users.create(request.params.arguments);  // Direct DB access
  return { content: [{ type: 'text', text: JSON.stringify(user) }] };
});

// Good: Handler delegates to service
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const user = await userService.createUser(request.params.arguments);
  return { content: [{ type: 'text', text: JSON.stringify(user) }] };
});
```

### ❌ No Tool Descriptions

```typescript
// Bad: AI models can't discover or use tools without descriptions
{ name: 'create_user', inputSchema: { ... } }

// Good: Rich descriptions guide model behavior
{
  name: 'create_user',
  description: 'Create a new user account. Returns the created user object.',
  inputSchema: { ... }
}
```

### ❌ Exposing Internal Errors

```typescript
// Bad: Stack traces and internal details exposed to clients
throw new McpError(ErrorCode.InternalError, err.stack);

// Good: Safe, user-facing error messages
throw new McpError(ErrorCode.InternalError, 'Failed to create user.');
```

---

## Related Patterns

- **[Adapter Base Pattern](core-sdk.adapter-base.md)** - Base adapter class
- **[Service Interface Pattern](core-sdk.service-interface.md)** - Services used by adapter
- **[Error Handling Pattern](core-sdk.service-error-handling.md)** - Error formatting

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, @modelcontextprotocol/sdk 0.5.0+
**Related Design**: [Core SDK Architecture](../design/core-sdk.architecture.md)
