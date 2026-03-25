import { ChevronUp, ChevronDown } from 'lucide-react'

interface SortIndicatorProps {
  direction: 'asc' | 'desc'
}

export function SortIndicator({ direction }: SortIndicatorProps) {
  const Icon = direction === 'asc' ? ChevronUp : ChevronDown
  return <Icon className="inline-block w-3.5 h-3.5 ml-1 text-text-secondary" />
}
