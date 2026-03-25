# Mobile Bottom Navigation

**Category**: Design
**Applicable To**: Mobile-first layouts requiring persistent bottom navigation with icon + label items and active route highlighting
**Status**: Stable

---

## Overview

The Mobile Bottom Navigation pattern provides a fixed bottom bar for mobile viewports with config-driven navigation items. Each item has an icon, label, and route path. The active item is highlighted based on the current URL. The bar accounts for safe-area-inset-bottom to avoid overlap with device home indicators (iPhone notch, Android gesture bar).

---

## When to Use This Pattern

| Scenario | Use Bottom Nav? |
|---|---|
| Mobile app with 3-5 top-level sections | Yes |
| PWA or hybrid app needing native-like navigation | Yes |
| Desktop-only application | No — use sidebar or top nav |
| More than 5 navigation items | No — use a hamburger menu or tab overflow |
| Single-page app without routing | No |

---

## Core Principles

1. **Config-Driven Items**: Navigation items are defined as a typed array (`NavItem[]`), not hardcoded JSX — enables easy reordering and conditional items
2. **Active Route Matching**: Uses `useLocation()` to match the current path against each item's `href`, supporting both exact and prefix matching
3. **Safe Area Padding**: `padding-bottom: env(safe-area-inset-bottom)` prevents content from being hidden behind device home indicators
4. **Fixed Positioning**: The bar is `position: fixed` at the bottom with a z-index above page content but below modals

---

## Implementation

### MobileBottomNav Component

**File**: `components/layout/MobileBottomNav.tsx`

```typescript
import { Link, useLocation } from '@tanstack/react-router'
import { Home, Search, Bell, User, PlusCircle } from 'lucide-react'

interface NavItem {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  /** Match mode: 'exact' matches href exactly, 'prefix' matches any path starting with href */
  match?: 'exact' | 'prefix'
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Home', href: '/', icon: Home, match: 'exact' },
  { label: 'Search', href: '/search', icon: Search },
  { label: 'Create', href: '/create', icon: PlusCircle },
  { label: 'Alerts', href: '/notifications', icon: Bell },
  { label: 'Profile', href: '/profile', icon: User },
]
```

**Component**:

```typescript
function MobileBottomNav() {
  const location = useLocation()

  const isActive = (item: NavItem): boolean => {
    if (item.match === 'exact') {
      return location.pathname === item.href
    }
    // Default: prefix match
    return location.pathname === item.href
      || location.pathname.startsWith(item.href + '/')
  }

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 bg-gray-900 border-t border-gray-800 md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-around h-14">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item)
          const Icon = item.icon

          return (
            <Link
              key={item.href}
              to={item.href}
              className={`flex flex-col items-center justify-center flex-1 h-full
                ${active
                  ? 'text-purple-400'
                  : 'text-gray-500 hover:text-gray-300'
                }`}
            >
              <Icon className={`w-5 h-5 ${active ? 'text-purple-400' : ''}`} />
              <span className="text-[10px] mt-0.5 leading-tight">{item.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
```

### Layout Integration

The bottom nav is rendered in the root layout and hidden on desktop via `md:hidden`:

```typescript
function RootLayout() {
  return (
    <div className="min-h-screen">
      <UnifiedHeader />

      {/* Main content with bottom padding to avoid nav overlap */}
      <main className="pb-16 md:pb-0">
        <Outlet />
      </main>

      <MobileBottomNav />
    </div>
  )
}
```

**Key detail**: `pb-16` (4rem) on main content matches the nav bar height (h-14 = 3.5rem + safe area), preventing the last items from being hidden behind the nav.

---

### Conditional Items

Items can be conditionally included based on auth state or feature flags:

