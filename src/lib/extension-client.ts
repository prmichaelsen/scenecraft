const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

// Types

export type ExtensionSearchResult = {
  name: string        // GitHub full_name e.g. "user/repo"
  description: string
  stars: number
  url: string         // html_url
  clone_url: string
  updated_at: string
}

export type InstalledExtension = {
  name: string
  version: string
  source: string      // clone URL
  installed_at: string
  path: string
}

// Search GitHub for extensions tagged with scenecraft-extension
export async function searchExtensions(query: string = ''): Promise<ExtensionSearchResult[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/extensions/search?q=${encodeURIComponent(query)}`)
  if (!res.ok) return []
  return res.json()
}

// Install extension from GitHub clone URL
export async function installExtension(cloneUrl: string): Promise<{ installed: string; version: string; path: string }> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/extensions/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clone_url: cloneUrl }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.errors ? err.errors.join(', ') : err.error || `Install failed: ${res.status}`)
  }
  return res.json()
}

// List installed extensions
export async function fetchInstalledExtensions(): Promise<InstalledExtension[]> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/extensions`)
  if (!res.ok) return []
  return res.json()
}

// Uninstall extension by name
export async function uninstallExtension(name: string): Promise<void> {
  const res = await fetch(`${SCENECRAFT_API_URL}/api/extensions/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `Uninstall failed: ${res.status}`)
  }
}
