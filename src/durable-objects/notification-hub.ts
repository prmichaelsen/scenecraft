import { DurableObject } from 'cloudflare:workers'

export type NotificationEventType =
  | 'new_notification'
  | 'notification_read'
  | 'notification_removed'
  | 'unread_count_update'

export interface NotificationEvent {
  type: NotificationEventType
  data: unknown
}

/**
 * NotificationHub Durable Object
 *
 * Per-user WebSocket hub for real-time notification delivery.
 * One instance per user (`idFromName(userId)`).
 *
 * Push-only channel — clients connect and receive events but never send messages.
 * Multiple tabs from the same user all connect to the same DO instance,
 * enabling multi-tab sync (e.g., mark-as-read in one tab updates all tabs).
 *
 * Endpoints:
 * - WebSocket upgrade (default) — connect a client tab
 * - POST /broadcast — send event to all connected tabs
 * - GET /connected — check if user has active connections
 */
export class NotificationHub extends DurableObject {
  private sessions: Set<WebSocket> = new Set()

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // POST /broadcast — send event to all connected tabs
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const event = (await request.json()) as NotificationEvent
      this.broadcast(event)
      return new Response('ok')
    }

    // GET /connected — check if user has active connections
    if (url.pathname === '/connected') {
      return Response.json({
        connected: this.sessions.size > 0,
        count: this.sessions.size,
      })
    }

    // WebSocket upgrade
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    this.sessions.add(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketClose(ws: WebSocket): void {
    this.sessions.delete(ws)
  }

  webSocketError(ws: WebSocket): void {
    this.sessions.delete(ws)
  }

  private broadcast(event: NotificationEvent): void {
    const payload = JSON.stringify(event)
    for (const ws of this.sessions) {
      try {
        ws.send(payload)
      } catch {
        this.sessions.delete(ws)
      }
    }
  }
}
