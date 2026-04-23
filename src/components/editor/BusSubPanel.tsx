/**
 * M13 task-54: Bus sub-panel for the Macro Panel.
 *
 * Collapsible list of `project_send_buses` rows with CRUD controls:
 *   - Add bus (picker for bus_type + default static_params)
 *   - Remove bus (confirm dialog)
 *   - Rename bus (inline edit)
 *   - Edit static params (expandable row; IR / time / feedback / tone fields)
 *   - Reorder (up/down arrows — drag-and-drop lands later)
 *
 * All callbacks are stubs today. The parent (MacroPanel) passes them through;
 * in task-52 they will be wired to POST /send-buses endpoints.
 *
 * Spec reference: agent/specs/local.effect-curves-macro-panel.md R36a + R54.
 */

import { useState, useCallback, useMemo } from 'react'

export type BusType = 'reverb' | 'delay' | 'echo'

export interface SendBus {
  id: string
  bus_type: BusType
  label: string
  order_index: number
  static_params: Record<string, unknown>
}

/** Shipped IR names per spec R53. `custom` is the pick-from-pool option (R54). */
export const BUILT_IN_IR_NAMES = [
  'room-small',
  'room-large',
  'hall',
  'plate',
  'spring',
  'chamber',
] as const

export interface BusSubPanelProps {
  buses: SendBus[]
  /** user clicked "Add Bus" with the given type */
  onAddBus: (body: { bus_type: BusType; label: string; static_params: Record<string, unknown> }) => void
  /** user confirmed removal */
  onRemoveBus: (id: string) => void
  /** user renamed or edited static_params */
  onUpdateBus: (id: string, patch: { label?: string; static_params?: Record<string, unknown> }) => void
  /** user dragged / arrow-clicked to a new order_index */
  onReorderBus: (id: string, newOrderIndex: number) => void
}

function defaultStaticParamsFor(bus_type: BusType): Record<string, unknown> {
  switch (bus_type) {
    case 'reverb': return { ir: 'plate' }
    case 'delay':  return { time_ms: 250, feedback: 0.35 }
    case 'echo':   return { time_ms: 500, tone: 0.5 }
  }
}

function defaultLabelFor(bus_type: BusType, existingCount: number): string {
  const base = bus_type === 'reverb' ? 'Reverb' : bus_type === 'delay' ? 'Delay' : 'Echo'
  return existingCount === 0 ? base : `${base} ${existingCount + 1}`
}

