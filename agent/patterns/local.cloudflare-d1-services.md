# Cloudflare D1 Database Services

**Category**: Architecture
**Applicable To**: TanStack Start + Cloudflare Workers apps using D1 (SQLite)
**Status**: Stable

---

## Overview

Pattern for accessing Cloudflare D1 databases in TanStack Start apps using a `BaseDatabaseService` class hierarchy. Provides a thin `getDb()` helper that reads the D1 binding from `cloudflare:workers` env, a base class with generic CRUD operations, parameterized query builders, and Zod-validated row hydration (JSON/boolean field parsing for SQLite type constraints).

Derived from the production cleanbook-tanstack codebase.

---

## When to Use This Pattern

**Use this pattern when:**
- Building a TanStack Start + Cloudflare Workers app with D1
- You need structured CRUD access across multiple tables
- You want Zod-validated, type-safe database results
- You're storing JSON or boolean values in SQLite (which only has TEXT/INTEGER)

**Don't use this pattern when:**
- Using an ORM like Drizzle (it handles query building and type mapping)
- You only have 1-2 simple queries (just use `getDb()` directly)
- You're not on Cloudflare Workers (D1 binding won't be available)

---

## Core Principles

1. **Binding via `cloudflare:workers`**: Access D1 through `import { env } from 'cloudflare:workers'`, not through request context or middleware
2. **Static service classes**: All methods are `static` — no instantiation needed, services are stateless
3. **Parameterized queries**: Always use `.prepare().bind()` — never interpolate values into SQL
4. **Hydration layer**: SQLite stores JSON as TEXT and booleans as INTEGER — each service declares which fields need parsing
5. **Zod validation**: Every row returned from the database is validated against a Zod schema before being returned to callers

---

## Implementation

### Structure

```
src/
├── lib/
│   ├── db/
│   │   ├── client.ts                    # getDb() helper
│   │   └── migrations/
│   │       ├── 0001_initial.sql
│   │       └── 0002_add_hits.sql
│   └── services/
│       ├── base.database-service.ts     # BaseDatabaseService
│       ├── hit-marker.database-service.ts
│       └── project.database-service.ts
├── schemas/
│   ├── hit-marker.schema.ts             # Zod schemas
│   └── project.schema.ts
```

### Component 1: D1 Client (`getDb()`)

```typescript
// src/lib/db/client.ts
import { env } from 'cloudflare:workers'

export function getDb(): D1Database {
  const db = (env as any)?.DB
  if (!db) {
    throw new Error('D1 database binding not available. Add [[d1_databases]] to wrangler.toml.')
  }
  return db
}
```

### Component 2: BaseDatabaseService

Provides generic CRUD, parameterized query builders, and field hydration helpers.

