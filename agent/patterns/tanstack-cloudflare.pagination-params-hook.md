# Pagination Params Hook

**Category**: Code  
**Applicable To**: Paginated list views with URL-synced pagination state  
**Status**: Stable

---

## Overview

The `usePaginationParams` hook manages pagination state (`page`, `pageSize`, `mode`) via TanStack Router's search params. It reads current values from the URL with validation and clamping, and provides setter functions that update the URL — making pagination state bookmarkable, shareable, and browser-back-compatible.

This hook complements the [Pagination Suite](./tanstack-cloudflare.pagination.md) by handling the URL state layer that the UI components consume.

---

## When to Use This Pattern

✅ **Use this pattern when:**
- A paginated list needs URL-synced page/pageSize state
- Users should be able to bookmark or share a specific page
- You support toggling between paginated and infinite scroll modes

❌ **Don't use this pattern when:**
- Pagination is fully client-side with no URL sync needed
- You're using TanStack Query's `useInfiniteQuery` with its own pagination management
- The list is small enough to not need pagination

---

## Implementation

```typescript
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback } from 'react'

type PaginationMode = 'pages' | 'infinite'

interface PaginationParams {
  mode: PaginationMode
  page: number
  pageSize: number
}

interface UsePaginationParamsResult extends PaginationParams {
  setMode: (mode: PaginationMode) => void
  setPage: (page: number) => void
  setPageSize: (size: number) => void
}

export function usePaginationParams(): UsePaginationParamsResult {
  const search = useSearch({ strict: false }) as {
    mode?: string; page?: number; pageSize?: number
  }
  const navigate = useNavigate()

  // Validate and clamp values
  const mode: PaginationMode =
    search.mode === 'infinite' ? 'infinite' : 'pages'
  const page =
    typeof search.page === 'number' && search.page >= 1 ? search.page : 1
  const pageSize =
    typeof search.pageSize === 'number' && [20, 50, 100].includes(search.pageSize)
      ? search.pageSize
      : 20

  const updateSearch = useCallback(
    (updates: Partial<{ mode: string; page: number; pageSize: number }>) => {
      navigate({
        search: (prev: Record<string, unknown>) => ({ ...prev, ...updates }),
      })
    },
    [navigate],
  )

  const setMode = useCallback(
    (newMode: PaginationMode) => updateSearch({ mode: newMode, page: 1 }),
    [updateSearch],
  )

  const setPage = useCallback(
    (newPage: number) => updateSearch({ page: newPage }),
    [updateSearch],
  )

  const setPageSize = useCallback(
    (newSize: number) => updateSearch({ pageSize: newSize, page: 1 }),
    [updateSearch],
  )

  return { mode, page, pageSize, setMode, setPage, setPageSize }
}
```

---

## Examples

### Example 1: Paginated List with Mode Toggle

```typescript
function MemoriesList() {
  const { mode, page, pageSize, setMode, setPage, setPageSize } = usePaginationParams()

  const { data } = useQuery({
    queryKey: ['memories', { page, pageSize }],
    queryFn: () => fetchMemories({ offset: (page - 1) * pageSize, limit: pageSize }),
  })

  return (
    <div>
      <PaginationToggle mode={mode} onModeChange={setMode} />
      <PageSizeSelector value={pageSize} onChange={setPageSize} options={[20, 50, 100]} />

      {mode === 'pages' ? (
        <>
          <MemoryGrid items={data?.items ?? []} />
          <Paginator page={page} totalPages={data?.totalPages ?? 1} onPageChange={setPage} />
        </>
      ) : (
        <InfiniteMemoryFeed pageSize={pageSize} />
      )}
    </div>
  )
}
```

### Example 2: URL Behavior

| URL | Parsed State |
|---|---|
| `/memories` | `{ mode: 'pages', page: 1, pageSize: 20 }` |
| `/memories?page=3&pageSize=50` | `{ mode: 'pages', page: 3, pageSize: 50 }` |
| `/memories?mode=infinite` | `{ mode: 'infinite', page: 1, pageSize: 20 }` |
| `/memories?page=-5&pageSize=999` | `{ mode: 'pages', page: 1, pageSize: 20 }` (clamped) |

---

## Benefits

### 1. Bookmarkable Pagination
Users can share links to specific pages — `?page=3&pageSize=50` restores exact state.

### 2. Browser History Integration
Back/forward buttons navigate between pagination states naturally.

### 3. Validated Defaults
Invalid or missing params silently default to safe values — no crashes from malformed URLs.

---

## Trade-offs

### 1. Fixed pageSize Allowlist
**Downside**: Only `[20, 50, 100]` are valid — arbitrary sizes are clamped to 20.  
**Mitigation**: Make the allowlist configurable via a parameter if needed.

### 2. Non-Strict Search
**Downside**: Uses `useSearch({ strict: false })` — loses some type safety.  
**Mitigation**: Pair with `validateSearch` on the route for full type safety (see [Search Param Validation](./tanstack-cloudflare.search-param-validation.md)).

---

## Related Patterns

- **[Pagination Suite](./tanstack-cloudflare.pagination.md)**: UI components (Paginator, InfiniteScrollSentinel) that consume this hook's state
- **[Search Param Validation](./tanstack-cloudflare.search-param-validation.md)**: Route-level validation for the same search params

---

**Status**: Stable  
**Last Updated**: 2026-04-08  
