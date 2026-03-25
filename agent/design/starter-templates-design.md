# Design: Starter Template Files for tanstack-cloudflare

**Created**: 2026-03-15
**Status**: Draft
**Related**: [Audit Report](../reports/audit-1-cleanbook-extractable-ux-components.md)

---

## Problem

All 43 patterns in tanstack-cloudflare are documentation-only. Consumers must implement every pattern from scratch by reading the docs and hand-coding. ACP already supports shipping starter source files via `agent/files/` and `contents.files` in `package.yaml`, but this package doesn't use that capability yet.

## Proposed Solution

Ship production-tested, generalized starter template files extracted from cleanbook-tanstack. Files live in `agent/files/` and install to consumer projects via `acp install tanstack-cloudflare --files`.

## Directory Structure

```
agent/files/
├── src/
│   ├── components/
│   │   ├── ui/
│   │   │   ├── Modal.tsx                    # Portal modal + ConfirmationModal variants
│   │   │   ├── SlideOverPanel.tsx           # Right-slide panel with backdrop
│   │   │   ├── PillInput.tsx                # Multi-select pill/tag input (fuse.js)
│   │   │   ├── Typeahead.tsx                # Multi-select combobox with search
│   │   │   └── SearchBar.tsx                # Controlled search input + clear button
│   │   │
│   │   ├── data/
│   │   │   ├── SortableTable.tsx            # Generic sortable table with column config
│   │   │   ├── MobileCardList.tsx           # Mobile card companion to SortableTable
│   │   │   ├── useSortableData.ts           # Sort/filter state hook
│   │   │   ├── ColumnFilter.tsx             # Inline column filter dropdown
│   │   │   ├── SortIndicator.tsx            # Sort direction arrow
│   │   │   ├── EntityTable.tsx              # Responsive table+card with Fuse search
│   │   │   ├── Paginator.tsx                # Full pagination bar with inline editing
│   │   │   ├── PaginationToggle.tsx         # Pages vs infinite scroll toggle
│   │   │   └── PaginationSlideOver.tsx      # Slide-over composing pagination controls
│   │   │
│   │   ├── layout/
│   │   │   ├── UnifiedHeader.tsx            # Fixed header with nav, notifications, menu
│   │   │   ├── UnifiedFooter.tsx            # Fixed footer with safe-area padding
│   │   │   ├── Sidebar.tsx                  # Responsive sidebar with mobile overlay
│   │   │   ├── MobileBottomNav.tsx          # Fixed bottom nav bar for mobile
│   │   │   └── MenuDropdown.tsx             # Full-width dropdown menu from header
│   │   │
│   │   ├── wizard/
│   │   │   └── WizardShell.tsx              # Multi-step wizard layout with progress bar
│   │   │
│   │   ├── media/
│   │   │   ├── PhotoGallery.tsx             # Grid gallery with lightbox modal
│   │   │   └── PhotoUpload.tsx              # Signed-URL upload with progress tracking
│   │   │
│   │   ├── notifications/
│   │   │   ├── NotificationBell.tsx         # Bell icon with unread badge + panel
│   │   │   └── NotificationPanel.tsx        # Dropdown notification list
│   │   │
│   │   └── auth/
│   │       ├── AuthContext.tsx              # Firebase auth context + session sync
│   │       └── AuthForm.tsx                 # Login/signup/forgot multi-mode form
│   │
│   ├── hooks/
│   │   ├── useWizardState.ts               # URL-synced multi-step wizard state
│   │   ├── useActionToast.ts               # withToast() async action wrapper
│   │   └── useNotifications.ts             # WebSocket + REST notification hook
│   │
│   ├── contexts/
│   │   └── GlobalSearchContext.tsx          # Keyed pub/sub search state context
│   │
│   ├── durable-objects/
│   │   ├── notification-hub.ts             # Per-user WebSocket broadcast DO
│   │   └── upload-manager.ts               # Chunked upload DO with progress relay
│   │
│   └── routes/
│       ├── api/
│       │   ├── auth/
│       │   │   ├── login.tsx               # Firebase session cookie login
│       │   │   ├── logout.tsx              # Session cookie clear
│       │   │   └── session.tsx             # Session check endpoint
│       │   ├── notifications-ws.tsx        # WebSocket upgrade proxy to DO
│       │   └── consent/
│       │       └── tos.tsx                 # Versioned TOS consent tracking
│       ├── settings.tsx                    # Protected layout route with auth guard
│       └── router.tsx                      # Minimal TanStack router factory
│
└── config/
    └── wrangler.toml.template             # Starter wrangler config with DO bindings
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Mirror consumer `src/` structure | `agent/files/src/components/...` → target `src/components/...` | Files land where consumers expect them; no manual moving |
| Group by concern, not by bundle | `ui/`, `data/`, `layout/`, `wizard/`, `media/`, `auth/` | Consumers cherry-pick files they need; logical grouping aids discovery |
| No barrel `index.ts` files | Individual files only | Consumers wire their own imports; avoids coupling |
| Keep domain references as `{{VARIABLES}}` | `{{APP_NAME}}`, `{{PRIMARY_COLOR}}`, `{{AUTH_REDIRECT}}` | ACP variable substitution fills at install time |
| Minimal variables | Only where hardcoded brand/route strings exist | Most files are already generic — don't over-parameterize |
| `.tsx`/`.ts` extensions (not `.template`) | Only `wrangler.toml.template` uses `.template` | Source files don't need extension stripping; config files that collide do |

## Variables

| Variable | Used In | Default | Description |
|----------|---------|---------|-------------|
| `APP_NAME` | UnifiedHeader.tsx, AuthForm.tsx | `"My App"` | Brand name shown in header/auth |
| `PRIMARY_COLOR` | WizardShell.tsx | `"#3B82F6"` | Primary brand color (Tailwind blue-500) |
| `AUTH_REDIRECT` | AuthForm.tsx, settings.tsx | `"/home"` | Post-login redirect path |

## File-to-Pattern Mapping

Each template file is linked to an existing pattern document. This lets consumers read the pattern doc for context, then install the starter file for implementation.

| Template File | Pattern Doc | Status |
|---------------|-------------|--------|
| `ui/Modal.tsx` | `modal.md` | Existing pattern |
| `ui/SlideOverPanel.tsx` | `slide-over.md` | Existing pattern |
| `ui/PillInput.tsx` | `pill-input.md` | Existing pattern |
| `ui/SearchBar.tsx` | `global-search-context.md` | Existing pattern |
| `data/SortableTable.tsx` | `sortable-filterable-tables.md` | Existing pattern |
| `data/Paginator.tsx` | `pagination.md` | Existing pattern |
| `layout/UnifiedHeader.tsx` | `unified-header.md` | Existing pattern |
| `auth/AuthContext.tsx` | `firebase-auth.md` | Existing pattern |
| `notifications/NotificationBell.tsx` | `notifications-engine.md` | Existing pattern |
| `durable-objects/notification-hub.ts` | `durable-objects-websocket.md` | Existing pattern |
| `hooks/useWizardState.ts` | **NEW**: `wizard-system.md` | Needs pattern |
| `ui/Typeahead.tsx` | **NEW**: `typeahead.md` | Needs pattern |
| `media/PhotoUpload.tsx` | **NEW**: `signed-url-upload.md` | Needs pattern |
| `routes/api/consent/tos.tsx` | **NEW**: `tos-consent.md` | Needs pattern |
| `durable-objects/upload-manager.ts` | **NEW**: `chunked-upload-do.md` | Needs pattern |

## package.yaml `contents.files` Schema

Each entry follows the ACP file schema:

```yaml
contents:
  files:
    # === UI Primitives ===
    - name: src/components/ui/Modal.tsx
      description: Portal-based modal with ConfirmationModal variants (ESC dismiss, body scroll lock)
      target: src/components/ui/
      required: false

    - name: src/components/ui/SlideOverPanel.tsx
      description: Animated right-side slide-over panel with backdrop
      target: src/components/ui/
      required: false

    # ... (one entry per file, ~35 total)
```

## Installation UX

```bash
# Install everything (patterns + commands + files)
acp install tanstack-cloudflare

# Install only template files
acp install tanstack-cloudflare --files

# Install specific files
acp install tanstack-cloudflare --files src/components/ui/Modal.tsx src/hooks/useWizardState.ts

# Install a "bundle" (future enhancement — not in scope for M3)
acp install tanstack-cloudflare --bundle auth
```

## Out of Scope for M3

- Bundle grouping system (`--bundle auth`, `--bundle data-display`)
- `withAuth()` middleware wrapper (useful but a separate pattern, not a template file concern)
- Automated tests for template files
- Storybook/preview for components

## Dependencies to Document

Consumers installing template files will need these npm packages:

| Package | Used By | Required? |
|---------|---------|-----------|
| `lucide-react` | Most UI components | Yes (any UI file) |
| `fuse.js` | PillInput, EntityTable | Only if using those files |
| `@prmichaelsen/pretty-toasts` | useActionToast | Only if using toast |
| `firebase` | AuthContext, AuthForm | Only if using auth bundle |
| `firebase-admin` | login.tsx, session.tsx | Only if using auth API routes |
