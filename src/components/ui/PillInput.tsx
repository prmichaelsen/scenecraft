import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import Fuse from 'fuse.js'
import { X } from 'lucide-react'

type OptionItem = string | { label: string; value: string }

interface PillInputProps {
  suggestions: OptionItem[]
  selected: string[]
  onChange: (selected: string[]) => void
  placeholder?: string
  allowCustom?: boolean
}

function normalizeOptions(
  items: OptionItem[]
): Array<{ label: string; value: string }> {
  return items.map((item) =>
    typeof item === 'string' ? { label: item, value: item } : item
  )
}

function getLabel(
  value: string,
  normalized: Array<{ label: string; value: string }>
): string {
  const found = normalized.find((o) => o.value === value)
  return found ? found.label : value
}

export function PillInput({
  suggestions,
  selected,
  onChange,
  placeholder = 'Type to search...',
  allowCustom = false,
}: PillInputProps) {
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const normalized = useMemo(() => normalizeOptions(suggestions), [suggestions])

  const fuse = useMemo(
    () =>
      new Fuse(normalized, {
        keys: ['label'],
        threshold: 0.4,
      }),
    [normalized]
  )

  const filteredSuggestions = useMemo(() => {
    const base = query
      ? fuse.search(query).map((r) => r.item)
      : normalized
    return base.filter((opt) => !selected.includes(opt.value)).slice(0, 8)
  }, [query, selected, fuse, normalized])

  // Click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const addValue = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (!trimmed || selected.includes(trimmed)) return
      onChange([...selected, trimmed])
      setQuery('')
      setHighlightIndex(-1)
    },
    [selected, onChange]
  )

  const removeValue = useCallback(
    (value: string) => {
      onChange(selected.filter((s) => s !== value))
    },
    [selected, onChange]
  )

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setIsOpen(true)
        setHighlightIndex((i) =>
          Math.min(filteredSuggestions.length - 1, i + 1)
        )
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightIndex((i) => Math.max(0, i - 1))
        break
      case 'Enter':
        e.preventDefault()
        if (highlightIndex >= 0 && filteredSuggestions[highlightIndex]) {
          addValue(filteredSuggestions[highlightIndex].value)
        } else if (allowCustom && query.trim()) {
          addValue(query)
        }
        break
      case ',':
        if (allowCustom && query.trim()) {
          e.preventDefault()
          addValue(query)
        }
        break
      case 'Escape':
        setIsOpen(false)
        setHighlightIndex(-1)
        break
      case 'Backspace':
        if (!query && selected.length > 0) {
          onChange(selected.slice(0, -1))
        }
        break
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Input area with pills */}
      <div
        className="flex flex-wrap items-center gap-1.5 px-3 py-2 bg-bg-page border border-border-default rounded-lg focus-within:ring-2 focus-within:ring-surface transition-shadow cursor-text min-h-[42px]"
        onClick={() => inputRef.current?.focus()}
      >
        {/* Pills */}
        {selected.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-primary/15 text-primary text-sm font-medium"
          >
            {getLabel(value, normalized)}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                removeValue(value)
              }}
              className="hover:text-primary/70 transition-colors"
              aria-label={`Remove ${getLabel(value, normalized)}`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
        ))}

        {/* Text input */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIsOpen(true)
            setHighlightIndex(-1)
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={selected.length === 0 ? placeholder : ''}
          className="flex-1 min-w-[80px] bg-transparent outline-none text-text-primary placeholder:text-text-muted text-sm"
        />
      </div>

      {/* Dropdown */}
      {isOpen && filteredSuggestions.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-bg-card border border-border-default rounded-lg shadow-lg overflow-hidden">
          {filteredSuggestions.map((option, index) => (
            <button
              key={option.value}
              type="button"
              onClick={() => addValue(option.value)}
              onMouseEnter={() => setHighlightIndex(index)}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                index === highlightIndex
                  ? 'bg-bg-elevated text-text-primary'
                  : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
