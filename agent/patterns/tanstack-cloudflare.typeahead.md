# Typeahead (Multi-Select Combobox)

**Category**: Design
**Applicable To**: Tag selectors, user pickers, category filters, and any multi-select input with search filtering
**Status**: Stable

---

## Overview

The Typeahead component provides a multi-select combobox with a search input, keyboard navigation (arrow keys + Enter), selected-item pills displayed below the input, and a fixed-position dropdown that avoids clipping inside scroll containers. Options are filtered with case-insensitive includes matching, and a custom render function allows rich option display (avatars, descriptions, badges).

---

## When to Use This Pattern

| Scenario | Use Typeahead? |
|---|---|
| Select multiple items from a searchable list | Yes |
| Tag/label assignment with free-text search | Yes |
| User or contact picker | Yes |
| Single-select dropdown | No — use a standard `<select>` or combobox |
| Selecting from < 5 static options | No — use checkboxes or toggle pills |

---

## Core Principles

1. **Fixed-Position Dropdown**: The dropdown uses `position: fixed` with coordinates calculated from `getBoundingClientRect()`, preventing clipping by overflow-hidden ancestors
2. **Keyboard-First Navigation**: Arrow keys move the highlighted index, Enter selects, Escape closes the dropdown
3. **Includes-Based Filtering**: Options are filtered by `option.label.toLowerCase().includes(query.toLowerCase())` — no fuzzy matching overhead
4. **Controlled Selection**: Selected items are managed externally via `value` / `onChange` props; the component is fully controlled

---

## Implementation

### Typeahead Component

**File**: `components/ui/Typeahead.tsx`

```typescript
interface TypeaheadOption {
  id: string
  label: string
  [key: string]: any  // Allow extra fields for custom rendering
}

interface TypeaheadProps<T extends TypeaheadOption> {
  options: T[]
  value: T[]
  onChange: (selected: T[]) => void
  placeholder?: string
  renderOption?: (option: T, isHighlighted: boolean) => React.ReactNode
  maxSelections?: number
  disabled?: boolean
}
```

**Internal State**:
- `query: string` — current search input text
- `isOpen: boolean` — dropdown visibility
- `highlightedIndex: number` — keyboard-focused option index
- `inputRef: React.RefObject<HTMLInputElement>` — for focus management
- `dropdownRef: React.RefObject<HTMLDivElement>` — for click-outside detection

**Layout**:

```
┌─────────────────────────────────┐
│ [Search input________________]  │  ← Input with search icon
├─────────────────────────────────┤
│ Option A                        │  ← Dropdown (fixed position)
│ Option B  (highlighted)         │
│ Option C                        │
└─────────────────────────────────┘
│ [Pill A ×] [Pill B ×] [Pill C ×]│  ← Selected pills below input
```

**Behavior**:
- **Dropdown positioning**: On input focus, calculate position via `inputRef.current.getBoundingClientRect()` and render dropdown with `position: fixed; top; left; width` matching input dimensions
- **Filtering**: `options.filter(o => !selected.includes(o) && o.label.toLowerCase().includes(query))`
- **Selection**: Click or Enter on highlighted option adds to `value` array, clears query, keeps dropdown open for multi-select
- **Deselection**: Click the `x` on a pill to remove from `value`
- **Keyboard navigation**:
  - `ArrowDown`: increment `highlightedIndex` (wrap to 0)
  - `ArrowUp`: decrement `highlightedIndex` (wrap to last)
  - `Enter`: select highlighted option
  - `Escape`: close dropdown, blur input
- **Click outside**: Close dropdown (detected via `mousedown` event listener on `document`)
- **Max selections**: When `value.length >= maxSelections`, input is disabled and dropdown won't open

**Usage**:

```typescript
const [selectedTags, setSelectedTags] = useState<Tag[]>([])

<Typeahead
  options={availableTags}
  value={selectedTags}
  onChange={setSelectedTags}
  placeholder="Search tags..."
  maxSelections={10}
  renderOption={(tag, highlighted) => (
    <div className={`px-3 py-2 ${highlighted ? 'bg-purple-600/20' : ''}`}>
      <span className="font-medium">{tag.label}</span>
      {tag.count && <span className="text-gray-400 text-sm ml-2">({tag.count})</span>}
    </div>
  )}
/>
```

