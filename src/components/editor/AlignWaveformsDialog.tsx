import { useMemo, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Wand2 } from 'lucide-react'
import type { AudioClip, AudioTrack } from '@/lib/audio-client'
import { postDetectAudioAlignment, postUpdateAudioClip } from '@/lib/audio-client'

/**
 * AlignWaveformsDialog — sync multiple audio clips across tracks by shifting
 * their timeline positions so their waveforms line up (Premiere's
 * "Synchronize" workflow).
 *
 * MVP scope:
 *   - Anchor clip stays fixed; non-anchor clips shift by a signed offset
 *     applied to both `start_time` and `end_time` (clip duration preserved).
 *   - Manual offset entry per non-anchor clip.
 *   - "Detect automatically" button calls the backend endpoint (not yet
 *     implemented); on failure, falls back to manual offsets.
 *
 * Out of scope for MVP (follow-ups):
 *   - Waveform overlay preview
 *   - Confidence score visualization
 *   - Snap-to-peak or per-side alignment handles
 */
export type AlignWaveformsDialogProps = {
  open: boolean
  projectName: string
  /** Audio clips being aligned (>= 2, one becomes the anchor). */
  clips: AudioClip[]
  /** Used to display the track name in the clip row. */
  tracksById: Record<string, AudioTrack | undefined>
  onClose: () => void
  /** Invoked after successful apply so the caller can refresh the timeline. */
  onApplied?: () => void
}

export function AlignWaveformsDialog({
  open,
  projectName,
  clips,
  tracksById,
  onClose,
  onApplied,
}: AlignWaveformsDialogProps) {
  // First clip defaults as anchor
  const [anchorId, setAnchorId] = useState<string>(() => clips[0]?.id ?? '')
  const [offsets, setOffsets] = useState<Record<string, number>>(() =>
    Object.fromEntries(clips.map((c) => [c.id, 0])),
  )
  const [isDetecting, setIsDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [isApplying, setIsApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  const anchor = useMemo(() => clips.find((c) => c.id === anchorId) ?? clips[0], [anchorId, clips])
  const nonZeroCount = Object.entries(offsets).filter(([id, v]) => id !== anchor?.id && Math.abs(v) > 0.0001).length

  const handleDetect = async () => {
    if (!anchor) return
    setIsDetecting(true)
    setDetectError(null)
    try {
      const res = await postDetectAudioAlignment(projectName, {
        anchorClipId: anchor.id,
        clipIds: clips.map((c) => c.id),
      })
      // Merge detected offsets, leaving anchor at 0
      setOffsets((prev) => {
        const next = { ...prev, [anchor.id]: 0 }
        for (const [id, off] of Object.entries(res.offsets)) {
          if (id !== anchor.id) next[id] = off
        }
        return next
      })
    } catch (err) {
      setDetectError(
        err instanceof Error && err.message.includes('501')
          ? 'Auto-detect not yet implemented. Enter offsets manually.'
          : `Detect failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setIsDetecting(false)
    }
  }

  const handleApply = async () => {
    if (!anchor) return
    setIsApplying(true)
    setApplyError(null)
    try {
      const toShift = clips.filter(
        (c) => c.id !== anchor.id && Math.abs(offsets[c.id] || 0) > 0.0001,
      )
      await Promise.all(
        toShift.map((c) => {
          const off = offsets[c.id]
          return postUpdateAudioClip(projectName, c.id, {
            startTime: c.start_time + off,
            endTime: c.end_time + off,
          })
        }),
      )
      onApplied?.()
      onClose()
    } catch (err) {
      setApplyError(`Apply failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsApplying(false)
    }
  }

  const setOffset = (id: string, value: number) => {
    setOffsets((prev) => ({ ...prev, [id]: value }))
  }

  return (
    <Modal
      isOpen={open}
      onClose={isApplying ? () => {} : onClose}
      title="Align Waveforms"
      maxWidth="2xl"
      isLoading={isApplying}
      style={{ background: '#111827' }}
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-400">
          Pick an anchor clip (stays fixed). Other clips shift by the signed offset you enter — positive
          moves them later on the timeline, negative moves them earlier. Clip durations are preserved.
        </p>

        {/* Detect button + status */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDetect}
            disabled={isDetecting || isApplying || !anchor || clips.length < 2}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-blue-600/30 hover:bg-blue-600/50 text-blue-100 border border-blue-500/40 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Wand2 size={12} />
            {isDetecting ? 'Detecting…' : 'Detect automatically'}
          </button>
          {detectError ? <span className="text-[11px] text-amber-400">{detectError}</span> : null}
        </div>

        {/* Clip list */}
        <div className="border border-gray-800 rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-900/50 text-[10px] text-gray-500 uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2 font-normal w-16">Anchor</th>
                <th className="text-left px-3 py-2 font-normal">Clip</th>
                <th className="text-left px-3 py-2 font-normal">Track</th>
                <th className="text-right px-3 py-2 font-normal w-32">Offset (s)</th>
                <th className="text-right px-3 py-2 font-normal w-28">New start</th>
              </tr>
            </thead>
            <tbody>
              {clips.map((c) => {
                const isAnchor = c.id === anchor?.id
                const off = offsets[c.id] ?? 0
                const track = tracksById[c.track_id]
                const fname = c.source_path.split('/').pop() ?? c.source_path
                const newStart = c.start_time + (isAnchor ? 0 : off)
                return (
                  <tr key={c.id} className="border-t border-gray-800 hover:bg-gray-800/30">
                    <td className="px-3 py-2">
                      <input
                        type="radio"
                        name="align-anchor"
                        checked={isAnchor}
                        onChange={() => {
                          setAnchorId(c.id)
                          // When switching anchor, zero out the new anchor's offset
                          setOffsets((prev) => ({ ...prev, [c.id]: 0 }))
                        }}
                        className="accent-cyan-400"
                        disabled={isApplying}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-gray-200 truncate max-w-[240px]" title={c.source_path}>{fname}</div>
                      <div className="text-[10px] text-gray-600 font-mono">{c.id.replace(/^audio_clip_/, '')}</div>
                    </td>
                    <td className="px-3 py-2 text-gray-400">
                      {track ? (
                        <>
                          <span className="text-[10px] text-gray-600">A{track.display_order + 1}</span>{' '}
                          <span>{track.name}</span>
                        </>
                      ) : (
                        <span className="text-gray-600">(unknown)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isAnchor ? (
                        <span className="text-[10px] text-cyan-400 uppercase tracking-wider">Anchor</span>
                      ) : (
                        <input
                          type="number"
                          step="0.01"
                          value={Number.isFinite(off) ? off : 0}
                          onChange={(e) => setOffset(c.id, parseFloat(e.target.value) || 0)}
                          className="w-24 text-right bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-200 focus:border-cyan-500 focus:outline-none"
                          disabled={isApplying}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-500">
                      {newStart.toFixed(2)}s
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {applyError ? <div className="text-xs text-red-400">{applyError}</div> : null}

        {/* Buttons */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isApplying}
            className="px-3 py-1.5 rounded text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={isApplying || nonZeroCount === 0}
            className="px-3 py-1.5 rounded text-xs bg-cyan-600/60 hover:bg-cyan-600/80 text-white border border-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed"
            title={nonZeroCount === 0 ? 'Enter a non-zero offset on at least one clip' : undefined}
          >
            {isApplying ? 'Applying…' : `Apply${nonZeroCount > 0 ? ` (${nonZeroCount})` : ''}`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
