import { useState, useEffect, useCallback, useRef } from 'react'
import { searchExtensions, installExtension, fetchInstalledExtensions, uninstallExtension } from '@/lib/extension-client'
import type { ExtensionSearchResult, InstalledExtension } from '@/lib/extension-client'

type ExtensionsPanelProps = {
  onClose: () => void
}

export function ExtensionsPanel({ onClose }: ExtensionsPanelProps) {
  const [tab, setTab] = useState<'browse' | 'installed'>('browse')

  return (
    <div className="shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
        <div className="text-sm font-medium">Extensions</div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">
          &times;
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-800 shrink-0">
        <button
          onClick={() => setTab('browse')}
          className={`text-xs px-2.5 py-1 rounded ${tab === 'browse' ? 'bg-orange-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}
        >
          Browse
        </button>
        <button
          onClick={() => setTab('installed')}
          className={`text-xs px-2.5 py-1 rounded ${tab === 'installed' ? 'bg-orange-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}
        >
          Installed
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'browse' ? <BrowseTab /> : <InstalledTab />}
      </div>
    </div>
  )
}

// --- Browse Tab ---

function BrowseTab() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ExtensionSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installingUrl, setInstallingUrl] = useState<string | null>(null)
  const [installedUrls, setInstalledUrls] = useState<Set<string>>(new Set())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doSearch = useCallback(async (q: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await searchExtensions(q)
      setResults(data)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(value), 500)
  }, [doSearch])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  const handleInstall = useCallback(async (cloneUrl: string) => {
    setInstallingUrl(cloneUrl)
    setError(null)
    try {
      await installExtension(cloneUrl)
      setInstalledUrls((prev) => new Set(prev).add(cloneUrl))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstallingUrl(null)
    }
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div className="px-3 py-2 border-b border-gray-800 shrink-0">
        <input
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Search scenecraft extensions..."
          className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 text-xs text-red-400 bg-red-900/20 border-b border-gray-800 shrink-0">
          {error}
        </div>
      )}

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-600">Searching...</div>
        ) : results.length === 0 && query === '' ? (
          <div className="p-4 text-center text-sm text-gray-600">
            Search for scenecraft extensions on GitHub
          </div>
        ) : results.length === 0 ? (
          <div className="p-4 text-center text-sm text-gray-600">
            No extensions found
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {results.map((ext) => {
              const isInstalling = installingUrl === ext.clone_url
              const isInstalled = installedUrls.has(ext.clone_url)
              return (
                <div key={ext.name} className="px-3 py-2 group">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <a
                        href={ext.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-400 hover:text-blue-300 leading-snug block truncate"
                      >
                        {ext.name}
                      </a>
                      {ext.description && (
                        <div className="text-[10px] text-gray-500 mt-0.5 line-clamp-2">{ext.description}</div>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-gray-600">&#9733; {ext.stars}</span>
                        <span className="text-[10px] text-gray-600">
                          {new Date(ext.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleInstall(ext.clone_url)}
                      disabled={isInstalling || isInstalled}
                      className={`shrink-0 text-[10px] px-2 py-1 rounded ${
                        isInstalled
                          ? 'bg-gray-700 text-gray-500 cursor-default'
                          : isInstalling
                            ? 'bg-gray-700 text-gray-400 cursor-wait'
                            : 'bg-green-700 hover:bg-green-600 text-white'
                      }`}
                    >
                      {isInstalled ? 'Installed' : isInstalling ? 'Installing...' : 'Install'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Installed Tab ---

function InstalledTab() {
  const [extensions, setExtensions] = useState<InstalledExtension[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uninstallingName, setUninstallingName] = useState<string | null>(null)

  const loadExtensions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchInstalledExtensions()
      setExtensions(data)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadExtensions() }, [loadExtensions])

  const handleUninstall = useCallback(async (name: string) => {
    if (!confirm(`Uninstall extension "${name}"?`)) return
    setUninstallingName(name)
    setError(null)
    try {
      await uninstallExtension(name)
      loadExtensions()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUninstallingName(null)
    }
  }, [loadExtensions])

  return (
    <div className="flex flex-col h-full">
      {/* Error */}
      {error && (
        <div className="px-3 py-2 text-xs text-red-400 bg-red-900/20 border-b border-gray-800 shrink-0">
          {error}
        </div>
      )}

      {/* Extension list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-600">Loading...</div>
        ) : extensions.length === 0 ? (
          <div className="p-4 text-center text-sm text-gray-600">
            No extensions installed
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {extensions.map((ext) => {
              const isUninstalling = uninstallingName === ext.name
              return (
                <div key={ext.name} className="px-3 py-2 group">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-300 leading-snug truncate">{ext.name}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-gray-600">v{ext.version}</span>
                        <span className="text-[10px] text-gray-600">
                          {new Date(ext.installed_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </div>
                      {ext.source && (
                        <a
                          href={ext.source.replace(/\.git$/, '')}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-blue-400/60 hover:text-blue-300 truncate block mt-0.5"
                        >
                          {ext.source}
                        </a>
                      )}
                    </div>
                    <button
                      onClick={() => handleUninstall(ext.name)}
                      disabled={isUninstalling}
                      className="shrink-0 text-[10px] px-2 py-1 rounded bg-red-900/40 text-red-400 hover:bg-red-800/60 hover:text-red-300 disabled:text-gray-600 disabled:bg-gray-800 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      {isUninstalling ? 'Removing...' : 'Uninstall'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
