import { Link } from '@tanstack/react-router'
import { LogOut } from 'lucide-react'

export interface NavItem {
  label: string
  to: string
  icon?: React.ComponentType<{ className?: string }>
}

interface MenuDropdownProps {
  onClose: () => void
  /** Callback invoked when the user clicks "Log Out" */
  onLogout: () => void | Promise<void>
  /** Navigation items rendered as links */
  items?: NavItem[]
  /** Optional user info displayed in the dropdown */
  userEmail?: string
}

export function MenuDropdown({
  onClose,
  onLogout,
  items = [],
  userEmail,
}: MenuDropdownProps) {
  const linkClass =
    'flex items-center gap-3 px-3 py-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors font-medium'

  async function handleLogout() {
    await onLogout()
    onClose()
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed top-14 inset-x-0 bottom-0 bg-black/30 z-[51]"
        onClick={onClose}
      />

      {/* Dropdown panel */}
      <div className="fixed top-14 left-0 right-0 z-[52] bg-bg-card border-b border-border-default rounded-b-xl shadow-lg overflow-hidden">
        <div className="flex flex-col gap-1 px-3 py-3 max-h-[calc(100vh-3.5rem)] overflow-y-auto">
          {items.map((item) => (
            <Link key={item.to} to={item.to} onClick={onClose} className={linkClass}>
              {item.icon && <item.icon className="w-5 h-5" />}
              <span>{item.label}</span>
            </Link>
          ))}

          {userEmail && (
            <>
              <hr className="my-1 border-border-default" />
              <div className="px-3 py-2">
                <span className="text-sm text-text-muted truncate">
                  {userEmail}
                </span>
              </div>
            </>
          )}

          <hr className="my-1 border-border-default" />
          <button
            type="button"
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-text-secondary hover:text-danger hover:bg-bg-elevated transition-colors font-medium w-full text-left"
          >
            <LogOut className="w-5 h-5" />
            <span>Log Out</span>
          </button>
        </div>
      </div>
    </>
  )
}
