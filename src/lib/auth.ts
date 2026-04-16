/**
 * Auth module for scenecraft frontend.
 *
 * Uses HttpOnly cookie-based auth — no token stored in JS. The browser
 * automatically includes the `scenecraft_jwt` cookie on every same-origin
 * or credentialed cross-origin request.
 *
 * This module installs a global fetch() wrapper that:
 * 1. Adds `credentials: 'include'` so cookies travel cross-origin
 * 2. Intercepts 401 responses and redirects to the login page
 */

const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'
const LOGIN_PATH = '/login'

let authInstalled = false

/**
 * Install the global fetch wrapper. Call once at app startup.
 *
 * Idempotent — subsequent calls are no-ops.
 */
export function installAuthFetch() {
  if (authInstalled) return
  authInstalled = true

  const originalFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    // Only attach credentials for scenecraft API requests
    const isApi = url.startsWith(SCENECRAFT_API_URL) || url.startsWith('/api/') || url.startsWith('/auth/')

    const nextInit: RequestInit = isApi
      ? { ...init, credentials: init?.credentials ?? 'include' }
      : (init ?? {})

    const res = await originalFetch(input, nextInit)

    // On 401 for API requests, redirect to login (unless already on /login or /auth/*)
    if (isApi && res.status === 401) {
      const path = window.location.pathname
      if (path !== LOGIN_PATH && !path.startsWith('/auth/')) {
        window.location.href = LOGIN_PATH
      }
    }

    return res
  }
}

/**
 * POST /auth/logout — clears the HttpOnly cookie server-side and redirects to login.
 */
export async function logout() {
  try {
    await fetch(`${SCENECRAFT_API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch {
    // Ignore network errors — we'll redirect anyway
  }
  window.location.href = LOGIN_PATH
}
