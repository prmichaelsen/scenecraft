/**
 * Shared "video pipeline is busy" flag for the preview viewport.
 *
 * Why this exists: scenecraft's preview pipeline has two independent
 * playback paths — the HTMLAudioElement (transition audio, audio mixer
 * clips) plays directly from local files in single-digit ms, while the
 * MSE-fed video element waits for the backend preview_worker to render
 * fragments and stream them over WS. On a seek, audio jumps instantly
 * but video is dark for ~100-300ms while the encoder warms up.
 *
 * UX: rather than freeze audio + playhead to wait for video (which
 * stops the music and the timeline mid-scrub), the viewport keeps
 * audio + playhead running and shows a "Rendering…" overlay over the
 * last-good frame while videoBlocked is true. PreviewViewport raises
 * the canvas (which has snapshotted the last visible video frame) above
 * the loading <video> element until the gate releases.
 *
 * Set by ``useMSEPlayback`` on seek detection, cleared on the first
 * SourceBuffer ``updateend`` after the seek action fires. Module-level
 * singleton because the seek detection and the overlay consumer are in
 * separate component subtrees (mirrors audio-mixer-ref / dmx-ref).
 */

let _videoBlocked = false
const _subs = new Set<() => void>()

export function getVideoBlocked(): boolean {
  return _videoBlocked
}

export function setVideoBlocked(value: boolean): void {
  if (_videoBlocked === value) return
  _videoBlocked = value
  for (const cb of _subs) cb()
}

export function subscribeVideoBlocked(cb: () => void): () => void {
  _subs.add(cb)
  return () => { _subs.delete(cb) }
}
