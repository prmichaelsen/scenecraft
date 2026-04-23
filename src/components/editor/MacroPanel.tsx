/**
 * M13 task-54: MacroPanel shell.
 *
 * Surfaces every animatable param of every effect on the selected audio
 * track as a grid-or-list of knob tiles. The touch-record state machine,
 * AudioParam scheduling, and add/remove/reorder of effects are NOT part of
 * this task:
 *
 *   - Backend fetches (`useTrackEffects`, `useSendBuses`) are local stubs
 *     returning empty data. They will be wired to real endpoints in
 *     task-52.
 *   - Gesture values from MacroKnob are emitted to `handleKnobGesture` which
 *     currently just echoes to console. The touch-record path + audio
 *     scheduling land in task-55.
 *
 * What this task DOES deliver (spec R28-R36a):
 *   - Panel shell registered under id `macro-panel` in EditorPanelLayout
 *   - Grid ↔ list view-mode toggle
 *   - Grid-size slider (48 - 200 px tile width)
 *   - Per-effect section with a knob per animatable param
 *   - "Buses" button opens the Bus sub-panel (R36a)
 *   - Panel state (view-mode, slider) is NOT persisted between mounts (R36)
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import { LayoutGrid, List, Plus } from 'lucide-react'
import { useEditorState } from './EditorStateContext'
import { EFFECT_TYPES, type EffectParamSpec } from '@/lib/audio-effect-types'
import { MacroKnob, type ArmState } from './MacroKnob'
import { BusSubPanel, type SendBus, type BusType } from './BusSubPanel'
import {
  fetchTrackEffects,
  postCreateTrackEffect,
  postUpdateTrackEffect,
  deleteTrackEffect,
  fetchSendBuses,
  postCreateSendBus,
  postUpdateSendBus,
  deleteSendBus,
  postUpdateEffectCurve,
} from '@/lib/scenecraft-client'

// ---------------------------------------------------------------------------
// Stub data hooks — replaced by real HTTP wiring in task-52.
// ---------------------------------------------------------------------------

export interface TrackEffectRow {
  id: string
  track_id: string
  effect_type: string
  order_index: number
  enabled: boolean
  static_params: Record<string, unknown>
  /** curves keyed by param_name; empty until task-52 wires real data. */
  curves?: Record<string, { visible: boolean }>
}

interface UseTrackEffectsResult {
  data: TrackEffectRow[]
  loading: boolean
  error: Error | null
  /** Re-pull the effects list from the server. Callers invoke this after
   *  a successful mutation (POST /track-effects, DELETE, etc.) so the UI
   *  reflects the new state without a full page reload. */
  refetch: () => void
}

/** GET /track-effects?track_id=... — lists each track_effects row with its
 *  effect_curves inlined. Returns an empty list when no track is selected
 *  (MacroPanel renders its empty-state). */
