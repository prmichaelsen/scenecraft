import { useState, useCallback, useEffect } from 'react'
import { fetchSettings, postUpdateSettings, type ProjectSettings } from '@/lib/settings-client'
import { updateMeta } from '@/routes/project/$name/editor'
import type { EditorData } from '@/routes/project/$name/editor'

type SettingsPanelProps = {
  data: EditorData
  projectName: string
  onClose: () => void
  onSave: () => void
  onPreviewQualityChange?: (quality: number) => void
}

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
    <div className="w-80 shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col">
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
