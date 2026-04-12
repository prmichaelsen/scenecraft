import { useState, useCallback, useEffect } from 'react'
import { fetchSettings, postUpdateSettings, type ProjectSettings } from '@/lib/settings-client'
import { updateMeta } from '@/routes/project/$name/editor'
import type { EditorData } from '@/routes/project/$name/editor'
import { fetchPromptRoster, postAddPromptRoster, postUpdatePromptRoster, postRemovePromptRoster, type PromptRosterEntry } from '@/lib/beatlab-client'

type SettingsPanelProps = {
  data: EditorData
  projectName: string
  onClose: () => void
  onSave: () => void
  onPreviewQualityChange?: (quality: number) => void
}

const PLAYBACK_SPEED_KEY = 'beatlab-playback-speed'

export function SettingsPanel({ data, projectName, onClose, onSave, onPreviewQualityChange }: SettingsPanelProps) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Project meta (editable)
  const [title, setTitle] = useState(data.meta.title)
  const [fps, setFps] = useState(String(data.meta.fps))
  const [resW, setResW] = useState(String(data.meta.resolution[0]))
  const [resH, setResH] = useState(String(data.meta.resolution[1]))
  const [motionPrompt, setMotionPrompt] = useState(data.meta.motionPrompt)
  const [defaultTrPrompt, setDefaultTrPrompt] = useState(data.meta.defaultTransitionPrompt)
  const [defaultDuration, setDefaultDuration] = useState<number>((data.meta as Record<string, unknown>).default_video_duration as number || 8)
  const [defaultCount, setDefaultCount] = useState<number>((data.meta as Record<string, unknown>).default_gen_count as number || 4)
  const [maxPreloads, setMaxPreloads] = useState<number>((data.meta as Record<string, unknown>).max_concurrent_preloads as number || 6)
  const [roster, setRoster] = useState<PromptRosterEntry[]>(data.promptRoster || [])
  const [defaultPromptId, setDefaultPromptId] = useState<string>((data.meta as Record<string, unknown>).default_prompt_id as string || '')
  const [playbackSpeed, setPlaybackSpeed] = useState(() => {
    if (typeof window === 'undefined') return 1
    const stored = localStorage.getItem(PLAYBACK_SPEED_KEY)
    return stored ? parseFloat(stored) : 1
  })
  const [preloadWindow, setPreloadWindowState] = useState(() => {
    if (typeof window === 'undefined') return 30
    const stored = localStorage.getItem('beatlab-preload-window')
    return stored ? parseInt(stored, 10) : 30
  })
  const [cacheMemoryGb, setCacheMemoryGb] = useState(() => {
    if (typeof window === 'undefined') return 2
    const stored = localStorage.getItem('beatlab-cache-memory-gb')
    return stored ? parseFloat(stored) : 2
  })
  const [editingRosterId, setEditingRosterId] = useState<string | null>(null)
  const [editingRosterName, setEditingRosterName] = useState('')
  const [editingRosterTemplate, setEditingRosterTemplate] = useState('')
  const [editingRosterCategory, setEditingRosterCategory] = useState('general')

  useEffect(() => {
    fetchSettings(projectName)
      .then((s) => setSettings(s))
      .catch(() => setSettings({
        preview_quality: 50,
        audio_intelligence_file: null,
        render_preview_fps: 24,
        available_audio_intelligence_files: [],
      }))
      .finally(() => setLoading(false))
  }, [projectName])

  const handleSettingChange = useCallback(async (field: string, value: string | number | null) => {
    setSaving(true)
    await postUpdateSettings(projectName, { [field]: value })
    setSettings((prev) => prev ? { ...prev, [field]: value } : prev)
    setSaving(false)
  }, [projectName])

  const handleSaveMeta = useCallback(async () => {
    setSaving(true)
    await updateMeta({
      data: {
        projectName,
        fields: {
          title,
          fps: fps,
          resolution: `${resW},${resH}`,
          motion_prompt: motionPrompt,
          default_transition_prompt: defaultTrPrompt,
        },
      },
    })
    setSaving(false)
    onSave()
  }, [projectName, title, fps, resW, resH, motionPrompt, defaultTrPrompt, onSave])

  return (
    <div className="shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col" style={{ width: parseInt(localStorage.getItem('beatlab-side-panel-width') || '360', 10) }}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
        <div className="text-sm font-medium">Settings</div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">
          &times;
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-600">Loading...</div>
        ) : (
          <div className="divide-y divide-gray-800">
            {/* Preview Settings */}
            <div className="px-3 py-3 space-y-3">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Preview</div>

              <PreviewQualityInput
                value={settings?.preview_quality || 50}
                resolution={data.meta.resolution}
                disabled={saving}
                onCommit={(v) => { handleSettingChange('preview_quality', v); onPreviewQualityChange?.(v) }}
              />

              <div>
                <label className="text-xs text-gray-400 block mb-1">Preview FPS</label>
                <select
                  value={settings?.render_preview_fps || 24}
                  onChange={(e) => handleSettingChange('render_preview_fps', parseInt(e.target.value))}
                  disabled={saving}
                  className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
                >
                  <option value={12}>12 fps</option>
                  <option value={24}>24 fps</option>
                  <option value={30}>30 fps</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-gray-400 block mb-1">Preload Window: ±{preloadWindow}s</label>
                <input
                  type="range" min={5} max={120} step={5}
                  value={preloadWindow}
                  onChange={(e) => {
                    const val = parseInt(e.target.value)
                    setPreloadWindowState(val)
                    localStorage.setItem('beatlab-preload-window', String(val))
                    window.dispatchEvent(new CustomEvent('beatlab-preload-window', { detail: val }))
                  }}
                  className="w-full h-1.5 accent-gray-500"
                />
                <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
                  <span>5s</span>
                  <span>60s</span>
                  <span>120s</span>
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-400 block mb-1">Frame Cache: {cacheMemoryGb}GB</label>
                <input
                  type="range" min={0.5} max={8} step={0.5}
                  value={cacheMemoryGb}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value)
                    setCacheMemoryGb(val)
                    import('@/lib/frame-cache').then(({ setCacheMemoryLimit }) => setCacheMemoryLimit(val))
                  }}
                  className="w-full h-1.5 accent-gray-500"
                />
                <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
                  <span>0.5GB</span>
                  <span>4GB</span>
                  <span>8GB</span>
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-400 block mb-1">Playback Speed: {playbackSpeed}x</label>
                <input
                  type="range" min={0.1} max={4} step={0.1}
                  value={playbackSpeed}
                  onChange={(e) => {
                    const rate = parseFloat(e.target.value)
                    setPlaybackSpeed(rate)
                    localStorage.setItem(PLAYBACK_SPEED_KEY, String(rate))
                    // Dispatch event so Timeline picks up the change
                    window.dispatchEvent(new CustomEvent('beatlab-playback-speed', { detail: rate }))
                  }}
                  className="w-full h-1.5 accent-gray-500"
                />
                <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
                  <span>0.1x</span>
                  <span>1x</span>
                  <span>4x</span>
                </div>
              </div>
            </div>

            {/* Generation Defaults */}
            <div className="px-3 py-3 space-y-3">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Generation Defaults</div>

              <div>
                <label className="text-xs text-gray-400 block mb-1">Default Video Duration</label>
                <div className="flex gap-0.5">
                  {([4, 6, 8] as const).map((d) => (
                    <button
                      key={d}
                      onClick={async () => {
                        setDefaultDuration(d)
                        await updateMeta({ data: { projectName, fields: { default_video_duration: d } as never } })
                      }}
                      disabled={saving}
                      className={`flex-1 text-[10px] py-1 rounded transition-colors ${defaultDuration === d ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-400 block mb-1">Default Candidate Count</label>
                <div className="flex gap-0.5">
                  {([1, 2, 3, 4] as const).map((c) => (
                    <button
                      key={c}
                      onClick={async () => {
                        setDefaultCount(c)
                        await updateMeta({ data: { projectName, fields: { default_gen_count: c } as never } })
                      }}
                      disabled={saving}
                      className={`flex-1 text-[10px] py-1 rounded transition-colors ${defaultCount === c ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Max Concurrent Preloads</label>
                <div className="flex items-center gap-2">
                  <input
                    type="range" min={1} max={20} step={1}
                    value={maxPreloads}
                    onChange={(e) => {
                      const v = parseInt(e.target.value)
                      setMaxPreloads(v)
                      import('@/lib/frame-cache').then(({ setMaxConcurrentPreloads }) => setMaxConcurrentPreloads(v))
                    }}
                    onPointerUp={async () => {
                      await updateMeta({ data: { projectName, fields: { max_concurrent_preloads: maxPreloads } as never } })
                    }}
                    className="flex-1 h-1.5 accent-gray-500"
                  />
                  <span className="text-[10px] text-gray-500 w-6 text-right">{maxPreloads}</span>
                </div>
              </div>
            </div>

            {/* Prompt Roster */}
            <div className="px-3 py-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">Prompt Roster</div>
                <button
                  onClick={async () => {
                    const name = window.prompt('New prompt name:')
                    if (!name) return
                    const result = await postAddPromptRoster(projectName, name, '', 'general')
                    const updated = await fetchPromptRoster(projectName)
                    setRoster(updated)
                    setEditingRosterId(result.id)
                    setEditingRosterName(name)
                    setEditingRosterTemplate('')
                    setEditingRosterCategory('general')
                  }}
                  className="text-[9px] text-green-400 hover:text-green-300"
                >
                  + New
                </button>
              </div>

              {/* Default prompt selector */}
              <div>
                <label className="text-xs text-gray-400 block mb-1">Default Prompt</label>
                <select
                  value={defaultPromptId}
                  onChange={async (e) => {
                    setDefaultPromptId(e.target.value)
                    await updateMeta({ data: { projectName, fields: { default_prompt_id: e.target.value } as never } })
                  }}
                  className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
                >
                  <option value="">None</option>
                  {roster.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>

              {/* Roster entries */}
              <div className="space-y-1 max-h-[300px] overflow-y-auto">
                {roster.map((entry) => (
                  <div key={entry.id} className="bg-gray-800/50 rounded p-2 space-y-1">
                    {editingRosterId === entry.id ? (
                      <>
                        <input
                          value={editingRosterName}
                          onChange={(e) => setEditingRosterName(e.target.value)}
                          className="w-full bg-gray-900 text-xs text-gray-300 rounded px-2 py-1 border border-gray-600 focus:outline-none focus:border-blue-500"
                          placeholder="Name"
                        />
                        <select
                          value={editingRosterCategory}
                          onChange={(e) => setEditingRosterCategory(e.target.value)}
                          className="w-full bg-gray-900 text-[10px] text-gray-400 rounded px-2 py-0.5 border border-gray-600 focus:outline-none"
                        >
                          {['general', 'camera', 'style', 'composition', 'effect'].map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                        <textarea
                          value={editingRosterTemplate}
                          onChange={(e) => setEditingRosterTemplate(e.target.value)}
                          className="w-full bg-gray-900 text-xs text-gray-300 rounded p-2 border border-gray-600 focus:outline-none focus:border-blue-500 resize-y min-h-[60px]"
                          placeholder="Prompt template..."
                        />
                        <div className="flex gap-1">
                          <button
                            onClick={async () => {
                              await postUpdatePromptRoster(projectName, entry.id, { name: editingRosterName, template: editingRosterTemplate, category: editingRosterCategory })
                              setRoster(await fetchPromptRoster(projectName))
                              setEditingRosterId(null)
                            }}
                            className="text-[9px] text-green-400 hover:text-green-300"
                          >
                            Save
                          </button>
                          <button onClick={() => setEditingRosterId(null)} className="text-[9px] text-gray-500 hover:text-gray-300">Cancel</button>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-gray-300 truncate">{entry.name}</div>
                          <div className="text-[9px] text-gray-500 truncate">{entry.category} — {entry.template.slice(0, 60) || '(empty)'}{entry.template.length > 60 ? '...' : ''}</div>
                        </div>
                        <div className="flex gap-1.5 shrink-0 ml-2">
                          <button
                            onClick={() => {
                              setEditingRosterId(entry.id)
                              setEditingRosterName(entry.name)
                              setEditingRosterTemplate(entry.template)
                              setEditingRosterCategory(entry.category)
                            }}
                            className="text-[9px] text-blue-400 hover:text-blue-300"
                          >
                            Edit
                          </button>
                          <button
                            onClick={async () => {
                              await postRemovePromptRoster(projectName, entry.id)
                              setRoster(await fetchPromptRoster(projectName))
                              if (defaultPromptId === entry.id) {
                                setDefaultPromptId('')
                                await updateMeta({ data: { projectName, fields: { default_prompt_id: '' } as never } })
                              }
                            }}
                            className="text-[9px] text-red-400/60 hover:text-red-400"
                          >
                            Del
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {roster.length === 0 && <div className="text-[10px] text-gray-600 text-center py-2">No saved prompts</div>}
              </div>
            </div>

            {/* Audio Intelligence */}
            {settings && settings.available_audio_intelligence_files.length > 0 && (
              <div className="px-3 py-3 space-y-3">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">Audio Intelligence</div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Active File</label>
                  <select
                    value={settings.audio_intelligence_file || ''}
                    onChange={(e) => handleSettingChange('audio_intelligence_file', e.target.value || null)}
                    disabled={saving}
                    className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">Auto-detect latest</option>
                    {settings.available_audio_intelligence_files.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Project Metadata */}
            <div className="px-3 py-3 space-y-3">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Project</div>

              <Field label="Title" value={title} onChange={setTitle} />

              <div className="flex gap-2">
                <Field label="FPS" value={fps} onChange={setFps} />
                <div className="flex-1">
                  <label className="text-xs text-gray-400 block mb-1">Resolution</label>
                  <div className="flex gap-1">
                    <input
                      value={resW} onChange={(e) => setResW(e.target.value)}
                      className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700 focus:border-blue-500 focus:outline-none"
                    />
                    <span className="text-gray-600 text-xs self-center">x</span>
                    <input
                      value={resH} onChange={(e) => setResH(e.target.value)}
                      className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-400 block mb-1">Motion Prompt</label>
                <textarea
                  value={motionPrompt}
                  onChange={(e) => setMotionPrompt(e.target.value)}
                  placeholder="Global motion prompt for all transitions..."
                  className="w-full bg-gray-800 text-xs text-gray-300 rounded p-2 border border-gray-700 focus:border-blue-500 focus:outline-none resize-y min-h-[40px]"
                />
              </div>

              <div>
                <label className="text-xs text-gray-400 block mb-1">Default Transition Prompt</label>
                <textarea
                  value={defaultTrPrompt}
                  onChange={(e) => setDefaultTrPrompt(e.target.value)}
                  placeholder="Fallback prompt when no action is set..."
                  className="w-full bg-gray-800 text-xs text-gray-300 rounded p-2 border border-gray-700 focus:border-blue-500 focus:outline-none resize-y min-h-[40px]"
                />
              </div>

              <button
                onClick={handleSaveMeta}
                disabled={saving}
                className="w-full text-xs bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-1.5 rounded transition-colors"
              >
                {saving ? 'Saving...' : 'Save Project Settings'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PreviewQualityInput({ value, resolution, disabled, onCommit }: {
  value: number; resolution: [number, number]; disabled: boolean; onCommit: (v: number) => void
}) {
  const [local, setLocal] = useState(String(value))
  const pct = parseInt(local) || value
  const w = Math.round(resolution[0] * pct / 100)
  const h = Math.round(resolution[1] * pct / 100)

  return (
    <div>
      <label className="text-xs text-gray-400 block mb-1">Preview Resolution %</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={5}
          max={100}
          step={5}
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => { const v = Math.max(5, Math.min(100, parseInt(local) || 50)); setLocal(String(v)); onCommit(v) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
          disabled={disabled}
          className="w-20 bg-gray-800 text-xs text-gray-300 rounded px-2 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
        />
        <span className="text-[10px] text-gray-500">{w}x{h}</span>
      </div>
    </div>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex-1">
      <label className="text-xs text-gray-400 block mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700 focus:border-blue-500 focus:outline-none"
      />
    </div>
  )
}
