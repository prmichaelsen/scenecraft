import { type ReactNode, type MouseEvent } from 'react'

/**
 * TrackHeaderPill — the small translucent pill that holds a track's label
 * and its mute / solo (/ extra action) buttons, shared by audio lanes and
 * video tracks. Styled to match the Align-Waveforms modal: `bg-black/50`
 * plus `backdrop-blur-sm` so whatever scrolls beneath it stays subtly
 * visible without eating legibility.
 *
 * Design goals:
 *   - Single component, one visual language across track types.
 *   - Contents-sized (does NOT stretch to full lane height).
 *   - No drag / drop / selection logic inside — those stay on callers so
 *     this stays trivially reusable in the upcoming left-column layout.
 *   - `M` / `S` buttons are sized with a realistic click hitbox
 *     (`text-[10px] px-1.5`) so they're reliable targets on a touchpad.
 */
export interface TrackHeaderPillProps {
  /** Optional small index / badge on the far left (e.g. "A1"). */
  prefix?: ReactNode
  /** The primary label slot. Either a plain string (rendered as a span
   *  with double-click-to-rename semantics via `onLabelDoubleClick`) or
   *  an explicit React node (e.g. an inline rename input). */
  label: ReactNode
  /** Title attribute on the default label rendering — ignored when
   *  `label` is a ReactNode. */
  labelTitle?: string
  /** Invoked on double-click of the label. Only applies when `label` is
   *  a string; ReactNode labels manage their own handlers. */
  onLabelDoubleClick?: (e: MouseEvent<HTMLElement>) => void
  /** Mute state. `true` = muted (red). */
  muted: boolean
  onMuteToggle: (e: MouseEvent<HTMLButtonElement>) => void
  /** Solo state. `true` = soloed (yellow). */
  solo: boolean
  onSoloToggle: (e: MouseEvent<HTMLButtonElement>) => void
  /** Optional extra action buttons rendered after the solo button —
   *  e.g. Properties, move-up, move-down. */
  actions?: ReactNode
  /** Optional amplitude meter rendered at the far right of the pill.
   *  Typically a `<LevelMeter>` driven by the mixer's per-track analyser.
   *  Passed as a ReactNode so this component doesn't have to know about
   *  audio graph types. */
  meter?: ReactNode
  /** Max width applied to the label when it's a plain string. */
  labelMaxWidthClass?: string
}

export function TrackHeaderPill({
  prefix,
  label,
  labelTitle,
  onLabelDoubleClick,
  muted,
  onMuteToggle,
  solo,
  onSoloToggle,
  actions,
  meter,
  labelMaxWidthClass = 'max-w-[120px]',
}: TrackHeaderPillProps) {
  return (
    <div
      className="flex items-center gap-2 px-1.5 py-0.5 rounded bg-black/50 backdrop-blur-sm"
      data-testid="track-header-pill"
    >
      {prefix && (
        <span className="text-[9px] text-gray-500 uppercase tracking-wider">
          {prefix}
        </span>
      )}
      {typeof label === 'string' ? (
        <span
          className={`text-[10px] text-gray-400 font-medium truncate ${labelMaxWidthClass} ${onLabelDoubleClick ? 'cursor-text' : ''}`}
          title={labelTitle}
          onDoubleClick={onLabelDoubleClick}
        >
          {label}
        </span>
      ) : (
        label
      )}
      <button
        type="button"
        onClick={onMuteToggle}
        className={`text-[10px] px-1.5 py-px rounded font-medium ${muted ? 'text-red-400 hover:text-red-300' : 'text-green-400 hover:text-green-300'}`}
        title={muted ? 'Unmute track' : 'Mute track'}
        data-testid="track-header-pill-mute"
      >
        M
      </button>
      <button
        type="button"
        onClick={onSoloToggle}
        className={`text-[10px] px-1.5 py-px rounded font-medium ${solo ? 'text-yellow-400 hover:text-yellow-300' : 'text-gray-500 hover:text-gray-300'}`}
        title={solo ? 'Un-solo track' : 'Solo track — silences non-solo tracks'}
        data-testid="track-header-pill-solo"
      >
        S
      </button>
      {actions}
      {meter}
    </div>
  )
}
