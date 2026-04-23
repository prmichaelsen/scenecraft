/**
 * AudioIsolationsPanel — placeholder stub.
 *
 * Task 103 ships this as a minimal stub so `plugins/isolate_vocals/index.ts`
 * can register it with the PluginHost. Task 104 replaces the body with the
 * real panel (runs list, stem rows, mini-waveforms, drag handles).
 *
 * Keeping the stub here (inside the plugin dir) rather than in
 * `components/editor/` preserves the plugin-boundary rule: the plugin owns
 * its panel, and nothing outside the plugin should import it directly —
 * the editor mounts it by descriptor lookup, not by file path.
 */

export type AudioIsolationsPanelProps = {
  entity?: {
    type: 'audio_clip' | 'transition'
    id: string
    durationSeconds?: number
    label?: string
  }
  projectName?: string
  onClose?: () => void
}

export function AudioIsolationsPanel(_props: AudioIsolationsPanelProps) {
  return (
    <div className="p-4 text-xs text-gray-400">
      Audio Isolations — panel body built in task 104.
    </div>
  )
}
