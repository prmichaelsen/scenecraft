import { useState, useRef, useEffect, useCallback } from 'react'
import {
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
} from 'lucide-react'

interface PaginatorProps {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
  siblings?: number
}

function getPageRange(current: number, total: number, siblings: number): number[] {
  const start = Math.max(1, current - siblings)
  const end = Math.min(total, current + siblings)
  const pages: number[] = []
  for (let i = start; i <= end; i++) {
    pages.push(i)
  }
  return pages
}

export function Paginator({
  currentPage,
  totalPages,
  onPageChange,
  siblings = 2,
}: PaginatorProps) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(String(currentPage))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  useEffect(() => {
    setEditValue(String(currentPage))
  }, [currentPage])

  const handleEditSubmit = useCallback(() => {
    const parsed = parseInt(editValue, 10)
    if (!isNaN(parsed) && parsed >= 1 && parsed <= totalPages) {
      onPageChange(parsed)
    } else {
      setEditValue(String(currentPage))
    }
    setEditing(false)
  }, [editValue, totalPages, onPageChange, currentPage])

  const pages = getPageRange(currentPage, totalPages, siblings)

  if (totalPages <= 1) return null

  const navBtnClass =
    'p-1.5 rounded-md transition-colors text-text-secondary hover:text-text-primary hover:bg-bg-elevated disabled:opacity-30 disabled:cursor-not-allowed'

  return (
    <div className="flex items-center justify-center gap-1">
      {/* First page */}
      <button
        type="button"
        className={navBtnClass}
        disabled={currentPage === 1}
        onClick={() => onPageChange(1)}
        aria-label="First page"
      >
        <ChevronsLeft className="w-4 h-4" />
      </button>

      {/* Previous page */}
      <button
        type="button"
        className={navBtnClass}
        disabled={currentPage === 1}
        onClick={() => onPageChange(currentPage - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>

      {/* Page numbers */}
      {pages.map((page) => {
        const isCurrentPage = page === currentPage

        if (isCurrentPage && editing) {
          return (
            <input
              key="edit"
              ref={inputRef}
              type="number"
              min={1}
              max={totalPages}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleEditSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleEditSubmit()
                if (e.key === 'Escape') {
                  setEditValue(String(currentPage))
                  setEditing(false)
                }
              }}
              className="w-10 h-8 text-center text-sm rounded-md bg-bg-elevated border border-primary text-text-primary outline-none focus:ring-2 focus:ring-primary [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          )
        }

        return (
          <button
            key={page}
            type="button"
            onClick={() => {
              if (isCurrentPage) {
                setEditing(true)
              } else {
                onPageChange(page)
              }
            }}
            className={`w-8 h-8 text-sm rounded-md transition-colors ${
              isCurrentPage
                ? 'bg-primary text-white font-semibold cursor-text'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
            }`}
          >
            {page}
          </button>
        )
      })}

      {/* Next page */}
      <button
        type="button"
        className={navBtnClass}
        disabled={currentPage === totalPages}
        onClick={() => onPageChange(currentPage + 1)}
        aria-label="Next page"
      >
        <ChevronRight className="w-4 h-4" />
      </button>

      {/* Last page */}
      <button
        type="button"
        className={navBtnClass}
        disabled={currentPage === totalPages}
        onClick={() => onPageChange(totalPages)}
        aria-label="Last page"
      >
        <ChevronsRight className="w-4 h-4" />
      </button>
    </div>
  )
}
