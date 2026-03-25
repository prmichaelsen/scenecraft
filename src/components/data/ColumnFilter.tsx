import { useState, useRef, useEffect } from 'react'
import { Filter } from 'lucide-react'

interface ColumnFilterProps {
  values: string[]
  active: string | null
  onChange: (value: string | null) => void
}

export function ColumnFilter({ values, active, onChange }: ColumnFilterProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={containerRef} className="relative inline-block ml-1">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((prev) => !prev)
        }}
        className={`inline-flex items-center justify-center w-5 h-5 rounded ${
          active
            ? 'text-primary bg-bg-elevated'
            : 'text-text-muted hover:text-text-secondary'
        }`}
        aria-label="Filter column"
      >
        <Filter className="w-3 h-3" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-border-default bg-bg-page shadow-lg py-1">
          <button
            type="button"
            onClick={() => {
              onChange(null)
              setOpen(false)
            }}
            className={`w-full text-left px-3 py-1.5 text-sm ${
              active === null
                ? 'text-primary font-medium bg-bg-elevated'
                : 'text-text-primary hover:bg-bg-elevated'
            }`}
          >
            All
          </button>
          {values.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                onChange(value)
                setOpen(false)
              }}
              className={`w-full text-left px-3 py-1.5 text-sm ${
                active === value
                  ? 'text-primary font-medium bg-bg-elevated'
                  : 'text-text-primary hover:bg-bg-elevated'
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
