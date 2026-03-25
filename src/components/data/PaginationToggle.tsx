type PaginationMode = 'pages' | 'infinite'

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const

interface PaginationToggleProps {
  mode: PaginationMode
  onModeChange: (mode: PaginationMode) => void
  pageSize: number
  onPageSizeChange: (size: number) => void
}

export function PaginationToggle({
  mode,
  onModeChange,
  pageSize,
  onPageSizeChange,
}: PaginationToggleProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* Mode toggle */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          View Mode
        </label>
        <div className="flex rounded-lg bg-bg-elevated p-1">
          <button
            type="button"
            onClick={() => onModeChange('pages')}
            className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              mode === 'pages'
                ? 'bg-primary text-white'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Pages
          </button>
          <button
            type="button"
            onClick={() => onModeChange('infinite')}
            className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              mode === 'infinite'
                ? 'bg-primary text-white'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Infinite
          </button>
        </div>
      </div>

      {/* Page size options */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          Page Size
        </label>
        <div className="flex rounded-lg bg-bg-elevated p-1 gap-1">
          {PAGE_SIZE_OPTIONS.map((size) => (
            <button
              key={size}
              type="button"
              onClick={() => onPageSizeChange(size)}
              className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                pageSize === size
                  ? 'bg-primary text-white'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {size}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
