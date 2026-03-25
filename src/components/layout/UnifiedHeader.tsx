import { Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Menu, MoreVertical, X } from 'lucide-react'
import { useState } from 'react'

export const HEADER_HEIGHT_CLASS = 'pt-14'
export const HEADER_TOP_CLASS = 'top-14'

export interface NavItem {
  label: string
  to: string
  icon?: React.ComponentType<{ className?: string }>
}

interface UnifiedHeaderProps {
  /** App brand name displayed when no title is set */
  brandName?: string
  /** Route the brand name links to */
  brandTo?: string
  title?: string
  icon?: React.ReactNode
  /** Callback for the ellipsis button. When provided, renders the MoreVertical button. */
  onEllipsisPress?: () => void
  headerActions?: React.ReactNode
  /** Slot for notification bell or other trailing icons */
  notificationSlot?: React.ReactNode
  /** Slot for the dropdown menu content rendered when hamburger is open */
  menuContent?: React.ReactNode
  children?: React.ReactNode
}

export function UnifiedHeader({
  brandName = '{{APP_NAME}}',
  brandTo = '/',
  title,
  icon,
  onEllipsisPress,
  headerActions,
  notificationSlot,
  menuContent,
  children,
}: UnifiedHeaderProps) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <>
      <header
        className="fixed top-0 left-0 right-0 z-50 bg-bg-page border-b border-border-default"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
      <div className="h-14 flex items-center justify-between px-4 max-w-3xl mx-auto">
        {/* Left: Back button or Logo */}
        <div className="flex items-center gap-2">
          {title ? (
            <>
              <button
                type="button"
                onClick={() => router.history.back()}
                className="p-1 text-text-secondary hover:text-text-primary transition-colors"
                aria-label="Go back"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-2">
                {icon}
                <span className="font-semibold text-text-primary truncate max-w-[200px]">
                  {title}
                </span>
              </div>
            </>
          ) : (
            <Link
              to={brandTo}
              className="text-xl font-bold bg-gradient-to-r from-[var(--color-primary,#6366f1)] to-[var(--color-primary-alt,#8b5cf6)] bg-clip-text text-transparent"
            >
              {brandName}
            </Link>
          )}
        </div>

        {/* Right: Actions, Notifications, Menu */}
        <div className="flex items-center gap-1">
          {headerActions}
          {children}
          {onEllipsisPress && (
            <button
              type="button"
              onClick={onEllipsisPress}
              className="p-2 text-text-secondary hover:text-text-primary transition-colors"
              aria-label="Page actions"
            >
              <MoreVertical className="w-5 h-5" />
            </button>
          )}
          {notificationSlot}
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-2 text-text-secondary hover:text-text-primary transition-colors"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          >
            {menuOpen ? (
              <X className="w-5 h-5" />
            ) : (
              <Menu className="w-5 h-5" />
            )}
          </button>
        </div>
      </div>
      </header>

      {/* Dropdown Menu */}
      {menuOpen && menuContent && (
        <div className="fixed left-1/2 -translate-x-1/2 top-14 z-[51] w-full max-w-3xl max-h-[calc(100vh-3.5rem)] bg-bg-page border-x border-border-default border-b border-border-default rounded-b-xl shadow-lg overflow-hidden">
          <div className="flex flex-col gap-1 px-4 py-4">
            {menuContent}
          </div>
        </div>
      )}
    </>
  )
}