---

### Custom Option Rendering

The `renderOption` prop allows rich option display:

```typescript
// User picker with avatars
<Typeahead
  options={users}
  value={selectedUsers}
  onChange={setSelectedUsers}
  renderOption={(user, highlighted) => (
    <div className={`flex items-center gap-2 px-3 py-2 ${highlighted ? 'bg-purple-600/20' : ''}`}>
      <img src={user.avatarUrl} className="w-6 h-6 rounded-full" />
      <div>
        <div className="font-medium">{user.label}</div>
        <div className="text-xs text-gray-400">{user.email}</div>
      </div>
    </div>
  )}
/>
```

When `renderOption` is not provided, the default renderer shows `option.label` in a padded row with highlighted background.

---

### Selected Pills Display

Selected items render as pills below the input:

```typescript
<div className="flex flex-wrap gap-1 mt-1">
  {value.map(item => (
    <span
      key={item.id}
      className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-700 rounded-full text-sm"
    >
      {item.label}
      <button
        onClick={() => onChange(value.filter(v => v.id !== item.id))}
        className="text-gray-400 hover:text-white"
      >
        <X className="w-3 h-3" />
      </button>
    </span>
  ))}
</div>
```

---

## Anti-Patterns

### Rendering Dropdown Inside a Scroll Container

```typescript
// Bad: Dropdown clips at overflow-hidden parent boundary
<div className="overflow-auto h-64">
  <div className="relative">
    <input ... />
    <div className="absolute top-full w-full">{/* dropdown */}</div>
  </div>
</div>

// Good: Use position: fixed with getBoundingClientRect coordinates
const rect = inputRef.current.getBoundingClientRect()
<div style={{ position: 'fixed', top: rect.bottom, left: rect.left, width: rect.width }}>
  {/* dropdown */}
</div>
```

### Resetting Highlighted Index on Filter Change

```typescript
// Bad: Highlighted index stays at 5 but filtered list only has 3 items
setQuery(newQuery)
// highlightedIndex unchanged -> out of bounds

// Good: Reset highlighted index when filtered options change
useEffect(() => {
  setHighlightedIndex(0)
}, [query])
```

### Closing Dropdown on Selection in Multi-Select Mode

```typescript
// Bad: Dropdown closes after each selection — tedious for multi-select
const handleSelect = (option) => {
  onChange([...value, option])
  setIsOpen(false)  // Forces user to re-open for each pick
}

// Good: Keep dropdown open, clear query, let user continue selecting
const handleSelect = (option) => {
  onChange([...value, option])
  setQuery('')
  inputRef.current?.focus()
}
```

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Dropdown positioning | `position: fixed` with `getBoundingClientRect` | Prevents clipping by overflow-hidden ancestors |
| Filter algorithm | Case-insensitive `includes` | Simple, predictable; sufficient for most option lists |
| Selection display | Pills below input (not inline chips) | Keeps input clean for continued searching |
| Keyboard model | Arrow keys + Enter + Escape | Standard combobox behavior per ARIA patterns |
| Selected option filtering | Exclude already-selected from dropdown | Prevents duplicate selection |

---

## Checklist

- [ ] Dropdown uses `position: fixed` with coordinates from `getBoundingClientRect()`
- [ ] Arrow keys navigate options; Enter selects; Escape closes
- [ ] Highlighted index resets to 0 when filter query changes
- [ ] Already-selected options are excluded from the dropdown list
- [ ] Dropdown stays open after selection for continued multi-select
- [ ] Click-outside listener closes dropdown (use `mousedown`, not `click`)
- [ ] Pills display below input with `x` button for removal
- [ ] `maxSelections` disables input when limit reached
- [ ] Component is fully controlled via `value` / `onChange`

---

## Related Patterns

- **[Pill Input](./tanstack-cloudflare.pill-input.md)**: Simpler pill-based input without dropdown search; use when options are created by typing, not selected from a list
- **[Form Controls](./tanstack-cloudflare.form-controls.md)**: Standard form inputs used alongside Typeahead in forms
- **[Mention Suggestions](./tanstack-cloudflare.mention-suggestions.md)**: Similar dropdown filtering but triggered inline within a text editor via `@` prefix

---

**Status**: Stable
**Last Updated**: 2026-03-15
**Contributors**: Community
