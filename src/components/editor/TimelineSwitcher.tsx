import { useState, useCallback, useEffect } from 'react'
import {
  fetchTimelines,
  postSwitchTimeline,
  postCreateTimeline,
  type TimelineInfo,
} from '@/lib/timeline-client'

type TimelineSwitcherProps = {
  projectName: string
  onSwitch: () => void
}

export function TimelineSwitcher({ projectName, onSwitch }: TimelineSwitcherProps) {
  const [info, setInfo] = useState<TimelineInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [copyFrom, setCopyFrom] = useState('')

  const loadTimelines = useCallback(async () => {
    try {
      const data = await fetchTimelines(projectName)
      setInfo(data)
    } catch {
      // Backend doesn't support timelines yet — hide the switcher
      setInfo(null)
    }
  }, [projectName])

  useEffect(() => { loadTimelines() }, [loadTimelines])

  const handleSwitch = useCallback(async (name: string) => {
    setLoading(true)
    try {
      await postSwitchTimeline(projectName, name)
      await loadTimelines()
      onSwitch()
    } finally {
      setLoading(false)
      setShowMenu(false)
    }
  }, [projectName, loadTimelines, onSwitch])

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return
    setLoading(true)
    try {
      await postCreateTimeline(projectName, newName.trim(), copyFrom || undefined)
      setNewName('')
      setCopyFrom('')
      setShowCreate(false)
      await loadTimelines()
      onSwitch()
    } finally {
      setLoading(false)
    }
  }, [newName, copyFrom, projectName, loadTimelines, onSwitch])

  // Don't render if backend doesn't support timelines
  if (!info || info.timelines.length === 0) return null

  // Only show switcher if there are multiple timelines or user might want to create one
  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-2 py-1 rounded transition-colors flex items-center gap-1"
        title="Switch timeline"
      >
        <span className="text-purple-400 font-mono">{info.active}</span>
        {info.timelines.length > 1 && <span className="text-gray-600">({info.timelines.length})</span>}
      </button>

      {showMenu && (
        <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 min-w-[200px]">
          <div className="py-1">
            {info.timelines.map((name) => (
              <button
                key={name}
                onClick={() => handleSwitch(name)}
                disabled={loading || name === info.active}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  name === info.active
                    ? 'text-purple-400 bg-purple-900/20'
                    : 'text-gray-300 hover:bg-gray-700'
                }`}
              >
                {name} {name === info.active && '(active)'}
              </button>
            ))}
          </div>

          <div className="border-t border-gray-700 p-2 space-y-1">
            {!showCreate ? (
              <button
                onClick={() => setShowCreate(true)}
                className="text-[10px] text-blue-400 hover:text-blue-300"
              >
                + New timeline
              </button>
            ) : (
              <div className="space-y-1">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="timeline-name"
                  className="w-full bg-gray-900 text-xs text-gray-300 rounded px-2 py-1 border border-gray-600 focus:border-blue-500 focus:outline-none"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
                  autoFocus
                />
                <div className="flex items-center gap-1">
                  <select
                    value={copyFrom}
                    onChange={(e) => setCopyFrom(e.target.value)}
                    className="flex-1 bg-gray-900 text-[10px] text-gray-400 rounded px-1 py-0.5 border border-gray-600"
                  >
                    <option value="">Empty timeline</option>
                    {info.timelines.map((t) => (
                      <option key={t} value={t}>Copy from: {t}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleCreate}
                    disabled={!newName.trim() || loading}
                    className="text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded disabled:bg-gray-700"
                  >
                    Create
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
