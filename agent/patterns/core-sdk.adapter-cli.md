# Pattern: CLI Adapter

**Namespace**: core-sdk
**Category**: Adapter Layer
**Created**: 2026-02-26
**Status**: Active

---

## Overview

The CLI Adapter pattern provides a standardized way to expose core business logic through command-line interfaces. It adapts service methods to CLI commands, handles argument parsing, and manages the CLI application lifecycle.

This pattern works with frameworks like Commander.js while keeping core logic framework-agnostic.

---

## Problem

Without a CLI adapter pattern:

1. **Framework Lock-in**: Core logic tightly coupled to CLI framework
2. **Inconsistent Commands**: Different commands use different patterns
3. **Manual Argument Parsing**: Must manually parse and validate arguments
4. **Error Handling Duplication**: CLI error formatting repeated everywhere

---

## Solution

Create a `CLIAdapter` class that:
- Extends BaseAdapter for consistent lifecycle
- Registers CLI commands from service methods
- Transforms CLI arguments to service calls
- Formats output for terminal display
- Handles errors with user-friendly messages

---

## Implementation

```typescript
// src/adapters/cli/CLIAdapter.ts
import { Command } from 'commander';
import { BaseAdapter, AdapterConfig } from '../BaseAdapter';
import { ServiceContainer } from '../../core/container/ServiceContainer';
import { ILogger } from '../../core/logging/ILogger';
import { BaseError } from '../../core/errors/BaseError';

interface CLIAdapterConfig extends AdapterConfig {
  programName: string;
  version: string;
  description: string;
  commands: CommandDefinition[];
}

interface CommandDefinition {
  name: string;
  description: string;
  arguments?: ArgumentDefinition[];
  options?: OptionDefinition[];
  handler: (args: any, options: any) => Promise<any>;
}

interface ArgumentDefinition {
  name: string;
  description: string;
  required?: boolean;
}

interface OptionDefinition {
  flags: string;
  description: string;
  defaultValue?: any;
}

export class CLIAdapter extends BaseAdapter {
  private program!: Command;
  private commands: Map<string, CommandDefinition> = new Map();

  constructor(
    config: CLIAdapterConfig,
    container: ServiceContainer,
    logger: ILogger
  ) {
    super(config, container, logger);
  }

  protected async onInitialize(): Promise<void> {
    const config = this.config as CLIAdapterConfig;

    this.logger.info('Initializing CLI program', {
      name: config.programName,
      version: config.version,
    });

    // Create Commander program
    this.program = new Command();
    this.program
      .name(config.programName)
      .version(config.version)
      .description(config.description);

    // Register commands
    for (const cmd of config.commands) {
      this.registerCommand(cmd);
    }

    this.logger.info('CLI program initialized', {
      commandCount: this.commands.size,
    });
  }

  protected async onStart(): Promise<void> {
    this.logger.info('Starting CLI program');

    try {
      // Parse command line arguments
      await this.program.parseAsync(process.argv);
      
      this.logger.info('CLI program completed');
    } catch (error) {
      this.handleError(error as Error);
      process.exit(1);
    }
  }

  /**
   * Register a CLI command
   */
  private registerCommand(cmd: CommandDefinition): void {
    this.commands.set(cmd.name, cmd);

    const command = this.program.command(cmd.name);
    command.description(cmd.description);

    // Add arguments
    if (cmd.arguments) {
      for (const arg of cmd.arguments) {
        const argStr = arg.required ? `<${arg.name}>` : `[${arg.name}]`;
        command.argument(argStr, arg.description);
      }
    }

    // Add options
    if (cmd.options) {
      for (const opt of cmd.options) {
        command.option(opt.flags, opt.description, opt.defaultValue);
      }
    }

    // Add action handler
    command.action(async (...args) => {
      try {
        // Extract arguments and options
        const options = args[args.length - 1];
        const cmdArgs = args.slice(0, -1);

        this.logger.info('Command executed', {
          command: cmd.name,
          args: cmdArgs,
          options,
        });

        // Call command handler
        const result = await cmd.handler(cmdArgs, options);

        // Format and display output
        this.displayOutput(result);

        this.logger.info('Command completed successfully', {
          command: cmd.name,
        });
      } catch (error) {
        this.logger.error('Command failed', error as Error, {
          command: cmd.name,
        });

        this.displayError(error as Error);
        process.exit(1);
      }
    });

    this.logger.debug('Registered command', { name: cmd.name });
  }

  /**
   * Display command output
   */
  private displayOutput(result: any): void {
    if (result === null || result === undefined) {
      return;
    }

    if (typeof result === 'object') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result);
    }
  }

  /**
   * Display error message
   */
  private displayError(error: Error): void {
    if (error instanceof BaseError) {
      console.error(`Error: ${error.getUserMessage()}`);
      
      if (error.context) {
        console.error('Details:', JSON.stringify(error.context, null, 2));
      }
    } else {
      console.error(`Error: ${error.message}`);
    }
  }

  protected handleError(error: Error): void {
    super.handleError(error);
    this.displayError(error);
  }
}

// Example usage
import { IUserService } from '../../core/interfaces/IUserService';

export function createUserCLIAdapter(
  container: ServiceContainer,
  logger: ILogger
): CLIAdapter {
  return new CLIAdapter(
    {
      name: 'UserCLIAdapter',
      programName: 'user-cli',
      version: '1.0.0',
      description: 'User management CLI tool',
      commands: [
        {
          name: 'get',
          description: 'Get user by ID',
          arguments: [
            {
              name: 'userId',
              description: 'User ID',
              required: true,
            },
          ],
          handler: async ([userId]) => {
            const userService = await container.resolve<IUserService>('userService');
            return await userService.getUser(userId);
          },
        },
        {
          name: 'create',
          description: 'Create a new user',
          options: [
            {
              flags: '-e, --email <email>',
              description: 'User email',
            },
            {
              flags: '-n, --name <name>',
              description: 'User name',
            },
            {
              flags: '-p, --password <password>',
              description: 'User password',
            },
          ],
          handler: async (args, options) => {
            const userService = await container.resolve<IUserService>('userService');
            return await userService.createUser({
              email: options.email,
              name: options.name,
              password: options.password,
            });
          },
        },
        {
          name: 'list',
          description: 'List all users',
          options: [
            {
              flags: '-l, --limit <number>',
              description: 'Maximum number of users',
              defaultValue: 100,
            },
            {
              flags: '-o, --offset <number>',
              description: 'Number of users to skip',
              defaultValue: 0,
            },
          ],
          handler: async (args, options) => {
            const userService = await container.resolve<IUserService>('userService');
            return await userService.listUsers({
              limit: parseInt(options.limit),
              offset: parseInt(options.offset),
            });
          },
        },
        {
          name: 'delete',
          description: 'Delete user by ID',
          arguments: [
            {
              name: 'userId',
              description: 'User ID',
              required: true,
            },
          ],
          handler: async ([userId]) => {
            const userService = await container.resolve<IUserService>('userService');
            await userService.deleteUser(userId);
            return { success: true, message: `User ${userId} deleted` };
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

const logger = LoggerFactory.getLogger('CLIAdapter');
const adapter = createUserCLIAdapter(container, logger);

await adapter.initialize();
await adapter.start();

// CLI commands:
// user-cli get <userId>
// user-cli create --email user@example.com --name "John Doe" --password secret
// user-cli list --limit 10 --offset 0
// user-cli delete <userId>
```