```typescript
function useMobileNavItems(): NavItem[] {
  const { user } = useAuth()

  return useMemo(() => {
    const items: NavItem[] = [
      { label: 'Home', href: '/', icon: Home, match: 'exact' },
      { label: 'Search', href: '/search', icon: Search },
    ]

    if (user) {
      items.push(
        { label: 'Create', href: '/create', icon: PlusCircle },
        { label: 'Alerts', href: '/notifications', icon: Bell },
        { label: 'Profile', href: `/u/${user.username}`, icon: User },
      )
    } else {
      items.push(
        { label: 'Sign In', href: '/login', icon: User },
      )
    }

    return items
  }, [user])
}
```

---

### Badge Support (Notification Count)

Extend `NavItem` to support a badge count:

```typescript
interface NavItem {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  match?: 'exact' | 'prefix'
  badge?: number  // Unread count
}

// In the render:
<div className="relative">
  <Icon className={`w-5 h-5 ${active ? 'text-purple-400' : ''}`} />
  {item.badge && item.badge > 0 && (
    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1
                     bg-red-500 rounded-full text-[10px] text-white
                     flex items-center justify-center font-bold">
      {item.badge > 99 ? '99+' : item.badge}
    </span>
  )}
</div>
```

---

## Anti-Patterns

### Hardcoding Nav Items in JSX

```typescript
// Bad: Difficult to reorder, add conditional items, or reuse config
<nav>
  <Link to="/"><Home /> Home</Link>
  <Link to="/search"><Search /> Search</Link>
  <Link to="/profile"><User /> Profile</Link>
</nav>

// Good: Config-driven array with typed NavItem interface
const NAV_ITEMS: NavItem[] = [...]
NAV_ITEMS.map(item => <Link .../>)
```

### Forgetting Safe Area Inset

```typescript
// Bad: Content hidden behind iPhone home indicator
<nav className="fixed bottom-0 h-14">

// Good: Add safe-area padding
<nav className="fixed bottom-0" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
```

### Using the Same z-index as Modals

```typescript
// Bad: Bottom nav overlaps modal backdrop
<nav className="fixed bottom-0 z-50">  // Same as modal z-index

// Good: Lower z-index than modals (z-55) and slide-overs (z-50)
<nav className="fixed bottom-0 z-40">
```

### Not Adding Bottom Padding to Main Content

```typescript
// Bad: Last list items hidden behind the fixed nav bar
<main>
  <Outlet />
</main>

// Good: Add padding-bottom on mobile, remove on desktop
<main className="pb-16 md:pb-0">
  <Outlet />
</main>
```

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Visibility | `md:hidden` (mobile only) | Desktop uses sidebar or top nav; bottom nav is a mobile pattern |
| z-index | 40 | Below modals (55) and slide-overs (50), above page content |
| Active detection | Prefix match by default | `/profile/settings` should highlight the Profile item |
| Item limit | 3-5 items recommended | More than 5 makes touch targets too small |
| Label size | `text-[10px]` | Compact enough to fit 5 labels without wrapping |
| Icon size | `w-5 h-5` (20px) | Standard mobile nav icon size; meets 44px touch target with padding |

---

## Checklist

- [ ] Nav items defined as typed `NavItem[]` array, not hardcoded JSX
- [ ] `md:hidden` hides bottom nav on desktop viewports
- [ ] `paddingBottom: env(safe-area-inset-bottom)` applied for device home indicators
- [ ] z-index (40) is below modals and slide-overs
- [ ] Main content has `pb-16 md:pb-0` to avoid overlap with nav
- [ ] Active route uses prefix matching (or `exact` for home `/`)
- [ ] No more than 5 items to maintain usable touch targets
- [ ] Badge count renders as overlay dot/number on icon when present

---

## Related Patterns

- **[Unified Header](./tanstack-cloudflare.unified-header.md)**: Top navigation bar; works in tandem with bottom nav on mobile
- **[Slide-Over](./tanstack-cloudflare.slide-over.md)**: Mobile-friendly panel that renders above the bottom nav (z-50 > z-40)

---

**Status**: Stable
**Last Updated**: 2026-03-15
**Contributors**: Community
