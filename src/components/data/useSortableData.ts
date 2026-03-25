import { useState, useMemo } from 'react'
import type { ColumnConfig } from './SortableTable'

export type SortDirection = 'asc' | 'desc'

export interface UseSortableDataOptions {
  defaultSortKey?: string
  defaultSortDirection?: SortDirection
}

export interface UseSortableDataReturn<T> {
  sortKey: string | null
  sortDirection: SortDirection
  handleSort: (key: string) => void
  sortedData: T[]
  filterModalKey: string | null
  openFilter: (key: string) => void
  closeFilter: () => void
  filterModalColumn: ColumnConfig<T> | undefined
}

export function useSortableData<T>(
  data: T[],
  columns: ColumnConfig<T>[],
  options?: UseSortableDataOptions
): UseSortableDataReturn<T> {
  const [sortKey, setSortKey] = useState<string | null>(
    options?.defaultSortKey ?? null
  )
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    options?.defaultSortDirection ?? 'asc'
  )
  const [filterModalKey, setFilterModalKey] = useState<string | null>(null)

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDirection('asc')
    }
  }

  const sortedData = useMemo(() => {
    if (!sortKey) return data

    const col = columns.find((c) => c.key === sortKey)
    if (!col?.getValue) return data

    const sorted = [...data].sort((a, b) => {
      const aVal = col.getValue!(a)
      const bVal = col.getValue!(b)

      // Nulls sort to end
      if (aVal == null && bVal == null) return 0
      if (aVal == null) return 1
      if (bVal == null) return -1

      // Numeric comparison
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal
      }

      // String comparison
      const aStr = String(aVal)
      const bStr = String(bVal)
      const cmp = aStr.localeCompare(bStr)
      return sortDirection === 'asc' ? cmp : -cmp
    })

    return sorted
  }, [data, sortKey, sortDirection, columns])

  const filterModalColumn = filterModalKey
    ? columns.find((c) => c.key === filterModalKey)
    : undefined

  return {
    sortKey,
    sortDirection,
    handleSort,
    sortedData,
    filterModalKey,
    openFilter: (key: string) => setFilterModalKey(key),
    closeFilter: () => setFilterModalKey(null),
    filterModalColumn,
  }
}
