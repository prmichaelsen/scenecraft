# Terms of Service Consent Tracking

**Category**: Architecture
**Applicable To**: Versioned legal consent flows — terms of service, privacy policy acceptance, GDPR consent, and any compliance-gated feature access
**Status**: Stable

---

## Overview

The TOS Consent pattern provides versioned terms-of-service acceptance tracking with a GET endpoint to check whether a user has accepted the current version and a POST endpoint to record acceptance. Each acceptance record stores the user ID, TOS version, IP address (for compliance), and timestamp in D1. When the TOS version is bumped, all users are re-prompted because their stored version no longer matches the current version.

---

## When to Use This Pattern

| Scenario | Use TOS Consent? |
|---|---|
| Legal terms that require explicit user acceptance | Yes |
| Re-prompting users when terms are updated | Yes |
| Privacy policy or cookie consent | Yes |
| Feature flags or preferences | No — use user settings |
| One-time onboarding acknowledgment (no legal requirement) | No — use a simpler dismissed flag |

---

## Core Principles

1. **Version-Based Re-Consent**: The current TOS version is a constant (e.g., `TOS_VERSION = "2024-03-01"`). Changing it automatically invalidates all prior acceptances.
2. **IP Logging**: The accepting user's IP address is stored for legal compliance and audit trails
3. **Idempotent Acceptance**: POST is idempotent — re-accepting the same version updates the timestamp but does not create duplicates
4. **Blocking Check**: The consent check runs early in the auth flow; users who have not accepted the current version are redirected to the consent screen

---

## Implementation

### Structure

```
routes/api/consent/
└── tos.tsx                   # GET: check acceptance, POST: record acceptance
components/consent/
└── TosConsentModal.tsx       # Persistent modal with TOS content and Accept button
lib/
└── tos-version.ts            # TOS_VERSION constant
```

### D1 Schema

```sql
CREATE TABLE tos_consent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  version TEXT NOT NULL,
  ip_address TEXT,
  accepted_at INTEGER NOT NULL,
  UNIQUE(user_id, version)
);

CREATE INDEX idx_tos_consent_user ON tos_consent(user_id, version);
```

### TOS Version Constant

**File**: `lib/tos-version.ts`

```typescript
// Bump this value whenever the TOS content changes.
// All users will be re-prompted on their next visit.
export const TOS_VERSION = '2024-03-01'
```

### API Route: GET (Check) + POST (Accept)

**File**: `routes/api/consent/tos.tsx`

```typescript
import { TOS_VERSION } from '~/lib/tos-version'

// GET /api/consent/tos — check if user has accepted current version
export async function loader({ request, context }: LoaderFunctionArgs) {
  const user = await requireAuth(request, context)
  const db = context.cloudflare.env.DB

  const row = await db.prepare(
    'SELECT accepted_at FROM tos_consent WHERE user_id = ? AND version = ?'
  ).bind(user.uid, TOS_VERSION).first()

  return json({
    accepted: !!row,
    currentVersion: TOS_VERSION,
    acceptedAt: row?.accepted_at ?? null,
  })
}

// POST /api/consent/tos — record acceptance
export async function action({ request, context }: ActionFunctionArgs) {
  const user = await requireAuth(request, context)
  const db = context.cloudflare.env.DB

  // Extract IP for compliance logging
  const ip = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown'

  await db.prepare(
    `INSERT INTO tos_consent (user_id, version, ip_address, accepted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, version) DO UPDATE SET
       ip_address = excluded.ip_address,
       accepted_at = excluded.accepted_at`
  ).bind(user.uid, TOS_VERSION, ip, Date.now()).run()

  return json({
    accepted: true,
    version: TOS_VERSION,
    acceptedAt: Date.now(),
  })
}
```

### Consent Check in Auth Flow

```typescript
// In root loader or layout loader
export async function loader({ request, context }: LoaderFunctionArgs) {
  const user = await getOptionalUser(request, context)
  if (!user) return json({ user: null, tosAccepted: true })

  const db = context.cloudflare.env.DB
  const row = await db.prepare(
    'SELECT 1 FROM tos_consent WHERE user_id = ? AND version = ?'
  ).bind(user.uid, TOS_VERSION).first()

  return json({
    user,
    tosAccepted: !!row,
  })
}
```

### TOS Consent Modal

