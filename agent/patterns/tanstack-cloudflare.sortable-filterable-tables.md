# Sortable & Filterable Tables

**Category**: Code
**Applicable To**: Any list/table page that needs sorting, filtering, or responsive desktop/mobile views
**Status**: Stable

---

## Overview

This pattern provides a unified approach for building data tables with per-column sorting and filtering, plus a responsive mobile card variant. The three core pieces are:

1. **`ColumnConfig<T>`** — a generic column definition with sort/filter/render hooks
2. **`useSortableData<T>`** — a React hook that manages sort state, direction, and filter modal state
3. **`SortableTable<T>`** / **`MobileCardList<T>`** — two interchangeable view components that consume the same column config and hook output

All filtering logic lives in the consuming component (via `useMemo`), not in the hook. The hook only handles **sorting** and **filter modal visibility**. This keeps filters fully flexible — any ReactNode can serve as a filter UI.

---

## When to Use This Pattern

✅ **Use this pattern when:**

- Building a page that lists data in rows/cards with sortable columns
- You need per-column filter modals (typeahead, date range, checkbox list, etc.)
- You want desktop table + mobile card views sharing the same sort/filter state
- You want reusable column builders across admin and portal pages

❌ **Don't use this pattern when:**

- The list has no sorting or filtering needs (use a simple map)
- The table is purely read-only with fixed layout (e.g., a settings form grid)
- You need virtualized/infinite-scroll tables (this pattern renders all rows)

---

## Core Principles

1. **Columns as configuration**: Each column is a `ColumnConfig<T>` object — header, sort function, render function, and optional filter UI are all co-located.
2. **Filtering is external**: The `useSortableData` hook sorts data but does not filter it. The component filters with `useMemo` and passes filtered data into the hook.
3. **Shared state, different views**: `SortableTable` and `MobileCardList` both accept the same `columns` and `sortable` return value, so desktop/mobile views stay in sync.
4. **Column builders for reuse**: Domain-specific column factories (e.g., `propertyColumn()`, `statusColumn()`) return `ColumnConfig<T>` objects and accept options for filter UI injection.

---

## Implementation

### Structure

```
src/components/ui/
├── SortableTable.tsx       # Desktop table view
├── MobileCardList.tsx      # Mobile card view
└── useSortableData.ts      # Sort + filter-modal state hook

src/lib/
└── appointment-columns.tsx # Reusable column builders (example)
```

### Key Types

```typescript
// SortableTable.tsx
export type ColumnConfig<T> = {
  key: string;                                          // Unique column key
  header: string;                                       // Display label
  sortable?: boolean;                                   // Enable sort toggle
  getValue?: (item: T) => string | number | null;       // Extract sortable value
  render: (item: T) => ReactNode;                       // Cell content
  filter?: ReactNode;                                   // Filter UI (shown in modal)
  filterActive?: boolean;                               // Highlights filter icon when true
};

// useSortableData.ts
export type UseSortableDataReturn<T> = {
  sortKey: string | null;
  sortDirection: 'asc' | 'desc';
  handleSort: (key: string) => void;
  sortedData: T[];
  filterModalKey: string | null;
  openFilter: (key: string) => void;
  closeFilter: () => void;
  filterModalColumn: ColumnConfig<T> | undefined;
};
```

### Wiring It Together

```typescript
// 1. Define filter state
const [propertyFilterIds, setPropertyFilterIds] = useState<string[]>([]);
const [statusFilter, setStatusFilter] = useState<string[]>([]);

// 2. Filter data (useMemo)
const filtered = useMemo(() => {
  let result = data;
  if (propertyFilterIds.length > 0) {
    result = result.filter(d => propertyFilterIds.includes(d.propertyId));
  }
  if (statusFilter.length > 0) {
    result = result.filter(d => statusFilter.includes(d.status));
  }
  return result;
}, [data, propertyFilterIds, statusFilter]);

// 3. Define columns (with filter UI injected)
const columns: ColumnConfig<MyItem>[] = useMemo(() => [
  {
    key: 'name',
    header: 'Name',
    sortable: true,
    getValue: (item) => item.name.toLowerCase(),
    render: (item) => <span>{item.name}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    sortable: true,
    getValue: (item) => item.status,
    render: (item) => <StatusBadge status={item.status} />,
    filterActive: statusFilter.length > 0,
    filter: (
      <CheckboxList
        options={statusOptions}
        selected={statusFilter}
        onChange={setStatusFilter}
      />
    ),
  },
], [statusFilter]);

// 4. Call the hook (filtered data + columns)
const sortable = useSortableData(filtered, columns, {
  defaultSortKey: 'name',
  defaultSortDirection: 'asc',
});

// 5. Render both views
<div className="hidden lg:block">
  <SortableTable columns={columns} sortable={sortable} keyExtractor={d => d.id} />
</div>
<div className="lg:hidden">
  <MobileCardList
    columns={columns}
    sortable={sortable}
    keyExtractor={d => d.id}
    renderCard={(item) => <MyCard item={item} />}
  />
</div>
```

### Key Components

#### Component 1: `useSortableData<T>` Hook

Manages sort key, direction, and filter modal open/close state. Sorting is done via `useMemo` — it clones the array and sorts using the active column's `getValue` function. Null values sort to the end. Numeric vs string comparison is auto-detected.

```typescript
const sortable = useSortableData(data, columns, {
  defaultSortKey: 'cleanDate',
  defaultSortDirection: 'desc',
});
// sortable.sortedData — sorted array ready to render
// sortable.handleSort('columnKey') — toggle sort on a column
// sortable.openFilter('columnKey') — open filter modal for column
```

