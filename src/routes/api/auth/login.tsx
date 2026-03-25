import { createAPIFileRoute } from '@tanstack/start/api'
import { initFirebaseAdmin } from '@/lib/firebase-admin'
import { createSessionCookie, buildSessionCookieHeader } from '@/lib/auth/session'
import { verifyIdToken } from '@prmichaelsen/firebase-admin-sdk-v8'

export const APIRoute = createAPIFileRoute('/api/auth/login')({
  POST: async ({ request }) => {
    initFirebaseAdmin()

    try {
      const { idToken } = await request.json()
      if (!idToken) {
        return new Response(JSON.stringify({ error: 'Missing idToken' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const decoded = await verifyIdToken(idToken)
      const sessionCookie = await createSessionCookie(idToken)

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': buildSessionCookieHeader(sessionCookie),
        },
      })
    } catch (error: any) {
      return new Response(JSON.stringify({ error: 'Authentication failed' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  },
})
