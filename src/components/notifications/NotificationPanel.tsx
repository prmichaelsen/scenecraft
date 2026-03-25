import { Trash2, Bell } from 'lucide-react'

/** Generic notification interface */
export interface Notification {
  id: string
  type: string
  title: string
  message: string
  isRead: boolean
  createdAt: string
  /** Optional data payload (e.g., { link: '/some/path' }) */
  data?: Record<string, unknown>
}

interface NotificationPanelProps {
  notifications: Notification[]
  onMarkAsRead: (id: string) => Promise<void>
  onMarkAllAsRead: () => Promise<void>
  onDelete: (id: string) => Promise<void>
  onClose: () => void
  /** Optional icon resolver — receives notification type, returns a React node */
  getIcon?: (type: string) => React.ReactNode
}

function defaultGetIcon(_type: string) {
  return <Bell className="w-4 h-4 text-text-secondary" />
}

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const seconds = Math.floor((now - then) / 1000)

  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

export function NotificationPanel({
  notifications,
  onMarkAsRead,
  onMarkAllAsRead,
  onDelete,
  onClose,
  getIcon = defaultGetIcon,
}: NotificationPanelProps) {
  const handleNotificationClick = async (notification: Notification) => {
    if (!notification.isRead) {
      await onMarkAsRead(notification.id)
    }

    // Navigate if link is available
    const link = notification.data?.link as string | undefined
    if (link) {
      onClose()
      window.location.href = link
    }
  }

  return (
    <div className="absolute right-0 top-full mt-2 w-80 max-h-96 bg-bg-card border border-border-default rounded-xl shadow-lg overflow-hidden z-50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
        <h3 className="text-sm font-semibold text-text-primary">
          Notifications
        </h3>
        {notifications.some((n) => !n.isRead) && (
          <button
            type="button"
            onClick={onMarkAllAsRead}
            className="text-xs text-primary hover:text-bridge transition-colors"
          >
            Mark all read
          </button>
        )}
      </div>

      {/* Notification List */}
      <div className="overflow-y-auto max-h-80">
        {notifications.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <Bell className="w-8 h-8 text-text-muted mx-auto mb-2" />
            <p className="text-sm text-text-muted">No notifications</p>
          </div>
        ) : (
          notifications.map((notification) => (
            <div
              key={notification.id}
              className={`flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-bg-elevated transition-colors border-b border-border-subtle ${
                !notification.isRead ? 'bg-surface/10' : ''
              }`}
              onClick={() => handleNotificationClick(notification)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNotificationClick(notification)
              }}
            >
              {/* Icon */}
              <div className="mt-0.5 shrink-0">
                {getIcon(notification.type)}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <p
                  className={`text-sm leading-tight ${
                    !notification.isRead
                      ? 'font-medium text-text-primary'
                      : 'text-text-secondary'
                  }`}
                >
                  {notification.title}
                </p>
                <p className="text-xs text-text-muted mt-0.5 truncate">
                  {notification.message}
                </p>
                <p className="text-[10px] text-text-muted mt-1">
                  {timeAgo(notification.createdAt)}
                </p>
              </div>

              {/* Unread dot + delete */}
              <div className="flex items-center gap-1 shrink-0">
                {!notification.isRead && (
                  <div className="w-2 h-2 rounded-full bg-primary" />
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(notification.id)
                  }}
                  className="p-1 text-text-muted hover:text-danger transition-colors opacity-0 group-hover:opacity-100"
                  aria-label="Delete notification"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