export function BusSubPanel({ buses, onAddBus, onRemoveBus, onUpdateBus, onReorderBus }: BusSubPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [addPickerType, setAddPickerType] = useState<BusType>('reverb')

  const sorted = useMemo(() => [...buses].sort((a, b) => a.order_index - b.order_index), [buses])

  const handleAdd = useCallback(() => {
    const countOfType = buses.filter((b) => b.bus_type === addPickerType).length
    onAddBus({
      bus_type: addPickerType,
      label: defaultLabelFor(addPickerType, countOfType),
      static_params: defaultStaticParamsFor(addPickerType),
    })
  }, [addPickerType, buses, onAddBus])

  const handleMove = useCallback((bus: SendBus, dir: -1 | 1) => {
    const idx = sorted.findIndex((b) => b.id === bus.id)
    const target = idx + dir
    if (target < 0 || target >= sorted.length) return
    const swap = sorted[target]
    onReorderBus(bus.id, swap.order_index)
  }, [sorted, onReorderBus])

  const commitRename = useCallback((id: string) => {
    const label = renameDraft.trim()
    if (label) onUpdateBus(id, { label })
    setRenamingId(null)
    setRenameDraft('')
  }, [renameDraft, onUpdateBus])

  return (
    <div className="flex flex-col gap-2 p-2 border border-gray-800 rounded bg-[#111827]" data-testid="bus-subpanel">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-gray-200">Send Buses</div>
        <div className="flex items-center gap-1">
          <select
            value={addPickerType}
            onChange={(e) => setAddPickerType(e.target.value as BusType)}
            className="text-[10px] bg-[#1f2937] border border-gray-700 text-gray-300 rounded px-1 py-0.5"
            data-testid="bus-add-type-picker"
          >
            <option value="reverb">Reverb</option>
            <option value="delay">Delay</option>
            <option value="echo">Echo</option>
          </select>
          <button
            type="button"
            onClick={handleAdd}
            className="text-[10px] px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded"
            data-testid="bus-add-button"
          >
            + Add
          </button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="text-[10px] text-gray-500 italic p-2">No send buses yet. Click “+ Add” above.</div>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="bus-subpanel-list">
          {sorted.map((bus, i) => {
            const isExpanded = expandedId === bus.id
            const isRenaming = renamingId === bus.id
            return (
              <li
                key={bus.id}
                className="border border-gray-800 rounded bg-[#0b1220]"
                data-testid="bus-subpanel-row"
                data-bus-id={bus.id}
              >
                <div className="flex items-center gap-1 px-2 py-1">
                  <span className="text-[9px] text-gray-500 uppercase tracking-wide w-12 flex-shrink-0">
                    {bus.bus_type}
                  </span>
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => commitRename(bus.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(bus.id)
                        if (e.key === 'Escape') { setRenamingId(null); setRenameDraft('') }
                      }}
                      className="flex-1 text-[11px] bg-[#1f2937] text-gray-200 border border-gray-600 rounded px-1"
                      data-testid="bus-rename-input"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setRenamingId(bus.id); setRenameDraft(bus.label) }}
                      className="flex-1 text-left text-[11px] text-gray-200 truncate hover:text-white"
                      data-testid="bus-row-label"
                    >
                      {bus.label}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleMove(bus, -1)}
                    disabled={i === 0}
                    className="text-[10px] text-gray-400 hover:text-gray-200 disabled:text-gray-700 px-1"
                    aria-label="Move up"
                    data-testid="bus-move-up"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMove(bus, 1)}
                    disabled={i === sorted.length - 1}
                    className="text-[10px] text-gray-400 hover:text-gray-200 disabled:text-gray-700 px-1"
                    aria-label="Move down"
                    data-testid="bus-move-down"
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : bus.id)}
                    className="text-[10px] text-gray-400 hover:text-gray-200 px-1"
                    aria-label={isExpanded ? 'Collapse' : 'Expand static params'}
                    aria-expanded={isExpanded}
                    data-testid="bus-expand-toggle"
                  >
                    {isExpanded ? '▾' : '▸'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemoveId(bus.id)}
                    className="text-[10px] text-red-400 hover:text-red-300 px-1"
                    aria-label="Remove bus"
                    data-testid="bus-remove-button"
                  >
                    ✕
                  </button>
                </div>

                {isExpanded && (
                  <BusStaticParamsEditor
                    bus={bus}
                    onChange={(patch) => onUpdateBus(bus.id, { static_params: patch })}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}

      {confirmRemoveId && (
        <div
          className="flex items-center gap-2 p-2 bg-red-950/60 border border-red-800 rounded text-[11px] text-red-200"
          role="dialog"
          aria-label="Confirm remove bus"
          data-testid="bus-remove-confirm"
        >
          <span className="flex-1">Remove this bus? Cascades to track sends + clears any send curves.</span>
          <button
            type="button"
            onClick={() => { onRemoveBus(confirmRemoveId); setConfirmRemoveId(null) }}
            className="px-2 py-0.5 bg-red-700 hover:bg-red-600 text-white rounded"
            data-testid="bus-remove-confirm-yes"
          >
            Remove
          </button>
          <button
            type="button"
            onClick={() => setConfirmRemoveId(null)}
            className="px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-white rounded"
            data-testid="bus-remove-confirm-no"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

/** Expandable row for a bus's static params. Shape depends on bus_type. */
function BusStaticParamsEditor({ bus, onChange }: {
  bus: SendBus
  onChange: (nextStaticParams: Record<string, unknown>) => void
}) {
  const sp = bus.static_params ?? {}

  if (bus.bus_type === 'reverb') {
    const ir = typeof sp.ir === 'string' ? sp.ir : 'plate'
    return (
      <div className="flex flex-col gap-1 p-2 border-t border-gray-800 text-[10px] text-gray-400" data-testid="bus-static-reverb">
        <label className="flex items-center gap-2">
          <span className="w-16">IR</span>
          <select
            value={BUILT_IN_IR_NAMES.includes(ir as typeof BUILT_IN_IR_NAMES[number]) ? ir : '__custom'}
            onChange={(e) => {
              const v = e.target.value
              if (v === '__custom') onChange({ ...sp, ir: 'custom' })
              else onChange({ ...sp, ir: v })
            }}
            className="flex-1 bg-[#1f2937] border border-gray-700 text-gray-300 rounded px-1 py-0.5"
            data-testid="bus-reverb-ir-select"
          >
            {BUILT_IN_IR_NAMES.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
            <option value="__custom">Custom from pool…</option>
          </select>
        </label>
      </div>
    )
  }

  if (bus.bus_type === 'delay') {
    const time = typeof sp.time_ms === 'number' ? sp.time_ms : 250
    const feedback = typeof sp.feedback === 'number' ? sp.feedback : 0.35
    return (
      <div className="flex flex-col gap-1 p-2 border-t border-gray-800 text-[10px] text-gray-400" data-testid="bus-static-delay">
        <label className="flex items-center gap-2">
          <span className="w-16">Time (ms)</span>
          <input
            type="number"
            min={1}
            max={2000}
            value={time}
            onChange={(e) => onChange({ ...sp, time_ms: Number(e.target.value) })}
            className="flex-1 bg-[#1f2937] border border-gray-700 text-gray-300 rounded px-1 py-0.5"
            data-testid="bus-delay-time-input"
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-16">Feedback</span>
          <input
            type="number"
            min={0}
            max={0.95}
            step={0.05}
            value={feedback}
            onChange={(e) => onChange({ ...sp, feedback: Number(e.target.value) })}
            className="flex-1 bg-[#1f2937] border border-gray-700 text-gray-300 rounded px-1 py-0.5"
            data-testid="bus-delay-feedback-input"
          />
        </label>
      </div>
    )
  }

  // echo
  const time = typeof sp.time_ms === 'number' ? sp.time_ms : 500
  const tone = typeof sp.tone === 'number' ? sp.tone : 0.5
  return (
    <div className="flex flex-col gap-1 p-2 border-t border-gray-800 text-[10px] text-gray-400" data-testid="bus-static-echo">
      <label className="flex items-center gap-2">
        <span className="w-16">Time (ms)</span>
        <input
          type="number"
          min={1}
          max={2000}
          value={time}
          onChange={(e) => onChange({ ...sp, time_ms: Number(e.target.value) })}
          className="flex-1 bg-[#1f2937] border border-gray-700 text-gray-300 rounded px-1 py-0.5"
          data-testid="bus-echo-time-input"
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-16">Tone</span>
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={tone}
          onChange={(e) => onChange({ ...sp, tone: Number(e.target.value) })}
          className="flex-1 bg-[#1f2937] border border-gray-700 text-gray-300 rounded px-1 py-0.5"
          data-testid="bus-echo-tone-input"
        />
      </label>
    </div>
  )
}
