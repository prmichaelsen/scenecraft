import { X } from 'lucide-react'
import { SlideOverPanel } from '../ui/SlideOverPanel'
import { PaginationToggle } from './PaginationToggle'
import { Paginator } from './Paginator'

type PaginationMode = 'pages' | 'infinite'

interface PaginationSlideOverProps {
  isOpen: boolean
  onClose: () => void
  // PaginationToggle props
  mode: PaginationMode
  onModeChange: (mode: PaginationMode) => void
  pageSize: number
  onPageSizeChange: (size: number) => void
  // Paginator props
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
  siblings?: number
}

export function PaginationSlideOver({
  isOpen,
  onClose,
  mode,
  onModeChange,
  pageSize,
  onPageSizeChange,
  currentPage,
  totalPages,
  onPageChange,
  siblings,
}: PaginationSlideOverProps) {
  return (
    <SlideOverPanel open={isOpen} onClose={onClose}>
      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-sm font-semibold text-text-primary">
            View Settings
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-elevated transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toggle + Page Size */}
        <PaginationToggle
          mode={mode}
          onModeChange={onModeChange}
          pageSize={pageSize}
          onPageSizeChange={onPageSizeChange}
        />

        {/* Paginator — only visible in pages mode */}
        {mode === 'pages' && totalPages > 1 && (
          <div className="mt-6 pt-4 border-t border-border-default">
            <label className="block text-xs font-medium text-text-secondary mb-3">
              Navigate
            </label>
            <Paginator
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={onPageChange}
              siblings={siblings}
            />
          </div>
        )}
      </div>
    </SlideOverPanel>
  )
}