```typescript
// src/lib/services/base.database-service.ts
import { getDb } from '@/lib/db/client'
import type { ZodType } from 'zod'

const TABLE_NAME_RE = /^[a-z_][a-z0-9_]*$/

export class BaseDatabaseService {
  protected static get db(): D1Database {
    return getDb()
  }

  protected static generateId(): string {
    return crypto.randomUUID()
  }

  // ── Row hydration ──────────────────────────────────────
  protected static parseJsonFields<T extends Record<string, unknown>>(
    row: T, fields: string[]
  ): T {
    const result = { ...row }
    for (const field of fields) {
      const value = (result as Record<string, unknown>)[field]
      if (typeof value === 'string') {
        try { (result as Record<string, unknown>)[field] = JSON.parse(value) } catch {}
      }
    }
    return result
  }

  protected static parseBooleanFields<T extends Record<string, unknown>>(
    row: T, fields: string[]
  ): T {
    const result = { ...row }
    for (const field of fields) {
      const value = (result as Record<string, unknown>)[field]
      if (typeof value === 'number') {
        (result as Record<string, unknown>)[field] = value === 1
      }
    }
    return result
  }

  protected static stringifyJsonFields<T extends Record<string, unknown>>(
    row: T, fields: string[]
  ): T {
    const result = { ...row }
    for (const field of fields) {
      const val = (result as Record<string, unknown>)[field]
      if (val !== null && val !== undefined && typeof val !== 'string') {
        (result as Record<string, unknown>)[field] = JSON.stringify(val)
      }
    }
    return result
  }

  // ── Zod validation ─────────────────────────────────────
  protected static validateRow<T>(schema: ZodType<T>, row: unknown): T {
    return schema.parse(row)
  }

  // ── Query builders ─────────────────────────────────────
  protected static buildInsert(
    table: string, data: Record<string, unknown>
  ): { sql: string; params: unknown[] } {
    if (!TABLE_NAME_RE.test(table)) throw new Error(`Invalid table name: ${table}`)
    const keys = Object.keys(data)
    const placeholders = keys.map(() => '?').join(', ')
    const sql = `INSERT INTO ${table} (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${placeholders})`
    return { sql, params: keys.map(k => data[k] ?? null) }
  }

  protected static buildUpdate(
    table: string, data: Record<string, unknown>
  ): { setClauses: string; params: unknown[] } {
    if (!TABLE_NAME_RE.test(table)) throw new Error(`Invalid table name: ${table}`)
    const keys = Object.keys(data)
    return {
      setClauses: keys.map(k => `"${k}" = ?`).join(', '),
      params: keys.map(k => data[k] ?? null),
    }
  }

  // ── Generic CRUD ───────────────────────────────────────
  protected static async _findById<T>(
    table: string, schema: ZodType<T>, id: string,
    hydrate?: (row: Record<string, unknown>) => Record<string, unknown>
  ): Promise<T | null> {
    const row = await this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first()
    if (!row) return null
    const data = hydrate ? hydrate(row as Record<string, unknown>) : row
    return this.validateRow(schema, data)
  }

  protected static async _createRecord<T>(
    table: string, data: Record<string, unknown>,
    findByIdFn: (id: string) => Promise<T | null>
  ): Promise<T> {
    const id = this.generateId()
    const { sql, params } = this.buildInsert(table, { id, ...data })
    await this.db.prepare(sql).bind(...params).run()
    return (await findByIdFn(id))!
  }

  protected static async _updateRecord<T>(
    table: string, id: string, data: Record<string, unknown>,
    findByIdFn: (id: string) => Promise<T | null>
  ): Promise<T | null> {
    const { setClauses, params } = this.buildUpdate(table, data)
    await this.db.prepare(`UPDATE ${table} SET ${setClauses} WHERE id = ?`).bind(...params, id).run()
    return findByIdFn(id)
  }

  protected static async _deleteRecord(table: string, id: string): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run()
    return (result.meta?.changes ?? 0) > 0
  }
}
```

### Component 3: Domain Service (Example)

```typescript
// src/lib/services/hit-marker.database-service.ts
import { BaseDatabaseService } from './base.database-service'
import { HitMarkerSchema, type HitMarker, type CreateHitMarker } from '@/schemas/hit-marker.schema'
import { withTimestamps, withUpdatedAt } from './timestamps'

const TABLE = 'hit_markers'
const JSON_FIELDS = ['preset_overrides']
const BOOL_FIELDS = ['is_locked']

export class HitMarkerDatabaseService extends BaseDatabaseService {
  private static hydrate(row: Record<string, unknown>) {
    return this.parseBooleanFields(this.parseJsonFields(row, JSON_FIELDS), BOOL_FIELDS)
  }

  static async findById(id: string): Promise<HitMarker | null> {
    return this._findById(TABLE, HitMarkerSchema, id, (row) => this.hydrate(row))
  }

  static async findByProjectId(projectId: string): Promise<HitMarker[]> {
    const rows = await this.db
      .prepare('SELECT * FROM hit_markers WHERE project_id = ? ORDER BY time ASC')
      .bind(projectId).all()
    return rows.results.map(r => this.validateRow(HitMarkerSchema, this.hydrate(r as Record<string, unknown>)))
  }

  static async create(data: CreateHitMarker): Promise<HitMarker> {
    const row = this.stringifyJsonFields(withTimestamps(data), JSON_FIELDS)
    return this._createRecord(TABLE, row, (id) => this.findById(id))
  }

  static async delete(id: string): Promise<boolean> {
    return this._deleteRecord(TABLE, id)
  }
}
```

### Component 4: Wrangler D1 Binding

```toml
# wrangler.toml
[[d1_databases]]
binding = "DB"
database_name = "beatlab-db"
database_id = "<your-database-id>"
```

### Component 5: Migrations

Migrations are plain SQL files applied via CLI:

