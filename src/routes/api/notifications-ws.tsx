import { createAPIFileRoute } from '@tanstack/start/api'
import { env } from 'cloudflare:workers'

export const APIRoute = createAPIFileRoute('/api/notifications-ws')({
  GET: async ({ request }) => {
    // Must be a WebSocket upgrade request
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    try {
      // TODO: Replace with your auth session check
      // const session = await getServerSession(request)
      // if (!session?.user) {
      //   return new Response('Unauthorized', { status: 401 })
      // }
      // const userId = session.user.id

      // Forward WebSocket upgrade to user's NotificationHub DO
      // const id = (env as any).NOTIFICATION_HUB.idFromName(userId)
      // const stub = (env as any).NOTIFICATION_HUB.get(id)
      // return stub.fetch(request)

      return new Response('Not implemented — wire up auth and DO binding', { status: 501 })
    } catch {
      return new Response('Internal Server Error', { status: 500 })
    }
  },
})
