import { Link } from '@tanstack/react-router'

export interface NavItem {
  label: string
  to: string
  icon?: React.ComponentType<{ className?: string }>
  /** When true, only match this route exactly */
  exact?: boolean
}

interface MobileBottomNavProps {
  items: NavItem[]
  /** CSS class applied to the active link (defaults to 'text-primary') */
  activeClassName?: string
}

export function MobileBottomNav({
  items,
  activeClassName = 'text-primary',
}: MobileBottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 h-16 bg-bg-page border-t border-border-default flex items-center justify-around z-50 md:hidden">
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="flex flex-col items-center gap-0.5 px-3 py-1.5 text-text-muted hover:text-text-primary transition-colors"
          activeProps={{ className: activeClassName }}
          activeOptions={{ exact: item.exact }}
        >
          {item.icon && <item.icon className="w-5 h-5" />}
          <span className="text-[10px] font-medium">{item.label}</span>
        </Link>
      ))}
    </nav>
  )
}
