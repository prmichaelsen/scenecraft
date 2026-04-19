import { useState, useEffect, useCallback } from 'react'
import { fetchOAuthStatus, startOAuthFlow, openOAuthPopup, disconnectOAuth, type OAuthService, type OAuthStatus } from '@/lib/oauth-client'

type MCPPanelProps = {
  onClose: () => void
}

type ServiceDef = {
  id: OAuthService
  name: string
  description: string
}

// Services that appear in the MCP panel. Extend this list (and the backend
// SERVICES registry) to expose additional OAuth-backed MCP integrations.
const SERVICES: ServiceDef[] = [
  {
    id: 'remember',
    name: 'Remember',
    description: 'Persistent memory, semantic search, and relationship graph. Exposes ~29 tools to chat (remember_create_memory, remember_search_memory, remember_publish, …).',
  },
]

export function MCPPanel({ onClose: _onClose }: MCPPanelProps) {
  return (
    <div className="flex flex-col h-full bg-[#111827] text-gray-300">
      <div className="px-3 py-2 border-b border-gray-800 shrink-0">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">MCP Integrations</div>
        <div className="text-[10px] text-gray-600 mt-0.5">
          Connect external tool servers via agentbase.me OAuth. Once connected, their tools appear in the chat assistant's tool list.
        </div>
      </div>
      <div className="flex-1 overflow-y-auto divide-y divide-gray-800">
        {SERVICES.map(svc => <ServiceRow key={svc.id} service={svc} />)}
      </div>
    </div>
  )
}

// --- Service Row ---

function ServiceRow({ service }: { service: ServiceDef }) {
  const [status, setStatus] = useState<OAuthStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchOAuthStatus(service.id))
    } catch {
      setStatus({ connected: false })
    }
  }, [service.id])

  useEffect(() => { refresh() }, [refresh])

  const handleConnect = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const url = await startOAuthFlow(service.id)
      const result = await openOAuthPopup(url)
      if (!result.success) {
        setError(result.message || 'Connection failed')
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [service.id, refresh])

  const handleDisconnect = useCallback(async () => {
    if (!confirm(`Disconnect ${service.name}? You can reconnect anytime.`)) return
    setBusy(true)
    setError(null)
    try {
      await disconnectOAuth(service.id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [service.id, service.name, refresh])

  const connected = status?.connected === true
  const expiresAt = connected ? new Date((status as Extract<OAuthStatus, { connected: true }>).expires_at) : null
  const expiresIn = expiresAt
    ? Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 60000))
    : null

  return (
    <div className="px-3 py-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-200">{service.name}</span>
            {status === null ? (
              <span className="text-[9px] text-gray-600">…</span>
            ) : connected ? (
              <span className="text-[9px] text-green-500 inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-green-500 rounded-full" /> Connected
              </span>
            ) : (
              <span className="text-[9px] text-gray-500 inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-gray-600 rounded-full" /> Not connected
              </span>
            )}
          </div>
          <div className="text-[10px] text-gray-500 leading-snug mt-0.5">{service.description}</div>
        </div>
        <div className="shrink-0">
          {connected ? (
            <button
              onClick={handleDisconnect}
              disabled={busy}
              className="text-[10px] px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50"
            >
              {busy ? '…' : 'Disconnect'}
            </button>
          ) : (
            <button
              onClick={handleConnect}
              disabled={busy}
              className="text-[10px] px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="text-[10px] text-red-400 bg-red-900/20 border border-red-800/30 rounded px-2 py-1">
          {error}
        </div>
      )}

      {connected && expiresAt && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] text-gray-600 font-mono">
          <div>token expires</div>
          <div className="text-gray-500 text-right">
            {expiresAt.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            {expiresIn !== null && ` · in ${expiresIn}m`}
          </div>
          <div>refresh</div>
          <div className="text-gray-500 text-right">
            {(status as Extract<OAuthStatus, { connected: true }>).has_refresh_token ? 'enabled' : 'missing'}
          </div>
        </div>
      )}
    </div>
  )
}
