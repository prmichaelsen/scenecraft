/**
 * Spec tests: auth-jwt-api-keys-double-gate (local, v1.0.0)
 *
 * Tests the frontend auth surface defined in src/lib/auth.ts against the
 * observable behaviors specified in agent/specs/local.auth-jwt-api-keys-double-gate.md.
 *
 * The spec is primarily server-side (JWT signing, PBKDF2, SQLite schema, etc.).
 * These tests cover the **frontend-observable** subset:
 *   - Cookie-based auth transport (R4, R5)
 *   - Bearer/cookie extraction precedence — frontend always uses cookies via
 *     credentials:'include', but the 401 redirect logic is tested (R5, R11)
 *   - 401 interception and login redirect (R11, R19)
 *   - Logout flow: POST /auth/logout + redirect (R4 cookie-clear)
 *   - Public/exempt route handling (R19)
 *   - Double-gate bearer-first, cookie-fallback from the frontend perspective (R11)
 *   - installAuthFetch idempotency
 *
 * Environment: vitest + happy-dom. fetch and location are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// We need to dynamically import auth.ts after setting up mocks, because it
// captures import.meta.env at module load time.
let installAuthFetch: typeof import('../auth')['installAuthFetch']
let logout: typeof import('../auth')['logout']

const SCENECRAFT_API_URL = 'http://localhost:8890'

describe('spec-auth-jwt-api-keys-double-gate — frontend auth surface', () => {
  let originalFetch: typeof globalThis.fetch
  let mockFetch: ReturnType<typeof vi.fn>

  // Track location.href assignments
  let locationHrefSetter: ReturnType<typeof vi.fn>
  let currentPathname: string

  beforeEach(async () => {
    // Reset module state so installAuthFetch's idempotency guard resets
    vi.resetModules()

    // Set up env before importing
    vi.stubEnv('VITE_SCENECRAFT_API_URL', SCENECRAFT_API_URL)

    const authModule = await import('../auth')
    installAuthFetch = authModule.installAuthFetch
    logout = authModule.logout

    // Save real fetch and install a mock
    mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch

    // Mock window.location
    currentPathname = '/project/foo/editor'
    locationHrefSetter = vi.fn()

    Object.defineProperty(window, 'location', {
      value: {
        get pathname() {
          return currentPathname
        },
        get href() {
          return `http://localhost:3000${currentPathname}`
        },
        set href(val: string) {
          locationHrefSetter(val)
          // Update pathname to match
          try {
            const url = new URL(val, 'http://localhost:3000')
            currentPathname = url.pathname
          } catch {
            currentPathname = val
          }
        },
      },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.unstubAllEnvs()
  })

  // ---------------------------------------------------------------------------
  // R4: Cookie transport — credentials:'include' ensures HttpOnly cookie travels
  // ---------------------------------------------------------------------------
  describe('R4 — cookie transport via credentials:include', () => {
    it('cookie-default: API requests include credentials by default', async () => {
      installAuthFetch()
      await fetch(`${SCENECRAFT_API_URL}/api/scenes`)
      expect(mockFetch).toHaveBeenCalledOnce()
      const [, init] = mockFetch.mock.calls[0]
      expect(init?.credentials).toBe('include')
    })

    it('cookie-default: /api/ prefixed requests include credentials', async () => {
      installAuthFetch()
      await fetch('/api/scenes')
      expect(mockFetch).toHaveBeenCalledOnce()
      const [, init] = mockFetch.mock.calls[0]
      expect(init?.credentials).toBe('include')
    })

    it('cookie-default: /auth/ prefixed requests include credentials', async () => {
      installAuthFetch()
      await fetch('/auth/login?code=abc')
      expect(mockFetch).toHaveBeenCalledOnce()
      const [, init] = mockFetch.mock.calls[0]
      expect(init?.credentials).toBe('include')
    })

    it('cookie-no-external: non-API requests do NOT force credentials', async () => {
      installAuthFetch()
      await fetch('https://cdn.example.com/asset.png')
      expect(mockFetch).toHaveBeenCalledOnce()
      const [, init] = mockFetch.mock.calls[0]
      expect(init?.credentials).toBeUndefined()
    })

    it('cookie-preserve-override: explicit credentials setting is preserved', async () => {
      installAuthFetch()
      await fetch(`${SCENECRAFT_API_URL}/api/scenes`, { credentials: 'omit' })
      expect(mockFetch).toHaveBeenCalledOnce()
      const [, init] = mockFetch.mock.calls[0]
      // The code uses ?? so explicit 'omit' should be preserved
      expect(init?.credentials).toBe('omit')
    })
  })

  // ---------------------------------------------------------------------------
  // R5, R11: Token extraction precedence — bearer first, cookie fallback
  // The frontend always sends cookies; the server extracts bearer first.
  // From the frontend perspective, we test that cookies are always attached.
  // ---------------------------------------------------------------------------
  describe('R5/R11 — double-gate bearer-first, cookie-fallback (frontend perspective)', () => {
    it('bearer-and-cookie-bearer-wins: frontend sends cookies; server decides precedence', async () => {
      // The frontend auth module does NOT set Authorization headers — it relies
      // on HttpOnly cookies. Bearer tokens are an API-key / programmatic concern.
      // This test verifies the frontend does not inject a Bearer header.
      installAuthFetch()
      await fetch(`${SCENECRAFT_API_URL}/api/data`)
      const [, init] = mockFetch.mock.calls[0]
      expect(init?.headers).toBeUndefined()
      // credentials: 'include' ensures the cookie travels
      expect(init?.credentials).toBe('include')
    })
  })

  // ---------------------------------------------------------------------------
  // R11: 401 handling — expired/missing token -> redirect to /login
  // ---------------------------------------------------------------------------
  describe('R11 — 401 interception and login redirect', () => {
    it('dg-no-token / status-401: API 401 redirects to /login', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      installAuthFetch()

      currentPathname = '/project/foo/editor'
      await fetch(`${SCENECRAFT_API_URL}/api/scenes`)

      expect(locationHrefSetter).toHaveBeenCalledWith('/login')
    })

    it('status-401: /api/ prefixed 401 also redirects', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      installAuthFetch()

      currentPathname = '/project/bar/editor'
      await fetch('/api/fixtures')

      expect(locationHrefSetter).toHaveBeenCalledWith('/login')
    })

    it('status-401: /auth/ prefixed 401 also redirects (for non-login paths)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      installAuthFetch()

      currentPathname = '/project/baz'
      await fetch('/auth/check')

      expect(locationHrefSetter).toHaveBeenCalledWith('/login')
    })

    it('no-redirect-on-200: successful API response does not redirect', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
      installAuthFetch()

      await fetch(`${SCENECRAFT_API_URL}/api/scenes`)
      expect(locationHrefSetter).not.toHaveBeenCalled()
    })

    it('no-redirect-on-403: non-401 errors do not trigger login redirect', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Forbidden', { status: 403 }),
      )
      installAuthFetch()

      await fetch(`${SCENECRAFT_API_URL}/api/scenes`)
      expect(locationHrefSetter).not.toHaveBeenCalled()
    })

    it('no-redirect-on-500: server errors do not trigger login redirect', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      )
      installAuthFetch()

      await fetch(`${SCENECRAFT_API_URL}/api/scenes`)
      expect(locationHrefSetter).not.toHaveBeenCalled()
    })

    it('non-api-401-ignored: external 401 does NOT redirect', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      installAuthFetch()

      await fetch('https://other-service.com/api/data')
      expect(locationHrefSetter).not.toHaveBeenCalled()
    })

    it('returns-response: 401 redirect still returns the response to caller', async () => {
      const res401 = new Response('Unauthorized', { status: 401 })
      mockFetch.mockResolvedValueOnce(res401)
      installAuthFetch()

      const result = await fetch(`${SCENECRAFT_API_URL}/api/scenes`)
      expect(result.status).toBe(401)
    })
  })

  // ---------------------------------------------------------------------------
  // R19: Exempt paths — /login and /auth/* skip 401 redirect
  // ---------------------------------------------------------------------------
  describe('R19 — exempt paths do not trigger 401 redirect', () => {
    it('exempt-login: 401 on /login page does not redirect (avoids loop)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      installAuthFetch()

      currentPathname = '/login'
      await fetch(`${SCENECRAFT_API_URL}/api/user/me`)

      expect(locationHrefSetter).not.toHaveBeenCalled()
    })

    it('exempt-auth-login: 401 on /auth/login does not redirect', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      installAuthFetch()

      currentPathname = '/auth/login'
      await fetch(`${SCENECRAFT_API_URL}/api/user/me`)

      expect(locationHrefSetter).not.toHaveBeenCalled()
    })

    it('exempt-auth-callback: 401 on /auth/callback does not redirect', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      installAuthFetch()

      currentPathname = '/auth/callback'
      await fetch(`${SCENECRAFT_API_URL}/api/user/me`)

      expect(locationHrefSetter).not.toHaveBeenCalled()
    })

    it('non-exempt-path-redirects: 401 on normal page does redirect', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      installAuthFetch()

      currentPathname = '/project/foo/editor'
      await fetch(`${SCENECRAFT_API_URL}/api/scenes`)

      expect(locationHrefSetter).toHaveBeenCalledWith('/login')
    })
  })

  // ---------------------------------------------------------------------------
  // R4 cookie-clear + Logout flow: POST /auth/logout, clear cookie, redirect
  // ---------------------------------------------------------------------------
  describe('R4/Logout — clear token, POST /auth/logout, redirect to /login', () => {
    it('logout-posts-to-server: logout() POSTs to /auth/logout with credentials', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      await logout()

      expect(mockFetch).toHaveBeenCalledWith(
        `${SCENECRAFT_API_URL}/auth/logout`,
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
        }),
      )
    })

    it('logout-redirects: logout() redirects to /login', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      await logout()

      expect(locationHrefSetter).toHaveBeenCalledWith('/login')
    })

    it('logout-redirects-on-network-error: logout() redirects even if POST fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      await logout()

      expect(locationHrefSetter).toHaveBeenCalledWith('/login')
    })
  })

  // ---------------------------------------------------------------------------
  // installAuthFetch idempotency
  // ---------------------------------------------------------------------------
  describe('installAuthFetch — idempotency', () => {
    it('idempotent: calling installAuthFetch twice does not double-wrap fetch', async () => {
      installAuthFetch()
      const fetchAfterFirst = globalThis.fetch

      installAuthFetch()
      const fetchAfterSecond = globalThis.fetch

      // The function reference should be the same (second call is a no-op)
      expect(fetchAfterFirst).toBe(fetchAfterSecond)
    })

    it('idempotent: double install still works correctly', async () => {
      installAuthFetch()
      installAuthFetch()

      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
      await fetch(`${SCENECRAFT_API_URL}/api/test`)

      // Should only call the underlying mock once (not wrapped twice)
      expect(mockFetch).toHaveBeenCalledOnce()
    })
  })

  // ---------------------------------------------------------------------------
  // R6/R7: Login-code handshake — frontend perspective
  // The login flow is: GET /auth/login?code=<code> -> server sets cookie -> redirect
  // From the frontend, we verify the login page exists and the code param flow.
  // ---------------------------------------------------------------------------
  describe('R6/R7 — login-code handshake (frontend observable)', () => {
    it('login-code-consumed-via-url: /auth/login requests carry credentials', async () => {
      installAuthFetch()
      await fetch('/auth/login?code=abc123')

      const [, init] = mockFetch.mock.calls[0]
      expect(init?.credentials).toBe('include')
    })
  })

  // ---------------------------------------------------------------------------
  // URL handling edge cases — Request objects, URL objects
  // ---------------------------------------------------------------------------
  describe('URL input handling', () => {
    it('handles URL object input', async () => {
      installAuthFetch()
      const url = new URL('/api/test', SCENECRAFT_API_URL)
      await fetch(url)

      expect(mockFetch).toHaveBeenCalledOnce()
      const [, init] = mockFetch.mock.calls[0]
      expect(init?.credentials).toBe('include')
    })

    it('handles Request object input', async () => {
      installAuthFetch()
      const req = new Request(`${SCENECRAFT_API_URL}/api/test`)
      await fetch(req)

      expect(mockFetch).toHaveBeenCalledOnce()
      const [, init] = mockFetch.mock.calls[0]
      expect(init?.credentials).toBe('include')
    })

    it('handles string input', async () => {
      installAuthFetch()
      await fetch(`${SCENECRAFT_API_URL}/api/test`)

      expect(mockFetch).toHaveBeenCalledOnce()
      const [, init] = mockFetch.mock.calls[0]
      expect(init?.credentials).toBe('include')
    })
  })
})
