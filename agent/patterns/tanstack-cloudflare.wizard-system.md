# Multi-Step Wizard System

**Category**: Design
**Applicable To**: Multi-step forms, onboarding flows, setup wizards, and any sequential data-collection UI
**Status**: Stable

---

## Overview

The Wizard System provides a URL-synced, multi-step form flow with sessionStorage persistence, typed form data via generics, a progress indicator, and back/next navigation. Each step is a standalone component receiving the shared wizard state; the shell handles step routing, validation gating, and data merging.

---

## When to Use This Pattern

| Scenario | Use Wizard? |
|---|---|
| Multi-page form with 3+ steps | Yes |
| Onboarding or setup flow with progress tracking | Yes |
| Single-page form with sections | No — use tabs or accordion |
| Linear flow with no back-navigation | Maybe — consider a simpler stepper |

---

## Core Principles

1. **URL-Synced Steps**: Current step index is stored in the URL search param (`?step=2`), enabling deep-linking and browser back/forward navigation
2. **sessionStorage Persistence**: Accumulated form data is written to sessionStorage on every step transition, surviving page refreshes but not tab closes
3. **Typed Form Data**: The wizard state is generic (`WizardState<T>`) so each consuming flow defines its own data shape with full type safety
4. **Step Isolation**: Each step component receives the shared data and an `onUpdate` callback — it does not know about other steps

---

## Implementation

### Structure

```
components/wizard/
├── WizardShell.tsx          # Layout shell: progress bar, nav buttons, step rendering
└── steps/
    ├── StepOne.tsx           # Individual step components
    ├── StepTwo.tsx
    └── StepThree.tsx
hooks/
└── useWizardState.ts        # URL sync, sessionStorage, data merging
```

### useWizardState Hook

**File**: `hooks/useWizardState.ts`

```typescript
interface WizardConfig<T> {
  totalSteps: number
  storageKey: string
  initialData: T
}

interface WizardState<T> {
  currentStep: number
  data: T
  goNext: () => void
  goBack: () => void
  goToStep: (step: number) => void
  updateData: (partial: Partial<T>) => void
  reset: () => void
  isFirstStep: boolean
  isLastStep: boolean
}

function useWizardState<T>(config: WizardConfig<T>): WizardState<T>
```

**Behavior**:
- Reads initial step from URL search param `?step=N`, defaults to 0
- On step change, updates URL via `window.history.replaceState` (no navigation)
- On `updateData`, merges partial into accumulated data and writes to `sessionStorage.setItem(storageKey, JSON.stringify(data))`
- On mount, attempts to hydrate from sessionStorage; falls back to `initialData`
- `reset()` clears sessionStorage entry and resets to step 0
- `goNext` / `goBack` clamp to `[0, totalSteps - 1]`

**Usage**:

```typescript
interface OnboardingData {
  name: string
  email: string
  preferences: string[]
  avatarUrl?: string
}

const wizard = useWizardState<OnboardingData>({
  totalSteps: 4,
  storageKey: 'onboarding-wizard',
  initialData: { name: '', email: '', preferences: [] },
})
```

---

### WizardShell

**File**: `components/wizard/WizardShell.tsx`

```typescript
interface WizardShellProps<T> {
  wizard: WizardState<T>
  steps: {
    label: string
    component: React.ComponentType<{ data: T; onUpdate: (partial: Partial<T>) => void }>
    validate?: (data: T) => boolean
  }[]
  onComplete: (data: T) => void
  title?: string
}
```

**Layout**:
- **Progress bar**: Row of dots/circles at top, active step highlighted with gradient (`from-purple-600 to-blue-600`), completed steps filled, future steps outlined
- **Step label**: Displayed below progress dots
- **Content area**: Renders `steps[currentStep].component` with `data` and `onUpdate` props
- **Navigation footer**: Back button (hidden on first step) | Next/Submit button
  - Next button disabled when `validate` returns false for current step
  - Last step shows "Submit" and calls `onComplete(wizard.data)` instead of `goNext`

**Usage**:

