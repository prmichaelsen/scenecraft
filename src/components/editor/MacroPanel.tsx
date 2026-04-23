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

import { useState, useCallback, useMemo } from 'react'
import { useEditorState } from './EditorStateContext'
import { EFFECT_TYPES, type EffectParamSpec } from '@/lib/audio-effect-types'
import { MacroKnob, type ArmState } from './MacroKnob'
import { BusSubPanel, type SendBus, type BusType } from './BusSubPanel'

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
}

/**
 * TODO(task-52): wire to GET /track-effects?track_id=...
 * Today returns an empty list so the panel shows the empty-state.
 */
export function useTrackEffects(_trackId: string | null): UseTrackEffectsResult {
  return { data: [], loading: false, error: null }
}

interface UseSendBusesResult {
  data: SendBus[]
  loading: boolean
  error: Error | null
}

/**
 * TODO(task-52): wire to GET /send-buses
 * Today returns an empty list so the sub-panel shows the empty-state.
 */
export function useSendBuses(): UseSendBusesResult {
  return { data: [], loading: false, error: null }
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
  /** optional injection points for tests */
  trackEffectsHook?: (trackId: string | null) => UseTrackEffectsResult
  sendBusesHook?: () => UseSendBusesResult
}

export function MacroPanel({
  trackEffectsHook = useTrackEffects,
  sendBusesHook = useSendBuses,
}: MacroPanelProps = {}) {
  const { selectedAudioTrackId } = useEditorState()
  const [viewMode, setViewMode] = useState<MacroPanelViewMode>('grid')
  const [tileSize, setTileSize] = useState<number>(MACRO_PANEL_TILE_DEFAULT)
  const [busesOpen, setBusesOpen] = useState(false)

  // Per-knob arm/enable/visible state. Until task-55 wires this to server
  // state, we keep a local map keyed by `${effect_id}.${param_name}`.
  // Arm + visible live here; enable lives on the effect (track_effects.enabled).
  type KnobKey = string
  const [armState, setArmState] = useState<Record<KnobKey, ArmState>>({})
  const [visibleState, setVisibleState] = useState<Record<KnobKey, boolean>>({})
  const [enabledOverride, setEnabledOverride] = useState<Record<string, boolean>>({})

  const effectsResult = trackEffectsHook(selectedAudioTrackId)
  const busesResult = sendBusesHook()

  const handleToggleView = useCallback(() => {
    setViewMode((m) => (m === 'grid' ? 'list' : 'grid'))
  }, [])

  const handleArmToggle = useCallback((key: KnobKey) => {
    setArmState((s) => ({ ...s, [key]: s[key] && s[key] !== 'idle' ? 'idle' : 'armed' }))
  }, [])

  const handleVisibleToggle = useCallback((key: KnobKey) => {
    setVisibleState((s) => ({ ...s, [key]: !s[key] }))
    // TODO(task-52): POST /effect-curves/:id { visible: ... }
  }, [])

  const handleEnableToggle = useCallback((effectId: string, currentEnabled: boolean) => {
    setEnabledOverride((s) => ({ ...s, [effectId]: !currentEnabled }))
    // TODO(task-52): POST /track-effects/:id { enabled: ... }
  }, [])

  const handleKnobGesture: React.ComponentProps<typeof MacroKnob>['onGesture'] = useCallback((_v, _meta) => {
    // TODO(task-55): route into touch-record state machine + audio scheduling.
    // No-op today — value emission is the knob's own responsibility; parent
    // just acknowledges receipt.
  }, [])

  // Bus sub-panel stub callbacks (wired in task-52).
  const handleAddBus = useCallback((_body: { bus_type: BusType; label: string; static_params: Record<string, unknown> }) => {
    // TODO(task-52): POST /send-buses
  }, [])
  const handleRemoveBus = useCallback((_id: string) => {
    // TODO(task-52): DELETE /send-buses/:id
  }, [])
  const handleUpdateBus = useCallback((_id: string, _patch: { label?: string; static_params?: Record<string, unknown> }) => {
    // TODO(task-52): POST /send-buses/:id
  }, [])
  const handleReorderBus = useCallback((_id: string, _newOrderIndex: number) => {
    // TODO(task-52): POST /send-buses/:id { order_index }
  }, [])

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
        {effectsResult.loading ? (
          <div className="text-[11px] text-gray-500 italic p-2">Loading effects…</div>
        ) : effectsResult.error ? (
          <div className="text-[11px] text-red-400 italic p-2">Failed to load effects: {effectsResult.error.message}</div>
        ) : effectsResult.data.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-[11px] text-gray-500 italic">
            <div>This track has no effects yet.</div>
            <div className="text-[10px] text-gray-600">+ Add Effect — wired in task-52</div>
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
              />
            ))
        )}
      </div>
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
      <button
        type="button"
        onClick={onToggleView}
        className="text-[10px] px-2 py-0.5 bg-[#1f2937] hover:bg-[#273244] border border-gray-700 text-gray-200 rounded"
        aria-label={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
        aria-pressed={viewMode === 'list'}
        data-testid="macro-panel-view-toggle"
      >
        {viewMode === 'grid' ? '☰ List' : '▦ Grid'}
      </button>

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

      <div className="flex-1" />

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