```bash
wrangler d1 migrations create beatlab-db "add hit markers table"
wrangler d1 migrations apply beatlab-db        # remote
wrangler d1 migrations apply beatlab-db --local # local dev
```

**SQLite type mappings** (no UUID, JSONB, or BOOLEAN in SQLite):

| App Type | SQLite Type | Hydration |
|----------|-------------|-----------|
| UUID | TEXT | None (stored as string) |
| JSON/Array | TEXT | `parseJsonFields()` on read, `stringifyJsonFields()` on write |
| Boolean | INTEGER | `parseBooleanFields()` on read (0/1 → false/true) |
| Decimal | REAL | None |
| Timestamp | TEXT | ISO 8601 strings |

---

## Key Design Decisions

### Binding Access

| Decision | Choice | Rationale |
|---|---|---|
| How to access D1 | `import { env } from 'cloudflare:workers'` | Works everywhere (routes, services, cron handlers) without threading context through params |
| Env casting | `(env as any)?.DB` | Cloudflare auto-generates `Env` type via `wrangler types`, but casting is simpler for the helper |

### Service Architecture

| Decision | Choice | Rationale |
|---|---|---|
| Static vs instance methods | Static | Services are stateless — no constructor needed, cleaner call sites (`UserService.findById()`) |
| Query building | Hand-rolled `buildInsert`/`buildUpdate` | Avoids ORM dependency, D1 API is simple enough, full control over SQL |
| Row validation | Zod schemas | Type-safe at runtime, catches schema drift between migrations and app code |
| Hydration | Per-service `hydrate()` method | Each table knows its own JSON/boolean fields — declared as constants at top of file |

---

## Anti-Patterns

### Anti-Pattern 1: String Interpolation in Queries

```typescript
// BAD — SQL injection risk
const row = await db.prepare(`SELECT * FROM users WHERE name = '${name}'`).first()

// GOOD — parameterized
const row = await db.prepare('SELECT * FROM users WHERE name = ?').bind(name).first()
```

### Anti-Pattern 2: Accessing env in Module Scope

```typescript
// BAD — env is not available at module load time
const db = (env as any).DB  // crashes

// GOOD — access inside a function/getter
export function getDb(): D1Database {
  return (env as any)?.DB
}
```

### Anti-Pattern 3: Forgetting JSON Hydration

```typescript
// BAD — capabilities is a raw JSON string from SQLite
const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()
user.capabilities  // "[\"admin\"]" — still a string!

// GOOD — hydrate before returning
const hydrated = this.parseJsonFields(user, ['capabilities'])
hydrated.capabilities  // ["admin"] — parsed array
```

---

## Related Patterns

- **[`tanstack-cloudflare.api-route-handlers`](tanstack-cloudflare.api-route-handlers.md)**: Services are called from API route handlers
- **[`tanstack-cloudflare.zod-schema-validation`](tanstack-cloudflare.zod-schema-validation.md)**: Zod schemas used for row validation
- **[`core-sdk.service-base`](core-sdk.service-base.md)**: General service base pattern (this is the D1-specific variant)
- **[`tanstack-cloudflare.wrangler-configuration`](tanstack-cloudflare.wrangler-configuration.md)**: Wrangler config for D1, DO, queues, cron

---

## Checklist for Implementation

- [ ] `wrangler.toml` has `[[d1_databases]]` binding named `DB`
- [ ] `src/lib/db/client.ts` exports `getDb()` using `cloudflare:workers` env
- [ ] `BaseDatabaseService` provides CRUD helpers and hydration
- [ ] Each domain service extends `BaseDatabaseService` with its own table/schema/hydration
- [ ] JSON fields are declared and parsed on read, stringified on write
- [ ] Boolean fields are declared and parsed (INTEGER → boolean)
- [ ] All queries use `.prepare().bind()` (no string interpolation)
- [ ] Zod schemas match the hydrated row shape (not raw SQLite shape)
- [ ] Migrations use SQLite-compatible types (TEXT, INTEGER, REAL)
- [ ] Run `wrangler types` after config changes to regenerate `Env` type

---

**Status**: Stable
**Recommendation**: Use as the default D1 access pattern for beatlab-synthesizer
**Last Updated**: 2026-03-25
**Contributors**: Derived from cleanbook-tanstack production codebase
