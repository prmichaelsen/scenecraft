import { useState, useEffect, useMemo, type ReactNode } from 'react'
import Fuse from 'fuse.js'
import { ChevronRight } from 'lucide-react'
import { SortIndicator } from './SortIndicator'
import { ColumnFilter } from './ColumnFilter'

// ---------------------------------------------------------------------------
// useMediaQuery — simple inline hook, no external library
// ---------------------------------------------------------------------------
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    const mql = window.matchMedia(query)
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches)
    mql.addEventListener('change', handler)
    setMatches(mql.matches)
    return () => mql.removeEventListener('change', handler)
  }, [query])

  return matches
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract distinct non-null string values from data for a given key path */
function getDistinctValues<T>(data: T[], key: string): string[] {
  const seen = new Set<string>()
  for (const row of data) {
    const value = getNestedValue(row, key)
    if (value != null) {
      seen.add(String(value))
    }
  }
  return Array.from(seen).sort()
}

/** Access a potentially nested value via dot-path (e.g. "address.city") */
function getNestedValue(obj: unknown, path: string): unknown {
  let current: unknown = obj
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Compare two values for sorting (handles string, number, boolean, date) */
function compareValues(a: unknown, b: unknown, dir: 'asc' | 'desc'): number {
  const multiplier = dir === 'asc' ? 1 : -1

  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1

  if (typeof a === 'string' && typeof b === 'string') {
    return multiplier * a.localeCompare(b)
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return multiplier * (a - b)
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return multiplier * (Number(a) - Number(b))
  }

  // Fallback: coerce to string
  return multiplier * String(a).localeCompare(String(b))
}

// ---------------------------------------------------------------------------
// Column Definition — injectable via props (replaces entity-config registry)
// ---------------------------------------------------------------------------

export interface EntityColumnDef<T = unknown> {
  /** Field path on the data row */
  key: string
  /** Display header label (plain text) */
  label: string
  /** Column is sortable (default: true) */
  sortable?: boolean
  /** Column gets a filter dropdown (discrete values only) */
  filterable?: boolean
  /** Included in Fuse.js search keys */
  searchable?: boolean
  /** Desktop table cell renderer */
  renderTable: (row: T) => ReactNode
  /** Mobile card field renderer */
  renderCard: (row: T) => ReactNode
  /** Compact inline renderer (e.g., tooltips, previews) */
  renderInline?: (row: T) => ReactNode
  /** Custom filter UI (modal trigger, date range picker, etc.) */
  renderFilter?: () => ReactNode
}

// ---------------------------------------------------------------------------
// EntityTable Props
// ---------------------------------------------------------------------------

interface EntityTableProps<T> {
  /** Column definitions — injected directly instead of registry lookup */
  columns: EntityColumnDef<T>[]
  /** Fuse.js search configuration */
  search?: { keys: string[] }
  /** Row detail trigger style */
  detail?: 'chevron' | 'none'
  /** Search query string (controlled externally) */
  searchQuery?: string
  /** Row data array */
  data: T[]
  /** Chevron click handler */
  onDetail?: (row: T) => void
  /** Slot for page-level action buttons (top-right) */
  topRight?: ReactNode
  /** External SearchBar component */
  searchBar?: ReactNode
  /** Optional key on row for avatar URL (mobile cards) */
  avatarKey?: string
  /** Optional per-row action buttons (rendered in an actions column) */
  renderRowActions?: (row: T) => ReactNode
  /** Custom empty state message */
  emptyMessage?: string
}

// ---------------------------------------------------------------------------
// EntityTable Component
// ---------------------------------------------------------------------------

export function EntityTable<T>({
  columns,
  search,
  detail = 'none',
  searchQuery = '',
  data,
  onDetail,
  topRight,
  searchBar,
  avatarKey,
  renderRowActions,
  emptyMessage,
}: EntityTableProps<T>) {
  const isMobile = useMediaQuery('(max-width: 767px)')

  // Derive Fuse.js search keys from columns if not explicitly provided
  const searchKeys = useMemo(
    () => search?.keys ?? columns.filter((c) => c.searchable).map((c) => c.key),
    [search, columns],
  )

  // Fuse.js instance — memoized on data + search keys
  const fuse = useMemo(
    () =>
      new Fuse(data, {
        keys: searchKeys,
        threshold: 0.3,
      }),
    [data, searchKeys],
  )

  // Filtered by search
  const searchFiltered = useMemo(
    () => (searchQuery ? fuse.search(searchQuery).map((r) => r.item) : data),
    [searchQuery, fuse, data],
  )

  // Sort state
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  function handleSort(key: string) {
    if (sortKey === key) {
      if (sortDir === 'asc') {
        setSortDir('desc')
      } else {
        // Reset sort
        setSortKey(null)
        setSortDir('asc')
      }
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  // Sorted data
  const sorted = useMemo(() => {
    if (!sortKey) return searchFiltered
    return [...searchFiltered].sort((a, b) => {
      const aVal = getNestedValue(a, sortKey)
      const bVal = getNestedValue(b, sortKey)
      return compareValues(aVal, bVal, sortDir)
    })
  }, [searchFiltered, sortKey, sortDir])

  // Filter state (per filterable column)
  const [filters, setFilters] = useState<Record<string, string | null>>({})

  // Apply column filters
  const finalData = useMemo(() => {
    const activeFilters = Object.entries(filters).filter(
      ([, value]) => value != null,
    )
    if (activeFilters.length === 0) return sorted
    return sorted.filter((row) =>
      activeFilters.every(([key, filterValue]) => {
        const rowValue = getNestedValue(row, key)
        return String(rowValue) === filterValue
      }),
    )
  }, [sorted, filters])

  // Empty state message
  const resolvedEmptyMessage = emptyMessage ?? 'No results found'

  return (
    <div>
      {/* Top bar: search + actions */}
      {(searchBar || topRight) && (
        <div className="flex items-center justify-between mb-4 gap-3">
          <div className="flex-1">{searchBar}</div>
          {topRight && <div className="flex-shrink-0">{topRight}</div>}
        </div>
      )}

      {/* Empty state */}
      {finalData.length === 0 && (
        <div className="text-center py-12 text-text-muted">{resolvedEmptyMessage}</div>
      )}

      {/* Desktop: table */}
      {!isMobile && finalData.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border-default">
                {columns.map((col) => {
                  const isSortable = col.sortable !== false
                  return (
                    <th
                      key={col.key}
                      className={`text-left px-3 py-2 text-text-secondary text-sm font-medium ${
                        isSortable
                          ? 'cursor-pointer select-none hover:text-text-primary'
                          : ''
                      }`}
                      onClick={() => isSortable && handleSort(col.key)}
                    >
                      <span className="inline-flex items-center">
                        {col.label}
                        {sortKey === col.key && (
                          <SortIndicator direction={sortDir} />
                        )}
                        {col.filterable &&
                          (col.renderFilter ? (
                            col.renderFilter()
                          ) : (
                            <ColumnFilter
                              values={getDistinctValues(data, col.key)}
                              active={filters[col.key] ?? null}
                              onChange={(v) =>
                                setFilters((f) => ({ ...f, [col.key]: v }))
                              }
                            />
                          ))}
                      </span>
                    </th>
                  )
                })}
                {renderRowActions && <th className="text-right px-3 py-2 text-text-secondary text-sm font-medium" />}
                {detail === 'chevron' && <th className="w-10" />}
              </tr>
            </thead>
            <tbody>
              {finalData.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-border-default hover:bg-bg-elevated transition-colors"
                >
                  {columns.map((col) => (
                    <td key={col.key} className="px-3 py-3">
                      {col.renderTable(row)}
                    </td>
                  ))}
                  {renderRowActions && (
                    <td className="px-3 py-3 text-right">
                      {renderRowActions(row)}
                    </td>
                  )}
                  {detail === 'chevron' && (
                    <td className="px-3 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => onDetail?.(row)}
                        className="p-1 rounded hover:bg-bg-elevated transition-colors"
                        aria-label="View details"
                      >
                        <ChevronRight className="w-4 h-4 text-text-muted" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile: card list */}
      {isMobile && finalData.length > 0 && (
        <div className="flex flex-col gap-3">
          {finalData.map((row, i) => (
            <div
              key={i}
              className="relative bg-bg-card border border-border-default rounded-xl p-4"
            >
              {/* Optional avatar */}
              {avatarKey && (
                <div className="mb-3">
                  {(() => {
                    const url = getNestedValue(row, avatarKey)
                    if (!url || typeof url !== 'string') return null
                    return (
                      <img
                        src={url}
                        alt=""
                        className="w-10 h-10 rounded-full object-cover"
                      />
                    )
                  })()}
                </div>
              )}

              {/* Card fields */}
              <div className="flex flex-col gap-1 pr-8">
                {columns.map((col) => (
                  <div key={col.key}>{col.renderCard(row)}</div>
                ))}
              </div>

              {/* Row actions (mobile) */}
              {renderRowActions && (
                <div className="mt-3 pt-3 border-t border-border-subtle">
                  {renderRowActions(row)}
                </div>
              )}

              {/* Chevron */}
              {detail === 'chevron' && (
                <button
                  type="button"
                  onClick={() => onDetail?.(row)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-bg-elevated transition-colors"
                  aria-label="View details"
                >
                  <ChevronRight className="w-4 h-4 text-text-muted" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
