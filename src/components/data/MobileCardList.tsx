import type { ReactNode } from 'react'
import { useState } from 'react'
import type { ColumnConfig } from './SortableTable'
import type { UseSortableDataReturn } from './useSortableData'
import { Modal } from '../ui/Modal'

interface MobileCardListProps<T> {
  columns: ColumnConfig<T>[]
  sortable: UseSortableDataReturn<T>
  keyExtractor: (item: T) => string
  renderCard: (item: T) => ReactNode
}

export function MobileCardList<T>({
  columns,
  sortable,
  keyExtractor,
  renderCard,
}: MobileCardListProps<T>) {
  const { sortedData, handleSort, sortKey, sortDirection, openFilter, filterModalKey, closeFilter, filterModalColumn } = sortable
  const [showSortModal, setShowSortModal] = useState(false)
  const [showFilterPicker, setShowFilterPicker] = useState(false)

  const sortableColumns = columns.filter((c) => c.sortable)
  const filterableColumns = columns.filter((c) => c.filter)
  const activeFilterCount = columns.filter((c) => c.filterActive).length

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-3">
        {sortableColumns.length > 0 && (
          <button
            type="button"
            onClick={() => setShowSortModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border-default rounded-lg text-text-secondary hover:bg-bg-elevated transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 14 14" fill="currentColor">
              <path d="M7 2l3 4H4l3-4zM7 12l-3-4h6l-3 4z" />
            </svg>
            Sort
          </button>
        )}
        {filterableColumns.length > 0 && (
          <button
            type="button"
            onClick={() => setShowFilterPicker(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border-default rounded-lg text-text-secondary hover:bg-bg-elevated transition-colors relative"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 14 14" fill="currentColor">
              <path d="M1 2h12l-4.5 5.5V12l-3-1.5V7.5L1 2z" />
            </svg>
            Filter
            {activeFilterCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-[#E22CB3] text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                {activeFilterCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Card list */}
      {sortedData.length === 0 ? (
        <div className="text-center py-12 text-text-muted">No results found</div>
      ) : (
        <div className="space-y-3">
          {sortedData.map((item) => (
            <div key={keyExtractor(item)}>{renderCard(item)}</div>
          ))}
        </div>
      )}

      {/* Sort modal */}
      <Modal
        isOpen={showSortModal}
        onClose={() => setShowSortModal(false)}
        title="Sort by"
        maxWidth="sm"
      >
        <div className="space-y-1">
          {sortableColumns.map((col) => (
            <button
              key={col.key}
              type="button"
              onClick={() => {
                handleSort(col.key)
                setShowSortModal(false)
              }}
              className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                sortKey === col.key
                  ? 'bg-[#E22CB3]/10 text-[#E22CB3]'
                  : 'text-text-primary hover:bg-bg-elevated'
              }`}
            >
              {col.header}
              {sortKey === col.key && (
                <span className="ml-2 text-xs">
                  ({sortDirection === 'asc' ? 'A-Z' : 'Z-A'})
                </span>
              )}
            </button>
          ))}
        </div>
      </Modal>

      {/* Filter picker modal */}
      <Modal
        isOpen={showFilterPicker}
        onClose={() => setShowFilterPicker(false)}
        title="Filter by"
        maxWidth="sm"
      >
        <div className="space-y-1">
          {filterableColumns.map((col) => (
            <button
              key={col.key}
              type="button"
              onClick={() => {
                setShowFilterPicker(false)
                openFilter(col.key)
              }}
              className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                col.filterActive
                  ? 'bg-[#E22CB3]/10 text-[#E22CB3]'
                  : 'text-text-primary hover:bg-bg-elevated'
              }`}
            >
              {col.header}
              {col.filterActive && (
                <span className="ml-2 text-xs text-[#E22CB3]">(active)</span>
              )}
            </button>
          ))}
        </div>
      </Modal>

      {/* Per-column filter modal */}
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
