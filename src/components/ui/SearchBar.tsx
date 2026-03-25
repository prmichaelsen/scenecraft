import { X } from 'lucide-react'
import { useGlobalSearch } from '../../contexts/GlobalSearchContext'

interface SearchBarProps {
  searchKey: string
  placeholder?: string
  className?: string
}

export function SearchBar({
  searchKey,
  placeholder = 'Search...',
  className,
}: SearchBarProps) {
  const [query, setQuery] = useGlobalSearch(searchKey)
  return (
    <div className={`relative ${className ?? ''}`}>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full max-w-xs px-3 py-2 rounded-lg bg-bg-elevated border border-border-default text-text-primary placeholder:text-text-muted focus:ring-2 focus:ring-primary focus:outline-none"
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
