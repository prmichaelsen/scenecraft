import { createAPIFileRoute } from '@tanstack/start/api'
import { initFirebaseAdmin } from '@/lib/firebase-admin'
import { getServerSession } from '@/lib/auth/session'

export const APIRoute = createAPIFileRoute('/api/auth/session')({
  GET: async ({ request }) => {
    initFirebaseAdmin()
    const session = await getServerSession(request)

    if (!session) {
      return new Response(
        JSON.stringify({ authenticated: false, user: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ authenticated: true, user: session.user }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  },
})
