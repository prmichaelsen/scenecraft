# Performance Timing Utility

**Category**: Code  
**Applicable To**: Server-side loaders, service methods, and any async operation needing duration tracking  
**Status**: Stable

---

## Overview

A lightweight performance timing utility for tracking operation durations in server-side code. Provides two APIs: a manual `perf(label)` timer with an `.end()` method, and a `perf.measure(label, fn)` wrapper for async functions. Both log duration via the structured logger.

---

## When to Use This Pattern

✅ **Use this pattern when:**
- Profiling server-side loader or service call durations
- Identifying slow database queries or external API calls
- Adding lightweight observability without a full APM tool

❌ **Don't use this pattern when:**
- You need distributed tracing across services (use OpenTelemetry)
- Client-side performance measurement (use browser Performance API or React Profiler)
- The operation is trivially fast (< 1ms)

---

## Implementation

```typescript
import { logger } from '@/lib/services/logger'

export function perf(label: string) {
  const start = performance.now()
  return {
    end() {
      const ms = Math.round((performance.now() - start) * 100) / 100
      logger.debug('perf', { label, ms })
      return ms
    },
  }
}

perf.measure = async function <T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try {
    const result = await fn()
    const ms = Math.round((performance.now() - start) * 100) / 100
    logger.debug('perf', { label, ms })
    return result
  } catch (err) {
    const ms = Math.round((performance.now() - start) * 100) / 100
    logger.warn('perf failed', { label, ms })
    throw err
  }
}
```

---

## Examples

### Example 1: Manual Timer

```typescript
const timer = perf('loadAppointments')
const appointments = await AppointmentService.findByBusiness(businessId)
timer.end() // logs: perf { label: 'loadAppointments', ms: 42.31 }
```

### Example 2: Async Wrapper

```typescript
const appointments = await perf.measure('loadAppointments', () =>
  AppointmentService.findByBusiness(businessId)
)
// logs on success: perf { label: 'loadAppointments', ms: 42.31 }
// logs on failure: perf failed { label: 'loadAppointments', ms: 12.5 }
```

### Example 3: Multiple Timers in a Loader

```typescript
const getPageData = createAuthenticatedLoaderNoInput(async (session) => {
  const [user, appointments, disputes] = await Promise.all([
    perf.measure('user', () => UserService.findByUid(session.user.uid)),
    perf.measure('appointments', () => AppointmentService.findByUser(session.user.uid)),
    perf.measure('disputes', () => DisputeService.findByUser(session.user.uid)),
  ])
  return { user, appointments, disputes }
})
```

---

## Benefits

### 1. Zero Dependencies
Uses the built-in `performance.now()` — no external packages needed.

### 2. Structured Logging
Integrates with the app's logger, so timing data flows through the same log pipeline as everything else.

### 3. Failure Tracking
`perf.measure` logs duration even on errors, helping identify slow-then-failing operations.

---

## Trade-offs

### 1. Debug-Level Only
**Downside**: Timings log at `debug` level — invisible in production unless debug logging is enabled.  
**Mitigation**: Promote to `info` for critical paths, or add a threshold-based escalation.

### 2. No Aggregation
**Downside**: Each timing is a standalone log line — no percentiles, histograms, or dashboards.  
**Mitigation**: Feed structured logs into a log aggregator (e.g., Logflare, Datadog) for analysis.

---

## Related Patterns

- **[Authenticated Loader](./tanstack-cloudflare.authenticated-loader.md)**: Loaders that benefit from timing instrumentation
- **[Library Services](./tanstack-cloudflare.library-services.md)**: Service methods to wrap with `perf.measure`

---

**Status**: Stable  
**Last Updated**: 2026-04-08  
