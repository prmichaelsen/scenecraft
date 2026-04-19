const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

export type OAuthService = 'remember'

export type OAuthStatus =
  | { connected: false }
  | {
      connected: true
      expires_at: string
      has_refresh_token: boolean
      created_at: string
      updated_at: string
    }

export type OAuthCallbackMessage = {
  type: 'scenecraft-oauth-callback'
  success: boolean
  service: string
  message: string
}

export async function fetchOAuthStatus(service: OAuthService): Promise<OAuthStatus> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/oauth/${service}/status`, { credentials: 'include' })
  if (!res.ok) return { connected: false }
  return res.json()
}

export async function startOAuthFlow(service: OAuthService): Promise<string> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/oauth/${service}/authorize`, { credentials: 'include' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `Failed to start OAuth flow: ${res.status}`)
  }
  const data = await res.json() as { url: string; state: string }
  return data.url
}

export async function disconnectOAuth(service: OAuthService): Promise<boolean> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/oauth/${service}/disconnect`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) return false
  const data = await res.json() as { disconnected: boolean }
  return data.disconnected
}

/**
 * Open the OAuth consent URL in a popup window and resolve when the callback
 * page posts a message back. Rejects on timeout or if the user closes the popup.
 */
export function openOAuthPopup(url: string, timeoutMs = 5 * 60 * 1000): Promise<OAuthCallbackMessage> {
  return new Promise((resolve, reject) => {
    const popup = window.open(
      url,
      'scenecraft-oauth',
      'width=540,height=720,menubar=no,toolbar=no,location=no',
    )
    if (!popup) {
      reject(new Error('Popup blocked. Please allow popups for this site.'))
      return
    }

    const start = Date.now()
    let settled = false

    const cleanup = () => {
      settled = true
      window.removeEventListener('message', onMessage)
      clearInterval(watchdog)
    }

    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || data.type !== 'scenecraft-oauth-callback') return
      cleanup()
      try { popup.close() } catch {}
      resolve(data as OAuthCallbackMessage)
    }
    window.addEventListener('message', onMessage)

    const watchdog = setInterval(() => {
      if (settled) return
      if (Date.now() - start > timeoutMs) {
        cleanup()
        try { popup.close() } catch {}
        reject(new Error('OAuth flow timed out'))
        return
      }
      if (popup.closed) {
        cleanup()
        reject(new Error('OAuth window closed before completion'))
      }
    }, 500)
  })
}
