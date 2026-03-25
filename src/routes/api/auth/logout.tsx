import { createAPIFileRoute } from '@tanstack/start/api'
import { buildClearSessionCookieHeader } from '@/lib/auth/session'

export const APIRoute = createAPIFileRoute('/api/auth/logout')({
  POST: async () => {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': buildClearSessionCookieHeader(),
      },
    })
  },
})
