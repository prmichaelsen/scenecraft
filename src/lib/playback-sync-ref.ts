/**
 * Shared "video pipeline is busy" gate for keeping audio + playhead in
 * lockstep with the MSE preview.
 *
 * Why this exists: scenecraft's preview pipeline has two independent
 * playback paths — the HTMLAudioElement (transition audio, audio mixer
 * clips) plays directly from local files in single-digit ms, while the
 * MSE-fed video element waits for the backend preview_worker to render
 * fragments and stream them over WS. On a seek, audio jumps instantly
 * but video is dark for ~100-300ms while the encoder warms up. Audio
 * ends up leading video by that gap permanently, since both then
 * advance at real-time.
 *
 * Fix: when ``useMSEPlayback`` detects a seek, it flips ``videoBlocked``
 * to ``true``. The transition audio element pauses, the playhead's
 * fallback rAF timer freezes the project clock. When the first new
 * fragment arrives (``updateend`` fires), the gate releases and audio +
 * playhead resume in sync with whatever frame the browser is now
 * presenting. No more permanent A/V offset after seeks.
 *
 * This is a tiny global because the seek detection lives in
 * ``useMSEPlayback`` (a hook inside PreviewViewport) and the audio /
 * playhead consumers live in ``Timeline.tsx`` — sibling components,
 * not a parent-child pair, so context propagation is awkward. Module
 * singletons mirror the established pattern (audio-mixer-ref, dmx-ref).
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
