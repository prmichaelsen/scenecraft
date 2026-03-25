import { createAPIFileRoute } from '@tanstack/start/api'

/**
 * Current TOS version — bump when terms change.
 * Consumers should check the user's accepted version against this.
 */
const CURRENT_TOS_VERSION = '1.0.0'

/**
 * Generic TOS consent service interface.
 * Replace with your own D1/database implementation.
 */
interface TosConsentService {
  getAcceptedVersion(userId: string): Promise<{
    version: string
    accepted_at: string
  } | null>
  acceptVersion(userId: string, version: string, ipAddress?: string): Promise<void>
}

/**
 * Placeholder implementation — replace with actual D1 queries.
 * Example D1 usage:
 *   const result = await env.DB.prepare('SELECT version, accepted_at FROM tos_consent WHERE user_id = ?')
 *     .bind(userId).first()
 */
const tosService: TosConsentService = {
  async getAcceptedVersion(_userId: string) {
    // TODO: implement with D1 or your database
    return null
  },
  async acceptVersion(_userId: string, _version: string, _ipAddress?: string) {
    // TODO: implement with D1 or your database
  },
}

export const APIRoute = createAPIFileRoute('/api/consent/tos')({
  GET: async ({ request }) => {
    try {
      // TODO: Replace with your auth session check
      // const session = await getServerSession(request)
      // if (!session?.user) { return json error 401 }
      const userId = '' // Replace with authenticated user ID

      if (!userId) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const consent = await tosService.getAcceptedVersion(userId)
      return new Response(
        JSON.stringify({
          hasAccepted: !!consent,
          currentVersion: CURRENT_TOS_VERSION,
          acceptedVersion: consent?.version ?? null,
          acceptedAt: consent?.accepted_at ?? null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }
  },

  POST: async ({ request }) => {
    try {
      // TODO: Replace with your auth session check
      const userId = '' // Replace with authenticated user ID

      if (!userId) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const ipAddress =
        request.headers.get('cf-connecting-ip') ??
        request.headers.get('x-forwarded-for') ??
        undefined

      await tosService.acceptVersion(userId, CURRENT_TOS_VERSION, ipAddress)

      return new Response(
        JSON.stringify({ accepted: true, version: CURRENT_TOS_VERSION }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }
  },
})
