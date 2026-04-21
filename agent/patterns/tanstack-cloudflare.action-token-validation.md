# Action Token Validation

**Category**: Architecture  
**Applicable To**: Email action links (claim, confirm, decline, set-password) with signed JWT tokens  
**Status**: Stable

---

## Overview

The Action Token Validation pattern centralizes the token-parse → validate → action-check boilerplate that every GET/POST handler in action routes repeats. A shared `action-handler` module provides three extraction variants (`validateActionTokenFromQuery`, `validateActionTokenFromForm`, `validateActionTokenFromJson`) that return a discriminated union result: either `{ ok: true, ctx: ActionContext }` with the decoded payload and DB handle, or `{ ok: false, response: Response }` with a pre-rendered error page.

---

## When to Use This Pattern

✅ **Use this pattern when:**
- Building email action links (claim appointment, confirm booking, decline, set password)
- Multiple routes share the same token validation logic
- Tokens arrive via different transports (query string, form data, JSON body)

❌ **Don't use this pattern when:**
- Using session-based auth (use `requireSession` instead)
- The token is a simple API key without expiry/consumption semantics
- You need stateless verification only (no DB consumption tracking)

---

## Core Principles

1. **Single Validation Path**: All token validation flows through one `validateToken` function
2. **Discriminated Union Result**: Callers get either a ready-to-use context or a complete error response
3. **Transport Agnostic**: Separate helpers for query params, form data, and JSON body
4. **Consume-Once Tokens**: Tokens are tracked via SHA-256 hash and consumed after use

---

## Implementation

### Structure

```
src/lib/api/
└── action-handler.ts       # Shared validation helpers

src/lib/services/
└── action-token.service.ts  # Token creation, validation, consumption

src/routes/api/actions/
├── claim.tsx                # Uses validateActionTokenFromQuery + validateActionTokenFromForm
├── confirm.tsx              # Uses validateActionTokenFromQuery
└── decline.tsx              # Uses validateActionTokenFromForm
```

### ActionContext Interface

```typescript
export interface ActionContext {
  payload: {
    id: string
    appointmentId: string
    cleanerId: string
    action: ActionType
    exp: number
  }
  tokenHash: string   // SHA-256 hash for ActionTokenService.consume()
  db: D1Database       // Database handle for the action handler
}

type ActionResult =
  | { ok: true; ctx: ActionContext }
  | { ok: false; response: Response }
```

### Validation Helpers

```typescript
// GET — token from ?token= query param
export async function validateActionTokenFromQuery(
  request: Request,
  expectedAction: ActionType,
): Promise<ActionResult> {
  const url = new URL(request.url)
  const tokenStr = url.searchParams.get('token')
  if (!tokenStr) {
    return { ok: false, response: htmlResponse(renderErrorPage('invalid', 'en-US'), 400) }
  }
  return validateToken(tokenStr, expectedAction)
}

// POST — token from form data (with URLSearchParams fallback)
export async function validateActionTokenFromForm(
  request: Request,
  expectedAction: ActionType,
): Promise<ActionResult & { formData?: FormData }> {
  let tokenStr: string | null = null
  let formData: FormData | undefined
  try {
    formData = await request.formData()
    tokenStr = formData.get('token') as string | null
  } catch {
    // Fallback: parse raw body as URLSearchParams
    const body = await request.clone().text()
    tokenStr = new URLSearchParams(body).get('token')
  }
  if (!tokenStr) {
    return { ok: false, response: htmlResponse(renderErrorPage('invalid', 'en-US'), 400) }
  }
  const result = await validateToken(tokenStr, expectedAction)
  if (result.ok) return { ...result, formData }
  return result
}

// JSON body — token from parsed JSON
export async function validateActionTokenFromJson(
  token: string,
): Promise<ActionResult> {
  return validateToken(token, null) // caller checks payload.action
}
```

---

## Examples

### Example 1: GET Action Route (Claim Page)

```typescript
// src/routes/api/actions/claim.tsx — GET handler
export const ServerRoute = createFileRoute('/api/actions/claim')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const result = await validateActionTokenFromQuery(request, 'claim')
        if (!result.ok) return result.response

        const { payload, tokenHash, db } = result.ctx
        // Render confirmation page with token in hidden form field
        return htmlResponse(renderClaimPage(payload, tokenStr))
      },
    },
  },
})
```

### Example 2: POST Action Route (Confirm Claim)

```typescript
// POST handler — user submitted the confirmation form
POST: async ({ request }) => {
  const result = await validateActionTokenFromForm(request, 'claim')
  if (!result.ok) return result.response

  const { payload, tokenHash, db } = result.ctx
  await ActionTokenService.consume(db, tokenHash)
  await AppointmentService.claim(db, payload.appointmentId, payload.cleanerId)

  return htmlResponse(renderSuccessPage('claimed'))
}
```

---

## Benefits

### 1. DRY Validation
Each action route drops from ~25 lines of token parsing to a single function call.

### 2. Consistent Error Pages
All invalid/expired/consumed tokens render the same branded error page.

### 3. Transport Flexibility
The same token validation works whether the token arrives as a query param, form field, or JSON property.

---

## Trade-offs

### 1. HTML Error Responses
**Downside**: Error responses are pre-rendered HTML, not JSON — not suitable for API-first clients.  
**Mitigation**: Add a JSON variant if you need to support programmatic consumers.

### 2. Coupled to D1
**Downside**: `ActionContext` includes a `D1Database` handle, coupling validation to Cloudflare D1.  
**Mitigation**: Abstract the DB handle behind an interface if you need to support other databases.

---

## Related Patterns

- **[Confirmation Tokens](./tanstack-cloudflare.confirmation-tokens.md)**: Token generation and consumption service
- **[API Route Handlers](./tanstack-cloudflare.api-route-handlers.md)**: Route structure that uses these helpers
- **[Email Service](./tanstack-cloudflare.email-service.md)**: Sends the emails containing action links

---

**Status**: Stable  
**Last Updated**: 2026-04-08  
