import { Bell } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { NotificationPanel } from './NotificationPanel'
import type { Notification } from './NotificationPanel'

interface NotificationBellProps {
  /** Current unread notification count */
  unreadCount: number
  /** Full list of notifications to display in the panel */
  notifications: Notification[]
  /** Called when a notification is marked as read */
  onMarkAsRead: (id: string) => Promise<void>
  /** Called when all notifications are marked as read */
  onMarkAllAsRead: () => Promise<void>
  /** Called when a notification is deleted */
  onDelete: (id: string) => Promise<void>
  /** Optional icon resolver by notification type */
  getIcon?: (type: string) => React.ReactNode
}

export function NotificationBell({
  unreadCount,
  notifications,
  onMarkAsRead,
  onMarkAllAsRead,
  onDelete,
  getIcon,
}: NotificationBellProps) {
  const [panelOpen, setPanelOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close panel on click outside
  useEffect(() => {
    if (!panelOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [panelOpen])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setPanelOpen(!panelOpen)}
        className="relative p-2 text-text-secondary hover:text-text-primary transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-primary text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {panelOpen && (
        <NotificationPanel
          notifications={notifications}
          onMarkAsRead={onMarkAsRead}
          onMarkAllAsRead={onMarkAllAsRead}
          onDelete={onDelete}
          onClose={() => setPanelOpen(false)}
          getIcon={getIcon}
        />
      )}
    </div>
  )
}
