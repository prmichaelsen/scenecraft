import { useCallback, useMemo } from 'react'
import { useEditorState } from './EditorStateContext'
import { VolumeCurveEditor } from './VolumeCurveEditor'
import { postUpdateAudioClip, postUpdateAudioTrack } from '@/lib/audio-client'
import type { AudioClip, AudioTrack, CurvePoint } from '@/lib/audio-client'

type Props = {
  projectName: string
  audioTracks: AudioTrack[]
  projectDurationSeconds: number
  onChanged?: () => void
}

/**
 * Properties panel for audio clips + audio tracks. Renders the VolumeCurveEditor
 * appropriate for the current selection:
 *   - clip selected  → normalised x (0..1) curve, source/duration/mute
 *   - track selected → seconds x (0..projectDuration) curve, name/mute/enabled
 *
 * Consumes EditorStateContext for the current audio selection. Debounced saves
 * flow through postUpdateAudioClip / postUpdateAudioTrack.
 */
export function AudioPropertiesPanel({ projectName, audioTracks, projectDurationSeconds, onChanged }: Props) {
  const { selectedAudioClipId, selectedAudioTrackId, setSelectedAudioClipId, setSelectedAudioTrackId } = useEditorState()

  const { clip, clipTrack, track } = useMemo(() => {
    let clip: AudioClip | null = null
    let clipTrack: AudioTrack | null = null
    let track: AudioTrack | null = null
    if (selectedAudioClipId) {
      for (const t of audioTracks) {
        const c = (t.clips ?? []).find((x) => x.id === selectedAudioClipId)
        if (c) { clip = c; clipTrack = t; break }
      }
    } else if (selectedAudioTrackId) {
      track = audioTracks.find((t) => t.id === selectedAudioTrackId) ?? null
    }
    return { clip, clipTrack, track }
  }, [audioTracks, selectedAudioClipId, selectedAudioTrackId])

  const handleClipCurveChange = useCallback(async (next: CurvePoint[]) => {
    if (!clip) return
    try {
      await postUpdateAudioClip(projectName, clip.id, { volumeCurve: next })
      onChanged?.()
    } catch (e) {
      console.error('[AudioPropertiesPanel] clip curve save failed:', e)
    }
  }, [clip, projectName, onChanged])

  const handleClipMuteToggle = useCallback(async () => {
    if (!clip) return
    try {
      await postUpdateAudioClip(projectName, clip.id, { muted: !clip.muted })
      onChanged?.()
    } catch (e) {
      console.error('[AudioPropertiesPanel] clip mute save failed:', e)
    }
  }, [clip, projectName, onChanged])

  const handleTrackCurveChange = useCallback(async (next: CurvePoint[]) => {
    if (!track) return
    try {
      await postUpdateAudioTrack(projectName, track.id, { volumeCurve: next })
      onChanged?.()
    } catch (e) {
      console.error('[AudioPropertiesPanel] track curve save failed:', e)
    }
  }, [track, projectName, onChanged])

  const handleTrackMuteToggle = useCallback(async () => {
    if (!track) return
    try {
      await postUpdateAudioTrack(projectName, track.id, { muted: !track.muted })
      onChanged?.()
    } catch (e) {
      console.error('[AudioPropertiesPanel] track mute save failed:', e)
    }
  }, [track, projectName, onChanged])

  const handleTrackSoloToggle = useCallback(async () => {
    if (!track) return
    try {
      await postUpdateAudioTrack(projectName, track.id, { solo: !track.solo })
      onChanged?.()
    } catch (e) {
      console.error('[AudioPropertiesPanel] track solo save failed:', e)
    }
  }, [track, projectName, onChanged])

  if (!clip && !track) {
    return (
      <div className="p-3 text-xs text-gray-500">
        Select an audio clip or audio track on the timeline to edit its volume curve.
      </div>
    )
  }

  if (clip) {
    const durationSeconds = clip.end_time - clip.start_time
    return (
      <div className="flex flex-col gap-3 p-3 text-xs text-gray-300">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-200">Audio Clip</h3>
          <button
            type="button"
            onClick={() => setSelectedAudioClipId(null)}
            className="text-[10px] text-gray-500 hover:text-gray-300"
            title="Deselect"
          >
            close
          </button>
        </div>
        <dl className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-1 text-[11px]">
          <dt className="text-gray-500">id</dt>
          <dd className="font-mono text-gray-400 truncate">{clip.id}</dd>
          <dt className="text-gray-500">track</dt>
          <dd className="text-gray-400 truncate">{clipTrack?.name ?? '—'}</dd>
          <dt className="text-gray-500">source</dt>
          <dd className="font-mono text-gray-400 truncate" title={clip.source_path}>{clip.source_path}</dd>
          <dt className="text-gray-500">duration</dt>
          <dd>{durationSeconds.toFixed(2)}s</dd>
          <dt className="text-gray-500">offset</dt>
          <dd>{clip.source_offset.toFixed(2)}s</dd>
        </dl>
        <label className="flex items-center gap-2 text-[11px]">
          <input type="checkbox" checked={!!clip.muted} onChange={handleClipMuteToggle} />
          <span>muted</span>
        </label>
        <VolumeCurveEditor
          curve={clip.volume_curve}
          onChange={handleClipCurveChange}
          xAxis="normalised"
          label="Volume (clip-local, 0..1)"
        />
      </div>
    )
  }

  // track selected
  const t = track!
  return (
    <div className="flex flex-col gap-3 p-3 text-xs text-gray-300">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-200">Audio Track</h3>
        <button
          type="button"
          onClick={() => setSelectedAudioTrackId(null)}
          className="text-[10px] text-gray-500 hover:text-gray-300"
          title="Deselect"
        >
          close
        </button>
      </div>
      <dl className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-1 text-[11px]">
        <dt className="text-gray-500">id</dt>
        <dd className="font-mono text-gray-400 truncate">{t.id}</dd>
        <dt className="text-gray-500">name</dt>
        <dd>{t.name}</dd>
        <dt className="text-gray-500">order</dt>
        <dd>A{t.display_order + 1}</dd>
      </dl>
      <div className="flex gap-3">
        <label className="flex items-center gap-2 text-[11px]">
          <input type="checkbox" checked={!!t.muted} onChange={handleTrackMuteToggle} />
          <span>muted</span>
        </label>
        <label className="flex items-center gap-2 text-[11px]">
          <input type="checkbox" checked={!!t.solo} onChange={handleTrackSoloToggle} />
          <span>solo</span>
        </label>
      </div>
      <VolumeCurveEditor
        curve={t.volume_curve}
        onChange={handleTrackCurveChange}
        xAxis="seconds"
        xAxisMax={Math.max(projectDurationSeconds, 1)}
        label="Volume (track-global, seconds)"
      />
    </div>
  )
}
