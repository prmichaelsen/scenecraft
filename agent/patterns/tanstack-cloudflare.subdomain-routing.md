# Subdomain Routing Middleware

**Category**: Architecture  
**Applicable To**: Multi-tenant apps where subdomains map to user profiles or tenant pages  
**Status**: Stable

---

## Overview

The Subdomain Routing pattern intercepts requests at the middleware level, extracts the subdomain from the `Host` header, and redirects to an internal route. For example, `janecleaner.cleanbook.com` redirects to `/book/janecleaner`. Reserved subdomains (`www`, `api`, `app`, `staging`, `admin`, `mail`) are ignored, and unknown subdomains redirect to the bare domain.

This runs before the TanStack router, making it transparent to the rest of the application.

---

## When to Use This Pattern

✅ **Use this pattern when:**
- Users need vanity subdomains (e.g., `username.yourdomain.com`)
- You want cleaner booking/profile URLs without changing the internal routing structure
- The app runs on Cloudflare Workers with wildcard DNS

❌ **Don't use this pattern when:**
- You only need path-based routing (`/profile/username`)
- Your hosting doesn't support wildcard subdomains
- You need subdomain-based tenant isolation (separate databases per tenant)

---

## Core Principles

1. **Middleware-Level Redirect**: Runs before the router — no route changes needed
2. **Reserved Subdomain Blocklist**: Prevents collisions with system subdomains
3. **Graceful Fallback**: Unknown subdomains redirect to bare domain instead of 404
4. **Idempotent**: If already on the target path (`/book/slug`), does nothing

---

## Implementation

```typescript
const RESERVED_SUBDOMAINS = new Set(['www', 'my', 'api', 'app', 'staging', 'admin', 'mail'])

function extractSubdomain(host: string): string | null {
  const hostname = host.split(':')[0]
  // Skip IPs and localhost
  if (/^(\d+\.){3}\d+$/.test(hostname) || hostname === 'localhost') return null
  const parts = hostname.split('.')
  if (parts.length < 3) return null  // bare domain
  const subdomain = parts[0].toLowerCase()
  if (RESERVED_SUBDOMAINS.has(subdomain)) return null
  return subdomain
}

export async function handleSubdomainRouting(request: Request): Promise<Response | null> {
  const host = request.headers.get('host')
  if (!host) return null

  const subdomain = extractSubdomain(host)
  if (!subdomain) return null

  const url = new URL(request.url)

  // Prevent redirect loops
  if (url.pathname.startsWith('/book/')) return null

  try {
    const profile = await ProfileService.findBySlug(subdomain)
    if (profile && profile.booking_subdomain) {
      const bookingUrl = new URL(`/book/${subdomain}`, url.origin)
      bookingUrl.search = url.search
      return Response.redirect(bookingUrl.toString(), 302)
    }
  } catch (error) {
    logger.error('[SubdomainMiddleware] lookup failed', { subdomain, error: String(error) })
  }

  // Unknown subdomain — redirect to bare domain
  const hostParts = host.split(':')[0].split('.')
  if (hostParts.length >= 3) {
    const bareDomain = hostParts.slice(1).join('.')
    const port = host.includes(':') ? `:${host.split(':')[1]}` : ''
    return Response.redirect(`${url.protocol}//${bareDomain}${port}${url.pathname}${url.search}`, 302)
  }

  return null
}
```

### Wiring Into the App

```typescript
// src/entry.server.ts or app.ts
export default {
  async fetch(request: Request, env: Env) {
    const subdomainRedirect = await handleSubdomainRouting(request)
    if (subdomainRedirect) return subdomainRedirect

    // Continue to normal TanStack router handling
    return handleRequest(request, env)
  },
}
```

---

## Examples

### Example: Subdomain Resolution

| Request Host | Result |
|---|---|
| `janecleaner.cleanbook.com` | → `302 /book/janecleaner` |
| `www.cleanbook.com` | → pass through (reserved) |
| `cleanbook.com` | → pass through (bare domain) |
| `unknown.cleanbook.com` | → `302 cleanbook.com/` (fallback) |
| `localhost:3321` | → pass through |

---

## Benefits

### 1. Vanity URLs
Users get memorable `username.yourdomain.com` URLs without custom domain setup.

### 2. No Router Changes
Internal routing stays path-based — the subdomain is resolved once at the edge.

### 3. SEO Friendly
The 302 redirect preserves the canonical `/book/slug` URL for search engines.

---

## Trade-offs

### 1. DNS Configuration Required
**Downside**: Requires wildcard DNS (`*.yourdomain.com`) and matching SSL cert.  
**Mitigation**: Cloudflare provides both automatically with proxy enabled.

### 2. Database Lookup Per Request
**Downside**: Every subdomain request triggers a profile lookup.  
**Mitigation**: Cache slugs in KV or use a Cloudflare Worker cache API for hot paths.

---

## Related Patterns

- **[Wrangler Configuration](./tanstack-cloudflare.wrangler-configuration.md)**: DNS and Worker routing setup
- **[Auth Session Management](./tanstack-cloudflare.auth-session-management.md)**: Session handling after redirect

---

**Status**: Stable  
**Last Updated**: 2026-04-08  