```typescript
<WizardShell
  wizard={wizard}
  title="Create Your Profile"
  steps={[
    {
      label: 'Basic Info',
      component: BasicInfoStep,
      validate: (d) => d.name.length > 0 && d.email.includes('@'),
    },
    {
      label: 'Preferences',
      component: PreferencesStep,
    },
    {
      label: 'Avatar',
      component: AvatarStep,
    },
    {
      label: 'Review',
      component: ReviewStep,
    },
  ]}
  onComplete={async (data) => {
    await api.createProfile(data)
    wizard.reset()
    navigate('/dashboard')
  }}
/>
```

---

### Step Component Contract

Each step receives `data` (full accumulated wizard data) and `onUpdate`:

```typescript
function BasicInfoStep({ data, onUpdate }: {
  data: OnboardingData
  onUpdate: (partial: Partial<OnboardingData>) => void
}) {
  return (
    <div className="space-y-4">
      <input
        value={data.name}
        onChange={(e) => onUpdate({ name: e.target.value })}
        placeholder="Your name"
      />
      <input
        value={data.email}
        onChange={(e) => onUpdate({ email: e.target.value })}
        placeholder="Email"
      />
    </div>
  )
}
```

---

## Anti-Patterns

### Storing Step State Locally in Each Step

```typescript
// Bad: Each step manages its own useState — data lost on back/forward
function StepOne() {
  const [name, setName] = useState('')
  return <input value={name} onChange={e => setName(e.target.value)} />
}

// Good: Step reads from and writes to shared wizard data
function StepOne({ data, onUpdate }) {
  return <input value={data.name} onChange={e => onUpdate({ name: e.target.value })} />
}
```

### Using pushState Instead of replaceState

```typescript
// Bad: Each step change adds a history entry — back button chaos
window.history.pushState(null, '', `?step=${step}`)

// Good: Replace current entry — browser back goes to previous page, not previous step
window.history.replaceState(null, '', `?step=${step}`)
```

### Forgetting to Clear sessionStorage on Completion

```typescript
// Bad: Stale wizard data persists after successful submission
onComplete(data)
navigate('/success')

// Good: Reset wizard state (clears sessionStorage) before navigating away
wizard.reset()
navigate('/success')
```

---

## Key Design Decisions

### Persistence

| Decision | Choice | Rationale |
|---|---|---|
| Storage mechanism | sessionStorage (not localStorage) | Data is transient; should not survive tab close |
| URL sync method | replaceState (not pushState) | Prevents polluting browser history with every step change |
| Data merge strategy | Shallow merge via spread | Steps update top-level fields; nested objects use full replacement |

### UX

| Decision | Choice | Rationale |
|---|---|---|
| Progress indicator | Dots with gradient active state | Compact, consistent with app gradient theme |
| Validation timing | On next-click (not inline) | Simpler; inline validation can be added per-step |
| Back button behavior | Goes to previous step, does not undo data changes | Users expect to review/edit previous steps |

---

## Checklist

- [ ] `useWizardState` reads initial step from URL `?step=N` and hydrates data from sessionStorage
- [ ] Step transitions update URL via `replaceState` and persist data to sessionStorage
- [ ] Each step component only uses `data` and `onUpdate` props — no local form state
- [ ] `validate` function gates the Next button for steps that require it
- [ ] Last step calls `onComplete` and `wizard.reset()` clears sessionStorage
- [ ] Progress dots show completed, active, and future states distinctly
- [ ] Back button hidden on first step; Next becomes Submit on last step
- [ ] Generic `<T>` type parameter ensures type safety across all steps

---

## Related Patterns

- **[Form Controls](./tanstack-cloudflare.form-controls.md)**: Input components used within wizard steps
- **[Modal](./tanstack-cloudflare.modal.md)**: Wizards can be rendered inside a modal for inline flows
- **[Toast](./tanstack-cloudflare.toast.md)**: Show success/error feedback after wizard completion

---

**Status**: Stable
**Last Updated**: 2026-03-15
**Contributors**: Community
