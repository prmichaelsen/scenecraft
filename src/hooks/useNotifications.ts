import { useState, useEffect, useRef, useCallback } from 'react'

/** Generic notification interface matching the NotificationPanel contract */
export interface Notification {
  id: string
  type: string
  title: string
  message: string
  isRead: boolean
  createdAt: string
  data?: Record<string, unknown>
}

/** Configuration for the notifications hook */
export interface UseNotificationsConfig {
  /** WebSocket URL for real-time notifications (e.g., '/api/notifications-ws') */
  wsUrl: string
  /** REST API functions for notification operations */
  api: {
    fetchNotifications: (params: { limit: number }) => Promise<Notification[]>
    fetchUnreadCount: () => Promise<number>
    markAsRead: (id: string) => Promise<void>
    markAllAsRead: () => Promise<void>
    deleteNotification: (id: string) => Promise<void>
  }
}

interface UseNotificationsReturn {
  notifications: Notification[]
  unreadCount: number
  isConnected: boolean
  markAsRead: (id: string) => Promise<void>
  markAllAsRead: () => Promise<void>
  deleteNotification: (id: string) => Promise<void>
  refetch: () => Promise<void>
}

export function useNotifications(
  userId: string | undefined,
  config: UseNotificationsConfig
): UseNotificationsReturn {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [isConnected, setIsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  const refetch = useCallback(async () => {
    try {
      const [notifs, count] = await Promise.all([
        config.api.fetchNotifications({ limit: 20 }),
        config.api.fetchUnreadCount(),
      ])
      setNotifications(notifs)
      setUnreadCount(count)
    } catch {
      // Silently fail — user may not be authenticated yet
    }
  }, [config.api])

  useEffect(() => {
    if (!userId) return

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = config.wsUrl.startsWith('/')
      ? `${protocol}//${window.location.host}${config.wsUrl}`
      : config.wsUrl

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.addEventListener('open', () => {
      setIsConnected(true)
    })

    ws.addEventListener('close', () => {
      setIsConnected(false)
    })

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data) as { type: string; data: unknown }

        switch (msg.type) {
          case 'new_notification': {
            const notification = msg.data as Notification
            setNotifications((prev) => [notification, ...prev])
            setUnreadCount((c) => c + 1)
            break
          }
          case 'notification_read': {
            const { id } = msg.data as { id: string }
            setNotifications((prev) =>
              prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
            )
            setUnreadCount((c) => Math.max(0, c - 1))
            break
          }
          case 'notification_removed': {
            const { id } = msg.data as { id: string }
            setNotifications((prev) => prev.filter((n) => n.id !== id))
            // Refetch count since removed notification may have been unread
            config.api.fetchUnreadCount()
              .then((c) => setUnreadCount(c))
              .catch(() => {})
            break
          }
          case 'unread_count_update': {
            const { count } = msg.data as { count: number }
            setUnreadCount(count)
            break
          }
        }
      } catch {
        // Ignore malformed messages
      }
    })

    // Fetch initial data
    refetch()

    return () => {
      ws.close()
      wsRef.current = null
      setIsConnected(false)
    }
  }, [userId, config.wsUrl, refetch])

  const markAsRead = useCallback(async (id: string) => {
    try {
      await config.api.markAsRead(id)
      // Optimistic update — WebSocket broadcast will sync other tabs
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
      )
      setUnreadCount((c) => Math.max(0, c - 1))
    } catch {
      // Revert on error
      await refetch()
    }
  }, [config.api, refetch])

  const markAllAsRead = useCallback(async () => {
    try {
      await config.api.markAllAsRead()
      // Optimistic update
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })))
      setUnreadCount(0)
    } catch {
      await refetch()
    }
  }, [config.api, refetch])

  const deleteNotification = useCallback(async (id: string) => {
    try {
      await config.api.deleteNotification(id)
      // Optimistic update
      setNotifications((prev) => prev.filter((n) => n.id !== id))
    } catch {
      await refetch()
    }
  }, [config.api, refetch])

  return {
    notifications,
    unreadCount,
    isConnected,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    refetch,
  }
}