#### Component 2: Column Builders (Reusable Factories)

For domain types used across multiple pages, create column factory functions:

```typescript
// src/lib/appointment-columns.tsx
export function propertyColumn(options: {
  linkPrefix: string;
  filter?: ReactNode;
  filterActive?: boolean;
}): ColumnConfig<CleanAppointment> {
  return {
    key: 'propertyName',
    header: 'Property',
    sortable: true,
    getValue: (a) => (a.propertyName ?? '').toLowerCase(),
    render: (a) => (
      <Link to={`${options.linkPrefix}/${a.id}`}>
        {a.propertyName}
      </Link>
    ),
    filter: options.filter,
    filterActive: options.filterActive,
  };
}
```

This lets admin and cleaner pages share the same column rendering while injecting page-specific filter UIs.

#### Component 3: `SortableTable<T>`

Renders a `<table>` with sort icons (FaSortUp/FaSortDown/FaSort) and filter icons (FaFilter, purple when active) in each header. Clicking a filter icon calls `openFilter(col.key)` which opens a `<Modal>` with the column's `filter` ReactNode.

#### Component 4: `MobileCardList<T>`

Renders cards via `renderCard` prop plus a Sort/Filter toolbar. Sort opens a modal listing sortable columns. Filter opens a picker listing filterable columns, then opens the per-column filter modal. Active filter count is shown as a badge.

---

## Examples

### Example 1: Admin Appointments Page

The most comprehensive usage. Defines 6 columns with 4 filterable (property typeahead, date range, status checkboxes, cleaner typeahead). Filter state is local `useState`, filtering happens in `useMemo`, columns are built with reusable builders from `appointment-columns.tsx`.

**File**: `src/routes/business/appointments/components/AppointmentsClient.tsx`

### Example 2: Cleaner Portal Appointments

Simpler version reusing the same column builders but with fewer filters (no cleaner filter, no editable status). Same pattern: filter state → useMemo → columns → useSortableData → SortableTable + MobileCardList.

**File**: `src/routes/cleaner/appointments/components/AppointmentsClient.tsx`

---

## Benefits

### 1. Consistent UX

Every table page gets the same sort icons, filter icons, filter modals, and mobile toolbar — users learn the interaction once.

### 2. Minimal Boilerplate

Adding a new sortable/filterable column is a single object. Adding a filter is just providing `filter` (ReactNode) and `filterActive` (boolean) to the column config.

### 3. Responsive by Default

Using both `SortableTable` and `MobileCardList` with the same hook means desktop and mobile share sort/filter state with zero extra wiring.

---

## Trade-offs

### 1. All Data In Memory

**Downside**: Sorting and filtering happen client-side on the full dataset. Not suitable for thousands of rows.
**Mitigation**: For large datasets, implement server-side sorting/filtering or add pagination.

### 2. Filter Logic is Manual

**Downside**: Each page writes its own `useMemo` filtering logic — there's no declarative filter-to-data binding.
**Mitigation**: This is intentional. Filters vary widely (typeahead vs date range vs checkbox). Manual filtering keeps the abstraction simple.

---

## Anti-Patterns

### ❌ Anti-Pattern 1: Putting Filter Logic in the Hook

**Description**: Trying to add filter state management inside `useSortableData`.

**Why it's bad**: Filter UIs are wildly different per column (typeaheads, date pickers, checkboxes). Baking them into the hook would require a complex generic API.

**Instead, do this**: Keep filter state as local `useState` in the component, apply filters via `useMemo`, pass filtered data to `useSortableData`.

### ❌ Anti-Pattern 2: Bypassing Column Builders

**Description**: Copy-pasting column definitions across admin and portal pages instead of using shared column builders.

**Why it's bad**: Duplicated render logic drifts over time. Bug fixes need to be applied in multiple places.

**Instead, do this**: Create column builder functions in `src/lib/*-columns.tsx` that accept options (filter, filterActive, linkPrefix) and return `ColumnConfig<T>`.

### ❌ Anti-Pattern 3: Custom Table Instead of SortableTable

**Description**: Building a one-off `<table>` with inline sort/filter logic for a specific page (as seen in `ReservationsDesktopTable.tsx`).

**Why it's bad**: Loses consistency with the rest of the app and duplicates sort/filter infrastructure.

**Instead, do this**: Use `SortableTable` + `useSortableData`. If the page needs unique rendering, customize via `render` in column config.

---

## Checklist for Implementation

- [ ] Filter state declared as `useState` in the component
- [ ] Filtering applied via `useMemo` before passing to `useSortableData`
- [ ] Columns defined with `ColumnConfig<T>[]` using `useMemo` (deps include filter state)
- [ ] Reusable columns extracted to `src/lib/*-columns.tsx` builders
- [ ] `useSortableData` called with filtered data, columns, and default sort options
- [ ] `SortableTable` rendered in `hidden lg:block` wrapper
- [ ] `MobileCardList` rendered in `lg:hidden` wrapper with `renderCard` prop
- [ ] `keyExtractor` returns a unique string per item
- [ ] Filter UI includes a "Clear filter" button when active
- [ ] `filterActive` boolean passed to column config so icon turns purple

---

**Status**: Stable
**Recommendation**: Use for all list/table pages — appointments, cleaners, properties, stays, payments, marketplace jobs.
**Last Updated**: 2026-03-14
**Contributors**: ACP Project
