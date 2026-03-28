import { useState, useRef, useCallback, useEffect } from 'react'
import type { Transition } from '@/routes/project/$name/editor'
import { updateTransitionAction, updateMeta, generateTransitionAction } from '@/routes/project/$name/editor'

const STORAGE_KEY = 'beatlab-transition-panel-width'
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240
const MAX_WIDTH = 800

type TransitionPanelProps = {
  transition: Transition
  projectName: string
  motionPrompt: string
  onClose: () => void
  onDelete: () => void
}

export function TransitionPanel({
  transition,
  projectName,
  motionPrompt,
  onClose,
  onDelete,
}: TransitionPanelProps) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parseInt(stored, 10))) : DEFAULT_WIDTH
  })
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    e.preventDefault()
  }, [width])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = startX.current - e.clientX
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth.current + delta))
      setWidth(newWidth)
    }
    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false
        setWidth((current) => {
          localStorage.setItem(STORAGE_KEY, String(current))
          return current
        })
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const tr = transition

  return (
    <div className="relative flex shrink-0" style={{ width }}>
      {/* Drag handle */}
      <div
        className="w-1 cursor-col-resize hover:bg-orange-500/50 active:bg-orange-500 transition-colors shrink-0"
        onMouseDown={handleMouseDown}
      />

      <div className="flex-1 bg-gray-900 border-l border-gray-800 overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 sticky top-0 bg-gray-900 z-10 shrink-0">
          <div className="text-sm font-medium text-orange-300">{tr.id}</div>
          <div className="flex items-center gap-4">
            <button
              onClick={onDelete}
              className="text-xs text-red-500/70 hover:text-red-400 transition-colors"
              title="Delete transition (move to bin)"
            >
              Delete
            </button>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Metadata */}
          <div className="px-3 py-3 space-y-3 border-b border-gray-800">
            <Field label="From → To" value={`${tr.from} → ${tr.to}`} />
            <Field label="Duration" value={`${tr.durationSeconds.toFixed(1)}s`} />
            <Field label="Slots" value={String(tr.slots)} />
            <Field label="Remap" value={`${tr.remap.method} (${tr.remap.target_duration.toFixed(1)}s)`} />
          </div>

          {/* Action prompt */}
          <div className="px-3 py-3 border-b border-gray-800">
            <ActionPromptEditor transition={tr} projectName={projectName} />
          </div>

          {/* Motion prompt (global) */}
          <div className="px-3 py-3">
            <MotionPromptEditor projectName={projectName} motionPrompt={motionPrompt} />
          </div>
        </div>
      </div>
    </div>
  )
}

function ActionPromptEditor({ transition, projectName }: { transition: Transition; projectName: string }) {
  const [action, setAction] = useState(transition.action)
  const [useGlobal, setUseGlobal] = useState(transition.useGlobalPrompt)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    setAction(transition.action)
    setUseGlobal(transition.useGlobalPrompt)
  }, [transition.id, transition.action, transition.useGlobalPrompt])

  const save = useCallback(async () => {
    setSaving(true)
    await updateTransitionAction({
      data: { projectName, transitionId: transition.id, action, useGlobalPrompt: useGlobal },
    })
    transition.action = action
    transition.useGlobalPrompt = useGlobal
    setSaving(false)
  }, [action, useGlobal, transition, projectName])

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    try {
      const result = await generateTransitionAction({
        data: { projectName, transitionId: transition.id },
      })
      if (result.action) {
        setAction(result.action)
        transition.action = result.action
      }
    } finally {
      setGenerating(false)
    }
  }, [projectName, transition])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Action Prompt</div>
        <button
          onClick={handleGenerate}
          disabled={generating || saving}
          className="text-[10px] text-orange-400 hover:text-orange-300 disabled:text-gray-600 transition-colors"
        >
          {generating ? 'Generating...' : action ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {action ? (
        <textarea
          value={action}
          onChange={(e) => setAction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              save()
            }
            if (e.key === 'Escape') {
              setAction(transition.action)
            }
          }}
          onBlur={save}
          className="w-full bg-gray-800 text-sm text-gray-300 rounded p-2 border border-gray-700 focus:border-orange-500 focus:outline-none resize-y min-h-[80px] leading-relaxed"
          disabled={saving || generating}
        />
      ) : (
        <div className="text-sm text-gray-500 italic bg-gray-800/50 rounded p-2">
          {generating ? 'Analyzing keyframe images with Claude...' : 'No action prompt yet. Click Generate to create one from the keyframe images.'}
        </div>
      )}
      <div className="text-[9px] text-gray-600">
        {action ? 'Ctrl+Enter to save, Esc to revert. ' : ''}Sent to Veo for video generation.
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={useGlobal}
          onChange={(e) => {
            setUseGlobal(e.target.checked)
            setSaving(true)
            updateTransitionAction({
              data: { projectName, transitionId: transition.id, action, useGlobalPrompt: e.target.checked },
            }).then(() => {
              transition.useGlobalPrompt = e.target.checked
              setSaving(false)
            })
          }}
          className="rounded border-gray-600 bg-gray-800 text-orange-500 focus:ring-orange-500"
        />
        <span className="text-xs text-gray-400">Append global motion prompt</span>
      </label>
    </div>
  )
}

function MotionPromptEditor({ projectName, motionPrompt }: { projectName: string; motionPrompt: string }) {
  const [motion, setMotion] = useState(motionPrompt)
  const [saving, setSaving] = useState(false)

  const save = useCallback(async () => {
    setSaving(true)
    await updateMeta({ data: { projectName, fields: { motion_prompt: motion } } })
    setSaving(false)
  }, [motion, projectName])

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">Global Motion Prompt</div>
      <textarea
        value={motion}
        onChange={(e) => setMotion(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() }
        }}
        placeholder="e.g. Slow camera drift, dreamy bokeh..."
        className="w-full bg-gray-800 text-xs text-gray-400 rounded p-2 border border-gray-700 focus:border-gray-500 focus:outline-none resize-y min-h-[40px] leading-relaxed"
        disabled={saving}
      />
      <div className="text-[9px] text-gray-600">Appended as "Camera and motion: ..." to every transition with the checkbox enabled</div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{label}</div>
      <div className="text-sm text-gray-300">{value}</div>
    </div>
  )
}
