import { useState, useCallback, useEffect } from 'react'
import type { NarrativeSection } from '@/lib/timeline-client'
import { postUpdateNarrative } from '@/lib/timeline-client'

type NarrativeSectionPanelProps = {
  sections: NarrativeSection[]
  projectName: string
  onClose: () => void
  onSeek: (time: number) => void
}

function parseTs(ts: string): number {
  const parts = ts.split(':')
  if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseFloat(parts[1])
  return 0
}

export function NarrativeSectionPanel({ sections: initialSections, projectName, onClose, onSeek }: NarrativeSectionPanelProps) {
  const [sections, setSections] = useState(initialSections)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setSections(initialSections) }, [initialSections])

  const handleFieldChange = useCallback((sectionId: string, field: string, value: string | string[]) => {
    setSections((prev) => prev.map((s) =>
      s.id === sectionId ? { ...s, [field]: value } : s
    ))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await postUpdateNarrative(projectName, sections)
    } finally {
      setSaving(false)
    }
  }, [projectName, sections])

  return (
    <div className="w-80 shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
        <div className="text-sm font-medium">Sections</div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-[10px] text-green-400 hover:text-green-300 disabled:text-gray-600"
          >
            {saving ? 'Saving...' : 'Save All'}
          </button>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">
            &times;
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {sections.length === 0 ? (
          <div className="p-4 text-center text-sm text-gray-600">No narrative sections</div>
        ) : (
          <div className="divide-y divide-gray-800">
            {sections.map((section) => (
              <SectionCard
                key={section.id}
                section={section}
                expanded={expandedId === section.id}
                onToggle={() => setExpandedId(expandedId === section.id ? null : section.id)}
                onChange={handleFieldChange}
                onSeek={() => onSeek(parseTs(section.start))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionCard({ section, expanded, onToggle, onChange, onSeek }: {
  section: NarrativeSection
  expanded: boolean
  onToggle: () => void
  onChange: (id: string, field: string, value: string | string[]) => void
  onSeek: () => void
}) {
  const s = section

  return (
    <div className="group">
      {/* Header — always visible */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-800/50"
        onClick={onToggle}
      >
        <span className="text-[10px] text-gray-600">{expanded ? '▼' : '▶'}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-gray-300">{s.label}</div>
          <div className="text-[10px] text-gray-500 truncate">{s.mood || 'No mood set'}</div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onSeek() }}
          className="text-[10px] text-blue-400 hover:text-blue-300 opacity-0 group-hover:opacity-100"
        >
          seek
        </button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          <div className="flex gap-2">
            <FieldInput label="Start" value={s.start} onChange={(v) => onChange(s.id, 'start', v)} />
            <FieldInput label="End" value={s.end || ''} onChange={(v) => onChange(s.id, 'end', v)} />
          </div>
          <FieldInput label="Mood" value={s.mood} onChange={(v) => onChange(s.id, 'mood', v)} />
          <FieldInput label="Energy" value={s.energy} onChange={(v) => onChange(s.id, 'energy', v)} />
          <TagInput label="Instruments" values={s.instruments} onChange={(v) => onChange(s.id, 'instruments', v)} />
          <TagInput label="Motifs" values={s.motifs} onChange={(v) => onChange(s.id, 'motifs', v)} />
          <FieldInput label="Visual Direction" value={s.visual_direction} onChange={(v) => onChange(s.id, 'visual_direction', v)} multiline />
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Notes</div>
            <textarea
              value={s.notes}
              onChange={(e) => onChange(s.id, 'notes', e.target.value)}
              className="w-full bg-gray-800 text-xs text-gray-300 rounded p-2 border border-gray-700 focus:border-blue-500 focus:outline-none resize-y min-h-[60px] leading-relaxed"
            />
          </div>
        </div>
      )}
    </div>
  )
}

function FieldInput({ label, value, onChange, multiline }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean }) {
  return (
    <div className="flex-1">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{label}</div>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700 focus:border-blue-500 focus:outline-none resize-y min-h-[40px]"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700 focus:border-blue-500 focus:outline-none"
        />
      )}
    </div>
  )
}

function TagInput({ label, values, onChange }: { label: string; values: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState('')

  const addTag = useCallback(() => {
    const tag = input.trim()
    if (tag && !values.includes(tag)) {
      onChange([...values, tag])
    }
    setInput('')
  }, [input, values, onChange])

  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{label}</div>
      <div className="flex flex-wrap gap-1 mb-1">
        {values.map((tag) => (
          <span key={tag} className="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded flex items-center gap-1">
            {tag}
            <button
              onClick={() => onChange(values.filter((t) => t !== tag))}
              className="text-gray-600 hover:text-red-400"
            >
              x
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
        placeholder="Add..."
        className="w-full bg-gray-800 text-xs text-gray-300 rounded px-2 py-1 border border-gray-700 focus:border-blue-500 focus:outline-none"
      />
    </div>
  )
}