---

## Benefits

1. **Framework Agnostic** - Core logic independent of CLI framework
2. **Standard CLI** - Consistent command patterns
3. **Type Safety** - TypeScript for commands and handlers
4. **Error Handling** - User-friendly error messages
5. **Testability** - Easy to test command handlers

---

## Best Practices

### 1. Use Clear Command Names
```typescript
{
  name: 'get',      // Not 'g' or 'fetch'
  name: 'create',   // Not 'c' or 'add'
  name: 'list',     // Not 'ls' or 'all'
  name: 'delete',   // Not 'del' or 'rm'
}
```

### 2. Provide Helpful Descriptions
```typescript
{
  name: 'create',
  description: 'Create a new user with email, name, and password',
  options: [
    {
      flags: '-e, --email <email>',
      description: 'User email address (required)',
    }
  ]
}
```

### 3. Validate Input
```typescript
handler: async (args, options) => {
  if (!options.email) {
    throw new ValidationError('Email is required', 'email');
  }
  return await service.createUser(options);
}
```

---

## Anti-Patterns

### ❌ Business Logic in CLI Handlers

```typescript
// Bad: Validation and business logic in the CLI layer
handler: async (args) => {
  if (!args.email.includes('@')) throw new Error('Invalid email');
  const user = await db.users.create({ email: args.email });  // Direct DB access
  return user;
}

// Good: CLI handler delegates to service
handler: async (args) => {
  return await userService.createUser({ email: args.email });
}
```

### ❌ Not Handling Process Exit Codes

```typescript
// Bad: Errors always exit 0 — scripts can't detect failure
process.on('uncaughtException', (err) => console.error(err));

// Good: Non-zero exit on error
process.on('uncaughtException', (err) => {
  console.error(err.message);
  process.exit(1);
});
```

### ❌ Missing --help Descriptions

```typescript
// Bad: No usage information
program.command('create-user').action(handler);

// Good: Descriptions for all commands and options
program
  .command('create-user')
  .description('Create a new user account')
  .requiredOption('--email <email>', 'User email address')
  .action(handler);
```

---

## Related Patterns

- **[Adapter Base Pattern](core-sdk.adapter-base.md)** - Base adapter class
- **[Service Interface Pattern](core-sdk.service-interface.md)** - Services used by adapter
- **[Error Handling Pattern](core-sdk.service-error-handling.md)** - CLI error messages

---

**Status**: Active
**Compatibility**: TypeScript 5.0+, Commander.js 11.x+
**Related Design**: [Core SDK Architecture](../design/core-sdk.architecture.md)