**File**: `components/consent/TosConsentModal.tsx`

```typescript
interface TosConsentModalProps {
  isOpen: boolean
  onAccept: () => void
  isLoading: boolean
}

function TosConsentModal({ isOpen, onAccept, isLoading }: TosConsentModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={() => {}} persistent title="Terms of Service">
      <div className="max-h-[60vh] overflow-y-auto text-sm text-gray-300 space-y-4">
        {/* TOS content rendered here — markdown or static JSX */}
        <h3>1. Acceptance of Terms</h3>
        <p>By using this service, you agree to...</p>
        {/* ... more sections ... */}
      </div>

      <div className="mt-6 flex justify-end">
        <button
          onClick={onAccept}
          disabled={isLoading}
          className="px-6 py-2 bg-gradient-to-r from-purple-600 to-blue-600 rounded-lg
                     text-white font-medium disabled:opacity-50"
        >
          {isLoading ? 'Accepting...' : 'I Accept'}
        </button>
      </div>
    </Modal>
  )
}
```

**Usage in layout**:

```typescript
function AppLayout() {
  const { tosAccepted } = useLoaderData()
  const [accepting, setAccepting] = useState(false)
  const [accepted, setAccepted] = useState(tosAccepted)

  const handleAccept = async () => {
    setAccepting(true)
    await fetch('/api/consent/tos', { method: 'POST' })
    setAccepted(true)
    setAccepting(false)
  }

  return (
    <>
      <TosConsentModal
        isOpen={!accepted}
        onAccept={handleAccept}
        isLoading={accepting}
      />
      <Outlet />
    </>
  )
}
```

---

## Anti-Patterns

### Storing Consent in localStorage

```typescript
// Bad: User clears browser data and consent is lost; no server-side audit trail
localStorage.setItem('tos-accepted', 'true')

// Good: Store in D1 with user ID, version, IP, and timestamp
await db.prepare('INSERT INTO tos_consent ...').bind(userId, version, ip, now).run()
```

### Using a Boolean Flag Without Version

```typescript
// Bad: No way to re-prompt when TOS changes
UPDATE users SET tos_accepted = true WHERE id = ?

// Good: Version-based — bumping TOS_VERSION invalidates all prior acceptances
INSERT INTO tos_consent (user_id, version, ...) VALUES (?, '2024-03-01', ...)
```

### Allowing Modal Dismissal

```typescript
// Bad: User can close modal without accepting — legal risk
<Modal isOpen={!accepted} onClose={() => setShowTos(false)}>

// Good: Use persistent modal — no close button, no escape, no backdrop dismiss
<Modal isOpen={!accepted} onClose={() => {}} persistent>
```

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Storage | D1 table with UNIQUE(user_id, version) | Server-side audit trail; version-based re-consent |
| Version format | Date string (`YYYY-MM-DD`) | Human-readable; easy to compare chronologically |
| IP extraction | `CF-Connecting-IP` header (Cloudflare) | Most reliable source on Cloudflare Workers |
| Re-consent trigger | Constant change in source code | Deploy-time; no admin UI needed |
| Modal type | Persistent (non-dismissible) | Legal requirement: user must explicitly accept |
| Idempotency | `ON CONFLICT ... DO UPDATE` | Safe to re-accept; updates timestamp |

---

## Checklist

- [ ] D1 table has `UNIQUE(user_id, version)` constraint
- [ ] `TOS_VERSION` constant defined in a single file, imported by both GET and POST routes
- [ ] GET endpoint checks acceptance by matching user ID + current version
- [ ] POST endpoint logs IP address via `CF-Connecting-IP` or `X-Forwarded-For`
- [ ] POST uses `ON CONFLICT DO UPDATE` for idempotent re-acceptance
- [ ] Consent check runs in root/layout loader, not per-page
- [ ] Modal uses `persistent: true` to prevent dismissal without acceptance
- [ ] Bumping `TOS_VERSION` automatically re-prompts all users

---

## Related Patterns

- **[Modal](./tanstack-cloudflare.modal.md)**: TOS consent uses `persistent: true` modal to block dismissal
- **[Firebase Auth](./tanstack-cloudflare.firebase-auth.md)**: Auth session provides the user ID for consent tracking

---

**Status**: Stable
**Last Updated**: 2026-03-15
**Contributors**: Community
