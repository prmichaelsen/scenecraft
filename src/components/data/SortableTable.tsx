import type { ReactNode } from 'react'
import type { UseSortableDataReturn } from './useSortableData'
import { Modal } from '../ui/Modal'

export type ColumnConfig<T> = {
  key: string
  header: string
  sortable?: boolean
  getValue?: (item: T) => string | number | null
  render: (item: T) => ReactNode
  filter?: ReactNode
  filterActive?: boolean
}

interface SortableTableProps<T> {
  columns: ColumnConfig<T>[]
  sortable: UseSortableDataReturn<T>
  keyExtractor: (item: T) => string
}

export function SortableTable<T>({
  columns,
  sortable,
  keyExtractor,
}: SortableTableProps<T>) {
  const { sortKey, sortDirection, handleSort, sortedData, openFilter, filterModalKey, closeFilter, filterModalColumn } = sortable

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-default">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="text-left py-3 px-4 font-medium text-text-secondary"
                >
                  <div className="flex items-center gap-1.5">
                    {col.sortable ? (
                      <button
                        type="button"
                        onClick={() => handleSort(col.key)}
                        className="flex items-center gap-1 hover:text-text-primary transition-colors"
                      >
                        {col.header}
                        <SortIcon
                          active={sortKey === col.key}
                          direction={sortKey === col.key ? sortDirection : undefined}
                        />
                      </button>
                    ) : (
                      col.header
                    )}
                    {col.filter && (
                      <button
                        type="button"
                        onClick={() => openFilter(col.key)}
                        className={`ml-1 p-0.5 rounded transition-colors ${
                          col.filterActive
                            ? 'text-[#E22CB3]'
                            : 'text-text-muted hover:text-text-secondary'
                        }`}
                        title={`Filter by ${col.header}`}
                      >
                        <FilterIcon />
                      </button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedData.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="py-12 text-center text-text-muted"
                >
                  No results found
                </td>
              </tr>
            ) : (
              sortedData.map((item) => (
                <tr
                  key={keyExtractor(item)}
                  className="border-b border-border-subtle hover:bg-bg-elevated/50 transition-colors"
                >
                  {columns.map((col) => (
                    <td key={col.key} className="py-3 px-4">
                      {col.render(item)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Filter Modal */}
      <Modal
        isOpen={!!(filterModalKey && filterModalColumn?.filter)}
        onClose={closeFilter}
        title={`Filter: ${filterModalColumn?.header ?? ''}`}
        maxWidth="sm"
      >
        {filterModalColumn?.filter}
      </Modal>
    </>
  )
}

function SortIcon({
  active,
  direction,
}: {
  active: boolean
  direction?: 'asc' | 'desc'
}) {
  if (!active) {
    return (
      <svg className="w-3.5 h-3.5 text-text-muted" viewBox="0 0 14 14" fill="currentColor">
        <path d="M7 2l3 4H4l3-4zM7 12l-3-4h6l-3 4z" />
      </svg>
    )
  }
  if (direction === 'asc') {
    return (
      <svg className="w-3.5 h-3.5 text-[#E22CB3]" viewBox="0 0 14 14" fill="currentColor">
        <path d="M7 2l3 4H4l3-4z" />
      </svg>
    )
  }
  return (
    <svg className="w-3.5 h-3.5 text-[#E22CB3]" viewBox="0 0 14 14" fill="currentColor">
      <path d="M7 12l-3-4h6l-3 4z" />
    </svg>
  )
}

function FilterIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 14 14" fill="currentColor">
      <path d="M1 2h12l-4.5 5.5V12l-3-1.5V7.5L1 2z" />
    </svg>
  )
}
