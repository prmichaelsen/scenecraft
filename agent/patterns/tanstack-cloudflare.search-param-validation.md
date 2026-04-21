# Search Param Validation

**Category**: Code  
**Applicable To**: TanStack Router routes that read URL search params  
**Status**: Stable

---

## Overview

TanStack Router's `validateSearch` option on `createFileRoute` provides type-safe search param parsing and coercion. This pattern documents two approaches: **inline validators** (lightweight functions for simple coercion) and **Zod schema validators** (for complex validation). Both ensure that `Route.useSearch()` returns typed, validated values — never raw `string | undefined`.

---

## When to Use This Pattern

✅ **Use this pattern when:**
- A route reads search params (`?page=2&filter=active`)
- You want type-safe access to search params in the component
- Search params need coercion (string → number, string → enum)

❌ **Don't use this pattern when:**
- The route has no search params
- You're using `useSearchParams()` from another router (this is TanStack-specific)

---

## Core Principles

1. **Validate at the Route Level**: `validateSearch` runs before the component — invalid params get defaults
2. **Coerce, Don't Reject**: Prefer defaulting invalid values over throwing errors
3. **Type Safety**: The return type of `validateSearch` becomes the type of `useSearch()`
4. **URL as Source of Truth**: Search params are the single source of truth for UI state like filters, pagination, and wizard steps

---

## Implementation

### Approach 1: Inline Validator (Simple Cases)

For routes with 1-3 simple search params:

```typescript
export const Route = createFileRoute('/disputes/file')({
  validateSearch: (search: Record<string, unknown>) => ({
    appointment_id: typeof search.appointment_id === 'string'
      ? search.appointment_id
      : '',
  }),
  component: FileDisputePage,
})

function FileDisputePage() {
  const { appointment_id } = Route.useSearch() // string, never undefined
}
```

### Approach 2: Inline Validator with Optional Params

For wizard steps and optional redirect targets:

```typescript
export const Route = createFileRoute('/cleaner/add-insurance')({
  validateSearch: (search: Record<string, unknown>) => ({
    step: typeof search.step === 'string' ? search.step : undefined,
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
})
```

### Approach 3: Zod Schema Validator (Complex Cases)

For routes with many params, enums, or numeric coercion:

```typescript
import { z } from 'zod'

const authSearchSchema = z.object({
  mode: z.enum(['login', 'register', 'reset']).default('login'),
  token: z.string().optional(),
  oobCode: z.string().optional(),
  email: z.string().optional(),
  redirect_url: z.string().optional(),
})

export const Route = createFileRoute('/auth')({
  validateSearch: authSearchSchema,
  component: AuthPage,
})

function AuthPage() {
  const { mode, token, oobCode, email, redirect_url } = Route.useSearch()
  // mode is always 'login' | 'register' | 'reset', defaulting to 'login'
}
```

### Approach 4: Shared Validator Function

For search params reused across multiple routes (e.g., pagination):

```typescript
// src/lib/search-validators.ts
export function paginationSearchValidator(search: Record<string, unknown>) {
  return {
    page: typeof search.page === 'number' && search.page >= 1 ? search.page : 1,
    pageSize: typeof search.pageSize === 'number' && [20, 50, 100].includes(search.pageSize)
      ? search.pageSize
      : 20,
    mode: search.mode === 'infinite' ? 'infinite' as const : 'pages' as const,
  }
}

// In route:
export const Route = createFileRoute('/memories')({
  validateSearch: paginationSearchValidator,
})
```

---

## Examples

### Example 1: Wizard Step from URL

```typescript
export const Route = createFileRoute('/setup/payments')({
  validateSearch: (search: Record<string, unknown>) => ({
    step: typeof search.step === 'string' ? search.step : undefined,
  }),
})

function SetupPaymentsWizard() {
  const { step } = Route.useSearch()
  const navigate = Route.useNavigate()

  const goToStep = (name: string) => {
    navigate({ search: { step: name } })
  }

  // step is string | undefined — undefined means "first step"
}
```

### Example 2: Navigating with Search Params

```typescript
// Updating search params preserves other params
const navigate = Route.useNavigate()

// Set a single param
navigate({ search: (prev) => ({ ...prev, page: 2 }) })

// Reset to defaults
navigate({ search: {} })
```

---

## Benefits

### 1. Type Safety
`useSearch()` returns the exact validated type — no manual parsing in components.

### 2. Graceful Degradation
Invalid or missing params get sensible defaults instead of runtime errors.

### 3. Shareable URLs
All UI state lives in the URL, making pages bookmarkable and shareable.

---

## Trade-offs

### 1. Inline Validators Can Get Verbose
**Downside**: Routes with many params have bulky `validateSearch` blocks.  
**Mitigation**: Extract to a named function or Zod schema when complexity grows.

### 2. No Validation Errors
**Downside**: Invalid params silently default — the user doesn't know their URL was wrong.  
**Mitigation**: This is usually desirable for robustness. Add toast notifications if users need feedback.

---

## Anti-Patterns

### ❌ Anti-Pattern: Raw useSearch Without Validation

```typescript
// ❌ Bad — search params are untyped Record<string, unknown>
const search = useSearch({ strict: false })
const page = Number(search.page) || 1  // manual coercion everywhere

// ✅ Good — validate at route level, use typed result
export const Route = createFileRoute('/list')({
  validateSearch: (s: Record<string, unknown>) => ({
    page: typeof s.page === 'number' && s.page >= 1 ? s.page : 1,
  }),
})
const { page } = Route.useSearch() // number, always valid
```

---

## Related Patterns

- **[Zod Schema Validation](./tanstack-cloudflare.zod-schema-validation.md)**: Zod schemas for complex validateSearch
- **[Pagination Suite](./tanstack-cloudflare.pagination.md)**: Uses search param validation for page/pageSize/mode
- **[Wizard System](./tanstack-cloudflare.wizard-system.md)**: Syncs wizard step to search params

---

**Status**: Stable  
**Last Updated**: 2026-04-08  