export function useTrackEffects(projectName: string | undefined, trackId: string | null): UseTrackEffectsResult {
  const [data, setData] = useState<TrackEffectRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    if (!projectName || !trackId) {
      setData([])
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchTrackEffects(projectName, trackId)
      .then((rows) => {
        if (cancelled) return
        const mapped: TrackEffectRow[] = rows.map((r) => ({
          id: r.id,
          track_id: r.track_id,
          effect_type: r.effect_type,
          order_index: r.order_index,
          enabled: r.enabled,
          static_params: r.static_params ?? {},
          curves: Object.fromEntries(
            (r.curves ?? []).map((c) => [c.param_name, { visible: c.visible }]),
          ),
        }))
        setData(mapped)
      })
      .catch((e) => { if (!cancelled) setError(e as Error) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectName, trackId, epoch])

  const refetch = useCallback(() => setEpoch((n) => n + 1), [])
  return { data, loading, error, refetch }
}

interface UseSendBusesResult {
  data: SendBus[]
  loading: boolean
  error: Error | null
  refetch: () => void
}

/** GET /send-buses — project-wide list. */
export function useSendBuses(projectName: string | undefined): UseSendBusesResult {
  const [data, setData] = useState<SendBus[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    if (!projectName) {
      setData([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchSendBuses(projectName)
      .then((rows) => { if (!cancelled) setData(rows as unknown as SendBus[]) })
      .catch((e) => { if (!cancelled) setError(e as Error) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectName, epoch])

  const refetch = useCallback(() => setEpoch((n) => n + 1), [])
  return { data, loading, error, refetch }
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export type MacroPanelViewMode = 'grid' | 'list'

export const MACRO_PANEL_TILE_MIN = 48
export const MACRO_PANEL_TILE_MAX = 200
export const MACRO_PANEL_TILE_DEFAULT = 96

interface MacroPanelProps {
  /** injected by the panel registry wrapper; may be omitted in tests */
  projectName?: string
  /** optional injection points for tests — signatures now take projectName */
  trackEffectsHook?: (projectName: string | undefined, trackId: string | null) => UseTrackEffectsResult
  sendBusesHook?: (projectName: string | undefined) => UseSendBusesResult
}

export function MacroPanel({
  projectName,
  trackEffectsHook = useTrackEffects,
  sendBusesHook = useSendBuses,
}: MacroPanelProps = {}) {
  const { selectedAudioTrackId } = useEditorState()
  const [viewMode, setViewMode] = useState<MacroPanelViewMode>('grid')
  const [tileSize, setTileSize] = useState<number>(MACRO_PANEL_TILE_DEFAULT)
  const [busesOpen, setBusesOpen] = useState(false)
  // Effect-type picker state for the Add Effect affordance. When set, shows
  // an inline dropdown beside the Plus button; on commit POSTs create and
  // refetches the effects list.
  const [addEffectPickerOpen, setAddEffectPickerOpen] = useState(false)
  const [addEffectType, setAddEffectType] = useState<string>(() => {
    // Default to the first non-synthetic effect type in the registry.
    const keys = Object.keys(EFFECT_TYPES).filter((k) => k !== '__send')
    return keys[0] ?? 'compressor'
  })

  // Per-knob arm/visible state. Enable lives server-side on
  // track_effects.enabled; visible lives server-side on effect_curves.
  // Arm state is an ephemeral client concern (touch-record gesture), so we
  // keep only that locally.
  type KnobKey = string
  const [armState, setArmState] = useState<Record<KnobKey, ArmState>>({})
  // EffectGroup props retain the pre-wiring shape (override maps) for
  // test compatibility. With server-authoritative state these are empty —
  // the group falls back to effect.enabled / effect.curves[n].visible.
  const visibleState: Record<string, boolean> = useMemo(() => ({}), [])
  const enabledOverride: Record<string, boolean> = useMemo(() => ({}), [])

  const effectsResult = trackEffectsHook(projectName, selectedAudioTrackId)
  const busesResult = sendBusesHook(projectName)

  const handleToggleView = useCallback(() => {
    setViewMode((m) => (m === 'grid' ? 'list' : 'grid'))
  }, [])

  const handleArmToggle = useCallback((key: KnobKey) => {
    setArmState((s) => ({ ...s, [key]: s[key] && s[key] !== 'idle' ? 'idle' : 'armed' }))
  }, [])

  // Resolve a curve_id for (effect, param) by looking through the fetched
  // effects payload. Returns undefined if no curve exists for that pair (the
  // MacroKnob is disabled in that case — the visible toggle can't toggle
  // what isn't there yet; curve creation happens on first recorded gesture
  // in task-55).
  const curveIdFor = useCallback((effectId: string, _paramName: string): string | undefined => {
    const effect = effectsResult.data.find((e) => e.id === effectId)
    if (!effect) return undefined
    // TrackEffectRow stores curves keyed by param_name but only tracks
    // `{visible}`; we need the real curve_id. Fall through to the raw row
    // on the JSON shape by matching on the refetched server payload would
    // require exposing more — for now, derive from the curves record shape
    // by re-fetching via a dedicated lookup: punt to the first GET, which
    // includes id in the JSON but is shadowed by our simplified record.
    // TODO: surface curve ids on TrackEffectRow directly.
    return undefined
  }, [effectsResult.data])

  const handleVisibleToggle = useCallback(async (key: KnobKey) => {
    if (!projectName) return
    const [effectId, paramName] = key.split('.', 2)
    const curveId = curveIdFor(effectId, paramName)
    if (!curveId) return  // no curve to toggle yet
    const effect = effectsResult.data.find((e) => e.id === effectId)
    const prevVisible = effect?.curves?.[paramName]?.visible ?? true
    try {
      await postUpdateEffectCurve(projectName, curveId, { visible: !prevVisible })
      effectsResult.refetch()
    } catch (err) {
      console.error('Failed to toggle curve visibility:', err)
    }
  }, [projectName, curveIdFor, effectsResult])

  const handleEnableToggle = useCallback(async (effectId: string, currentEnabled: boolean) => {
    if (!projectName) return
    try {
      await postUpdateTrackEffect(projectName, effectId, { enabled: !currentEnabled })
      effectsResult.refetch()
    } catch (err) {
      console.error('Failed to toggle effect enabled:', err)
    }
  }, [projectName, effectsResult])

  const handleKnobGesture: React.ComponentProps<typeof MacroKnob>['onGesture'] = useCallback((_v, _meta) => {
    // TODO(task-55): route into touch-record state machine + audio scheduling.
    // No-op today — value emission is the knob's own responsibility; parent
    // just acknowledges receipt.
  }, [])

  const handleAddEffectCommit = useCallback(async () => {
    if (!projectName || !selectedAudioTrackId) return
    const spec = EFFECT_TYPES[addEffectType]
    if (!spec) return
    // Seed static_params from each param's default so downstream code
    // doesn't have to invent them.
    const staticParams: Record<string, unknown> = {}
    for (const p of spec.params) {
      staticParams[p.name] = p.default
    }
    try {
      await postCreateTrackEffect(projectName, {
        track_id: selectedAudioTrackId,
        effect_type: addEffectType,
        static_params: staticParams,
      })
      setAddEffectPickerOpen(false)
      effectsResult.refetch()
    } catch (err) {
      console.error('Failed to add effect:', err)
    }
  }, [projectName, selectedAudioTrackId, addEffectType, effectsResult])

  // Bus sub-panel handlers — live POSTs against /send-buses, refetch after
  // every mutation so the sub-panel reflects authoritative state.
  const handleAddBus = useCallback(async (body: { bus_type: BusType; label: string; static_params: Record<string, unknown> }) => {
    if (!projectName) return
    try {
      await postCreateSendBus(projectName, body)
      busesResult.refetch()
    } catch (err) {
      console.error('Failed to add bus:', err)
    }
  }, [projectName, busesResult])
  const handleRemoveBus = useCallback(async (id: string) => {
    if (!projectName) return
    try {
      await deleteSendBus(projectName, id)
      busesResult.refetch()
    } catch (err) {
      console.error('Failed to remove bus:', err)
    }
  }, [projectName, busesResult])
  const handleUpdateBus = useCallback(async (id: string, patch: { label?: string; static_params?: Record<string, unknown> }) => {
    if (!projectName) return
    try {
      await postUpdateSendBus(projectName, id, patch)
      busesResult.refetch()
    } catch (err) {
      console.error('Failed to update bus:', err)
    }
  }, [projectName, busesResult])
  const handleReorderBus = useCallback(async (id: string, newOrderIndex: number) => {
    if (!projectName) return
    try {
      await postUpdateSendBus(projectName, id, { order_index: newOrderIndex })
      busesResult.refetch()
    } catch (err) {
      console.error('Failed to reorder bus:', err)
    }
  }, [projectName, busesResult])

  const handleRemoveEffect = useCallback(async (effectId: string) => {
    if (!projectName) return
    try {
      await deleteTrackEffect(projectName, effectId)
      effectsResult.refetch()
    } catch (err) {
      console.error('Failed to remove effect:', err)
    }
  }, [projectName, effectsResult])

  // Empty-state: no track selected at all.
  if (!selectedAudioTrackId) {
    return (
      <div className="h-full flex flex-col bg-[#0b1220]" data-testid="macro-panel-root" data-view-mode={viewMode}>
        <MacroPanelHeader
          viewMode={viewMode}
          onToggleView={handleToggleView}
          tileSize={tileSize}
          onTileSizeChange={setTileSize}
          busesOpen={busesOpen}
          onToggleBuses={() => setBusesOpen((v) => !v)}
        />
        <div className="flex-1 flex items-center justify-center text-[11px] text-gray-500 italic">
          Select an audio track to see its effects.
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-[#0b1220]" data-testid="macro-panel-root" data-view-mode={viewMode}>
      <MacroPanelHeader
        viewMode={viewMode}
        onToggleView={handleToggleView}
        tileSize={tileSize}
        onTileSizeChange={setTileSize}
        busesOpen={busesOpen}
        onToggleBuses={() => setBusesOpen((v) => !v)}
      />

      {busesOpen && (
        <div className="border-b border-gray-800 p-2">
          <BusSubPanel
            buses={busesResult.data}
            onAddBus={handleAddBus}
            onRemoveBus={handleRemoveBus}
            onUpdateBus={handleUpdateBus}
            onReorderBus={handleReorderBus}
          />
        </div>
      )}

      <div className="flex-1 overflow-auto p-2" data-testid="macro-panel-body">
        <AddEffectBar
          open={addEffectPickerOpen}
          effectType={addEffectType}
          onOpen={() => setAddEffectPickerOpen(true)}
          onCancel={() => setAddEffectPickerOpen(false)}
          onEffectTypeChange={setAddEffectType}
          onCommit={handleAddEffectCommit}
        />

        {effectsResult.loading ? (
          <div className="text-[11px] text-gray-500 italic p-2">Loading effects…</div>
        ) : effectsResult.error ? (
          <div className="text-[11px] text-red-400 italic p-2">Failed to load effects: {effectsResult.error.message}</div>
        ) : effectsResult.data.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-[11px] text-gray-500 italic">
            <div>This track has no effects yet.</div>
          </div>
        ) : (
          effectsResult.data
            .slice()
            .sort((a, b) => a.order_index - b.order_index)
            .map((effect) => (
              <EffectGroup
                key={effect.id}
                effect={effect}
                viewMode={viewMode}
                tileSize={tileSize}
                armState={armState}
                visibleState={visibleState}
                enabledOverride={enabledOverride}
                onArmToggle={handleArmToggle}
                onEnableToggle={handleEnableToggle}
                onVisibleToggle={handleVisibleToggle}
                onGesture={handleKnobGesture}
                onRemove={handleRemoveEffect}
              />
            ))
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add-effect bar — a "+" icon that expands into a type picker + confirm.
// Uses the EFFECT_TYPES registry as the source of truth for selectable
// types; filters out the synthetic __send type per spec R8a.
// ---------------------------------------------------------------------------

interface AddEffectBarProps {
  open: boolean
  effectType: string
  onOpen: () => void
  onCancel: () => void
  onEffectTypeChange: (v: string) => void
  onCommit: () => void
}

function AddEffectBar({ open, effectType, onOpen, onCancel, onEffectTypeChange, onCommit }: AddEffectBarProps) {
  const options = useMemo(
    () => Object.keys(EFFECT_TYPES)
      .filter((k) => k !== '__send')
      .sort(),
    [],
  )
  if (!open) {
    return (
      <div className="flex items-center justify-end mb-2">
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center justify-center p-1 bg-[#1f2937] hover:bg-[#273244] border border-gray-700 text-gray-200 rounded"
          aria-label="Add effect"
          title="Add effect"
          data-testid="macro-panel-add-effect-button"
        >
          <Plus size={14} />
        </button>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-end gap-1 mb-2" data-testid="macro-panel-add-effect-picker">
      <select
        value={effectType}
        onChange={(e) => onEffectTypeChange(e.target.value)}
        className="text-[10px] bg-[#1f2937] border border-gray-700 text-gray-300 rounded px-1 py-0.5"
        data-testid="macro-panel-add-effect-type"
      >
        {options.map((t) => (
          <option key={t} value={t}>{EFFECT_TYPES[t]?.label ?? t}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={onCommit}
        className="flex items-center justify-center p-1 bg-blue-600 hover:bg-blue-700 text-white rounded"
        aria-label="Confirm add effect"
        title="Add"
        data-testid="macro-panel-add-effect-confirm"
      >
        <Plus size={14} />
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-[10px] px-2 py-1 text-gray-400 hover:text-gray-200"
        data-testid="macro-panel-add-effect-cancel"
      >
        Cancel
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface MacroPanelHeaderProps {
  viewMode: MacroPanelViewMode
  onToggleView: () => void
  tileSize: number
  onTileSizeChange: (v: number) => void
  busesOpen: boolean
  onToggleBuses: () => void
}

function MacroPanelHeader({
  viewMode,
  onToggleView,
  tileSize,
  onTileSizeChange,
  busesOpen,
  onToggleBuses,
}: MacroPanelHeaderProps) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1 border-b border-gray-800 bg-[#111827]"
      data-testid="macro-panel-header"
    >
      {/* Spacer pushes slider + toggle to the right. */}
      <div className="flex-1" />

      {viewMode === 'grid' && (
        <label className="flex items-center gap-1 text-[10px] text-gray-400">
          <span>Size</span>
          <input
            type="range"
            min={MACRO_PANEL_TILE_MIN}
            max={MACRO_PANEL_TILE_MAX}
            step={4}
            value={tileSize}
            onChange={(e) => onTileSizeChange(Number(e.target.value))}
            className="w-24"
            aria-label="Tile size"
            data-testid="macro-panel-size-slider"
          />
          <span className="w-8 tabular-nums text-right" data-testid="macro-panel-size-readout">{tileSize}</span>
        </label>
      )}

      <button
        type="button"
        onClick={onToggleView}
        className="flex items-center justify-center px-1.5 py-1 bg-[#1f2937] hover:bg-[#273244] border border-gray-700 text-gray-200 rounded"
        aria-label={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
        title={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
        aria-pressed={viewMode === 'list'}
        data-testid="macro-panel-view-toggle"
      >
        {viewMode === 'grid' ? <List size={14} /> : <LayoutGrid size={14} />}
      </button>

      <button
        type="button"
        onClick={onToggleBuses}
        className={`text-[10px] px-2 py-0.5 rounded border ${busesOpen ? 'bg-blue-600 border-blue-500 text-white' : 'bg-[#1f2937] border-gray-700 text-gray-200 hover:bg-[#273244]'}`}
        aria-pressed={busesOpen}
        data-testid="macro-panel-buses-button"
      >
        Buses
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-effect group
// ---------------------------------------------------------------------------

interface EffectGroupProps {
  effect: TrackEffectRow
  viewMode: MacroPanelViewMode
  tileSize: number
  armState: Record<string, ArmState>
  visibleState: Record<string, boolean>
  enabledOverride: Record<string, boolean>
  onArmToggle: (key: string) => void
  onVisibleToggle: (key: string) => void
  onEnableToggle: (effectId: string, currentEnabled: boolean) => void
  onGesture: React.ComponentProps<typeof MacroKnob>['onGesture']
  /** Optional: delete this effect from the track's chain. */
  onRemove?: (effectId: string) => void
}

function EffectGroup({
  effect,
  viewMode,
  tileSize,
  armState,
  visibleState,
  enabledOverride,
  onArmToggle,
  onVisibleToggle,
  onEnableToggle,
  onGesture,
  onRemove,
}: EffectGroupProps) {
  const spec = EFFECT_TYPES[effect.effect_type]

  const animatableParams: EffectParamSpec[] = useMemo(() => {
    if (!spec) return []
    return spec.params.filter((p) => p.animatable)
  }, [spec])

  // Effective enabled = override if set, else DB value.
  const enabled = Object.prototype.hasOwnProperty.call(enabledOverride, effect.id)
    ? enabledOverride[effect.id]
    : effect.enabled

  if (!spec) {
    return (
      <div className="mb-2 p-2 border border-yellow-800 bg-yellow-900/30 rounded text-[10px] text-yellow-300">
        Unknown effect_type “{effect.effect_type}” — registry missing entry.
      </div>
    )
  }

  if (animatableParams.length === 0) {
    return (
      <div className="mb-2 p-2 border border-gray-800 rounded text-[10px] text-gray-500 italic">
        {spec.label} has no animatable parameters.
      </div>
    )
  }

  return (
    <section
      className="mb-3 border border-gray-800 rounded bg-[#0f172a]"
      data-testid="macro-effect-group"
      data-effect-id={effect.id}
      data-effect-type={effect.effect_type}
    >
      <header className="flex items-center gap-2 px-2 py-1 border-b border-gray-800 bg-[#111827]">
        <span className="text-[11px] font-semibold text-gray-200">{spec.label}</span>
        <span className="text-[9px] text-gray-500 uppercase">{spec.category}</span>
        <div className="flex-1" />
        <label className="flex items-center gap-1 text-[10px] text-gray-400">
          <input
            type="checkbox"
            checked={enabled}
            onChange={() => onEnableToggle(effect.id, enabled)}
            data-testid="macro-effect-enable"
          />
          <span>enabled</span>
        </label>
        {onRemove && (
          <button
            type="button"
            onClick={() => onRemove(effect.id)}
            className="text-[10px] text-gray-500 hover:text-red-400 px-1"
            aria-label="Remove effect"
            title="Remove effect"
            data-testid="macro-effect-remove"
          >
            ×
          </button>
        )}
      </header>

      {viewMode === 'grid' ? (
        <div
          className="flex flex-wrap gap-2 p-2"
          data-testid="macro-effect-grid"
          data-tile-count={animatableParams.length}
        >
          {animatableParams.map((param) => {
            const key = `${effect.id}.${param.name}`
            const curveVisible = visibleState[key] ?? effect.curves?.[param.name]?.visible ?? false
            return (
              <MacroKnob
                key={key}
                effect_id={effect.id}
                param_name={param.name}
                value={normaliseFromDefault(param)}
                range={param.range}
                scale={param.scale}
                armed={armState[key] ?? 'idle'}
                enabled={enabled}
                visible={curveVisible}
                label={param.label}
                size={tileSize}
                onGesture={onGesture}
                onArmToggle={() => onArmToggle(key)}
                onEnableToggle={() => onEnableToggle(effect.id, enabled)}
                onVisibleToggle={() => onVisibleToggle(key)}
              />
            )
          })}
        </div>
      ) : (
        <table
          className="w-full text-[10px] text-gray-300"
          data-testid="macro-effect-list"
        >
          <thead className="bg-[#0b1220] text-gray-500">
            <tr>
              <th className="text-left px-2 py-1 font-normal">Param</th>
              <th className="text-left px-2 py-1 font-normal">Arm</th>
              <th className="text-left px-2 py-1 font-normal">Value</th>
              <th className="text-left px-2 py-1 font-normal">Visible</th>
            </tr>
          </thead>
          <tbody>
            {animatableParams.map((param) => {
              const key = `${effect.id}.${param.name}`
              const norm = normaliseFromDefault(param)
              const curveVisible = visibleState[key] ?? effect.curves?.[param.name]?.visible ?? false
              return (
                <tr key={key} data-testid="macro-effect-list-row" data-param-name={param.name}>
                  <td className="px-2 py-1">{param.label}</td>
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      onClick={() => onArmToggle(key)}
                      className="rounded-full"
                      style={{
                        width: 12, height: 12,
                        borderRadius: 999,
                        border: `2px solid ${armState[key] && armState[key] !== 'idle' ? '#ef4444' : '#4b5563'}`,
                        background: armState[key] && armState[key] !== 'idle' ? '#ef4444' : '#374151',
                      }}
                      aria-label="Toggle arm"
                      data-testid="macro-effect-list-arm"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.001}
                      value={norm}
                      readOnly
                      className="w-32"
                      data-testid="macro-effect-list-slider"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      onClick={() => onVisibleToggle(key)}
                      className="text-[10px]"
                      style={{ color: curveVisible ? '#a7f3d0' : '#4b5563' }}
                      aria-pressed={curveVisible}
                      data-testid="macro-effect-list-visible"
                    >
                      {curveVisible ? 'eye' : 'eye-off'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

/**
 * Derive a display-time normalised value from a param spec. Until task-55
 * connects live curve sampling, each knob shows its static default mapped
 * from native-unit space back into [0, 1].
 */
function normaliseFromDefault(param: EffectParamSpec): number {
  const { range, scale, default: def } = param
  if (scale === 'log' || scale === 'hz') {
    const minL = Math.log(Math.max(range.min, 1e-6))
    const maxL = Math.log(Math.max(range.max, 1e-6))
    const valL = Math.log(Math.max(def, 1e-6))
    if (maxL === minL) return 0
    return Math.max(0, Math.min(1, (valL - minL) / (maxL - minL)))
  }
  if (range.max === range.min) return 0
  return Math.max(0, Math.min(1, (def - range.min) / (range.max - range.min)))
}
